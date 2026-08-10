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

  it('reuses verified locator evidence from another test case on the same URL', () => {
    const verifiedCase: ParsedTestCase = {
      id: 'TC_01',
      name: 'Đăng nhập thành công',
      url: 'https://example.com/login',
      unparsedSteps: [],
      steps: [
        { type: 'goto', url: 'https://example.com/login', raw: '- Mở URL' },
        { type: 'fill', target: 'Nhập tên đăng nhập', value: 'admin', raw: '- Nhập username' },
        { type: 'click', target: 'Đăng nhập', raw: '- Bấm Đăng nhập' },
      ],
    };
    const repeatedCase: ParsedTestCase = {
      ...verifiedCase,
      id: 'TC_02',
      name: 'Sai mật khẩu',
      steps: [
        { type: 'goto', url: 'https://example.com/login', raw: '- Mở URL' },
        { type: 'fill', target: 'Nhập tên đăng nhập', value: 'admin', raw: '- Nhập username' },
        { type: 'click', target: 'Đăng nhập', raw: '- Bấm Đăng nhập' },
      ],
    };
    const verifiedSnapshot: DomSnapshot = {
      url: 'https://example.com/login?from=e2e',
      afterStep: 'before step 2: fill username',
      elements: [
        {
          tag: 'input',
          placeholder: 'Nhập tên đăng nhập',
          selector: '#username',
          isVisible: true,
        },
        {
          tag: 'button',
          text: 'Đăng nhập',
          selector: '#login-button',
          isVisible: true,
        },
      ],
    };
    const incompleteSnapshot: DomSnapshot = {
      url: 'https://example.com/login',
      afterStep: 'before step 2: empty render',
      elements: [],
    };

    const plan = buildActionPlan(
      [verifiedCase, repeatedCase],
      new Map([
        ['TC_01', [verifiedSnapshot]],
        ['TC_02', [incompleteSnapshot]],
      ]),
      { persist: false },
    );
    const repeatedActions = plan.testCases[1].actions;

    expect(repeatedActions[1]).toMatchObject({
      confidence: 'high',
      matchedBy: 'placeholder',
      playwrightCode: "await page.getByPlaceholder('Nhập tên đăng nhập').fill('admin');",
    });
    expect(repeatedActions[2]).toMatchObject({
      confidence: 'high',
      matchedBy: 'role+name',
      playwrightCode: "await page.getByRole('button', { name: 'Đăng nhập' }).click();",
    });
  });

  it('does not reuse locator evidence from a different URL', () => {
    const testCase: ParsedTestCase = {
      id: 'TC_02',
      name: 'Trang khác',
      url: 'https://example.com/profile',
      unparsedSteps: [],
      steps: [
        { type: 'goto', url: 'https://example.com/profile', raw: '- Mở URL' },
        { type: 'click', target: 'Đăng nhập', raw: '- Bấm Đăng nhập' },
      ],
    };
    const loginSnapshot: DomSnapshot = {
      url: 'https://example.com/login',
      afterStep: 'before step 2: login page',
      elements: [{
        tag: 'button',
        text: 'Đăng nhập',
        selector: '#login-button',
        isVisible: true,
      }],
    };

    const plan = buildActionPlan(
      [testCase],
      new Map([
        ['TC_01', [loginSnapshot]],
        ['TC_02', [{
          url: 'https://example.com/profile',
          afterStep: 'before step 2: profile page',
          elements: [],
        }]],
      ]),
      { persist: false },
    );

    expect(plan.testCases[0].actions[1].confidence).toBe('low');
    expect(plan.testCases[0].actions[1].matchedBy).toBe('fallback_role_button');
  });

  it('compiles a custom dropdown from trigger and option snapshots', () => {
    const testCase: ParsedTestCase = {
      id: 'TC_01',
      name: 'Chọn loại hình tổ chức',
      url: 'https://example.com/to-chuc',
      unparsedSteps: [],
      steps: [
        { type: 'goto', url: 'https://example.com/to-chuc', raw: '- Mở URL' },
        {
          type: 'select',
          target: 'loại hình tổ chức',
          value: 'Tổ chức tôn giáo',
          raw: "- Dropdown chọn loại hình tổ chức, chọn 'Tổ chức tôn giáo'",
        },
      ],
    };
    const triggerSnapshot: DomSnapshot = {
      url: 'https://example.com/to-chuc',
      afterStep: 'before step 2: dropdown',
      elements: [{
        tag: 'button',
        role: 'combobox',
        accessibleName: 'Chọn loại hình tổ chức',
        ariaHasPopup: 'listbox',
        selector: '#organization-type',
        isVisible: true,
      }],
    };
    const optionSnapshot: DomSnapshot = {
      url: 'https://example.com/to-chuc',
      afterStep: 'during step 2: options for dropdown',
      elements: [{
        tag: 'div',
        role: 'option',
        accessibleName: 'Tổ chức tôn giáo',
        text: 'Tổ chức tôn giáo',
        selector: '#organization-type-religious',
        isVisible: true,
      }],
    };

    const plan = buildActionPlan(
      [testCase],
      new Map([['TC_01', [triggerSnapshot, optionSnapshot]]]),
      { persist: false },
    );
    const select = plan.testCases[0].actions[1];

    expect(select.confidence).toBe('high');
    expect(select.matchedBy).toBe('verified_dropdown_trigger+verified_option');
    expect(select.playwrightCode).toContain("page.locator('#organization-type').click()");
    expect(select.playwrightCode).toContain(
      "page.getByRole('option', { name: 'Tổ chức tôn giáo', exact: true }).click()",
    );
    expect(select.playwrightCode).not.toContain('.first()');
  });

  it('adds an observed URL postcondition after a navigation click', () => {
    const testCase: ParsedTestCase = {
      id: 'TC_01',
      name: 'Đăng nhập rồi chuyển trang',
      url: 'https://example.com/dang-nhap',
      unparsedSteps: [],
      steps: [
        { type: 'goto', url: 'https://example.com/dang-nhap', raw: '- Mở URL' },
        { type: 'click', target: 'Đăng nhập', raw: "- Bấm nút 'Đăng nhập'" },
      ],
    };
    const before: DomSnapshot = {
      url: 'https://example.com/dang-nhap',
      afterStep: 'before step 2: login',
      elements: [{
        tag: 'button',
        text: 'Đăng nhập',
        accessibleName: 'Đăng nhập',
        selector: '#login',
        isVisible: true,
      }],
    };
    const after: DomSnapshot = {
      url: 'https://example.com/dashboard',
      afterStep: 'after step 2: login',
      elements: [],
    };

    const plan = buildActionPlan(
      [testCase],
      new Map([['TC_01', [before, after]]]),
      { persist: false },
    );

    expect(plan.testCases[0].actions[1].playwrightCode).toContain(
      "await page.waitForURL('https://example.com/dashboard'",
    );
  });
});
