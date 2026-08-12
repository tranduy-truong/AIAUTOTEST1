import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { analyzeUnitInput } from '../../src/core/unit/artifacts.js';
import {
  prepareOracleVerifiedPlan,
  typecheckGeneratedUnitFile,
} from '../../src/agents/generator/unit-generator.js';
import { compileUnitTestFile } from '../../src/core/unit/compiler/test-file-compiler.js';
import { resolveUnitPlannerProposal } from '../../src/core/unit/planner-fallback.js';
import { buildDeterministicUnitTarget } from '../../src/core/unit/deterministic-plan-builder.js';
import { resolveUnitTestOracle } from '../../src/core/unit/oracle/oracle-resolver.js';
import { validateStructuredUnitPlan } from '../../src/core/unit/plan-validator.js';
import type { UnitContextBundle, UnitTarget } from '../../src/core/unit/schema.js';

function ollamaRunContext(): UnitContextBundle {
  const analysis = analyzeUnitInput(process.cwd());
  const target = analysis.index.targets.find(item =>
    item.sourceFile === 'src/adapters/ollama.ts' && item.symbol === 'OllamaAdapter.run');
  if (!target) throw new Error('OllamaAdapter.run target missing from repository fixture.');
  return { version: 1, project: analysis.manifest, targets: [target] };
}

describe('Unit Planner deterministic fallback', () => {
  it('infers required object properties used by pasted snippets instead of emitting an empty object', () => {
    const target: UnitTarget = {
      id: 'snippet.ts#Adapter.run', sourceFile: 'snippet.ts', sourceHash: 'fixture-hash',
      symbol: 'Adapter.run', kind: 'class-method', exported: true, defaultExport: false, async: true,
      parameters: [{ name: 'opts', type: 'MissingImportedOptions', optional: false }],
      returnType: 'Promise<unknown>', startLine: 1, endLine: 3,
      rawCode: 'async run(opts: MissingImportedOptions) { return path.join(opts.promptDir, "task.md"); }',
      classMethod: { className: 'Adapter', methodName: 'run', static: false, constructorParameters: [] },
      dependencies: [],
      supportingContext: {
        callGraph: [], helperDefinitions: [], typeDefinitions: [], constantDefinitions: [],
        reachableImports: [], unresolvedSymbols: ['MissingImportedOptions'], truncated: false,
      },
      branches: [],
      executionMode: 'NATIVE_DIRECT', profile: 'UNIT_NATIVE', runtimeEnvironment: 'node',
      profileReasons: [], unsupportedReasons: [],
    };

    const planned = buildDeterministicUnitTarget(target);
    expect(planned.testCases[0].inputs).toEqual({ opts: { promptDir: 'fixture' } });
  });

  it('solves direct parameter conditions for true and false branch inputs', () => {
    const fixtureTarget: UnitTarget = {
      id: 'src/discount.ts#discount', sourceFile: 'src/discount.ts', sourceHash: 'fixture-hash',
      symbol: 'discount', kind: 'function', exported: true, defaultExport: false, async: false,
      parameters: [{ name: 'total', type: 'number', optional: false }], returnType: 'number',
      startLine: 1, endLine: 4,
      rawCode: 'export function discount(total: number) { if (total <= 0) return -1; return total; }',
      dependencies: [],
      supportingContext: {
        callGraph: [], helperDefinitions: [], typeDefinitions: [], constantDefinitions: [],
        reachableImports: [], unresolvedSymbols: [], truncated: false,
      },
      branches: [
        { id: 'B001_TRUE', kind: 'if', condition: 'total <= 0', outcome: 'return -1', line: 1 },
        { id: 'B001_FALSE', kind: 'if', condition: 'total <= 0', outcome: 'continue', line: 1 },
      ],
      executionMode: 'NATIVE_DIRECT', profile: 'UNIT_NATIVE', runtimeEnvironment: 'node',
      profileReasons: ['pure'], unsupportedReasons: [],
    };
    const base = ollamaRunContext();
    const context: UnitContextBundle = {
      version: 1,
      project: { ...base.project, sourceFiles: ['src/discount.ts'] },
      targets: [fixtureTarget],
    };
    const result = resolveUnitPlannerProposal('invalid json', context);
    const cases = result.plan!.targets[0].testCases;
    expect(cases.find(testCase => testCase.branchIds.includes('B001_TRUE'))).toMatchObject({
      inputs: { total: 0 }, expected: { kind: 'return', value: -1 },
    });
    expect(cases.find(testCase => testCase.branchIds.includes('B001_FALSE'))).toMatchObject({
      inputs: { total: 1 }, expected: { kind: 'return', value: 1 },
    });
  });

  it('continues with a contract-valid AST plan when AI returns invalid JSON', () => {
    const context = ollamaRunContext();
    const result = resolveUnitPlannerProposal('Here is the plan: { truncated', context);

    expect(result.mode).toBe('deterministic-fallback');
    expect(result.issues).toEqual([]);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INVALID_JSON' }),
    ]));
    expect(result.plan?.source).toBe('deterministic-planner');
    expect(validateStructuredUnitPlan(result.plan!, context).filter(issue => issue.code !== 'UNCOVERED_BRANCH'))
      .toEqual([]);
  });

  it('derives verifiable process/network outcomes without executing real IO', () => {
    const context = ollamaRunContext();
    const result = resolveUnitPlannerProposal('not json', context);
    const target = context.targets[0];
    const testCases = result.plan?.targets[0].testCases || [];

    expect(testCases.length).toBeGreaterThanOrEqual(3);
    for (const testCase of testCases) {
      expect(resolveUnitTestOracle(context, target, testCase)).toMatchObject({ status: 'VERIFIED' });
    }
    expect(testCases.map(testCase => testCase.expected)).toEqual(expect.arrayContaining([
      { kind: 'resolve', value: { ok: true, rawOutput: 'fixture', durationMs: 50 } },
      { kind: 'resolve', value: { ok: false, rawOutput: 'Error: fixture failure', durationMs: 50 } },
    ]));
  });

  it('also falls back when the AI provider itself fails', () => {
    const context = ollamaRunContext();
    const result = resolveUnitPlannerProposal('rate limit exceeded', context, true);
    expect(result.mode).toBe('deterministic-fallback');
    expect(result.issues).toEqual([]);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AI_API_ERROR' }),
    ]));
  });

  it('compiles and executes the fallback plan end-to-end', () => {
    const context = ollamaRunContext();
    const target = context.targets[0];
    const resolved = resolveUnitPlannerProposal('invalid json', context);
    const prepared = prepareOracleVerifiedPlan(context, target, resolved.plan!.targets[0]);
    expect(prepared.unresolvedCases).toEqual([]);

    const compiled = compileUnitTestFile({
      target,
      planTarget: prepared.planTarget,
      framework: 'vitest',
      importPath: '../../../src/adapters/ollama.js',
      dependencyPaths: new Map(target.dependencies.map(dependency => [dependency.module, dependency.module])),
    });
    expect(compiled.testCases.every(testCase => testCase.status === 'GENERATED')).toBe(true);

    const generatedDirectory = path.join(process.cwd(), 'tests', 'unit', 'ai-generated');
    const testFile = path.join(generatedDirectory, '.ollama-planner-fallback-generated.test.ts');
    try {
      fs.mkdirSync(generatedDirectory, { recursive: true });
      fs.writeFileSync(testFile, compiled.code!);
      expect(typecheckGeneratedUnitFile(process.cwd(), testFile)).toEqual([]);
      const executed = spawnSync(process.execPath, [
        path.join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs'),
        'run', testFile,
      ], { cwd: process.cwd(), encoding: 'utf-8' });
      expect(`${executed.stdout}\n${executed.stderr}`).toContain(`${prepared.planTarget.testCases.length} passed`);
      expect(executed.status).toBe(0);
    } finally {
      fs.rmSync(testFile, { force: true });
    }
  });
});
