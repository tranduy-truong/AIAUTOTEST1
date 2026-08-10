import { describe, expect, it } from 'vitest';
import { DomSnapshot, resolveLocator } from '../../src/core/locator-resolver.js';

describe('resolveLocator', () => {
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
});
