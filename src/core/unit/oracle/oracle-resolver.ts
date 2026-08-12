import type {
  UnitContextBundle,
  UnitExpectedResult,
  UnitPlannedTestCase,
  UnitTarget,
} from '../schema.js';
import { validateExpectedIntent } from '../test-intent.schema.js';
import { dataValueToRuntime, evaluateTargetStatically, runtimeValuesEqual } from './ast-evaluator.js';
import {
  ComprehensiveOracle,
  OracleGateResult,
  OracleGateStatus,
} from './oracle-taxonomy.js';
import { migrateTestCaseV1ToV2 } from '../plan-migrator.js';

export interface UnitOracleGateResolution {
  testCaseId: string;
  gateStatus: OracleGateStatus;
  oracle: ComprehensiveOracle;
  reason?: string;
  specExpected?: UnitExpectedResult;
  errors: string[];
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function expectedErrorMatches(
  expected: UnitExpectedResult,
  actual: { errorClass: string; message: string },
): boolean {
  if (expected.error?.className && expected.error.className !== actual.errorClass) return false;
  const matcher = expected.error?.message;
  if (matcher) {
    if (matcher.match === 'equals') return actual.message === matcher.value;
    if (matcher.match === 'contains') return actual.message.includes(matcher.value);
    try { return new RegExp(matcher.value, matcher.flags).test(actual.message); }
    catch { return false; }
  }
  if (expected.message !== undefined) return actual.message === expected.message;
  if (expected.value !== undefined) return runtimeValuesEqual(actual.message, dataValueToRuntime(expected.value));
  return true;
}

export function evaluateOracleGate(
  context: Pick<UnitContextBundle, 'requirements'>,
  target: UnitTarget,
  rawTestCase: UnitPlannedTestCase,
): UnitOracleGateResolution {
  const testCase = migrateTestCaseV1ToV2(rawTestCase);
  const oracle = testCase.oracle!;

  const schemaIssues = validateExpectedIntent(testCase.expected);
  if (schemaIssues.length > 0) {
    return {
      testCaseId: testCase.id,
      gateStatus: 'INVALID_EVIDENCE',
      oracle,
      reason: `Schema expected không hợp lệ: ${schemaIssues.map(i => i.message).join(', ')}`,
      errors: schemaIssues.map(issue => `${issue.path}: ${issue.message}`),
    };
  }

  // Handle sandbox observation legacy case
  if (rawTestCase.oracleEvidence?.source === 'sandbox-observation') {
    return {
      testCaseId: testCase.id,
      gateStatus: 'NEEDS_ORACLE',
      oracle,
      reason: 'Sandbox observation chỉ là characterization, chưa phải expected nghiệp vụ đã xác minh.',
      errors: ['Sandbox observation chỉ là characterization, chưa phải expected nghiệp vụ đã xác minh.'],
    };
  }

  // 1. SPECIFICATION từ Requirement hoặc Tester Confirmation
  if (oracle.intentType === 'SPECIFICATION') {
    if (oracle.authority === 'REQUIREMENT') {
      const reference = oracle.evidence.reference?.trim();
      if (!reference) {
        return {
          testCaseId: testCase.id,
          gateStatus: 'NEEDS_ORACLE',
          oracle,
          reason: 'Oracle requirement thiếu reference mã điều khoản nghiệp vụ.',
          errors: ['Oracle requirement thiếu exact reference.'],
        };
      }
      if (!context.requirements || !normalizeText(context.requirements).includes(normalizeText(reference))) {
        return {
          testCaseId: testCase.id,
          gateStatus: 'NEEDS_ORACLE',
          oracle,
          reason: `Không tìm thấy reference "${reference}" trong tài liệu requirement được cấp.`,
          errors: ['Không tìm thấy oracle reference trong yêu cầu nghiệp vụ tester đã nhập.'],
        };
      }

      // Static Evaluation check for CONFLICT_WITH_SPEC
      const evaluated = evaluateTargetStatically(target, testCase.inputs, testCase.mocks);
      if (evaluated.supported) {
        const expectsThrow = testCase.expected.kind === 'throw' || testCase.expected.kind === 'reject';
        let conflictDetected = false;
        if (evaluated.kind === 'throw') {
          if (!expectsThrow || !expectedErrorMatches(testCase.expected, evaluated)) {
            conflictDetected = true;
          }
        } else {
          if (expectsThrow || !['return', 'resolve'].includes(testCase.expected.kind) ||
              !runtimeValuesEqual(evaluated.value, dataValueToRuntime(testCase.expected.value!))) {
            conflictDetected = true;
          }
        }

        if (conflictDetected) {
          return {
            testCaseId: testCase.id,
            gateStatus: 'CONFLICT_WITH_SPEC',
            oracle,
            reason: `Mâu thuẫn với Requirement: Requirement mong đợi ${JSON.stringify(testCase.expected.value || testCase.expected.kind)} nhưng implementation hiện tại trả về ${JSON.stringify(evaluated.value || evaluated.kind)}`,
            specExpected: testCase.expected, // VẪN LƯU SPEC EXPECTED ĐỂ GENERATOR SINH TEST CÁCH LỖI
            errors: ['Source implementation conflicts with requirement specification'],
          };
        }
      }

      return {
        testCaseId: testCase.id,
        gateStatus: 'READY_SPECIFICATION',
        oracle,
        specExpected: testCase.expected,
        errors: [],
      };
    }

    if (oracle.authority === 'TESTER_CONFIRMATION') {
      if (rawTestCase.oracleEvidence && !rawTestCase.oracleEvidence.reference?.trim()) {
        return {
          testCaseId: testCase.id,
          gateStatus: 'NEEDS_ORACLE',
          oracle,
          reason: 'Xác nhận của tester thiếu audit reference hợp lệ từ CLI.',
          errors: ['Xác nhận của tester thiếu audit reference hợp lệ từ CLI.'],
        };
      }
      return {
        testCaseId: testCase.id,
        gateStatus: 'READY_SPECIFICATION',
        oracle,
        specExpected: testCase.expected,
        errors: [],
      };
    }
  }

  // 2. CHARACTERIZATION từ Static Evaluation / Implementation
  if (oracle.intentType === 'CHARACTERIZATION') {
    const evaluated = evaluateTargetStatically(target, testCase.inputs, testCase.mocks);
    if (!evaluated.supported) {
      return {
        testCaseId: testCase.id,
        gateStatus: 'NEEDS_ORACLE',
        oracle,
        reason: `Không thể chứng minh expected bằng static evaluator: ${evaluated.reason}`,
        errors: [`Không thể chứng minh expected bằng static evaluator: ${evaluated.reason}`],
      };
    }

    // Check if proposed expected matches evaluation
    const expectedKind = testCase.expected.kind;
    const expectsThrow = expectedKind === 'throw' || expectedKind === 'reject';
    let matches = true;

    if (evaluated.kind === 'throw') {
      if (!expectsThrow || !expectedErrorMatches(testCase.expected, evaluated)) {
        matches = false;
      }
    } else {
      if (expectsThrow || !['return', 'resolve'].includes(expectedKind) ||
          !runtimeValuesEqual(evaluated.value, dataValueToRuntime(testCase.expected.value!))) {
        matches = false;
      }
    }

    if (!matches && oracle.authority === 'IMPLEMENTATION') {
      return {
        testCaseId: testCase.id,
        gateStatus: 'NEEDS_ORACLE',
        oracle,
        reason: 'Expected value không khớp kết quả được chứng minh từ implementation.',
        errors: ['Expected value không khớp kết quả được chứng minh từ implementation.'],
      };
    }

    return {
      testCaseId: testCase.id,
      gateStatus: 'READY_CHARACTERIZATION',
      oracle,
      errors: [],
    };
  }

  return {
    testCaseId: testCase.id,
    gateStatus: 'NEEDS_ORACLE',
    oracle,
    reason: 'Chưa đủ bằng chứng xác minh Oracle',
    errors: ['Undefined oracle status'],
  };
}

export function resolveTargetOraclesV2(
  context: Pick<UnitContextBundle, 'requirements'>,
  target: UnitTarget,
  testCases: UnitPlannedTestCase[],
): UnitOracleGateResolution[] {
  return testCases.map(testCase => evaluateOracleGate(context, target, testCase));
}

// BACKWARD COMPATIBILITY ADAPTERS FOR V1 CALLERS
export type UnitOracleResolutionStatus = 'VERIFIED' | 'NEEDS_ORACLE';

export interface UnitOracleResolution {
  testCaseId: string;
  status: UnitOracleResolutionStatus;
  evidence?: unknown;
  errors: string[];
}

export function resolveUnitTestOracle(
  context: Pick<UnitContextBundle, 'requirements'>,
  target: UnitTarget,
  testCase: UnitPlannedTestCase,
): UnitOracleResolution {
  const gate = evaluateOracleGate(context, target, testCase);
  if (gate.gateStatus === 'READY_SPECIFICATION' || gate.gateStatus === 'READY_CHARACTERIZATION' || gate.gateStatus === 'CONFLICT_WITH_SPEC') {
    const evaluated = evaluateTargetStatically(target, testCase.inputs, testCase.mocks);
    let evidenceSource = evaluated.supported ? (testCase.mocks && testCase.mocks.length > 0 ? 'mock-trace' : 'pure-evaluation') : 'ai-inference';
    if (testCase.oracleSource === 'tester-confirmation' || testCase.oracleEvidence?.source === 'tester-confirmation') {
      evidenceSource = 'tester-confirmation';
    } else if (testCase.oracleSource === 'requirement' || testCase.oracleEvidence?.source === 'requirement') {
      evidenceSource = 'requirement';
    }

    const legacySource = testCase.oracleEvidence?.source;
    const finalSource = (legacySource && legacySource !== 'ai-inference' && legacySource !== 'proposed') 
      ? legacySource 
      : evidenceSource;

    return {
      testCaseId: testCase.id,
      status: 'VERIFIED',
      evidence: {
        status: 'verified',
        source: finalSource,
        reference: testCase.oracleEvidence?.reference || gate.oracle.evidence.reference,
        expression: testCase.oracleEvidence?.expression || evaluated.expression,
      },
      errors: [],
    };
  }

  return {
    testCaseId: testCase.id,
    status: 'NEEDS_ORACLE',
    errors: gate.errors.length > 0 ? gate.errors : [gate.reason || 'Needs Oracle'],
  };
}

export function resolveTargetOracles(
  context: Pick<UnitContextBundle, 'requirements'>,
  target: UnitTarget,
  testCases: UnitPlannedTestCase[],
): UnitOracleResolution[] {
  return testCases.map(testCase => resolveUnitTestOracle(context, target, testCase));
}
