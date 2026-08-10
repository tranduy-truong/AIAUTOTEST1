import fs from 'fs';
import path from 'path';
import { ParsedAssertion, ParsedTestCase, ParsedStep, parseAssertions } from './step-parser.js';
import { DomSnapshot, resolveLocator } from './locator-resolver.js';

export interface ResolvedAction {
  stepIndex: number;
  type: ParsedStep['type'];
  playwrightCode: string;
  description: string;
  confidence: 'high' | 'medium' | 'low';
  matchedBy?: string;
  verifiedSelector?: string;
  assertions?: ParsedAssertion[];
}

export interface ActionPlan {
  testCases: {
    id: string;
    name: string;
    baseUrl: string;
    needsLogin: boolean;
    actions: ResolvedAction[];
  }[];
}

export function buildActionPlan(
  parsedCases: ParsedTestCase[],
  snapshotsMap: Map<string, DomSnapshot[]>,
  options: { persist?: boolean } = {},
): ActionPlan {
  const plan: ActionPlan = { testCases: [] };

  for (const testCase of parsedCases) {
    const snapshots = snapshotsMap.get(testCase.id) || [];
    const actions: ResolvedAction[] = [];

    testCase.steps.forEach((step, index) => {
      const stepIndex = index + 1;
      let playwrightCode = '';
      let confidence: 'high' | 'medium' | 'low' = 'high';
      let matchedBy: string | undefined;
      let verifiedSelector: string | undefined;
      const currentSnapshot = snapshots.find(snapshot =>
        snapshot.afterStep.startsWith(`before step ${stepIndex}:`) ||
        snapshot.afterStep.startsWith(`after step ${stepIndex}:`),
      ) || snapshots
        .filter(snapshot => {
          const match = snapshot.afterStep.match(/(?:before|after) step (\d+):/);
          return match ? Number(match[1]) < stepIndex : false;
        })
        .at(-1);
      
      switch (step.type) {
        case 'goto':
          playwrightCode = `await page.goto('${escapeSingleQuoted(step.url || '')}', { waitUntil: 'domcontentloaded' });`;
          break;

        case 'fill': {
          const fillRes = resolveLocator('fill', step.target || '', currentSnapshot);
          const safeFillVal = escapeSingleQuoted(step.value || '');
          playwrightCode = `await ${fillRes.locator || 'page.locator("unknown")'}.fill('${safeFillVal}');`;
          confidence = fillRes.confidence || 'medium';
          matchedBy = fillRes.matchedBy;
          verifiedSelector = fillRes.element?.selector;
          break;
        }

        case 'click': {
          const clickRes = resolveLocator('click', step.target || '', currentSnapshot);
          playwrightCode = `await ${clickRes.locator || 'page.locator("unknown")'}.click();`;
          confidence = clickRes.confidence || 'medium';
          matchedBy = clickRes.matchedBy;
          verifiedSelector = clickRes.element?.selector;
          break;
        }

        case 'select':
          const safeSelectTarget = (step.target || '').replace(/'/g, "\\'");
          const safeSelectValue = (step.value || '').replace(/'/g, "\\'");
          playwrightCode = `await page.getByText('${safeSelectTarget}').or(page.getByRole('combobox', { name: '${safeSelectTarget}' })).first().click();\nawait page.getByRole('option', { name: '${safeSelectValue}' }).first().click();`;
          confidence = 'medium';
          break;

        case 'check': {
          const assertions = step.assertions?.length
            ? step.assertions
            : parseAssertions(step.assertion || '');
          const compiled = assertions.map(compileAssertion);
          playwrightCode = compiled.map(result => result.code).join('\n');
          confidence = compiled.some(result => result.confidence === 'low') ? 'low' : 'high';
          matchedBy = confidence === 'high' ? 'structured_assertions' : 'unresolved_assertion';
          break;
        }

        case 'wait':
          playwrightCode = `await page.waitForLoadState('domcontentloaded');`;
          break;
      }

      actions.push({
        stepIndex,
        type: step.type,
        playwrightCode,
        description: step.raw || step.target || '',
        confidence,
        matchedBy,
        verifiedSelector,
        assertions: step.type === 'check'
          ? (step.assertions?.length ? step.assertions : parseAssertions(step.assertion || ''))
          : undefined,
      });
    });

    // Quyết định needsLogin: Chỉ cần khi TC đến trang quản trị (không phải trang login)
    const tcUrl = testCase.steps.find(s => s.type === 'goto')?.url || testCase.url || '';
    const isLoginUrl = !tcUrl || /dang-nhap|login/i.test(tcUrl);
    const needsLogin = !isLoginUrl;

    plan.testCases.push({
      id: testCase.id,
      name: testCase.name || testCase.id,
      baseUrl: tcUrl,
      needsLogin,
      actions
    });
  }

  if (options.persist !== false) {
    const artifactsDir = path.join(process.cwd(), 'artifacts');
    if (!fs.existsSync(artifactsDir)) {
        fs.mkdirSync(artifactsDir, { recursive: true });
    }
    fs.writeFileSync(path.join(artifactsDir, 'action-plan.json'), JSON.stringify(plan, null, 2), 'utf-8');
  }

  return plan;
}

function escapeSingleQuoted(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function compileAssertion(assertion: ParsedAssertion): {
  code: string;
  confidence: 'high' | 'low';
} {
  const value = escapeSingleQuoted(assertion.value);

  switch (assertion.kind) {
    case 'text_visible':
      return {
        code: `await expect(page.getByText('${value}', { exact: true })).toBeVisible();`,
        confidence: 'high',
      };
    case 'url_contains':
      return {
        code: `await expect(page).toHaveURL(/.*${escapeRegex(assertion.value)}.*/i);`,
        confidence: 'high',
      };
    case 'url_not_contains':
      return {
        code: `await expect(page).not.toHaveURL(/.*${escapeRegex(assertion.value)}.*/i);`,
        confidence: 'high',
      };
    case 'attribute':
      return {
        code: `await expect(page.getByPlaceholder('Nhập mật khẩu')).toHaveAttribute('type', '${assertion.value}');`,
        confidence: 'high',
      };
    case 'unknown':
      return {
        code: `test.fixme(true, 'Planner chưa hiểu assertion: ${value}');`,
        confidence: 'low',
      };
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '\\/');
}

/**
 * Sinh mã nguồn Playwright (.spec.ts) từ ActionPlan đã xác thực.
 */
export function generateSpecFromActionPlan(plan: ActionPlan): string {
  const lines: string[] = [];

  lines.push("import { test, expect } from '@playwright/test';");
  lines.push("");

  // Lấy BASE_URL từ test case đầu tiên
  const firstUrl = plan.testCases[0]?.baseUrl || "about:blank";
  lines.push(`const BASE_URL = '${firstUrl}';`);
  lines.push("");

  // Kiểm tra xem có cần login helper dùng chung không
  const needsLoginHelper = plan.testCases.some((tc, idx) => idx > 0 && tc.needsLogin);
  if (needsLoginHelper) {
    const loginTC = plan.testCases.find(tc => tc.id === 'TC_01' || tc.needsLogin) || plan.testCases[0];
    lines.push("// Helper đăng nhập dùng chung cho các test case cần phiên quản trị");
    lines.push("async function login(page: any) {");
    lines.push(`  await page.goto(BASE_URL);`);
    
    loginTC.actions.forEach(action => {
      if (action.type === 'fill' || action.type === 'click') {
        const actionLines = action.playwrightCode.split('\n');
        actionLines.forEach(l => lines.push(`  ${l}`));
      }
    });
    lines.push("  await page.waitForLoadState('domcontentloaded');");
    lines.push("}");
    lines.push("");
  }

  lines.push("test.describe('E2E Test Suite', () => {");

  plan.testCases.forEach((tc, idx) => {
    lines.push(`  test('${tc.id} - ${tc.name.replace(/'/g, "\\'")}', async ({ page }) => {`);

    if (idx > 0 && tc.needsLogin && needsLoginHelper) {
      lines.push("    // Tự động đăng nhập trước khi thực hiện nghiệp vụ");
      lines.push("    await login(page);");
      lines.push("");
    }

    tc.actions.forEach(action => {
      if (action.description) {
        lines.push(`    // ${action.description}`);
      }
      const codeLines = action.playwrightCode.split('\n');
      codeLines.forEach(codeLine => {
        if (codeLine.trim()) {
          lines.push(`    ${codeLine.trim()}`);
        }
      });
    });

    lines.push("  });");
    lines.push("");
  });

  lines.push("});");
  lines.push("");

  return lines.join('\n');
}
