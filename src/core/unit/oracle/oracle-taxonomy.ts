export type TestIntentType = 'SPECIFICATION' | 'CHARACTERIZATION';

export type OracleAuthority =
  | 'REQUIREMENT'
  | 'TESTER_CONFIRMATION'
  | 'EXISTING_TEST'
  | 'IMPLEMENTATION';

export type OracleEvidenceStatus = 'VERIFIED' | 'PROPOSED' | 'OBSERVED';

export type OracleEvidenceMethod =
  | 'REQUIREMENT_REFERENCE'
  | 'TESTER_APPROVAL'
  | 'STATIC_EVALUATION'
  | 'MOCK_TRACE'
  | 'SANDBOX_OBSERVATION'
  | 'EXISTING_TEST_REFERENCE';

export type OracleGateStatus =
  | 'READY_SPECIFICATION'
  | 'READY_CHARACTERIZATION'
  | 'NEEDS_ORACLE'
  | 'CONFLICT_WITH_SPEC'
  | 'INVALID_EVIDENCE';

export interface OracleAuditEntry {
  id: string;
  timestamp: string; // ISO 8601 String
  actor: {
    type: 'LOCAL_TESTER' | 'CI_USER';
    identifier?: string;
  };
  action:
    | 'APPROVE_EXPECTED'
    | 'REPLACE_EXPECTED'
    | 'REVOKE_APPROVAL'
    | 'MARK_NEEDS_REVIEW';
  previousOracle: ComprehensiveOracle;
  nextOracle: ComprehensiveOracle;
  expectedBefore?: unknown;
  expectedAfter?: unknown;
  source: 'interactive-cli' | 'github-actions' | 'web-ui';
  note: string;
}

export interface ComprehensiveOracle {
  intentType: TestIntentType;
  authority: OracleAuthority;
  evidence: {
    status: OracleEvidenceStatus;
    method: OracleEvidenceMethod;
    reference?: string;
    description?: string;
  };
  auditTrail: OracleAuditEntry[];
}

export interface OracleGateResult {
  status: OracleGateStatus;
  reason?: string;
  specExpected?: unknown;
  actualObserved?: unknown;
}

export function buildCharacterizationOracle(
  expression: string,
  evaluatedValue: unknown,
  description?: string,
): ComprehensiveOracle {
  return {
    intentType: 'CHARACTERIZATION',
    authority: 'IMPLEMENTATION',
    evidence: {
      status: 'VERIFIED',
      method: 'STATIC_EVALUATION',
      reference: expression,
      description: description || `Suy ra từ code hiện tại qua biểu thức: ${expression} = ${JSON.stringify(evaluatedValue)}`,
    },
    auditTrail: [],
  };
}

export function buildSpecificationOracle(
  requirementCode: string,
  referenceText?: string,
  description?: string,
): ComprehensiveOracle {
  return {
    intentType: 'SPECIFICATION',
    authority: 'REQUIREMENT',
    evidence: {
      status: 'VERIFIED',
      method: 'REQUIREMENT_REFERENCE',
      reference: requirementCode,
      description: description || referenceText || `Dựa trên yêu cầu nghiệp vụ: ${requirementCode}`,
    },
    auditTrail: [],
  };
}

export function appendAuditEntry(
  oracle: ComprehensiveOracle,
  entry: Omit<OracleAuditEntry, 'id' | 'timestamp'>,
): ComprehensiveOracle {
  const fullEntry: OracleAuditEntry = {
    ...entry,
    id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    timestamp: new Date().toISOString(),
  };

  return {
    ...oracle,
    auditTrail: [...oracle.auditTrail, fullEntry],
  };
}

export function promoteToSpecificationByTester(
  currentOracle: ComprehensiveOracle,
  actorType: 'LOCAL_TESTER' | 'CI_USER' = 'LOCAL_TESTER',
  note = 'Expected này do implementation đề xuất và đã được tester chấp thuận qua CLI.',
): ComprehensiveOracle {
  const nextOracle: ComprehensiveOracle = {
    ...currentOracle,
    intentType: 'SPECIFICATION',
    authority: 'TESTER_CONFIRMATION',
    evidence: {
      status: 'VERIFIED',
      method: 'TESTER_APPROVAL',
      reference: currentOracle.evidence.reference,
      description: note,
    },
  };

  return appendAuditEntry(nextOracle, {
    actor: { type: actorType },
    action: 'APPROVE_EXPECTED',
    previousOracle: currentOracle,
    nextOracle,
    source: 'interactive-cli',
    note,
  });
}

export function replaceExpectedByTester(
  currentOracle: ComprehensiveOracle,
  expectedBefore: unknown,
  expectedAfter: unknown,
  actorType: 'LOCAL_TESTER' | 'CI_USER' = 'LOCAL_TESTER',
  note = 'Tester tự tay thay thế kết quả mong đợi khác với đề xuất ban đầu.',
): ComprehensiveOracle {
  const nextOracle: ComprehensiveOracle = {
    ...currentOracle,
    intentType: 'SPECIFICATION',
    authority: 'TESTER_CONFIRMATION',
    evidence: {
      status: 'VERIFIED',
      method: 'TESTER_APPROVAL',
      description: note,
    },
  };

  return appendAuditEntry(nextOracle, {
    actor: { type: actorType },
    action: 'REPLACE_EXPECTED',
    previousOracle: currentOracle,
    nextOracle,
    expectedBefore,
    expectedAfter,
    source: 'interactive-cli',
    note,
  });
}
