import { describe, expect, it } from 'vitest';
import {
  buildCharacterizationOracle,
  buildSpecificationOracle,
  promoteToSpecificationByTester,
  replaceExpectedByTester,
} from '../../src/core/unit/oracle/oracle-taxonomy.js';
import { evaluateOracleGate } from '../../src/core/unit/oracle/oracle-resolver.js';
import { migratePlanV1ToV2 } from '../../src/core/unit/plan-migrator.js';
import type { StructuredUnitPlan, UnitPlannedTestCase, UnitTarget } from '../../src/core/unit/schema.js';

function mockTarget(): UnitTarget {
  return {
    id: 'src/discount.ts#calculateDiscount',
    sourceFile: 'src/discount.ts',
    sourceHash: 'hash',
    symbol: 'calculateDiscount',
    kind: 'function',
    exported: true,
    defaultExport: false,
    async: false,
    parameters: [
      { name: 'price', type: 'number', optional: false },
      { name: 'percent', type: 'number', optional: false },
    ],
    returnType: 'number',
    startLine: 1,
    endLine: 5,
    rawCode: 'export function calculateDiscount(price: number, percent: number) { return price - percent; }',
    dependencies: [],
    supportingContext: {
      callGraph: [], helperDefinitions: [], typeDefinitions: [], constantDefinitions: [],
      reachableImports: [], unresolvedSymbols: [], truncated: false,
    },
    branches: [{ id: 'B001', kind: 'if', condition: 'default', outcome: 'return', line: 1 }],
    executionMode: 'NATIVE_DIRECT',
    profile: 'UNIT_NATIVE',
    runtimeEnvironment: 'node',
    profileReasons: ['pure'],
    unsupportedReasons: [],
  };
}

describe('Oracle Taxonomy v2 & Gate Resolver', () => {
  it('builds a Characterization oracle with static evaluation evidence', () => {
    const oracle = buildCharacterizationOracle('price - percent', 99990);
    expect(oracle.intentType).toBe('CHARACTERIZATION');
    expect(oracle.authority).toBe('IMPLEMENTATION');
    expect(oracle.evidence.method).toBe('STATIC_EVALUATION');
    expect(oracle.auditTrail).toEqual([]);
  });

  it('builds a Specification oracle from requirement code', () => {
    const oracle = buildSpecificationOracle('BR-DISCOUNT-01', 'Giảm 10% cho đơn 100.000đ');
    expect(oracle.intentType).toBe('SPECIFICATION');
    expect(oracle.authority).toBe('REQUIREMENT');
    expect(oracle.evidence.method).toBe('REQUIREMENT_REFERENCE');
    expect(oracle.evidence.reference).toBe('BR-DISCOUNT-01');
  });

  it('promotes Characterization to Specification by Tester with append-only audit entry', () => {
    const characterization = buildCharacterizationOracle('price - percent', 99990);
    const specification = promoteToSpecificationByTester(
      characterization,
      'LOCAL_TESTER',
      'Xác nhận 99990 là hành vi nghiệp vụ.',
    );

    expect(specification.intentType).toBe('SPECIFICATION');
    expect(specification.authority).toBe('TESTER_CONFIRMATION');
    expect(specification.auditTrail).toHaveLength(1);
    expect(specification.auditTrail[0].action).toBe('APPROVE_EXPECTED');
    expect(specification.auditTrail[0].previousOracle.intentType).toBe('CHARACTERIZATION');
    expect(specification.auditTrail[0].nextOracle.intentType).toBe('SPECIFICATION');
  });

  it('records REPLACE_EXPECTED when tester enters a different expected value', () => {
    const characterization = buildCharacterizationOracle('price - percent', 99990);
    const replaced = replaceExpectedByTester(
      characterization,
      99990,
      90000,
      'LOCAL_TESTER',
      'Tester thay đổi expected thành 90000 đúng nghiệp vụ.',
    );

    expect(replaced.intentType).toBe('SPECIFICATION');
    expect(replaced.authority).toBe('TESTER_CONFIRMATION');
    expect(replaced.auditTrail).toHaveLength(1);
    expect(replaced.auditTrail[0].action).toBe('REPLACE_EXPECTED');
    expect(replaced.auditTrail[0].expectedBefore).toBe(99990);
    expect(replaced.auditTrail[0].expectedAfter).toBe(90000);
  });

  it('migrates a v1 legacy plan to v2 seamlessly', () => {
    const planV1: StructuredUnitPlan = {
      version: 1,
      source: 'ai-planner',
      project: { name: 'test', root: '.', testFramework: 'vitest' },
      targets: [
        {
          sourceFile: 'src/discount.ts',
          symbol: 'calculateDiscount',
          sourceHash: 'hash',
          executionMode: 'NATIVE_DIRECT',
          profile: 'UNIT_NATIVE',
          testCases: [
            {
              id: 'UT_DISCOUNT_001',
              name: 'calculates discount',
              branchIds: ['B001'],
              inputs: { price: 100000, percent: 10 },
              expected: { kind: 'return', value: 90000 },
              oracleSource: 'requirement',
              oracleEvidence: { status: 'verified', source: 'requirement', reference: 'BR-01' },
              mocks: [],
            },
          ],
        },
      ],
      clarifications: [],
    };

    const planV2 = migratePlanV1ToV2(planV1);
    expect(planV2.version).toBe(2);
    const testCaseV2 = planV2.targets[0].testCases[0];
    expect(testCaseV2.oracle).toBeDefined();
    expect(testCaseV2.oracle?.intentType).toBe('SPECIFICATION');
    expect(testCaseV2.oracle?.authority).toBe('REQUIREMENT');
  });

  it('detects CONFLICT_WITH_SPEC when implementation differs from requirement, preserving specExpected', () => {
    const target = mockTarget(); // Code returns price - percent (100000 - 10 = 99990)
    const testCase: UnitPlannedTestCase = {
      id: 'UT_DISCOUNT_001',
      name: 'should give 90000 for 10% of 100000',
      branchIds: ['B001'],
      inputs: { price: 100000, percent: 10 },
      expected: { kind: 'return', value: 90000 }, // Requirement says 90000
      oracle: buildSpecificationOracle('BR-DISCOUNT-01', 'Expected = 90000'),
      mocks: [],
    };

    const gate = evaluateOracleGate(
      { requirements: 'Mã BR-DISCOUNT-01: Chiết khấu phải giảm đúng 10%.' },
      target,
      testCase,
    );

    expect(gate.gateStatus).toBe('CONFLICT_WITH_SPEC');
    expect(gate.reason).toContain('Mâu thuẫn với Requirement');
    expect(gate.specExpected).toEqual({ kind: 'return', value: 90000 });
  });
});
