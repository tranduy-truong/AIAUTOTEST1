import type { StructuredUnitPlan, UnitPlannedTestCase } from './schema.js';
import type {
  ComprehensiveOracle,
  OracleAuthority,
  OracleEvidenceMethod,
  OracleEvidenceStatus,
  TestIntentType,
} from './oracle/oracle-taxonomy.js';

export function migrateTestCaseV1ToV2(testCase: UnitPlannedTestCase): UnitPlannedTestCase {
  if (testCase.oracle) {
    return testCase; // Already v2
  }

  const legacySource = testCase.oracleSource || 'implementation';
  const legacyEvidence = testCase.oracleEvidence;

  let intentType: TestIntentType = 'CHARACTERIZATION';
  let authority: OracleAuthority = 'IMPLEMENTATION';
  let method: OracleEvidenceMethod = 'STATIC_EVALUATION';
  let status: OracleEvidenceStatus = 'VERIFIED';

  if (legacySource === 'requirement' || legacyEvidence?.source === 'requirement') {
    intentType = 'SPECIFICATION';
    authority = 'REQUIREMENT';
    method = 'REQUIREMENT_REFERENCE';
  } else if (legacySource === 'tester-confirmation' || legacyEvidence?.source === 'tester-confirmation') {
    intentType = 'SPECIFICATION';
    authority = 'TESTER_CONFIRMATION';
    method = 'TESTER_APPROVAL';
  } else if (legacySource === 'existing-test' || legacyEvidence?.source === 'existing-test') {
    intentType = 'CHARACTERIZATION';
    authority = 'EXISTING_TEST';
    method = 'EXISTING_TEST_REFERENCE';
  }

  const oracle: ComprehensiveOracle = {
    intentType,
    authority,
    evidence: {
      status,
      method,
      reference: legacyEvidence?.reference || legacyEvidence?.expression,
      description: `Migrated from v1 plan (source: ${legacySource})`,
    },
    auditTrail: [],
  };

  return {
    ...testCase,
    oracle,
  };
}

export function migratePlanV1ToV2(plan: StructuredUnitPlan): StructuredUnitPlan {
  if (plan.version === 2) {
    return plan;
  }

  const migratedTargets = plan.targets.map(target => ({
    ...target,
    testCases: target.testCases.map(migrateTestCaseV1ToV2),
  }));

  return {
    ...plan,
    version: 2,
    targets: migratedTargets,
  };
}
