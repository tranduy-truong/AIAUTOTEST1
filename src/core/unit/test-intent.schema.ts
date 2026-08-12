import type {
  UnitExpectedResult,
  UnitOracleEvidence,
  UnitPlannedTestCase,
} from './schema.js';

export interface TestIntentSchemaIssue {
  path: string;
  message: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const errorClasses = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError']);
const evidenceStatuses = new Set(['verified', 'proposed', 'observed']);
const evidenceSources = new Set([
  'requirement', 'existing-test', 'return-literal', 'throw-literal',
  'pure-evaluation', 'mock-trace', 'sandbox-observation', 'ai-inference',
  'tester-confirmation',
]);

export function validateExpectedIntent(expected: UnitExpectedResult, path = 'expected'): TestIntentSchemaIssue[] {
  const issues: TestIntentSchemaIssue[] = [];
  if (!isObject(expected)) return [{ path, message: 'Expected phải là object.' }];
  if (!['return', 'throw', 'resolve', 'reject', 'side-effect'].includes(String(expected.kind))) {
    issues.push({ path: `${path}.kind`, message: 'Kind không được hỗ trợ.' });
  }
  if (expected.error !== undefined) {
    if (!isObject(expected.error)) issues.push({ path: `${path}.error`, message: 'Error matcher phải là object.' });
    else {
      if (expected.error.className !== undefined && !errorClasses.has(String(expected.error.className))) {
        issues.push({ path: `${path}.error.className`, message: 'Error class không nằm trong allow-list an toàn.' });
      }
      if (expected.error.className === undefined && expected.error.message === undefined) {
        issues.push({ path: `${path}.error`, message: 'Error matcher cần className hoặc message.' });
      }
      if (expected.error.message !== undefined) {
        if (!isObject(expected.error.message)) {
          issues.push({ path: `${path}.error.message`, message: 'Message matcher phải là object.' });
        } else {
          if (!['equals', 'contains', 'regexp'].includes(String(expected.error.message.match))) {
            issues.push({ path: `${path}.error.message.match`, message: 'Matcher phải là equals | contains | regexp.' });
          }
          if (typeof expected.error.message.value !== 'string' || !expected.error.message.value) {
            issues.push({ path: `${path}.error.message.value`, message: 'Matcher cần value dạng string không rỗng.' });
          }
          if (expected.error.message.flags !== undefined && !/^[dgimsuvy]*$/.test(expected.error.message.flags)) {
            issues.push({ path: `${path}.error.message.flags`, message: 'RegExp flags không hợp lệ.' });
          }
          if (expected.error.message.flags && expected.error.message.match !== 'regexp') {
            issues.push({ path: `${path}.error.message.flags`, message: 'Flags chỉ hợp lệ với matcher regexp.' });
          }
        }
      }
    }
  }
  if (expected.error !== undefined && !['throw', 'reject'].includes(expected.kind)) {
    issues.push({ path: `${path}.error`, message: 'Error matcher chỉ dùng cho throw/reject.' });
  }
  if (expected.value !== undefined && expected.error !== undefined) {
    issues.push({ path, message: 'Không được khai báo đồng thời expected.value và expected.error.' });
  }
  if (['throw', 'reject'].includes(expected.kind)
    && expected.value === undefined && expected.message === undefined && expected.error === undefined) {
    issues.push({ path, message: `${expected.kind} cần value hoặc error matcher.` });
  }
  if (['return', 'resolve'].includes(expected.kind) && expected.value === undefined) {
    issues.push({ path: `${path}.value`, message: `${expected.kind} cần value.` });
  }
  if (expected.kind === 'side-effect' && (!Array.isArray(expected.calls) || expected.calls.length === 0)) {
    issues.push({ path: `${path}.calls`, message: 'Side-effect cần ít nhất một call assertion.' });
  }
  return issues;
}

export function validateOracleEvidence(
  evidence: UnitOracleEvidence | undefined,
  path = 'oracleEvidence',
): TestIntentSchemaIssue[] {
  if (!evidence) return [{ path, message: 'Thiếu provenance cho expected result.' }];
  if (!isObject(evidence)) return [{ path, message: 'Oracle evidence phải là object.' }];
  const issues: TestIntentSchemaIssue[] = [];
  if (!evidenceStatuses.has(String(evidence.status))) {
    issues.push({ path: `${path}.status`, message: 'Status phải là verified | proposed | observed.' });
  }
  if (!evidenceSources.has(String(evidence.source))) {
    issues.push({ path: `${path}.source`, message: 'Nguồn oracle không được hỗ trợ.' });
  }
  if (evidence.source === 'requirement' && (!evidence.reference || !evidence.reference.trim())) {
    issues.push({ path: `${path}.reference`, message: 'Requirement evidence cần exact reference.' });
  }
  if (evidence.source === 'tester-confirmation'
    && (evidence.status !== 'verified' || !evidence.reference?.trim())) {
    issues.push({
      path,
      message: 'Tester confirmation cần status=verified và mã tham chiếu xác nhận từ CLI.',
    });
  }
  if (evidence.source === 'existing-test' && (!evidence.testFile || !evidence.testCaseId)) {
    issues.push({ path, message: 'Existing-test evidence cần testFile và testCaseId.' });
  }
  return issues;
}

export function validateTestIntent(testCase: UnitPlannedTestCase): TestIntentSchemaIssue[] {
  return [
    ...validateExpectedIntent(testCase.expected),
    ...validateOracleEvidence(testCase.oracleEvidence),
  ];
}
