import { describe, expect, it } from 'vitest';
import path from 'path';
import {
  fixCommonPlaywrightIssues,
  getGeneratedTestDirectory,
  limitDomReport,
} from '../../src/agents/generator/run.js';

describe('getGeneratedTestDirectory', () => {
  it('isolates generated E2E specs from tracked source files', () => {
    expect(getGeneratedTestDirectory('e2e', '/workspace')).toBe(
      path.join('/workspace', 'tests', 'e2e', 'generated'),
    );
    expect(getGeneratedTestDirectory('unit', '/workspace')).toBe(
      path.join('/workspace', 'tests', 'unit'),
    );
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
