import { describe, expect, it } from 'vitest';
import { classifyFailure } from '../../src/agents/healer/run.js';

describe('Healer failure classification', () => {
  it('recognizes an unsplit natural-language assertion as a test script bug', () => {
    const diagnosis = classifyFailure([
      "await expect(page.locator('body')).toContainText(",
      "'Có cả 2 thông báo A và B cùng lúc'",
      ');',
    ].join('\n'));

    expect(diagnosis).toMatchObject({
      category: 'TEST_SCRIPT_BUG',
      reasonCode: 'SEMANTIC_ASSERTION_NOT_SPLIT',
      canSelfHeal: true,
      preservesExpectedResult: true,
    });
  });

  it('keeps a missing locator separate from semantic assertion errors', () => {
    const diagnosis = classifyFailure(
      "locator.click: Test timeout exceeded - waiting for getByRole('button', { name: 'Sửa' })",
    );

    expect(diagnosis).toMatchObject({
      category: 'LOCATOR_CHANGED',
      reasonCode: 'LOCATOR_NOT_UNIQUE_OR_NOT_FOUND',
      canSelfHeal: true,
      recoveryAction: 'RECRAWL_FAILED_STATE',
    });
  });

  it('separates an expired authentication state from a locator change', () => {
    const diagnosis = classifyFailure([
      "locator.click: Test timeout exceeded - waiting for getByText('Thêm')",
      'Current URL: https://example.com/dang-nhap',
      'at organization.spec.ts:16:20',
    ].join('\n'));

    expect(diagnosis).toMatchObject({
      category: 'AUTHENTICATION_ERROR',
      reasonCode: 'AUTH_STATE_NOT_READY_OR_EXPIRED',
      recoveryAction: 'REPLAY_AUTH_FLOW',
      failedLine: 16,
    });
  });

  it('classifies an observed-state wait separately from a locator failure', () => {
    const diagnosis = classifyFailure(
      'page.waitForURL: navigation timeout at organization.spec.ts:10:12',
    );

    expect(diagnosis).toMatchObject({
      category: 'TIMING_OR_ASYNC',
      recoveryAction: 'WAIT_FOR_OBSERVED_STATE',
      failedLine: 10,
    });
  });
});
