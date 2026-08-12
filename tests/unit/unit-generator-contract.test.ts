import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildGenerationManifest,
  typecheckGeneratedUnitFile,
  validateGeneratedUnitCode,
} from '../../src/agents/generator/unit-generator.js';
import type { UnitPlanTarget, UnitTarget } from '../../src/core/unit/schema.js';

const target: UnitTarget = {
  id: 'src/discount.ts#applyDiscount', sourceFile: 'src/discount.ts', sourceHash: 'hash',
  symbol: 'applyDiscount', kind: 'function', exported: true, defaultExport: false, async: false,
  parameters: [], returnType: 'number', startLine: 1, endLine: 1,
  rawCode: 'export function applyDiscount() { return 90; }',
  dependencies: [],
  supportingContext: {
    callGraph: [], helperDefinitions: [], typeDefinitions: [], constantDefinitions: [],
    reachableImports: [], unresolvedSymbols: [], truncated: false,
  },
  branches: [{ id: 'B001_PATH', kind: 'if', condition: 'default', outcome: 'return', line: 1 }],
  executionMode: 'NATIVE_DIRECT', profile: 'UNIT_NATIVE', runtimeEnvironment: 'node',
  profileReasons: ['pure logic'], unsupportedReasons: [],
};
const planTarget: UnitPlanTarget = {
  sourceFile: target.sourceFile, symbol: target.symbol, sourceHash: target.sourceHash,
  executionMode: target.executionMode,
  profile: target.profile,
  testCases: [{
    id: 'UT_DISCOUNT_001', name: 'returns discount', branchIds: ['B001_PATH'], inputs: {},
    expected: { kind: 'return', value: 90 }, oracleSource: 'implementation', mocks: [],
  }],
};

describe('Unit Generator contract', () => {
  it('typechecks a generated file before accepting it', () => {
    const goodFile = path.join(process.cwd(), 'tests', 'unit', '.unit-preflight-good.ts');
    const badFile = path.join(process.cwd(), 'tests', 'unit', '.unit-preflight-bad.ts');
    try {
      fs.writeFileSync(goodFile, 'const value: number = 1; export { value };\n');
      fs.writeFileSync(badFile, "const value: number = 'wrong'; export { value };\n");
      expect(typecheckGeneratedUnitFile(process.cwd(), goodFile)).toEqual([]);
      expect(typecheckGeneratedUnitFile(process.cwd(), badFile).join('\n')).toContain("not assignable to type 'number'");
    } finally {
      fs.rmSync(goodFile, { force: true });
      fs.rmSync(badFile, { force: true });
    }
  });

  it('accepts a test that imports the real source', () => {
    const code = `
import { describe, expect, it } from 'vitest';
import { applyDiscount } from '../../../src/discount';
describe('applyDiscount', () => {
  it('UT_DISCOUNT_001 - returns discount', () => {
    expect(applyDiscount()).toBe(90);
  });
});`;
    expect(validateGeneratedUnitCode({
      code, target, planTarget, importPath: '../../../src/discount', framework: 'vitest', dependencyPaths: new Map(),
    })).toEqual({ ok: true, errors: [] });
  });

  it('blocks pasted production code and skipped tests', () => {
    const code = `
import { describe, expect, it } from 'vitest';
import { applyDiscount } from '../../../src/discount';
function applyDiscount() { return 90; }
it.skip('UT_DISCOUNT_001', () => expect(applyDiscount()).toBe(90));`;
    const result = validateGeneratedUnitCode({
      code, target, planTarget, importPath: '../../../src/discount', framework: 'vitest', dependencyPaths: new Map(),
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('copy hàm'),
      expect.stringContaining('skip/only/todo'),
    ]));
  });

  it('blocks nested mocks and non-hoisted mock factory references', () => {
    const mockedTarget: UnitTarget = {
      ...target,
      dependencies: [{
        module: 'openai', importedNames: ['OpenAI'], external: true,
        boundary: 'network', strategy: 'mock',
      }],
      executionMode: 'NATIVE_WITH_MOCKS',
    };
    const mockedPlan: UnitPlanTarget = {
      ...planTarget,
      executionMode: 'NATIVE_WITH_MOCKS',
      testCases: planTarget.testCases.map(testCase => ({
        ...testCase,
        mocks: [{ module: 'openai', symbol: 'OpenAI', behavior: { kind: 'return', value: 'output' } }],
      })),
    };
    const code = `
import { describe, expect, it, vi } from 'vitest';
import { applyDiscount } from '../../../src/discount';
const output = 'unsafe';
describe('applyDiscount', () => {
  vi.mock('openai', () => ({ default: vi.fn(() => output) }));
  it('UT_DISCOUNT_001 - returns discount', () => expect(applyDiscount()).toBe(90));
});`;
    const result = validateGeneratedUnitCode({
      code, target: mockedTarget, planTarget: mockedPlan,
      importPath: '../../../src/discount', framework: 'vitest',
      dependencyPaths: new Map([['openai', 'openai']]),
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('top-level'),
      expect.stringContaining('chưa vi.hoisted'),
    ]));
  });

  it('accepts one self-contained top-level mock for a verified dependency', () => {
    const mockedTarget: UnitTarget = {
      ...target,
      dependencies: [{
        module: 'openai', importedNames: ['OpenAI'], external: true,
        boundary: 'network', strategy: 'mock',
      }],
      executionMode: 'NATIVE_WITH_MOCKS',
    };
    const mockedPlan: UnitPlanTarget = {
      ...planTarget,
      executionMode: 'NATIVE_WITH_MOCKS',
      testCases: planTarget.testCases.map(testCase => ({
        ...testCase,
        mocks: [{ module: 'openai', symbol: 'OpenAI', behavior: { kind: 'return', value: { ok: true } } }],
      })),
    };
    const code = `
import { describe, expect, it, vi } from 'vitest';
vi.mock('openai', () => ({ default: vi.fn(() => ({ ok: true })) }));
import { applyDiscount } from '../../../src/discount';
describe('applyDiscount', () => {
  it('UT_DISCOUNT_001 - returns discount', () => expect(applyDiscount()).toBe(90));
});`;
    expect(validateGeneratedUnitCode({
      code, target: mockedTarget, planTarget: mockedPlan,
      importPath: '../../../src/discount', framework: 'vitest',
      dependencyPaths: new Map([['openai', 'openai']]),
    })).toEqual({ ok: true, errors: [] });
  });

  it('accepts a class-method test that imports the owning class instead of a dotted symbol', () => {
    const methodTarget: UnitTarget = {
      ...target,
      id: 'src/adapter.ts#Adapter.run',
      sourceFile: 'src/adapter.ts',
      symbol: 'Adapter.run',
      kind: 'class-method',
      async: true,
      parameters: [{ name: 'value', type: 'string', optional: false }],
      returnType: 'Promise<string>',
      rawCode: 'async run(value: string) { return value; }',
      classMethod: {
        className: 'Adapter', methodName: 'run', static: false,
        constructorParameters: [{ name: 'prefix', type: 'string', optional: false }],
      },
    };
    const methodPlan: UnitPlanTarget = {
      sourceFile: methodTarget.sourceFile,
      symbol: methodTarget.symbol,
      sourceHash: methodTarget.sourceHash,
      executionMode: methodTarget.executionMode,
      profile: methodTarget.profile,
      testCases: [{
        id: 'UT_ADAPTER_RUN_001', name: 'returns value', branchIds: ['B001_PATH'],
        constructorInputs: { prefix: 'test' }, inputs: { value: 'value' },
        expected: { kind: 'resolve', value: 'value' }, oracleSource: 'implementation', mocks: [],
      }],
    };
    const code = `
import { describe, expect, it } from 'vitest';
import { Adapter } from '../../../src/adapter';
describe('Adapter.run', () => {
  it('UT_ADAPTER_RUN_001 - returns value', async () => {
    await expect(new Adapter('test').run('value')).resolves.toBe('value');
  });
});`;

    expect(validateGeneratedUnitCode({
      code, target: methodTarget, planTarget: methodPlan,
      importPath: '../../../src/adapter', framework: 'vitest', dependencyPaths: new Map(),
    })).toEqual({ ok: true, errors: [] });
  });

  it('requires verified global boundaries to be stubbed instead of vi.mocked as modules', () => {
    const globalTarget: UnitTarget = {
      ...target,
      dependencies: [{
        module: 'globalThis.fetch', importedNames: ['fetch'], external: true,
        boundary: 'network', strategy: 'mock', mockKind: 'global', globalName: 'fetch',
      }],
      executionMode: 'NATIVE_WITH_MOCKS',
    };
    const globalPlan: UnitPlanTarget = {
      ...planTarget,
      executionMode: 'NATIVE_WITH_MOCKS',
      testCases: planTarget.testCases.map(testCase => ({
        ...testCase,
        mocks: [{ module: 'globalThis.fetch', symbol: 'fetch', behavior: { kind: 'resolve', value: { ok: true } } }],
      })),
    };
    const withoutStub = `
import { describe, expect, it, vi } from 'vitest';
import { applyDiscount } from '../../../src/discount';
it('UT_DISCOUNT_001 - returns discount', () => expect(applyDiscount()).toBe(90));`;
    const withStub = `
import { describe, expect, it, vi } from 'vitest';
vi.stubGlobal('fetch', vi.fn());
import { applyDiscount } from '../../../src/discount';
it('UT_DISCOUNT_001 - returns discount', () => expect(applyDiscount()).toBe(90));`;

    expect(validateGeneratedUnitCode({
      code: withoutStub, target: globalTarget, planTarget: globalPlan,
      importPath: '../../../src/discount', framework: 'vitest',
      dependencyPaths: new Map([['globalThis.fetch', 'globalThis.fetch']]),
    }).errors).toContain('Thiếu mock global bắt buộc cho dependency: globalThis.fetch');
    expect(validateGeneratedUnitCode({
      code: withStub, target: globalTarget, planTarget: globalPlan,
      importPath: '../../../src/discount', framework: 'vitest',
      dependencyPaths: new Map([['globalThis.fetch', 'globalThis.fetch']]),
    })).toEqual({ ok: true, errors: [] });
  });

  it('summarizes mixed target outcomes without treating one failure as a batch crash', () => {
    const manifest = buildGenerationManifest([
      { target: 'a#ok', profile: 'UNIT_NATIVE', status: 'GENERATED', file: '/tmp/a.test.ts', errors: [] },
      { target: 'b#bad', profile: 'PROCESS_SANDBOX', status: 'TYPECHECK_FAILED', errors: ['type error'] },
      { target: 'c#skip', profile: 'INTEGRATION_SANDBOX', status: 'PROFILE_NOT_SUPPORTED', errors: ['no sandbox'] },
    ]);

    expect(manifest.summary).toEqual(expect.objectContaining({ total: 3, generated: 1, notGenerated: 2 }));
    expect(manifest.summary.statusCounts).toEqual({
      GENERATED: 1,
      TYPECHECK_FAILED: 1,
      PROFILE_NOT_SUPPORTED: 1,
    });
    expect(manifest.generatedFiles).toEqual(['/tmp/a.test.ts']);
  });

  it('counts a partially generated target as runnable while preserving case failures', () => {
    const manifest = buildGenerationManifest([{
      target: 'src/service.ts#Service.run',
      profile: 'UNIT_MOCKED',
      status: 'PARTIAL',
      file: '/tmp/service.test.ts',
      errors: ['UT_SERVICE_002 needs oracle'],
      testCases: [
        { testCaseId: 'UT_SERVICE_001', status: 'GENERATED', errors: [] },
        { testCaseId: 'UT_SERVICE_002', status: 'NEEDS_ORACLE', errors: ['missing expected value'] },
      ],
    }]);

    expect(manifest.summary).toEqual(expect.objectContaining({ generated: 1, notGenerated: 0 }));
    expect(manifest.targets[0].testCases?.[1].status).toBe('NEEDS_ORACLE');
  });
});
