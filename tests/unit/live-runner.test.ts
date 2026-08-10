import { describe, expect, it } from 'vitest';
import { CAPTURE_SNAPSHOT_SCRIPT } from '../../src/agents/crawler/live-runner.js';

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
});
