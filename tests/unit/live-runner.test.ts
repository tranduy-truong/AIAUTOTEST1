import { describe, expect, it } from 'vitest';
import {
  buildCompactDomReport,
  CAPTURE_SNAPSHOT_SCRIPT,
  crawlerRunsHeadless,
  describeStepForGuidance,
  guidedLearningEnabled,
  guidedPickScript,
  isPotentiallyDestructive,
  isLoginUrl,
  loginStepBeforeProtectedGoto,
  nextStateStep,
  protectedGotoAfterLogin,
} from '../../src/agents/crawler/live-runner.js';
import type { ParsedStep } from '../../src/core/step-parser.js';

describe('browser snapshot script', () => {
  it('executes without relying on tsx helpers such as __name', () => {
    document.body.innerHTML = `
      <label for="password">Mật khẩu</label>
      <div class="password-field">
        <input id="password" name="password" placeholder="Nhập mật khẩu" type="password" />
        <button id="password-toggle" aria-label="Hiện mật khẩu">
          <svg class="eye-icon" title="Hiện mật khẩu"></svg>
        </button>
      </div>
    `;

    const elements = window.eval(CAPTURE_SNAPSHOT_SCRIPT) as Array<Record<string, unknown>>;
    const passwordInput = elements.find(element => element.id === 'password');
    const eyeIcon = elements.find(element => element.tag === 'svg');

    expect(CAPTURE_SNAPSHOT_SCRIPT).not.toContain('__name');
    expect(passwordInput).toMatchObject({
      type: 'password',
      placeholder: 'Nhập mật khẩu',
      selector: '#password',
    });
    expect(eyeIcon).toMatchObject({
      accessibleName: 'Hiện mật khẩu',
      nearbyInputPlaceholder: 'Nhập mật khẩu',
      selector: '#password-toggle',
    });
  });

  it('captures drawer scope and custom dropdown semantics', () => {
    document.body.innerHTML = `
      <aside id="organization-drawer" role="dialog" aria-modal="true" tabindex="-1">
        <input id="organization-name" placeholder="Nhập tên tổ chức" />
        <div class="field">
          <label>Loại hình tổ chức</label>
          <button
            id="organization-type"
            role="combobox"
            aria-haspopup="listbox"
          >Chọn loại hình tổ chức</button>
        </div>
        <div role="listbox">
          <div data-slot="select-item" data-value="Tổ chức tôn giáo">Tổ chức tôn giáo</div>
        </div>
      </aside>
    `;

    const elements = window.eval(CAPTURE_SNAPSHOT_SCRIPT) as Array<Record<string, unknown>>;
    const organizationName = elements.find(element => element.id === 'organization-name');
    const trigger = elements.find(element => element.id === 'organization-type');
    const option = elements.find(element => element.dataValue === 'Tổ chức tôn giáo');

    expect(organizationName).toMatchObject({
      placeholder: 'Nhập tên tổ chức',
      scopeSelector: '#organization-drawer',
      selector: '#organization-name',
    });

    expect(trigger).toMatchObject({
      role: 'combobox',
      ariaHasPopup: 'listbox',
      labelText: 'Loại hình tổ chức',
      scopeSelector: '#organization-drawer',
      selector: '#organization-type',
    });
    expect(option).toMatchObject({
      dataSlot: 'select-item',
      dataValue: 'Tổ chức tôn giáo',
      text: 'Tổ chức tôn giáo',
      scopeSelector: '#organization-drawer',
      selector: '[data-slot="select-item"][data-value="Tổ chức tôn giáo"]',
    });
  });
});

describe('crawler guidance context', () => {
  it('shows the test case, progress and step without exposing fill values', () => {
    const description = describeStepForGuidance({
      type: 'fill',
      target: 'Nhập mật khẩu',
      value: 'Secret@123',
      raw: "- Nhập 'Secret@123' vào ô 'Nhập mật khẩu'",
    });
    const script = guidedPickScript('fill: Nhập mật khẩu', {
      testCaseId: 'TC_18',
      testCaseName: 'Đăng nhập quản trị',
      testCasePosition: 18,
      totalTestCases: 30,
      stepNumber: 3,
      totalSteps: 12,
      stepDescription: description,
    });

    expect(script).toContain('TC_18 - Đăng nhập quản trị (18/30)');
    expect(script).toContain('Bước: 3/12');
    expect(script).toContain('Nhập dữ liệu vào ô');
    expect(script).not.toContain('Secret@123');
  });
});

describe('buildCompactDomReport', () => {
  it('deduplicates repeated snapshots before sending DOM evidence to the Generator', () => {
    const element = {
      tag: 'input',
      placeholder: 'Nhập tên đăng nhập',
      selector: '#username',
      isVisible: true,
    };
    const repeatedSnapshots = Array.from({ length: 47 }, (_, index) => ({
      url: 'https://example.com/login',
      afterStep: `state ${index + 1}`,
      elements: [element],
    }));

    const report = buildCompactDomReport(new Map([['TC_01', repeatedSnapshots]]));

    expect(report).toContain('Snapshots captured: 47');
    expect(report).toContain('Unique visible elements: 1');
    expect(report.match(/#username/g)).toHaveLength(1);
  });
});

describe('state-aware crawler policy', () => {
  it('uses the next actionable step as the expected UI state after a click', () => {
    const steps: ParsedStep[] = [
      { type: 'click', target: 'Thêm', raw: "- Bấm nút 'Thêm'" },
      {
        type: 'fill',
        target: 'Nhập tên tổ chức',
        value: 'Tổ chức Test',
        raw: "- Nhập 'Tổ chức Test' vào ô 'Nhập tên tổ chức'",
      },
    ];

    expect(nextStateStep(steps, 0)).toEqual({ step: steps[1], stepNumber: 2 });
  });

  it('does not wait across an explicit navigation or assertion boundary', () => {
    const steps: ParsedStep[] = [
      { type: 'click', target: 'Đăng nhập', raw: "- Bấm nút 'Đăng nhập'" },
      { type: 'goto', url: 'https://example.com/to-chuc', raw: '- Mở URL trang tổ chức' },
      { type: 'fill', target: 'Nhập tên tổ chức', value: 'Test', raw: '- Nhập tên' },
    ];

    expect(nextStateStep(steps, 0)).toBeUndefined();
  });

  it('verifies destructive controls without executing them', () => {
    expect(isPotentiallyDestructive('Lưu')).toBe(true);
    expect(isPotentiallyDestructive('Xóa tổ chức')).toBe(true);
    expect(isPotentiallyDestructive('Thêm')).toBe(false);
    expect(isPotentiallyDestructive('Đăng nhập')).toBe(false);
  });

  it('uses the declared protected navigation to verify an authentication step', () => {
    const steps: ParsedStep[] = [
      { type: 'click', target: 'Đăng nhập', raw: "- Bấm nút 'Đăng nhập'" },
      {
        type: 'goto',
        url: 'https://example.com/quan-tri/to-chuc',
        raw: '- Mở URL trang tổ chức',
      },
    ];

    expect(protectedGotoAfterLogin(steps, 0)).toEqual({
      step: steps[1],
      stepNumber: 2,
    });
    expect(loginStepBeforeProtectedGoto(steps, 1)).toEqual({
      step: steps[0],
      stepNumber: 1,
    });
  });

  it('keeps authentication verification across intermediate wait/check steps', () => {
    const steps: ParsedStep[] = [
      { type: 'click', target: 'Đăng nhập', raw: "- Bấm nút 'Đăng nhập'" },
      { type: 'wait', raw: '- Chờ trang load xong' },
      {
        type: 'check',
        assertion: "URL không còn chứa 'dang-nhap'",
        raw: '- Kiểm tra đăng nhập',
      },
      {
        type: 'goto',
        url: 'https://example.com/quan-tri/to-chuc',
        raw: '- Mở URL trang tổ chức',
      },
    ];

    expect(protectedGotoAfterLogin(steps, 0)).toEqual({
      step: steps[3],
      stepNumber: 4,
    });
    expect(loginStepBeforeProtectedGoto(steps, 3)).toEqual({
      step: steps[0],
      stepNumber: 1,
    });
  });

  it('does not treat another login URL as proof of authentication', () => {
    const steps: ParsedStep[] = [
      { type: 'click', target: 'Đăng nhập', raw: "- Bấm nút 'Đăng nhập'" },
      { type: 'goto', url: 'https://example.com/dang-nhap', raw: '- Mở lại đăng nhập' },
    ];

    expect(protectedGotoAfterLogin(steps, 0)).toBeUndefined();
    expect(isLoginUrl('https://example.com/dang-nhap?redirect=%2Fadmin')).toBe(true);
    expect(isLoginUrl('https://example.com/quan-tri/to-chuc')).toBe(false);
  });

  it('allows headed crawler diagnostics without changing website credentials', () => {
    expect(crawlerRunsHeadless({})).toBe(true);
    expect(crawlerRunsHeadless({ E2E_CRAWLER_HEADLESS: 'false' })).toBe(false);
    expect(crawlerRunsHeadless({ E2E_CRAWLER_HEADLESS: 'FALSE' })).toBe(false);
    expect(guidedLearningEnabled({})).toBe(true);
    expect(guidedLearningEnabled({ E2E_GUIDED_LEARNING: 'false' })).toBe(false);
  });

  it('captures the interactive ancestor selected by the user without executing its click', () => {
    document.body.innerHTML = `
      <button id="religion-option" role="option">
        <span>Công giáo</span>
      </button>
    `;
    window.eval(guidedPickScript('option: Công giáo'));
    const nestedText = document.querySelector('span') as HTMLElement;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });

    nestedText.dispatchEvent(event);

    const result = (globalThis as typeof globalThis & {
      __AI_TEST_GUIDED_PICK_RESULT__?: Record<string, unknown>;
    }).__AI_TEST_GUIDED_PICK_RESULT__;
    expect(event.defaultPrevented).toBe(true);
    expect(result).toMatchObject({
      selector: '#religion-option',
      tag: 'button',
      role: 'option',
      text: 'Công giáo',
    });
  });
});
