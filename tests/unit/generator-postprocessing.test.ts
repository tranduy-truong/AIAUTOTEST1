import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ActionPlan } from '../../src/core/action-plan.js';
import {
  clearGeneratedE2ESpecs,
  fixCommonPlaywrightIssues,
  getGeneratedTestDirectory,
  limitDomReport,
} from '../../src/agents/generator/run.js';

describe('getGeneratedTestDirectory', () => {
  it('isolates generated E2E specs from tracked source files', () => {
    expect(getGeneratedTestDirectory('e2e', '/workspace')).toBe(
      path.join('/workspace', 'tests', 'e2e'),
    );
    expect(getGeneratedTestDirectory('unit', '/workspace')).toBe(
      path.join('/workspace', 'tests', 'unit'),
    );
  });

  it('cleans generated specs but keeps documentation in tests/e2e', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-output-'));

    try {
      fs.writeFileSync(path.join(outDir, 'old.spec.ts'), 'generated');
      fs.writeFileSync(path.join(outDir, 'README.md'), 'keep');
      fs.mkdirSync(path.join(outDir, 'generated'));
      fs.writeFileSync(path.join(outDir, 'generated', 'legacy.spec.ts'), 'legacy');

      clearGeneratedE2ESpecs(outDir);

      expect(fs.existsSync(path.join(outDir, 'old.spec.ts'))).toBe(false);
      expect(fs.existsSync(path.join(outDir, 'generated'))).toBe(false);
      expect(fs.readFileSync(path.join(outDir, 'README.md'), 'utf-8')).toBe('keep');
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe('verified password toggle locators', () => {
  it('replaces an invented accessible name with the Crawler-verified selector', () => {
    const actionPlan: ActionPlan = {
      testCases: [{
        id: 'TC_08',
        name: 'Ẩn hiện mật khẩu',
        baseUrl: 'https://example.com/login',
        needsLogin: false,
        actions: [
          {
            stepIndex: 3,
            type: 'click',
            description: 'Bấm icon con mắt ở góc phải ô Mật khẩu',
            playwrightCode: "await page.locator('button.password-toggle').click();",
            confidence: 'high',
            matchedBy: 'dom_icon_metadata',
          },
          {
            stepIndex: 5,
            type: 'click',
            description: 'Bấm icon con mắt thêm một lần nữa',
            playwrightCode: "await page.locator('button.password-toggle').click();",
            confidence: 'high',
            matchedBy: 'dom_icon_metadata',
          },
        ],
      }],
    };
    const generatedCode = [
      "test('TC_08 - Kiểm tra ẩn/hiện mật khẩu', async ({ page }) => {",
      "  const passwordInput = page.getByPlaceholder('Nhập mật khẩu');",
      '  await passwordInput.click();',
      "  await page.getByRole('button', { name: /.*con mắt.*/i }).click();",
      "  await expect(passwordInput).toHaveAttribute('type', 'text');",
      "  await page.getByRole('button', { name: /.*con mắt.*/i }).click();",
      "  await expect(passwordInput).toHaveAttribute('type', 'password');",
      '});',
    ].join('\n');

    const fixed = fixCommonPlaywrightIssues(generatedCode, actionPlan);

    expect(fixed.match(/button\.password-toggle/g)).toHaveLength(2);
    expect(fixed).not.toContain('con mắt');
    expect(fixed).not.toContain('passwordInput.click()');
  });
});

describe('limitDomReport', () => {
  it('caps DOM evidence before building the Groq prompt', () => {
    const report = 'x'.repeat(20_000);
    const limited = limitDomReport(report, 1_000);

    expect(limited.length).toBeLessThan(1_100);
    expect(limited).toContain('truncated');
  });
});

describe('fixCommonPlaywrightIssues password visibility', () => {
  it('replaces value-based visibility assertions with input type assertions', () => {
    const generatedCode = [
      "test('TC_08 - Kiểm tra tính năng ẩn/hiện mật khẩu', async ({ page }) => {",
      "  await page.getByPlaceholder('Nhập mật khẩu').fill('123123');",
      "  await page.locator('.verified-eye').click();",
      "  await expect(page.getByPlaceholder('Nhập mật khẩu')).toHaveValue('123123');",
      "  await page.locator('.verified-eye').click();",
      "  await expect(page.getByPlaceholder('Nhập mật khẩu')).not.toHaveValue('123123');",
      '});',
    ].join('\n');

    const fixed = fixCommonPlaywrightIssues(generatedCode);

    expect(fixed).toContain("toHaveAttribute('type', 'text')");
    expect(fixed).toContain("toHaveAttribute('type', 'password')");
    expect(fixed).not.toContain('not.toHaveValue');
  });

  it('preserves correct type assertions and separate value checks', () => {
    const generatedCode = [
      "test('TC_08 - Kiểm tra tính năng ẩn/hiện mật khẩu', async ({ page }) => {",
      "  await page.getByPlaceholder('Nhập mật khẩu').fill('123123');",
      "  await page.locator('.verified-eye').click();",
      "  await expect(page.getByPlaceholder('Nhập mật khẩu')).toHaveAttribute('type', 'text');",
      "  await expect(page.getByPlaceholder('Nhập mật khẩu')).toHaveValue('123123');",
      "  await page.locator('.verified-eye').click();",
      "  await expect(page.getByPlaceholder('Nhập mật khẩu')).toHaveAttribute('type', 'password');",
      "  await expect(page.getByPlaceholder('Nhập mật khẩu')).toHaveValue('123123');",
      '});',
    ].join('\n');

    expect(fixCommonPlaywrightIssues(generatedCode)).toBe(generatedCode);
  });
});
