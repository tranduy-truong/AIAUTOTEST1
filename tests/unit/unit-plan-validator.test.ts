import { describe, expect, it } from 'vitest';
import {
  anchorStructuredUnitPlan,
  parseStructuredUnitPlan,
  salvageStructuredUnitPlan,
  validateStructuredUnitPlan,
} from '../../src/core/unit/plan-validator.js';
import type {
  StructuredUnitPlan,
  UnitContextBundle,
  UnitTarget,
} from '../../src/core/unit/schema.js';

function target(): UnitTarget {
  return {
    id: 'src/discount.ts#applyDiscount', sourceFile: 'src/discount.ts', sourceHash: 'hash-123',
    symbol: 'applyDiscount', kind: 'function', exported: true, defaultExport: false, async: false,
    parameters: [{ name: 'total', type: 'number', optional: false }], returnType: 'number',
    startLine: 1, endLine: 4, rawCode: 'export function applyDiscount(total: number) { return total; }',
    dependencies: [{ module: './db', importedNames: ['db'], external: false, boundary: 'database', strategy: 'mock', resolvedFile: 'src/db.ts' }],
    supportingContext: {
      callGraph: [], helperDefinitions: [], typeDefinitions: [], constantDefinitions: [],
      reachableImports: [{
        sourceFile: 'src/discount.ts', module: './db', importedNames: ['db'], resolvedFile: 'src/db.ts',
      }],
      unresolvedSymbols: [], truncated: false,
    },
    branches: [
      { id: 'B001_TRUE', kind: 'if', condition: 'total <= 0', outcome: 'throw', line: 2 },
      { id: 'B001_FALSE', kind: 'if', condition: 'total <= 0', outcome: 'continue', line: 2 },
    ],
    executionMode: 'NATIVE_WITH_MOCKS', profile: 'UNIT_MOCKED', runtimeEnvironment: 'node',
    profileReasons: ['mock boundary'], unsupportedReasons: [],
  };
}

function context(): UnitContextBundle {
  return {
    version: 1,
    project: {
      version: 1, projectName: 'shop', projectRoot: '/project', packageType: 'module',
      language: 'typescript', testFramework: 'vitest', packageManager: 'npm',
      sourceFiles: ['src/discount.ts'], configFiles: ['package.json'], scannedAt: '2026-08-11T00:00:00.000Z',
    },
    targets: [target()],
  };
}

function validPlan(): StructuredUnitPlan {
  return {
    version: 1, source: 'ai-planner',
    project: { name: 'shop', root: '/project', testFramework: 'vitest' },
    targets: [{
      sourceFile: 'src/discount.ts', symbol: 'applyDiscount', sourceHash: 'hash-123', executionMode: 'NATIVE_WITH_MOCKS',
      profile: 'UNIT_MOCKED',
      testCases: [
        {
          id: 'UT_DISCOUNT_001', name: 'reject invalid total', branchIds: ['B001_TRUE'], inputs: { total: 0 },
          expected: { kind: 'throw', message: 'INVALID_TOTAL' }, oracleSource: 'implementation',
          mocks: [{ module: './db', symbol: 'db', behavior: { kind: 'return', value: null } }],
        },
        {
          id: 'UT_DISCOUNT_002', name: 'returns valid total', branchIds: ['B001_FALSE'], inputs: { total: 100 },
          expected: { kind: 'return', value: 100 }, oracleSource: 'implementation',
          mocks: [{ module: './db', symbol: 'db', behavior: { kind: 'return', value: null } }],
        },
      ],
    }],
    clarifications: [],
  };
}

describe('Structured Unit Plan validator', () => {
  it('extracts valid JSON from provider prose/fences and removes only trailing commas', () => {
    const raw = `Planner result:\n\`\`\`json\n${JSON.stringify(validPlan(), null, 2).replace(/\n}/g, ',\n}')}\n\`\`\``;
    expect(parseStructuredUnitPlan(raw)?.targets[0].symbol).toBe('applyDiscount');
  });

  it('does not invent missing content for truncated JSON', () => {
    expect(parseStructuredUnitPlan('{"version":1,"source":"ai-planner","targets":[')).toBeNull();
  });

  it('accepts a plan grounded in source hash, branch map, and dependency map', () => {
    expect(validateStructuredUnitPlan(validPlan(), context())).toEqual([]);
  });

  it('allows supplemental constructor/setup tests without a branch ID when real branches remain covered', () => {
    const plan = validPlan();
    plan.targets[0].testCases.unshift({
      id: 'UT_DISCOUNT_000',
      name: 'initializes exported module metadata',
      branchIds: [],
      inputs: { total: 100 },
      expected: { kind: 'return', value: 100 },
      oracleSource: 'type-contract',
      mocks: [{ module: './db', symbol: 'db', behavior: { kind: 'return', value: null } }],
    });

    expect(validateStructuredUnitPlan(plan, context())).toEqual([]);
  });

  it('blocks invented branches, mocks, and stale source hashes', () => {
    const plan = validPlan();
    plan.targets[0].sourceHash = 'stale';
    plan.targets[0].testCases[0].branchIds = ['B999_FAKE'];
    plan.targets[0].testCases[0].mocks = [{ module: './invented', behavior: { kind: 'return', value: null } }];
    const codes = validateStructuredUnitPlan(plan, context()).map(issue => issue.code);

    expect(codes).toContain('STALE_OR_INVENTED_SOURCE_HASH');
    expect(codes).toContain('INVENTED_BRANCH');
    expect(codes).toContain('INVENTED_MOCK');
    expect(codes).toContain('UNCOVERED_BRANCH');
  });

  it('requires safety-boundary mocks and blocks mocking real dependencies', () => {
    const ctx = context();
    ctx.targets[0].dependencies.push({
      module: './math', importedNames: ['round'], external: false,
      boundary: 'internal', strategy: 'real', resolvedFile: 'src/math.ts',
    });
    const plan = validPlan();
    plan.targets[0].testCases[0].mocks = [{ module: './math', behavior: { kind: 'return', value: 1 } }];
    const codes = validateStructuredUnitPlan(plan, ctx).map(issue => issue.code);

    expect(codes).toContain('MOCK_OF_REAL_DEPENDENCY');
    expect(codes).toContain('MISSING_REQUIRED_MOCK');
  });

  it('preserves Map return types in async oracles', () => {
    const ctx = context();
    ctx.targets[0].async = true;
    ctx.targets[0].returnType = 'Promise<Map<string, number>>';
    const plan = validPlan();
    plan.targets[0].testCases.forEach(testCase => {
      testCase.expected = {
        kind: 'resolve',
        value: { $type: 'map', entries: [['total', 100]] },
      };
    });
    expect(validateStructuredUnitPlan(plan, ctx)).toEqual([]);

    plan.targets[0].testCases[0].expected = { kind: 'resolve', value: { total: 100 } };
    expect(validateStructuredUnitPlan(plan, ctx).map(issue => issue.code))
      .toContain('RETURN_TYPE_ORACLE_MISMATCH');
  });

  it('blocks missing, invented, and primitive-mismatched function inputs', () => {
    const plan = validPlan();
    plan.targets[0].testCases[0].inputs = { total: 'not-a-number', invented: true };
    const codes = validateStructuredUnitPlan(plan, context()).map(issue => issue.code);

    expect(codes).toContain('INPUT_TYPE_MISMATCH');
    expect(codes).toContain('INVENTED_INPUT');

    plan.targets[0].testCases[0].inputs = {};
    expect(validateStructuredUnitPlan(plan, context()).map(issue => issue.code))
      .toContain('MISSING_REQUIRED_INPUT');
  });

  it('re-anchors immutable Code Reader fields without changing test intent', () => {
    const plan = validPlan();
    plan.project = { name: 'invented', root: '/invented', testFramework: 'jest' };
    plan.targets[0].sourceFile = 'wrong.ts';
    plan.targets[0].symbol = 'wrong';
    plan.targets[0].sourceHash = 'wrong';
    plan.targets[0].executionMode = 'NATIVE_DIRECT';

    const anchored = anchorStructuredUnitPlan(plan, context());

    expect(anchored.project).toEqual({ name: 'shop', root: '/project', testFramework: 'vitest' });
    expect(anchored.targets[0]).toEqual(expect.objectContaining({
      sourceFile: 'src/discount.ts', symbol: 'applyDiscount', sourceHash: 'hash-123',
      executionMode: 'NATIVE_WITH_MOCKS',
    }));
    expect(anchored.targets[0].testCases).toEqual(plan.targets[0].testCases);
    expect(validateStructuredUnitPlan(anchored, context())).toEqual([]);
  });

  it('validates method inputs separately from class constructor inputs', () => {
    const ctx = context();
    ctx.targets[0] = {
      ...ctx.targets[0],
      id: 'src/discount.ts#DiscountService.apply',
      symbol: 'DiscountService.apply',
      kind: 'class-method',
      async: true,
      parameters: [{ name: 'total', type: 'number', optional: false }],
      returnType: 'Promise<number>',
      classMethod: {
        className: 'DiscountService', methodName: 'apply', static: false,
        constructorParameters: [{ name: 'rate', type: 'number', optional: false }],
      },
    };
    const plan = validPlan();
    plan.targets[0].symbol = 'DiscountService.apply';
    plan.targets[0].testCases.forEach(testCase => {
      testCase.inputs = { total: 100 };
      testCase.constructorInputs = { rate: 0.1 };
      testCase.expected = { kind: 'resolve', value: 90 };
    });

    expect(validateStructuredUnitPlan(plan, ctx)).toEqual([]);
    delete plan.targets[0].testCases[0].constructorInputs;
    expect(validateStructuredUnitPlan(plan, ctx).map(issue => issue.code))
      .toContain('MISSING_REQUIRED_CONSTRUCTOR_INPUT');
  });

  it('isolates an invalid test intent instead of discarding the whole target', () => {
    const plan = validPlan();
    plan.targets[0].testCases[0].inputs = { total: 'wrong-type' };

    const salvaged = salvageStructuredUnitPlan(plan, context());

    expect(salvaged.blockingIssues).toEqual([]);
    expect(salvaged.plan?.targets[0].testCases.map(testCase => testCase.id))
      .toEqual(['UT_DISCOUNT_002']);
    expect(salvaged.skippedIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ testCaseId: 'UT_DISCOUNT_001', code: 'INPUT_TYPE_MISMATCH' }),
      expect.objectContaining({ code: 'UNCOVERED_BRANCH' }),
    ]));
  });
});
