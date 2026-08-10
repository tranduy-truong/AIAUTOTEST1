import { chromium, Browser, Locator, Page } from 'playwright';
import { ParsedStep, ParsedTestCase } from '../../core/step-parser.js';
import {
  DomSnapshot,
  ElementInfo,
  ResolvedLocator,
  resolveLocator,
} from '../../core/locator-resolver.js';

async function captureSnapshot(page: Page, afterStep: string): Promise<DomSnapshot> {
  const elements = await page.evaluate(() => {
    const query = [
      'input', 'textarea', 'select', 'button', 'a[href]', 'label', 'svg', 'i',
      '[role]', '[aria-label]', '[data-testid]', '[title]',
    ].join(', ');
    const nodes = Array.from(document.querySelectorAll(query));

    const escapeCss = (value: string) => {
      if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
      return value.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`);
    };

    const uniqueSelector = (source: Element): string | undefined => {
      const interactive = source.closest('button, a, [role="button"], [role="link"]') || source;
      const testId = interactive.getAttribute('data-testid');
      if (testId) return `[data-testid="${escapeCss(testId)}"]`;
      if (interactive.id) return `#${escapeCss(interactive.id)}`;

      const ariaLabel = interactive.getAttribute('aria-label');
      if (ariaLabel) return `[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]`;

      const name = interactive.getAttribute('name');
      const tag = interactive.tagName.toLowerCase();
      if (name) {
        const selector = `${tag}[name="${name.replace(/"/g, '\\"')}"]`;
        if (document.querySelectorAll(selector).length === 1) return selector;
      }

      const classes = (interactive.getAttribute('class') || '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 4)
        .map(className => `.${escapeCss(className)}`)
        .join('');
      if (classes) {
        const selector = `${tag}${classes}`;
        if (document.querySelectorAll(selector).length === 1) return selector;
      }

      const path: string[] = [];
      let current: Element | null = interactive;
      while (current && current !== document.body && path.length < 5) {
        const currentTag = current.tagName.toLowerCase();
        const siblings = current.parentElement
          ? Array.from(current.parentElement.children).filter(child => child.tagName === current!.tagName)
          : [];
        const position = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : '';
        path.unshift(`${currentTag}${position}`);
        current = current.parentElement;
      }
      return path.length ? path.join(' > ') : undefined;
    };

    return nodes.map(node => {
      const htmlNode = node as HTMLElement;
      const interactive = node.closest('button, a, [role="button"], [role="link"]');
      let ancestor: Element | null = node;
      let nearbyInput: HTMLInputElement | null = null;
      for (let depth = 0; ancestor && depth < 5 && !nearbyInput; depth++) {
        nearbyInput = ancestor.querySelector('input') as HTMLInputElement | null;
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

      return {
        tag: node.tagName.toLowerCase(),
        type: (node as HTMLInputElement).type || undefined,
        role: node.getAttribute('role') || interactive?.getAttribute('role') || undefined,
        placeholder: node.getAttribute('placeholder') || undefined,
        ariaLabel: node.getAttribute('aria-label') || interactive?.getAttribute('aria-label') || undefined,
        text: (node.textContent || '').trim().substring(0, 100),
        testId: node.getAttribute('data-testid') || interactive?.getAttribute('data-testid') || undefined,
        id: node.id || interactive?.id || undefined,
        name: (node as HTMLInputElement).name || undefined,
        className: (node.getAttribute('class') || interactive?.getAttribute('class') || '').substring(0, 120) || undefined,
        title: node.getAttribute('title') || interactive?.getAttribute('title') || undefined,
        accessibleName,
        nearbyInputPlaceholder: nearbyInput?.placeholder || nearbyInput?.name || undefined,
        selector: uniqueSelector(node),
        isVisible,
      };
    });
  });

  return { url: page.url(), afterStep, elements: elements as ElementInfo[] };
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

async function uniqueLocator(page: Page, step: ParsedStep, snapshot: DomSnapshot): Promise<Locator> {
  const target = step.target || '';
  const resolution = resolveLocator(step.type, target, snapshot);
  const candidates = locatorCandidates(page, resolution, target);

  for (const candidate of candidates) {
    if (await candidate.count() === 1) return candidate;
  }

  throw new Error(`Khong tim thay locator duy nhat cho "${target}" (${resolution.matchedBy})`);
}

function isPotentiallyDestructive(target: string): boolean {
  return /(xóa|xoá|delete|remove|thanh toán|payment|đặt hàng|place order|lưu|save|gửi|send)/iu.test(target);
}

export async function runLive(testCases: ParsedTestCase[]): Promise<Map<string, DomSnapshot[]>> {
  const snapshotsMap = new Map<string, DomSnapshot[]>();
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: true });

    for (const testCase of testCases) {
      console.log(`[Live Runner] Dang thu thap DOM cho ${testCase.id}...`);
      const snapshots: DomSnapshot[] = [];
      // Mỗi test case có context riêng để cookie/session không rò rỉ sang test khác.
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        for (let index = 0; index < testCase.steps.length; index++) {
          const step = testCase.steps[index];
          const stepNumber = index + 1;

          try {
            if (step.type === 'goto') {
              if (!step.url) throw new Error('Buoc goto khong co URL');
              await page.goto(step.url, { timeout: 15000, waitUntil: 'domcontentloaded' });
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
                console.warn(`[Live Runner]   SKIP step ${stepNumber}: hanh dong co the thay doi du lieu`);
                continue;
              }
              const locator = await uniqueLocator(page, step, beforeAction);
              await locator.click({ timeout: 10000 });
              await page.waitForTimeout(500);
            } else if (step.type === 'select') {
              const locator = await uniqueLocator(page, step, beforeAction);
              if (await locator.evaluate(element => element.tagName.toLowerCase() === 'select')) {
                await locator.selectOption({ label: step.value });
              } else {
                await locator.click({ timeout: 10000 });
                const option = page.getByRole('option', { name: step.value || '', exact: true });
                if (await option.count() !== 1) throw new Error(`Option "${step.value}" khong duy nhat`);
                await option.click({ timeout: 10000 });
              }
            } else if (step.type === 'wait') {
              await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
            }

            if (step.type !== 'check') {
              snapshots.push(await captureSnapshot(page, `after step ${stepNumber}: ${step.raw}`));
            }
          } catch (error) {
            console.warn(`[Live Runner]   WARNING step ${stepNumber}: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }
      } finally {
        snapshotsMap.set(testCase.id, snapshots);
        await context.close();
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  return snapshotsMap;
}
