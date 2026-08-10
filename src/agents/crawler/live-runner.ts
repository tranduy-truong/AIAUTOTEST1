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
import {
  findLearnedLocator,
  forgetLearnedLocator,
  loadLocatorRegistry,
  LocatorRegistry,
  rememberLearnedLocator,
  saveLocatorRegistry,
} from './locator-registry.js';

interface GuidedChoice extends Partial<ElementInfo> {
  selector: string;
  tag: string;
}

interface LocatorRuntime {
  registry: LocatorRegistry;
  guided: boolean;
}

export interface CrawlerGuidanceContext {
  testCaseId: string;
  testCaseName: string;
  testCasePosition: number;
  totalTestCases: number;
  stepNumber: number;
  totalSteps: number;
  stepDescription: string;
}

const GUIDED_RESULT_KEY = '__AI_TEST_GUIDED_PICK_RESULT__';

export function guidedPickScript(
  instruction: string,
  context?: CrawlerGuidanceContext,
): string {
  const bannerText = context
    ? [
        'CRAWLER CẦN XÁC NHẬN PHẦN TỬ',
        `Test case: ${context.testCaseId} - ${context.testCaseName} (${context.testCasePosition}/${context.totalTestCases})`,
        `Bước: ${context.stepNumber}/${context.totalSteps}`,
        `Nội dung: ${context.stepDescription}`,
        `Cần chọn: ${instruction}`,
        'Hãy click đúng phần tử. Nhấn ESC để hủy.',
      ].join('\n')
    : `CRAWLER CẦN XÁC NHẬN: Click đúng phần tử cho "${instruction}". Nhấn ESC để hủy.`;
  return String.raw`
    (() => {
      const resultKey = ${JSON.stringify(GUIDED_RESULT_KEY)};
      globalThis[resultKey] = null;
      const oldBanner = document.getElementById('__ai-test-guided-banner__');
      if (oldBanner) oldBanner.remove();

      const banner = document.createElement('div');
      banner.id = '__ai-test-guided-banner__';
      banner.textContent = ${JSON.stringify(bannerText)};
      banner.style.cssText = [
        'position:fixed', 'top:12px', 'left:50%', 'transform:translateX(-50%)',
        'z-index:2147483647', 'background:#7f1d1d', 'color:white',
        'padding:14px 18px', 'border-radius:8px', 'font:600 14px/1.5 sans-serif',
        'box-shadow:0 4px 20px rgba(0,0,0,.35)', 'width:min(760px,calc(100vw - 32px))',
        'white-space:pre-line', 'text-align:left',
      ].join(';');
      document.documentElement.appendChild(banner);

      function escapeCss(value) {
        if (globalThis.CSS && typeof globalThis.CSS.escape === 'function') return globalThis.CSS.escape(value);
        return String(value).replace(/[^a-zA-Z0-9_-]/g, function (character) { return '\\' + character; });
      }

      function escapeAttribute(value) {
        return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      }

      function unique(selector) {
        try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
      }

      function stableId(value) {
        return value && !/base-ui|_r_|[a-f0-9]{10,}|^\d+$/i.test(value);
      }

      function selectorFor(element) {
        const tag = element.tagName.toLowerCase();
        const testId = element.getAttribute('data-testid');
        if (testId) return '[data-testid="' + escapeAttribute(testId) + '"]';
        if (stableId(element.id)) return '#' + escapeCss(element.id);

        const placeholder = element.getAttribute('placeholder');
        if (placeholder) {
          const selector = tag + '[placeholder="' + escapeAttribute(placeholder) + '"]';
          if (unique(selector)) return selector;
        }

        const name = element.getAttribute('name');
        if (name) {
          const selector = tag + '[name="' + escapeAttribute(name) + '"]';
          if (unique(selector)) return selector;
        }

        const ariaLabel = element.getAttribute('aria-label');
        if (ariaLabel) {
          const selector = '[aria-label="' + escapeAttribute(ariaLabel) + '"]';
          if (unique(selector)) return selector;
        }

        const dataSlot = element.getAttribute('data-slot');
        const dataValue = element.getAttribute('data-value');
        if (dataSlot && dataValue) {
          const selector = '[data-slot="' + escapeAttribute(dataSlot) + '"][data-value="' + escapeAttribute(dataValue) + '"]';
          if (unique(selector)) return selector;
        }

        const path = [];
        let current = element;
        while (current && current !== document.body && path.length < 8) {
          if (stableId(current.id)) {
            path.unshift('#' + escapeCss(current.id));
            break;
          }
          const currentTag = current.tagName.toLowerCase();
          const siblings = current.parentElement
            ? Array.from(current.parentElement.children).filter(function (sibling) {
                return sibling.tagName === current.tagName;
              })
            : [];
          const position = siblings.length > 1
            ? ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')'
            : '';
          path.unshift(currentTag + position);
          current = current.parentElement;
        }
        return path.join(' > ');
      }

      function cleanup() {
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKeyDown, true);
        banner.remove();
      }

      function onKeyDown(event) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        cleanup();
        globalThis[resultKey] = { cancelled: true };
      }

      function onClick(event) {
        if (banner.contains(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const clicked = event.target;
        const element = clicked.closest(
          'input, textarea, select, option, button, a[href], [role], [data-testid], [data-slot], [data-value], [contenteditable], [onclick], [tabindex]'
        ) || clicked;
        const selector = selectorFor(element);
        const scope = element.closest('dialog, [role="dialog"], [aria-modal="true"], form, [data-slot="sheet-content"], [class*="drawer"], [class*="modal"]');
        cleanup();
        globalThis[resultKey] = {
          cancelled: false,
          selector,
          tag: element.tagName.toLowerCase(),
          type: element.type || undefined,
          role: element.getAttribute('role') || undefined,
          placeholder: element.getAttribute('placeholder') || undefined,
          ariaLabel: element.getAttribute('aria-label') || undefined,
          text: (element.textContent || '').trim().substring(0, 100),
          testId: element.getAttribute('data-testid') || undefined,
          dataSlot: element.getAttribute('data-slot') || undefined,
          dataValue: element.getAttribute('data-value') || undefined,
          id: element.id || undefined,
          name: element.getAttribute('name') || undefined,
          className: (element.getAttribute('class') || '').substring(0, 120) || undefined,
          title: element.getAttribute('title') || undefined,
          accessibleName: element.getAttribute('aria-label') || (element.textContent || '').trim().substring(0, 100) || undefined,
          ariaHasPopup: element.getAttribute('aria-haspopup') || undefined,
          scopeSelector: scope ? selectorFor(scope) : undefined,
          isVisible: true,
        };
      }

      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKeyDown, true);
    })()
  `;
}

// Dùng chuỗi JavaScript thuần để đoạn code chạy trong browser không bị tsx/esbuild
// chèn helper nội bộ (ví dụ __name) mà Playwright không thể serialize sang page.
export const CAPTURE_SNAPSHOT_SCRIPT = String.raw`
  (() => {
    const query = [
      'input', 'textarea', 'select', 'option', 'button', 'a[href]', 'label', 'svg', 'i',
      '[role]', '[aria-label]', '[aria-haspopup]', '[data-testid]', '[data-slot]', '[data-value]', '[title]',
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
      const isDirectTarget = source.matches('input, textarea, select, option, button, a[href], label, [role], [contenteditable], [data-testid], [data-slot], [data-value], [aria-label], [tabindex]');
      const interactive = isDirectTarget
        ? source
        : source.closest('button, a, select, [role="button"], [role="link"], [role="combobox"], [role="option"], [role="menuitem"], [onclick], [tabindex]') || source;
      const testId = interactive.getAttribute('data-testid');
      if (testId) return '[data-testid="' + escapeCss(testId) + '"]';
      if (interactive.id) return '#' + escapeCss(interactive.id);

      const dataSlot = interactive.getAttribute('data-slot');
      const dataValue = interactive.getAttribute('data-value');
      if (dataSlot && dataValue) {
        const selector = '[data-slot="' + dataSlot.replace(/"/g, '\\"') + '"][data-value="' + dataValue.replace(/"/g, '\\"') + '"]';
        if (document.querySelectorAll(selector).length === 1) return selector;
      }

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
        dataSlot: node.getAttribute('data-slot') || (interactive && interactive.getAttribute('data-slot')) || undefined,
        dataValue: node.getAttribute('data-value') || (interactive && interactive.getAttribute('data-value')) || undefined,
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
          element.dataSlot,
          element.dataValue,
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

function escapeSingleQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function annotateGuidedBinding(
  snapshot: DomSnapshot,
  stepType: string,
  target: string,
  selector: string,
  metadata: Partial<ElementInfo> = {},
): void {
  const existing = snapshot.elements.find(element => element.selector === selector);
  const binding: ElementInfo = existing || {
    tag: metadata.tag || 'learned',
    selector,
    isVisible: true,
  };
  Object.assign(binding, metadata, {
    selector,
    isVisible: true,
    learnedStepType: stepType,
    learnedTarget: target,
    learnedLocator: `page.locator('${escapeSingleQuoted(selector)}')`,
  });
  if (!existing) snapshot.elements.push(binding);
}

async function pickGuidedLocator(
  page: Page,
  stepType: string,
  target: string,
  guidance?: CrawlerGuidanceContext,
): Promise<GuidedChoice> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const location = guidance
      ? `${guidance.testCaseId} (${guidance.testCasePosition}/${guidance.totalTestCases}), ` +
        `step ${guidance.stepNumber}/${guidance.totalSteps}: ${guidance.stepDescription}`
      : 'không có ngữ cảnh bước';
    console.log(
      `[Crawler] Cần xác nhận tại ${location}. Không tự xác minh được "${target}". ` +
      `Hãy click đúng phần tử trên browser (lần ${attempt}/3, ESC để hủy).`,
    );
    await page.evaluate(guidedPickScript(`${stepType}: ${target}`, guidance));
    await page.waitForFunction(
      `globalThis[${JSON.stringify(GUIDED_RESULT_KEY)}] !== null`,
      undefined,
      { timeout: 120000 },
    );
    const result = await page.evaluate(
      `globalThis[${JSON.stringify(GUIDED_RESULT_KEY)}]`,
    ) as (GuidedChoice & { cancelled?: boolean }) | null;

    if (!result || result.cancelled) {
      throw new Error(`Crawler da huy viec hoc locator cho "${target}"`);
    }
    if (!result.selector) continue;

    const locator = page.locator(result.selector);
    if (await locatorIsUniqueAndVisible(locator)) {
      console.log(`[Crawler] Đã ghi nhớ locator cho "${target}": ${result.selector}`);
      return result;
    }
    console.warn(`[Crawler] Locator chưa duy nhất/hiển thị, vui lòng chọn lại.`);
  }

  throw new Error(`Crawler khong hoc duoc locator duy nhat cho "${target}"`);
}

async function learnGuidedLocatorFor(
  page: Page,
  stepType: string,
  target: string,
  snapshot: DomSnapshot,
  runtime: LocatorRuntime,
  context?: string,
  guidance?: CrawlerGuidanceContext,
): Promise<Locator> {
  const choice = await pickGuidedLocator(page, stepType, target, guidance);
  rememberLearnedLocator(runtime.registry, {
    pageUrl: page.url(),
    stepType,
    target,
    context,
    selector: choice.selector,
  });
  saveLocatorRegistry(runtime.registry);
  annotateGuidedBinding(snapshot, stepType, target, choice.selector, choice);
  return page.locator(choice.selector);
}

async function uniqueLocatorFor(
  page: Page,
  stepType: string,
  target: string,
  snapshot: DomSnapshot,
  runtime: LocatorRuntime,
  context?: string,
  guidance?: CrawlerGuidanceContext,
): Promise<Locator> {
  const learned = findLearnedLocator(
    runtime.registry,
    page.url(),
    stepType,
    target,
    context,
  );
  if (learned) {
    const learnedLocator = page.locator(learned.selector);
    if (await locatorIsUniqueAndVisible(learnedLocator)) {
      learned.lastVerifiedAt = new Date().toISOString();
      annotateGuidedBinding(snapshot, stepType, target, learned.selector);
      saveLocatorRegistry(runtime.registry);
      console.log(`[Crawler] Dùng locator đã ghi nhớ cho "${target}".`);
      return learnedLocator;
    }
    forgetLearnedLocator(runtime.registry, learned);
    saveLocatorRegistry(runtime.registry);
    console.warn(`[Crawler] Locator cũ của "${target}" đã hỏng; cần xác nhận lại.`);
  }

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

  if (runtime.guided) {
    return learnGuidedLocatorFor(page, stepType, target, snapshot, runtime, context, guidance);
  }

  throw new Error(`Khong tim thay locator duy nhat cho "${target}" (${resolution.matchedBy})`);
}

async function uniqueLocator(
  page: Page,
  step: ParsedStep,
  snapshot: DomSnapshot,
  runtime: LocatorRuntime,
  guidance?: CrawlerGuidanceContext,
): Promise<Locator> {
  return uniqueLocatorFor(page, step.type, step.target || '', snapshot, runtime, undefined, guidance);
}

export function describeStepForGuidance(step: ParsedStep): string {
  switch (step.type) {
    case 'fill':
      return `Nhập dữ liệu vào ô "${step.target || 'không xác định'}"`;
    case 'select':
      return `Chọn "${step.value || 'không xác định'}" trong dropdown "${step.target || 'không xác định'}"`;
    case 'click':
      return `Bấm "${step.target || 'không xác định'}"`;
    case 'goto':
      return `Mở URL ${step.url || ''}`;
    case 'check':
      return 'Kiểm tra kết quả mong đợi';
    case 'wait':
      return 'Chờ trang sẵn sàng';
  }
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

  let nextIndex = currentIndex + 1;
  while (
    nextIndex < steps.length &&
    (steps[nextIndex].type === 'wait' || steps[nextIndex].type === 'check')
  ) {
    nextIndex++;
  }

  const next = steps[nextIndex];
  if (next?.type !== 'goto' || !next.url || isLoginUrl(next.url)) return undefined;
  return { step: next, stepNumber: nextIndex + 1 };
}

export function loginStepBeforeProtectedGoto(
  steps: ParsedStep[],
  gotoIndex: number,
): { step: ParsedStep; stepNumber: number } | undefined {
  let loginIndex = gotoIndex - 1;
  while (
    loginIndex >= 0 &&
    (steps[loginIndex].type === 'wait' || steps[loginIndex].type === 'check')
  ) {
    loginIndex--;
  }
  if (loginIndex < 0) return undefined;

  const protectedGoto = protectedGotoAfterLogin(steps, loginIndex);
  if (protectedGoto?.stepNumber !== gotoIndex + 1) return undefined;
  return { step: steps[loginIndex], stepNumber: loginIndex + 1 };
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

export function guidedLearningEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return String(env.E2E_GUIDED_LEARNING ?? 'true').toLowerCase() !== 'false';
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
  const registry = loadLocatorRegistry();
  const guided = guidedLearningEnabled();
  const runtime: LocatorRuntime = { registry, guided };
  let browser: Browser | null = null;

  try {
    const headless = guided ? false : crawlerRunsHeadless();
    if (guided) console.log('[Live Runner] Crawler co the yeu cau xac nhan locator khi can.');
    console.log(`[Live Runner] Che do trinh duyet: ${headless ? 'headless' : 'headed'}`);
    browser = await chromium.launch({ headless });

    for (const [testCaseIndex, testCase] of testCases.entries()) {
      console.log(
        `[Live Runner] Dang thu thap DOM cho ${testCase.id} - ${testCase.name} ` +
        `(${testCaseIndex + 1}/${testCases.length})...`,
      );
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
          const guidance: CrawlerGuidanceContext = {
            testCaseId: testCase.id,
            testCaseName: testCase.name,
            testCasePosition: testCaseIndex + 1,
            totalTestCases: testCases.length,
            stepNumber,
            totalSteps: testCase.steps.length,
            stepDescription: describeStepForGuidance(step),
          };

          try {
            if (step.type === 'goto') {
              if (!step.url) throw new Error('Buoc goto khong co URL');
              await page.goto(step.url, { timeout: 15000, waitUntil: 'domcontentloaded' });
              await waitForStateSettled(page);

              const declaredAuthProbe = index > 0
                ? loginStepBeforeProtectedGoto(testCase.steps, index)
                : undefined;
              if (declaredAuthProbe && isLoginUrl(page.url())) {
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
              const locator = await uniqueLocator(page, step, beforeAction, runtime, guidance);
              await locator.fill(step.value || '', { timeout: 10000 });
            } else if (step.type === 'click') {
              if (isPotentiallyDestructive(step.target || '')) {
                // Resolve the locator from the current DOM but never execute the
                // destructive action. ActionPlan can therefore generate the
                // verified click without the Crawler mutating production data.
                await uniqueLocator(page, step, beforeAction, runtime, guidance);
                console.warn(`[Live Runner]   VERIFY-ONLY step ${stepNumber}: khong thuc thi hanh dong thay doi du lieu`);
                continue;
              }
              const declaredAuthProbe = protectedGotoAfterLogin(testCase.steps, index);
              const locator = await uniqueLocator(page, step, beforeAction, runtime, guidance);
              await locator.click({ timeout: 10000 });
              if (declaredAuthProbe) {
                console.log(`[Live Runner]   Dang cho website xac nhan dang nhap tai step ${stepNumber}...`);
                await waitForAuthenticationTransition(page, locator);
                console.log(`[Live Runner]   Da xac nhan trang dang nhap ket thuc tai step ${stepNumber}.`);
              }
              await waitForStateSettled(page);

              const expectedState = nextStateStep(testCase.steps, index);
              if (expectedState) {
                let readySnapshot: DomSnapshot;
                try {
                  readySnapshot = await waitForVerifiedTarget(
                    page,
                    expectedState.step.type,
                    expectedState.step.target || '',
                    `ready for step ${expectedState.stepNumber}: ${expectedState.step.raw}`,
                  );
                } catch (error) {
                  if (!guided) throw error;
                  console.warn(
                    `[Crawler] Trạng thái kế tiếp chưa tự xác minh được; ` +
                    `sẽ yêu cầu chọn phần tử ở step ${expectedState.stepNumber}.`,
                  );
                  readySnapshot = await captureSnapshot(
                    page,
                    `ready for guided step ${expectedState.stepNumber}: ${expectedState.step.raw}`,
                  );
                }
                snapshots.push(readySnapshot);
              }
            } else if (step.type === 'select') {
              let locator = await uniqueLocator(page, step, beforeAction, runtime, guidance);
              if (await locator.evaluate(element => element.tagName.toLowerCase() === 'select')) {
                await locator.selectOption({ label: step.value });
              } else {
                await locator.click({ timeout: 10000 });
                await waitForStateSettled(page);
                let optionSnapshot: DomSnapshot;
                try {
                  optionSnapshot = await waitForVerifiedTarget(
                    page,
                    'option',
                    step.value || '',
                    `during step ${stepNumber}: options for ${step.raw}`,
                    2500,
                  );
                } catch (error) {
                  if (!guided) throw error;

                  // The automatically resolved trigger did not reveal the
                  // requested option. Close any wrong popup, learn the actual
                  // trigger, then execute that learned click ourselves. This
                  // prevents a manual browser click from silently making a bad
                  // Action Plan appear valid.
                  console.warn(
                    `[Crawler] Trigger tự động của "${step.target}" không mở đúng danh sách; ` +
                    `cần chọn lại chính dropdown này.`,
                  );
                  await page.keyboard.press('Escape').catch(() => undefined);
                  locator = await learnGuidedLocatorFor(
                    page,
                    'select',
                    step.target || '',
                    beforeAction,
                    runtime,
                    undefined,
                    guidance,
                  );
                  await locator.click({ timeout: 10000 });
                  await waitForStateSettled(page);

                  try {
                    optionSnapshot = await waitForVerifiedTarget(
                      page,
                      'option',
                      step.value || '',
                      `during step ${stepNumber}: options after guided trigger for ${step.raw}`,
                      5000,
                    );
                  } catch {
                    optionSnapshot = await captureSnapshot(
                      page,
                      `during step ${stepNumber}: guided options for ${step.raw}`,
                    );
                  }
                }
                snapshots.push(optionSnapshot);
                const option = await uniqueLocatorFor(
                  page,
                  'option',
                  step.value || '',
                  optionSnapshot,
                  runtime,
                  step.target,
                  guidance,
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
