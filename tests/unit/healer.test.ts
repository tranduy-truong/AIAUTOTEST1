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
    });
  });
});
