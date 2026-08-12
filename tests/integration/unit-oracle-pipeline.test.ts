import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { runUnitGenerator } from '../../src/agents/generator/unit-generator.js';
import {
  analyzeUnitInput,
  createUnitSession,
  loadUnitSession,
  saveUnitPlan,
  UNIT_CURRENT_SESSION_PATH,
} from '../../src/core/unit/artifacts.js';
import { runLastGeneratedUnitTests } from '../../src/core/unit/runner.js';
import type { StructuredUnitPlan } from '../../src/core/unit/schema.js';

const cwd = process.cwd();
const currentSessionFile = path.join(cwd, UNIT_CURRENT_SESSION_PATH);
const legacyPlanFile = path.join(cwd, 'artifacts', 'test-plan-unit.json');
const backups = new Map<string, Buffer | undefined>();
const cleanupDirectories: string[] = [];

function backup(file: string): void {
  if (!backups.has(file)) backups.set(file, fs.existsSync(file) ? fs.readFileSync(file) : undefined);
}

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  for (const [file, content] of backups) {
    if (content === undefined) fs.rmSync(file, { force: true });
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  }
  backups.clear();
});

describe('Unit Oracle pipeline integration', () => {
  it('scans, verifies, compiles and executes a pure target without AI TypeScript generation', async () => {
    backup(currentSessionFile);
    backup(legacyPlanFile);
    const projectRoot = fs.mkdtempSync(path.join(cwd, '.tmp-unit-oracle-project-'));
    cleanupDirectories.push(projectRoot);
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({
      name: 'oracle-fixture', type: 'module', devDependencies: { vitest: '^4.0.0', typescript: '^5.0.0' },
    }));
    fs.writeFileSync(path.join(projectRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
        strict: true, skipLibCheck: true,
      },
    }));
    fs.writeFileSync(path.join(projectRoot, 'src', 'clamp.ts'), `
      export function clamp(value: number, minimum: number, maximum: number): number {
        if (value < minimum) return minimum;
        if (value > maximum) return maximum;
        return value;
      }
    `);

    const analysis = analyzeUnitInput(projectRoot);
    const target = analysis.index.targets.find(item => item.id === 'src/clamp.ts#clamp');
    expect(target).toBeDefined();
    const prepared = createUnitSession(analysis, [target!.id], '', cwd);
    cleanupDirectories.push(prepared.session.runDirectory);
    const plan: StructuredUnitPlan = {
      version: 1,
      source: 'ai-planner',
      project: {
        name: analysis.manifest.projectName,
        root: analysis.manifest.projectRoot,
        testFramework: analysis.manifest.testFramework,
      },
      targets: [{
        sourceFile: target!.sourceFile,
        symbol: target!.symbol,
        sourceHash: target!.sourceHash,
        executionMode: target!.executionMode,
        profile: target!.profile,
        testCases: [{
          id: 'UT_CLAMP_001', name: 'returns value inside range',
          branchIds: target!.branches.map(branch => branch.id),
          inputs: { value: 5, minimum: 0, maximum: 10 },
          expected: { kind: 'return', value: 5 },
          oracleSource: 'implementation',
          oracleEvidence: { status: 'proposed', source: 'ai-inference' },
          mocks: [],
        }],
      }],
      clarifications: [],
    };
    saveUnitPlan(plan, prepared.session);

    expect(await runUnitGenerator()).toBe(true);
    const session = loadUnitSession();
    expect(session.generatedFiles).toHaveLength(1);
    expect(fs.readFileSync(session.generatedFiles[0], 'utf-8')).toContain('expect(clamp(5, 0, 10)).toEqual(5)');
    const oracleArtifact = JSON.parse(fs.readFileSync(
      path.join(session.runDirectory, 'oracle-resolution.json'), 'utf-8',
    )) as { targets: Array<{ testCases: Array<{ status: string; evidence?: { source: string } }> }> };
    expect(oracleArtifact.targets[0].testCases[0]).toMatchObject({
      status: 'VERIFIED', evidence: { source: 'pure-evaluation' },
    });

    const run = runLastGeneratedUnitTests();
    expect(run.ok, `${run.stdout}\n${run.stderr}`).toBe(true);
    expect(run.stdout).toContain('1 passed');
  });
});
