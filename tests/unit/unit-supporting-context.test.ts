import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeUnitInput } from '../../src/core/unit/artifacts.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createContextProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testkit-supporting-context-'));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'src', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'core'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'supporting-context-sample', type: 'module', devDependencies: { vitest: '^4.0.0' },
  }));
  fs.writeFileSync(path.join(root, 'src', 'core', 'action-plan.ts'), `
export interface ResolvedAction {
  type: string;
  code: string;
}
export interface ActionPlan {
  testCases: Array<{ id: string; actions: ResolvedAction[] }>;
}
`);
  fs.writeFileSync(path.join(root, 'src', 'agents', 'generator.ts'), `
import fs from 'fs';
import OpenAI from 'openai';
import type { ActionPlan } from '../core/action-plan.js';

const PREFIX = 'verified';
const UNUSED = 'not reachable';

function compactAction(action: { type: string; code: string }) {
  return { type: action.type, code: action.code };
}

function compactPlan(plan: ActionPlan) {
  return {
    contract: PREFIX,
    testCases: plan.testCases.map(testCase => ({
      id: testCase.id,
      actions: testCase.actions.map(compactAction),
    })),
  };
}

function unrelatedFileWork() { fs.writeFileSync('x.txt', UNUSED); }
function unrelatedNetworkWork() { return new OpenAI({ apiKey: 'secret' }); }

export function buildContext(plan: ActionPlan): string {
  return JSON.stringify(compactPlan(plan));
}
`);
  return root;
}

describe('Unit Supporting Context Resolver', () => {
  it('grounds the real buildGeneratorContext target without unrelated file imports', () => {
    const analysis = analyzeUnitInput(path.join(process.cwd(), 'src', 'agents', 'generator', 'run.ts'));
    const target = analysis.index.targets.find(item => item.symbol === 'buildGeneratorContext');

    expect(target?.supportingContext.helperDefinitions.map(item => item.symbol)).toEqual(expect.arrayContaining([
      'compactAgentContract', 'compactStructuredPlannerPlan', 'limitDomReport', 'readPlannerNames',
    ]));
    expect(target?.supportingContext.typeDefinitions.map(item => item.symbol))
      .toEqual(expect.arrayContaining(['ActionPlan', 'ResolvedAction']));
    expect(target?.dependencies).toEqual([
      expect.objectContaining({
        module: '../../core/action-plan.js',
        strategy: 'real',
        resolvedFile: 'src/core/action-plan.ts',
      }),
    ]);
    expect(target?.dependencies.map(item => item.module)).not.toEqual(expect.arrayContaining([
      'fs', 'path', '../../adapters/openai.js', './unit-generator.js',
    ]));
  });

  it('collects reachable helpers, constants, and imported type definitions transitively', () => {
    const root = createContextProject();
    const analysis = analyzeUnitInput(path.join(root, 'src', 'agents', 'generator.ts'));
    const target = analysis.index.targets.find(item => item.symbol === 'buildContext');

    expect(target?.supportingContext.helperDefinitions.map(item => item.symbol))
      .toEqual(expect.arrayContaining(['compactPlan', 'compactAction']));
    expect(target?.supportingContext.constantDefinitions.map(item => item.symbol)).toContain('PREFIX');
    expect(target?.supportingContext.typeDefinitions.map(item => item.symbol))
      .toEqual(expect.arrayContaining(['ActionPlan', 'ResolvedAction']));
    expect(target?.supportingContext.callGraph).toEqual(expect.arrayContaining([
      expect.objectContaining({ caller: 'buildContext', callee: 'compactPlan' }),
      expect.objectContaining({ caller: 'compactPlan', callee: 'compactAction' }),
    ]));
  });

  it('does not attach imports used only by unreachable functions', () => {
    const root = createContextProject();
    const analysis = analyzeUnitInput(path.join(root, 'src', 'agents', 'generator.ts'));
    const target = analysis.index.targets.find(item => item.symbol === 'buildContext');

    const reachableModules = target?.supportingContext.reachableImports.map(item => item.module);
    expect(reachableModules).toContain('../core/action-plan.js');
    expect(reachableModules).not.toContain('fs');
    expect(reachableModules).not.toContain('openai');
    expect(target?.dependencies.map(item => item.module)).toEqual(['../core/action-plan.js']);
  });
});
