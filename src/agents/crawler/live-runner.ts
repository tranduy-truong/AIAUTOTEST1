import fs from 'fs';
import path from 'path';
import { chromium, Browser, Locator, Page } from 'playwright';
import { ParsedStep, ParsedTestCase } from '../../core/step-parser.js';
import {
  DomSnapshot,
  ElementInfo,
  ResolvedLocator,
  resolveLocator,
} from '../../core/locator-resolver.js';

// Dùng chuỗi JavaScript thuần để đoạn code chạy trong browser không bị tsx/esbuild
// chèn helper nội bộ (ví dụ __name) mà Playwright không thể serialize sang page.
export const CAPTURE_SNAPSHOT_SCRIPT = String.raw`
  (() => {
    const query = [
      'input', 'textarea', 'select', 'option', 'button', 'a[href]', 'label', 'svg', 'i',
      '[role]', '[aria-label]', '[aria-haspopup]', '[data-testid]', '[title]',
      '[onclick]', '[tabindex]',
    ].join(', ');
    const nodes = Array.from(document.querySelectorAll(query));

    function escapeCss(value) {
      if (globalThis.CSS && typeof globalThis.CSS.escape === 'function') {
        return globalThis.CSS.escape(value);
      }
      return value.replace(/[^a-zA-Z0-9_-]/g, function (character) {
        return '\\' + character;
      });
    }

    function uniqueSelector(source) {
      const interactive = source.closest('button, a, select, [role="button"], [role="link"], [role="combobox"], [role="option"], [role="menuitem"], [onclick], [tabindex]') || source;
      const testId = interactive.getAttribute('data-testid');
      if (testId) return '[data-testid="' + escapeCss(testId) + '"]';
      if (interactive.id) return '#' + escapeCss(interactive.id);

      const ariaLabel = interactive.getAttribute('aria-label');
      if (ariaLabel) {
        const selector = '[aria-label="' + ariaLabel.replace(/"/g, '\\"') + '"]';
        if (document.querySelectorAll(selector).length === 1) return selector;
      }

      const name = interactive.getAttribute('name');
      const tag = interactive.tagName.toLowerCase();
      if (name) {
        const selector = tag + '[name="' + name.replace(/"/g, '\\"') + '"]';
        if (document.querySelectorAll(selector).length === 1) return selector;
      }

      const classes = (interactive.getAttribute('class') || '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 4)
        .map(function (className) { return '.' + escapeCss(className); })
        .join('');
      if (classes) {
        const selector = tag + classes;
        if (document.querySelectorAll(selector).length === 1) return selector;
      }

      const path = [];
      let current = interactive;
      while (current && current !== document.body && path.length < 5) {
        const currentTag = current.tagName.toLowerCase();
        const siblings = current.parentElement
          ? Array.from(current.parentElement.children).filter(function (child) {
              return child.tagName === current.tagName;
            })
          : [];
        const position = siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')' : '';
        path.unshift(currentTag + position);
        current = current.parentElement;
      }
      return path.length ? path.join(' > ') : undefined;
    }

    return nodes.map(function (node) {
      const htmlNode = node;
      const interactive = node.closest('button, a, select, [role="button"], [role="link"], [role="combobox"], [role="option"], [role="menuitem"], [onclick], [tabindex]');
      let ancestor = node;
      let nearbyInput = null;
      for (let depth = 0; ancestor && depth < 5 && !nearbyInput; depth++) {
        nearbyInput = ancestor.querySelector('input');
        ancestor = ancestor.parentElement;
      }

      const rect = node.getBoundingClientRect();
      const style = globalThis.getComputedStyle(htmlNode);
      const isVisible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      const accessibleName =
        node.getAttribute('aria-label') ||
        interactive?.getAttribute('aria-label') ||
        node.getAttribute('title') ||
        interactive?.getAttribute('title') ||
        (interactive?.textContent || node.textContent || '').trim().substring(0, 100) ||
        undefined;
      const nodeId = node.getAttribute('id');
      const explicitLabel = nodeId
        ? document.querySelector('label[for="' + escapeCss(nodeId) + '"]')
        : null;
      const wrappingLabel = node.closest('label');
      const nearbyLabel = explicitLabel || wrappingLabel || node.parentElement?.querySelector('label');
      const scope = node.closest('dialog, [role="dialog"], [aria-modal="true"], form, [data-slot="sheet-content"], [class*="drawer"], [class*="modal"]');

      return {
        tag: node.tagName.toLowerCase(),
        type: node.type || undefined,
        role: node.getAttribute('role') || (interactive && interactive.getAttribute('role')) || undefined,
        placeholder: node.getAttribute('placeholder') || undefined,
        ariaLabel: node.getAttribute('aria-label') || (interactive && interactive.getAttribute('aria-label')) || undefined,
        text: (node.textContent || '').trim().substring(0, 100),
        testId: node.getAttribute('data-testid') || (interactive && interactive.getAttribute('data-testid')) || undefined,
        id: node.id || (interactive && interactive.id) || undefined,
        name: node.name || undefined,
        className: (node.getAttribute('class') || (interactive && interactive.getAttribute('class')) || '').substring(0, 120) || undefined,
        title: node.getAttribute('title') || (interactive && interactive.getAttribute('title')) || undefined,
        accessibleName,
        nearbyInputPlaceholder: (nearbyInput && (nearbyInput.placeholder || nearbyInput.name)) || undefined,
        labelText: (nearbyLabel && nearbyLabel.textContent || '').trim().replace(/\s*\*\s*$/, '').substring(0, 100) || undefined,
        scopeSelector: scope ? uniqueSelector(scope) : undefined,
        ariaHasPopup: node.getAttribute('aria-haspopup') || (interactive && interactive.getAttribute('aria-haspopup')) || undefined,
        selector: uniqueSelector(node),
        isVisible,
      };
    });
  })()
`;

export async function captureSnapshot(page: Page, afterStep: string): Promise<DomSnapshot> {
  const elements = await page.evaluate(CAPTURE_SNAPSHOT_SCRIPT) as ElementInfo[];

  return { url: page.url(), afterStep, elements };
}

const INTERACTIVE_SELECTOR = [
  'input', 'textarea', 'select', 'button', 'a[href]',
  '[role]', '[aria-label]', '[aria-haspopup]', '[data-testid]', '[tabindex]',
].join(', ');

async function waitForInteractiveDom(page: Page): Promise<void> {
  const expression = `document.querySelector(${JSON.stringify(INTERACTIVE_SELECTOR)}) !== null`;
  try {
    await page.waitForFunction(expression, undefined, { timeout: 10000 });
  } catch {
    // Một số trang hợp lệ không có control tương tác ở màn hình đầu. Snapshot vẫn
    // được chụp để Planner/Generator có bằng chứng thay vì dừng toàn bộ pipeline.
  }
}

function reportCell(value: unknown): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 120);
}

function elementPriority(element: ElementInfo): number {
  let score = 0;
  if (element.selector) score += 5;
  if (element.placeholder || element.ariaLabel || element.accessibleName) score += 4;
  if (element.testId || element.id || element.name) score += 3;
  if (element.nearbyInputPlaceholder) score += 3;
  if (['input', 'textarea', 'select', 'button', 'svg', 'i'].includes(element.tag)) score += 2;
  return score;
}

export function buildCompactDomReport(
  snapshotsMap: Map<string, DomSnapshot[]>,
  maxElements = 60,
): string {
  const uniqueElements = new Map<string, ElementInfo>();
  let totalSnapshots = 0;

  for (const snapshots of snapshotsMap.values()) {
    totalSnapshots += snapshots.length;
    for (const snapshot of snapshots) {
      for (const element of snapshot.elements) {
        if (!element.isVisible) continue;
        if (!element.selector && !element.placeholder && !element.ariaLabel && !element.text) continue;

        const signature = JSON.stringify([
          element.tag,
          element.type,
          element.role,
          element.accessibleName,
          element.placeholder,
          element.ariaLabel,
          element.text,
          element.testId,
          element.id,
          element.name,
          element.nearbyInputPlaceholder,
          element.labelText,
          element.scopeSelector,
          element.ariaHasPopup,
          element.selector,
        ]);
        if (!uniqueElements.has(signature)) uniqueElements.set(signature, element);
      }
    }
  }

  const selected = [...uniqueElements.values()]
    .sort((left, right) => elementPriority(right) - elementPriority(left))
    .slice(0, maxElements);

  const lines = [
    '# Compact Verified DOM Locator Catalog',
    '',
    `- Snapshots captured: ${totalSnapshots}`,
    `- Unique visible elements: ${uniqueElements.size}`,
    `- Elements included: ${selected.length}`,
    '- Duplicate elements across test cases and states were removed.',
    '',
    '| Tag | Type/Role | Accessible name | Label/Placeholder | Text | Test ID/ID/Name | Scope | Verified selector |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  for (const element of selected) {
    lines.push(`| ${[
      element.tag,
      [element.type, element.role].filter(Boolean).join('/'),
      element.accessibleName || element.ariaLabel,
      element.labelText || element.placeholder,
      element.text,
      element.testId || element.id || element.name,
      element.scopeSelector || element.nearbyInputPlaceholder,
      element.selector,
    ].map(reportCell).join(' | ')} |`);
  }

  return lines.join('\n') + '\n';
}

function locatorCandidates(page: Page, resolution: ResolvedLocator, target: string): Locator[] {
  const element = resolution.element;
  if (element?.selector) return [page.locator(element.selector)];

  switch (resolution.matchedBy) {
    case 'placeholder':
      return element?.placeholder ? [page.getByPlaceholder(element.placeholder, { exact: true })] : [];
    case 'ariaLabel':
      return element?.ariaLabel ? [page.getByLabel(element.ariaLabel, { exact: true })] : [];
    case 'name':
      return element?.name ? [page.locator(`[name="${element.name}"]`)] : [];
    case 'id':
      return element?.id ? [page.locator(`#${element.id}`)] : [];
    case 'role+name':
    case 'link_name': {
      const role = element?.tag === 'a' || element?.role === 'link' ? 'link' : 'button';
      return element?.text ? [page.getByRole(role, { name: element.text.trim(), exact: true })] : [];
    }
    case 'fallback_placeholder':
      return [page.getByPlaceholder(target, { exact: true }), page.getByLabel(target, { exact: true })];
    case 'fallback_role_button':
      return [page.getByRole('button', { name: target, exact: true }), page.getByText(target, { exact: true })];
    case 'fallback_dropdown':
      return [page.getByRole('combobox', { name: target, exact: true }), page.getByText(target, { exact: true })];
    default:
      return [];
  }
}

async function uniqueLocatorFor(
  page: Page,
  stepType: string,
  target: string,
  snapshot: DomSnapshot,
): Promise<Locator> {
  const resolution = resolveLocator(stepType, target, snapshot);
  const candidates = locatorCandidates(page, resolution, target);

  for (const candidate of candidates) {
    try {
      await candidate.first().waitFor({ state: 'attached', timeout: 4000 });
    } catch {
      continue;
    }
    if (await candidate.count() === 1) return candidate;
  }

  throw new Error(`Khong tim thay locator duy nhat cho "${target}" (${resolution.matchedBy})`);
}

async function uniqueLocator(page: Page, step: ParsedStep, snapshot: DomSnapshot): Promise<Locator> {
  return uniqueLocatorFor(page, step.type, step.target || '', snapshot);
}

async function locatorIsUniqueAndVisible(locator: Locator): Promise<boolean> {
  try {
    return await locator.count() === 1 && await locator.isVisible();
  } catch {
    return false;
  }
}

/**
 * Wait for a state-specific control instead of assuming that network-idle means
 * a React drawer, dialog, or portal has finished rendering. The returned
 * snapshot is real DOM evidence and is never used as a guessed locator.
 */
async function waitForVerifiedTarget(
  page: Page,
  stepType: ParsedStep['type'] | 'option',
  target: string,
  afterStep: string,
  timeout = 8000,
): Promise<DomSnapshot> {
  const deadline = Date.now() + timeout;
  let latestSnapshot = await captureSnapshot(page, afterStep);

  while (Date.now() <= deadline) {
    const resolution = resolveLocator(stepType, target, latestSnapshot);
    if (resolution.confidence !== 'low') {
      const candidates = locatorCandidates(page, resolution, target);
      for (const candidate of candidates) {
        if (await locatorIsUniqueAndVisible(candidate)) return latestSnapshot;
      }
    }

    await page.waitForTimeout(200);
    latestSnapshot = await captureSnapshot(page, afterStep);
  }

  const resolution = resolveLocator(stepType, target, latestSnapshot);
  throw new Error(
    `Trang thai moi khong hien thi locator duy nhat cho "${target}" (${resolution.matchedBy})`,
  );
}

export function nextStateStep(
  steps: ParsedStep[],
  currentIndex: number,
): { step: ParsedStep; stepNumber: number } | undefined {
  for (let index = currentIndex + 1; index < steps.length; index++) {
    const step = steps[index];
    if (step.type === 'goto' || step.type === 'check' || step.type === 'wait') return undefined;
    if (step.target) return { step, stepNumber: index + 1 };
  }
  return undefined;
}

function normalizeActionText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function isLoginUrl(value: string): boolean {
  try {
    const pathname = new URL(value).pathname;
    return /(?:^|\/)(?:dang-nhap|login|sign-in)(?:\/|$)/i.test(pathname);
  } catch {
    return /(?:dang-nhap|login|sign-in)/i.test(value);
  }
}

export function protectedGotoAfterLogin(
  steps: ParsedStep[],
  currentIndex: number,
): { step: ParsedStep; stepNumber: number } | undefined {
  const current = steps[currentIndex];
  const target = normalizeActionText(current?.target || '');
  if (!['dang nhap', 'login', 'sign in'].includes(target)) return undefined;

  const next = steps[currentIndex + 1];
  if (next?.type !== 'goto' || !next.url || isLoginUrl(next.url)) return undefined;
  return { step: next, stepNumber: currentIndex + 2 };
}

async function waitForAuthenticationTransition(
  page: Page,
  loginControl: Locator,
  timeout = 15000,
): Promise<void> {
  const deadline = Date.now() + timeout;

  while (Date.now() <= deadline) {
    if (!isLoginUrl(page.url())) return;
    if (!await loginControl.isVisible().catch(() => false)) return;
    await page.waitForTimeout(200);
  }

  throw new Error(
    'AUTHENTICATION_FAILED: URL van o trang dang nhap va form dang nhap van hien thi',
  );
}

async function waitForStateSettled(page: Page): Promise<void> {
  try {
    await page.waitForLoadState('networkidle', { timeout: 8000 });
  } catch {
    // Long-polling applications may never become network-idle.
  }
  await page.waitForTimeout(250);
  await waitForInteractiveDom(page);
}

export function isPotentiallyDestructive(target: string): boolean {
  return /(xóa|xoá|delete|remove|thanh toán|payment|đặt hàng|place order|lưu|save|gửi|send)/iu.test(target);
}

export interface CrawlerFailure {
  testCaseId: string;
  stepNumber: number;
  step: string;
  currentUrl: string;
  reason: string;
}

export function crawlerRunsHeadless(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return String(env.E2E_CRAWLER_HEADLESS ?? 'true').toLowerCase() !== 'false';
}

function writeCrawlerFailures(failures: CrawlerFailure[]): void {
  const artifactsDir = path.join(process.cwd(), 'artifacts');
  if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactsDir, 'crawler-failures.json'),
    JSON.stringify(failures, null, 2) + '\n',
    'utf-8',
  );
}

export async function runLive(testCases: ParsedTestCase[]): Promise<Map<string, DomSnapshot[]>> {
  const snapshotsMap = new Map<string, DomSnapshot[]>();
  const failures: CrawlerFailure[] = [];
  let browser: Browser | null = null;

  try {
    const headless = crawlerRunsHeadless();
    console.log(`[Live Runner] Che do trinh duyet: ${headless ? 'headless' : 'headed'}`);
    browser = await chromium.launch({ headless });

    for (const testCase of testCases) {
      console.log(`[Live Runner] Dang thu thap DOM cho ${testCase.id}...`);
      const snapshots: DomSnapshot[] = [];
      let abortRemainingSteps = false;
      // Mỗi test case có context riêng để cookie/session không rò rỉ sang test khác.
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        for (let index = 0; index < testCase.steps.length; index++) {
          if (abortRemainingSteps) break;
          const step = testCase.steps[index];
          const stepNumber = index + 1;

          try {
            if (step.type === 'goto') {
              if (!step.url) throw new Error('Buoc goto khong co URL');
              await page.goto(step.url, { timeout: 15000, waitUntil: 'domcontentloaded' });
              await waitForStateSettled(page);

              const declaredAuthProbe = index > 0
                ? protectedGotoAfterLogin(testCase.steps, index - 1)
                : undefined;
              if (declaredAuthProbe?.stepNumber === stepNumber && isLoginUrl(page.url())) {
                throw new Error(
                  `AUTHENTICATION_FAILED: website chuyen ve trang dang nhap khi mo ${step.url}`,
                );
              }

              snapshots.push(await captureSnapshot(page, `after step ${stepNumber}: ${step.raw}`));
              continue;
            }

            // Chụp DOM trước hành động để resolver không phải đoán phần tử chưa biết.
            const beforeAction = await captureSnapshot(page, `before step ${stepNumber}: ${step.raw}`);
            snapshots.push(beforeAction);

            if (step.type === 'fill') {
              const locator = await uniqueLocator(page, step, beforeAction);
              await locator.fill(step.value || '', { timeout: 10000 });
            } else if (step.type === 'click') {
              if (isPotentiallyDestructive(step.target || '')) {
                // Resolve the locator from the current DOM but never execute the
                // destructive action. ActionPlan can therefore generate the
                // verified click without the Crawler mutating production data.
                await uniqueLocator(page, step, beforeAction);
                console.warn(`[Live Runner]   VERIFY-ONLY step ${stepNumber}: khong thuc thi hanh dong thay doi du lieu`);
                continue;
              }
              const declaredAuthProbe = protectedGotoAfterLogin(testCase.steps, index);
              const locator = await uniqueLocator(page, step, beforeAction);
              await locator.click({ timeout: 10000 });
              if (declaredAuthProbe) {
                await waitForAuthenticationTransition(page, locator);
              }
              await waitForStateSettled(page);

              const expectedState = nextStateStep(testCase.steps, index);
              if (expectedState) {
                const readySnapshot = await waitForVerifiedTarget(
                  page,
                  expectedState.step.type,
                  expectedState.step.target || '',
                  `ready for step ${expectedState.stepNumber}: ${expectedState.step.raw}`,
                );
                snapshots.push(readySnapshot);
              }
            } else if (step.type === 'select') {
              const locator = await uniqueLocator(page, step, beforeAction);
              if (await locator.evaluate(element => element.tagName.toLowerCase() === 'select')) {
                await locator.selectOption({ label: step.value });
              } else {
                await locator.click({ timeout: 10000 });
                await waitForStateSettled(page);
                const optionSnapshot = await waitForVerifiedTarget(
                  page,
                  'option',
                  step.value || '',
                  `during step ${stepNumber}: options for ${step.raw}`,
                );
                snapshots.push(optionSnapshot);
                const option = await uniqueLocatorFor(
                  page,
                  'option',
                  step.value || '',
                  optionSnapshot,
                );
                await option.click({ timeout: 10000 });
                await waitForStateSettled(page);
              }
            } else if (step.type === 'wait') {
              await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
            }

            if (step.type !== 'check') {
              snapshots.push(await captureSnapshot(page, `after step ${stepNumber}: ${step.raw}`));
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : 'Unknown error';
            failures.push({
              testCaseId: testCase.id,
              stepNumber,
              step: step.raw,
              currentUrl: page.url(),
              reason,
            });
            console.warn(`[Live Runner]   WARNING step ${stepNumber}: ${reason} (URL: ${page.url()})`);
            if (reason.startsWith('AUTHENTICATION_FAILED:')) {
              abortRemainingSteps = true;
              console.warn('[Live Runner]   STOP test case: cac buoc sau can phien dang nhap hop le');
            }
          }
        }
      } finally {
        snapshotsMap.set(testCase.id, snapshots);
        await context.close();
      }
    }
  } finally {
    if (browser) await browser.close();
    writeCrawlerFailures(failures);
  }

  return snapshotsMap;
}
