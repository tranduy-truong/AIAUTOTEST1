import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { compileUnitTestFile } from '../../src/core/unit/compiler/test-file-compiler.js';
import { analyzeUnitInput } from '../../src/core/unit/artifacts.js';
import {
  prepareOracleVerifiedPlan,
  typecheckGeneratedUnitFile,
  validateGeneratedUnitCode,
} from '../../src/agents/generator/unit-generator.js';
import type { UnitPlanTarget, UnitTarget } from '../../src/core/unit/schema.js';

function ollamaPlan(target: UnitTarget): UnitPlanTarget {
  return {
    sourceFile: target.sourceFile,
    symbol: target.symbol,
    sourceHash: target.sourceHash,
    executionMode: target.executionMode,
    profile: target.profile,
    testCases: [{
      id: 'UT_OLLAMA_RUN_001',
      name: 'returns model response with measured duration',
      branchIds: target.branches.map(branch => branch.id),
      inputs: {
        opts: {
          promptDir: '/fixture/prompt',
          workDir: '/fixture/work',
          timeoutMs: 1000,
        },
      },
      constructorInputs: {},
      mocks: [
        { module: 'fs', symbol: 'existsSync', behavior: { kind: 'return', value: true } },
        { module: 'fs', symbol: 'readFileSync', behavior: { kind: 'return', value: 'prompt' } },
        {
          module: 'globalThis.fetch', symbol: 'fetch',
          behavior: {
            kind: 'resolve',
            methods: { json: { kind: 'resolve', value: { response: 'answer' } } },
          },
        },
        {
          module: 'Date.now', symbol: 'Date.now',
          behavior: {
            kind: 'return', value: 150,
            sequence: [{ kind: 'return', value: 100 }, { kind: 'return', value: 150 }],
          },
        },
      ],
      expected: {
        kind: 'resolve',
        value: { ok: true, rawOutput: 'answer', durationMs: 50 },
      },
      oracleSource: 'implementation',
    }],
  };
}

describe('Deterministic Unit Compiler', () => {
  it('compiles a native pure function without mock boilerplate', () => {
    const target: UnitTarget = {
      id: 'src/math.ts#sum', sourceFile: 'src/math.ts', sourceHash: 'hash',
      symbol: 'sum', kind: 'function', exported: true, defaultExport: false, async: false,
      parameters: [
        { name: 'left', type: 'number', optional: false },
        { name: 'right', type: 'number', optional: false },
      ],
      returnType: 'number', startLine: 1, endLine: 1,
      rawCode: 'export const sum = (left: number, right: number) => left + right;',
      dependencies: [],
      supportingContext: {
        callGraph: [], helperDefinitions: [], typeDefinitions: [], constantDefinitions: [],
        reachableImports: [], unresolvedSymbols: [], truncated: false,
      },
      branches: [{ id: 'B001_PATH', kind: 'if', condition: 'default execution path', outcome: 'return', line: 1 }],
      executionMode: 'NATIVE_DIRECT', profile: 'UNIT_NATIVE', runtimeEnvironment: 'node',
      profileReasons: ['pure'], unsupportedReasons: [],
    };
    const plan: UnitPlanTarget = {
      sourceFile: target.sourceFile, symbol: target.symbol, sourceHash: target.sourceHash,
      executionMode: target.executionMode, profile: target.profile,
      testCases: [{
        id: 'UT_SUM_001', name: 'adds two numbers', branchIds: ['B001_PATH'],
        inputs: { left: 2, right: 3 }, expected: { kind: 'return', value: 5 },
        oracleSource: 'implementation', mocks: [],
      }],
    };

    const result = compileUnitTestFile({
      target, planTarget: plan, framework: 'vitest', importPath: '../../../src/math.js',
      dependencyPaths: new Map(),
    });

    expect(result.code).toContain('expect(sum(2, 3)).toEqual(5)');
    expect(result.code).not.toContain('vi.mock(');
  });

  it('detects concrete process operations used by OllamaAdapter.run', () => {
    const analysis = analyzeUnitInput(process.cwd());
    const target = analysis.index.targets.find(item => item.id === 'src/adapters/ollama.ts#OllamaAdapter.run');
    expect(target?.profile).toBe('PROCESS_SANDBOX');
    expect(target?.dependencies.find(dependency => dependency.module === 'fs')?.usedMembers)
      .toEqual(expect.arrayContaining(['existsSync', 'readFileSync']));
    expect(target?.dependencies.map(dependency => dependency.module))
      .toEqual(expect.arrayContaining(['globalThis.fetch', 'Date.now']));
  });

  it('compiles OllamaAdapter.run without an AI-generated TypeScript body', () => {
    const analysis = analyzeUnitInput(process.cwd());
    const target = analysis.index.targets.find(item => item.id === 'src/adapters/ollama.ts#OllamaAdapter.run');
    expect(target).toBeDefined();
    const plan = ollamaPlan(target!);
    const dependencyPaths = new Map(target!.dependencies.map(dependency => [dependency.module, dependency.module]));
    const result = compileUnitTestFile({
      target: target!,
      planTarget: plan,
      framework: 'vitest',
      importPath: '../../../src/adapters/ollama.js',
      dependencyPaths,
    });

    expect(result.testCases).toEqual([{ testCaseId: 'UT_OLLAMA_RUN_001', status: 'GENERATED', errors: [] }]);
    expect(result.code).toMatch(/import \{ OllamaAdapter \} from ["']\.\.\/\.\.\/\.\.\/src\/adapters\/ollama\.js["']/);
    expect(result.code).toMatch(/vi\.mock\(["']fs["']/);
    expect(result.code).toMatch(/vi\.stubGlobal\(["']fetch["']/);
    expect(result.code).toContain("new OllamaAdapter().run(");
    const parsed = ts.createSourceFile('ollama.test.ts', result.code!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const diagnostics = (parsed as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics || [];
    expect(diagnostics).toEqual([]);
    expect(validateGeneratedUnitCode({
      code: result.code!, target: target!, planTarget: plan,
      importPath: '../../../src/adapters/ollama.js', framework: 'vitest', dependencyPaths,
    })).toEqual({ ok: true, errors: [] });

    const generatedDirectory = path.join(process.cwd(), 'tests', 'unit', 'ai-generated');
    const testFile = path.join(generatedDirectory, '.ollama-deterministic-generated.test.ts');
    try {
      fs.mkdirSync(generatedDirectory, { recursive: true });
      fs.writeFileSync(testFile, result.code!);
      expect(typecheckGeneratedUnitFile(process.cwd(), testFile)).toEqual([]);
      const executed = spawnSync(process.execPath, [
        path.join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs'),
        'run', testFile,
      ], { cwd: process.cwd(), encoding: 'utf-8' });
      expect(`${executed.stdout}\n${executed.stderr}`).toContain('1 passed');
      expect(executed.status).toBe(0);
    } finally {
      fs.rmSync(testFile, { force: true });
    }
  });

  it('keeps valid cases when another case has no oracle', () => {
    const analysis = analyzeUnitInput(process.cwd());
    const target = analysis.index.targets.find(item => item.id === 'src/adapters/ollama.ts#OllamaAdapter.run')!;
    const plan = ollamaPlan(target);
    plan.testCases.push({
      ...plan.testCases[0],
      id: 'UT_OLLAMA_RUN_002',
      name: 'missing expected value',
      expected: { kind: 'resolve' },
    });
    const result = compileUnitTestFile({
      target,
      planTarget: plan,
      framework: 'vitest',
      importPath: '../../../src/adapters/ollama.js',
      dependencyPaths: new Map(target.dependencies.map(dependency => [dependency.module, dependency.module])),
    });

    expect(result.code).toContain('UT_OLLAMA_RUN_001');
    expect(result.code).not.toContain('UT_OLLAMA_RUN_002');
    expect(result.testCases).toEqual(expect.arrayContaining([
      expect.objectContaining({ testCaseId: 'UT_OLLAMA_RUN_001', status: 'GENERATED' }),
      expect.objectContaining({ testCaseId: 'UT_OLLAMA_RUN_002', status: 'NEEDS_ORACLE' }),
    ]));
  });

  it('generates and runs OllamaAdapter.isAvailable from verified process mock traces', () => {
    const analysis = analyzeUnitInput(process.cwd());
    const target = analysis.index.targets.find(item => item.id === 'src/adapters/ollama.ts#OllamaAdapter.isAvailable')!;
    const plan: UnitPlanTarget = {
      sourceFile: target.sourceFile, symbol: target.symbol, sourceHash: target.sourceHash,
      executionMode: target.executionMode, profile: target.profile,
      testCases: [
        {
          id: 'UT_OLLAMA_AVAILABLE_001', name: 'returns true when Ollama command is available',
          branchIds: ['B001_TRY'], inputs: {}, constructorInputs: {},
          expected: { kind: 'resolve', value: true }, oracleSource: 'implementation',
          oracleEvidence: { status: 'proposed', source: 'ai-inference' },
          mocks: [{ module: 'child_process', symbol: 'execSync', behavior: { kind: 'return', value: '' } }],
        },
        {
          id: 'UT_OLLAMA_AVAILABLE_002', name: 'returns false when Ollama command is unavailable',
          branchIds: ['B001_CATCH'], inputs: {}, constructorInputs: {},
          expected: { kind: 'resolve', value: false }, oracleSource: 'implementation',
          oracleEvidence: { status: 'proposed', source: 'ai-inference' },
          mocks: [{ module: 'child_process', symbol: 'execSync', behavior: { kind: 'throw', message: 'not installed' } }],
        },
      ],
    };
    const prepared = prepareOracleVerifiedPlan({}, target, plan);
    expect(prepared.unresolvedCases).toEqual([]);
    expect(prepared.resolutions).toEqual([
      expect.objectContaining({ status: 'VERIFIED', evidence: expect.objectContaining({ source: 'mock-trace' }) }),
      expect.objectContaining({ status: 'VERIFIED', evidence: expect.objectContaining({ source: 'mock-trace' }) }),
    ]);
    const dependencyPaths = new Map(target.dependencies.map(dependency => [dependency.module, dependency.module]));
    const compiled = compileUnitTestFile({
      target, planTarget: prepared.planTarget, framework: 'vitest',
      importPath: '../../../src/adapters/ollama.js', dependencyPaths,
    });
    expect(compiled.testCases.every(testCase => testCase.status === 'GENERATED')).toBe(true);
    expect(compiled.code).toContain('vi.mock("child_process"');

    const generatedDirectory = path.join(process.cwd(), 'tests', 'unit', 'ai-generated');
    const testFile = path.join(generatedDirectory, '.ollama-availability-generated.test.ts');
    try {
      fs.mkdirSync(generatedDirectory, { recursive: true });
      fs.writeFileSync(testFile, compiled.code!);
      expect(typecheckGeneratedUnitFile(process.cwd(), testFile)).toEqual([]);
      const executed = spawnSync(process.execPath, [
        path.join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs'),
        'run', testFile,
      ], { cwd: process.cwd(), encoding: 'utf-8' });
      expect(`${executed.stdout}\n${executed.stderr}`).toContain('2 passed');
      expect(executed.status).toBe(0);
    } finally {
      fs.rmSync(testFile, { force: true });
    }
  });
});
