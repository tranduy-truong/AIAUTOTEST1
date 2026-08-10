import { describe, expect, it } from 'vitest';
import { buildActionPlan } from '../../src/core/action-plan.js';
import type { DomSnapshot } from '../../src/core/locator-resolver.js';
import type { ParsedTestCase } from '../../src/core/step-parser.js';

describe('buildActionPlan', () => {
  it('binds a password-toggle step to the selector verified before that step', () => {
    const testCase: ParsedTestCase = {
      id: 'TC_08',
      name: 'Ẩn hiện mật khẩu',
      url: 'https://example.com/login',
      unparsedSteps: [],
      steps: [
        { type: 'goto', url: 'https://example.com/login', raw: '- Mở URL' },
        { type: 'fill', target: 'Nhập mật khẩu', value: 'secret', raw: "- Nhập 'secret' vào ô 'Nhập mật khẩu'" },
        { type: 'click', target: 'Con mắt ở góc phải ô Mật khẩu', raw: '- Bấm icon con mắt' },
      ],
    };
    const passwordSnapshot: DomSnapshot = {
      url: 'https://example.com/login',
      afterStep: 'before step 2: fill password',
      elements: [{
        tag: 'input',
        placeholder: 'Nhập mật khẩu',
        selector: '#password',
        isVisible: true,
      }],
    };
    const iconSnapshot: DomSnapshot = {
      url: 'https://example.com/login',
      afterStep: 'before step 3: click eye',
      elements: [{
        tag: 'svg',
        className: 'eye-icon',
        ariaLabel: 'Hiện mật khẩu',
        nearbyInputPlaceholder: 'Nhập mật khẩu',
        selector: 'button.password-toggle',
        isVisible: true,
      }],
    };

    const plan = buildActionPlan(
      [testCase],
      new Map([['TC_08', [passwordSnapshot, iconSnapshot]]]),
      { persist: false },
    );
    const click = plan.testCases[0].actions.find(action => action.type === 'click');

    expect(click).toMatchObject({
      playwrightCode: "await page.locator('button.password-toggle').click();",
      confidence: 'high',
      matchedBy: 'dom_icon_metadata',
      verifiedSelector: 'button.password-toggle',
    });
  });

  it('compiles every compound message as a separate exact assertion', () => {
    const testCase: ParsedTestCase = {
      id: 'TC_07',
      name: 'Bỏ trống hai trường',
      url: 'https://example.com/login',
      unparsedSteps: [],
      steps: [
        { type: 'goto', url: 'https://example.com/login', raw: '- Mở URL' },
        {
          type: 'check',
          assertion: 'Có cả 2 thông báo "Vui lòng nhập tên đăng nhập" và "Vui lòng nhập mật khẩu"',
          assertions: [
            { kind: 'text_visible', value: 'Vui lòng nhập tên đăng nhập' },
            { kind: 'text_visible', value: 'Vui lòng nhập mật khẩu' },
          ],
          raw: '- Kiểm tra hai thông báo',
        },
      ],
    };

    const plan = buildActionPlan([testCase], new Map(), { persist: false });
    const check = plan.testCases[0].actions[1];

    expect(check.confidence).toBe('high');
    expect(check.matchedBy).toBe('structured_assertions');
    expect(check.playwrightCode).toContain("getByText('Vui lòng nhập tên đăng nhập', { exact: true })");
    expect(check.playwrightCode).toContain("getByText('Vui lòng nhập mật khẩu', { exact: true })");
    expect(check.playwrightCode).not.toContain("locator('body')");
  });
});
