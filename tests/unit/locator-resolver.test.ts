import { describe, expect, it } from 'vitest';
import { DomSnapshot, resolveLocator } from '../../src/core/locator-resolver.js';

describe('resolveLocator', () => {
  it('uses a user-verified Guided Learning binding before heuristic matching', () => {
    const snapshot: DomSnapshot = {
      url: 'https://example.com/to-chuc',
      afterStep: 'guided option',
      elements: [{
        tag: 'div',
        selector: '[data-value="catholic"]',
        learnedStepType: 'option',
        learnedTarget: 'Công giáo',
        learnedLocator: "page.locator('[data-value=\"catholic\"]')",
        isVisible: true,
      }],
    };

    expect(resolveLocator('option', 'Cong giao', snapshot)).toMatchObject({
      locator: "page.locator('[data-value=\"catholic\"]')",
      confidence: 'high',
      matchedBy: 'guided_learning',
    });
  });

  it('uses DOM evidence for an icon locator', () => {
    const snapshot: DomSnapshot = {
      url: 'https://example.com/login',
      afterStep: 'after goto',
      elements: [{
        tag: 'svg',
        className: 'password-toggle',
        accessibleName: 'Hiện mật khẩu',
        nearbyInputPlaceholder: 'Nhập mật khẩu',
        selector: 'button.password-toggle',
        isVisible: true,
      }],
    };

    expect(resolveLocator('click', 'icon con mắt', snapshot)).toMatchObject({
      locator: "page.locator('button.password-toggle')",
      confidence: 'high',
      matchedBy: 'dom_icon_metadata',
    });
  });

  it('does not invent a UI-library class when DOM evidence is absent', () => {
    const resolved = resolveLocator('click', 'icon con mắt');
    expect(resolved.locator).not.toContain('lucide');
    expect(resolved.locator).not.toContain('[class*="eye"]');
    expect(resolved.confidence).toBe('low');
  });

  it('uses input type instead of value for password visibility assertions', () => {
    expect(resolveLocator('check', 'Mật khẩu chuyển sang dạng văn bản đọc được')).toMatchObject({
      locator: expect.stringContaining("toHaveAttribute('type', 'text')"),
      confidence: 'high',
    });
    expect(resolveLocator('check', 'Mật khẩu quay lại dạng ẩn')).toMatchObject({
      locator: expect.stringContaining("toHaveAttribute('type', 'password')"),
      confidence: 'high',
    });
  });

  it('matches common login controls from a captured DOM snapshot', () => {
    const snapshot: DomSnapshot = {
      url: 'https://example.com/login',
      afterStep: 'after goto',
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

    expect(resolveLocator('fill', 'Nhap ten dang nhap', snapshot)).toMatchObject({
      matchedBy: 'placeholder',
      confidence: 'high',
    });
    expect(resolveLocator('click', 'Đăng nhập', snapshot)).toMatchObject({
      matchedBy: 'role+name',
      confidence: 'high',
    });
  });

  it('resolves a custom dropdown trigger and option from separate DOM states', () => {
    const triggerSnapshot: DomSnapshot = {
      url: 'https://example.com/to-chuc',
      afterStep: 'before dropdown',
      elements: [{
        tag: 'button',
        role: 'combobox',
        accessibleName: 'Chọn loại hình tổ chức',
        labelText: 'Loại hình tổ chức',
        ariaHasPopup: 'listbox',
        selector: '#organization-type',
        isVisible: true,
      }],
    };
    const optionSnapshot: DomSnapshot = {
      url: 'https://example.com/to-chuc',
      afterStep: 'dropdown opened',
      elements: [{
        tag: 'div',
        role: 'option',
        text: 'Tổ chức tôn giáo',
        accessibleName: 'Tổ chức tôn giáo',
        selector: '#religious-option',
        isVisible: true,
      }],
    };

    expect(resolveLocator('select', 'loại hình tổ chức', triggerSnapshot)).toMatchObject({
      locator: "page.locator('#organization-type')",
      confidence: 'high',
      matchedBy: 'verified_dropdown_trigger',
    });
    expect(resolveLocator('option', 'Tổ chức tôn giáo', optionSnapshot)).toMatchObject({
      locator: "page.getByRole('option', { name: 'Tổ chức tôn giáo', exact: true })",
      confidence: 'high',
      matchedBy: 'verified_option',
    });
  });

  it('does not accept an ambiguous duplicate placeholder as verified evidence', () => {
    const snapshot: DomSnapshot = {
      url: 'https://example.com/form',
      afterStep: 'duplicate fields',
      elements: [1, 2].map(index => ({
        tag: 'input',
        placeholder: 'Nhập tên',
        selector: `#name-${index}`,
        isVisible: true,
      })),
    };

    expect(resolveLocator('fill', 'Nhập tên', snapshot).confidence).toBe('low');
  });

  it('prefers a drawer dropdown over a same-named page filter', () => {
    const snapshot: DomSnapshot = {
      url: 'https://example.com/to-chuc',
      afterStep: 'drawer opened',
      elements: [
        {
          tag: 'button',
          role: 'combobox',
          labelText: 'Loại hình tổ chức',
          selector: '#page-filter',
          isVisible: true,
        },
        {
          tag: 'button',
          role: 'combobox',
          labelText: 'Loại hình tổ chức',
          scopeSelector: '#organization-drawer',
          selector: '#drawer-organization-type',
          isVisible: true,
        },
      ],
    };

    expect(resolveLocator('select', 'loại hình tổ chức', snapshot)).toMatchObject({
      locator: "page.locator('#drawer-organization-type')",
      confidence: 'high',
      matchedBy: 'verified_dropdown_trigger',
    });
  });

  it('resolves a Base UI option captured through data-slot metadata', () => {
    const snapshot: DomSnapshot = {
      url: 'https://example.com/to-chuc',
      afterStep: 'select popup opened',
      elements: [{
        tag: 'div',
        dataSlot: 'select-item',
        dataValue: 'Tổ chức tôn giáo',
        text: 'Tổ chức tôn giáo',
        selector: '[data-slot="select-item"][data-value="Tổ chức tôn giáo"]',
        isVisible: true,
      }, {
        tag: 'span',
        dataSlot: 'select-item-text',
        text: 'Tổ chức tôn giáo',
        selector: '#nested-option-text',
        isVisible: true,
      }],
    };

    expect(resolveLocator('option', 'Tổ chức tôn giáo', snapshot)).toMatchObject({
      locator: "page.locator('[data-slot=\"select-item\"][data-value=\"Tổ chức tôn giáo\"]')",
      confidence: 'high',
      matchedBy: 'verified_option_selector',
    });
  });
});
