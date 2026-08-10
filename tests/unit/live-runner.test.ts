import { describe, expect, it } from 'vitest';
import {
  buildCompactDomReport,
  CAPTURE_SNAPSHOT_SCRIPT,
  isPotentiallyDestructive,
  isLoginUrl,
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
      <aside id="organization-drawer" role="dialog" aria-modal="true">
        <div class="field">
          <label>Loại hình tổ chức</label>
          <button
            id="organization-type"
            role="combobox"
            aria-haspopup="listbox"
          >Chọn loại hình tổ chức</button>
        </div>
        <div role="listbox">
          <div id="religious-option" role="option">Tổ chức tôn giáo</div>
        </div>
      </aside>
    `;

    const elements = window.eval(CAPTURE_SNAPSHOT_SCRIPT) as Array<Record<string, unknown>>;
    const trigger = elements.find(element => element.id === 'organization-type');
    const option = elements.find(element => element.id === 'religious-option');

    expect(trigger).toMatchObject({
      role: 'combobox',
      ariaHasPopup: 'listbox',
      labelText: 'Loại hình tổ chức',
      scopeSelector: '#organization-drawer',
      selector: '#organization-type',
    });
    expect(option).toMatchObject({
      role: 'option',
      text: 'Tổ chức tôn giáo',
      scopeSelector: '#organization-drawer',
      selector: '#religious-option',
    });
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
});
