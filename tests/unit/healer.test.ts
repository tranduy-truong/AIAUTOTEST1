import { describe, expect, it } from 'vitest';
import { classifyFailure, classifyUnitFailure } from '../../src/agents/healer/run.js';

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

describe('Unit Healer diagnose-only policy', () => {
  it('classifies assertion mismatch without allowing expected-result healing', () => {
    const diagnosis = classifyUnitFailure(`AssertionError: expected 200000 to be 90000\n tests/unit/discount.test.ts:12:5`);
    expect(diagnosis.reasonCode).toBe('IMPLEMENTATION_DIFFERS_FROM_PLANNED_ORACLE');
    expect(diagnosis.canSelfHeal).toBe(false);
    expect(diagnosis.preservesExpectedResult).toBe(true);
    expect(diagnosis.recoveryAction).toBe('REPORT_ONLY');
  });

  it('identifies an unverified import or alias error', () => {
    const diagnosis = classifyUnitFailure(`Error: Cannot find module '@/services/order' from tests/unit/order.test.ts`);
    expect(diagnosis.reasonCode).toBe('IMPORT_OR_ALIAS_NOT_RESOLVED');
    expect(diagnosis.canSelfHeal).toBe(false);
  });

  it('classifies a Windows command-shim launch failure as infrastructure', () => {
    const diagnosis = classifyUnitFailure(
      String.raw`spawnSync D:\project\node_modules\.bin\vitest.cmd EINVAL`,
    );
    expect(diagnosis).toMatchObject({
      category: 'ENVIRONMENT_ERROR',
      reasonCode: 'UNIT_TEST_RUNNER_LAUNCH_FAILED',
      confidence: 'high',
      canSelfHeal: false,
    });
  });

  it('recognizes a generated object fixture missing a required path property', () => {
    const diagnosis = classifyUnitFailure([
      'AssertionError: promise rejected instead of resolving',
      'TypeError: The "path" argument must be of type string. Received undefined',
      "Serialized Error: { code: 'ERR_INVALID_ARG_TYPE' }",
    ].join('\n'));
    expect(diagnosis).toMatchObject({
      category: 'TEST_SCRIPT_BUG',
      reasonCode: 'GENERATED_INPUT_FIXTURE_INVALID',
      confidence: 'high',
    });
  });
});
