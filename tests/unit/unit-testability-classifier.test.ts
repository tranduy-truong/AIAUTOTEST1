import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeUnitInput, createUnitSession } from '../../src/core/unit/artifacts.js';

const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testkit-profile-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'profile-project',
    type: 'module',
    devDependencies: { vitest: '^4.0.0', jsdom: '^30.0.0', '@testing-library/react': '^16.0.0' },
    dependencies: { react: '^19.0.0' },
  }));
  fs.writeFileSync(path.join(root, 'src', 'pure.ts'), 'export function sum(a: number, b: number) { return a + b; }\n');
  fs.writeFileSync(path.join(root, 'src', 'async.ts'), 'export async function available(): Promise<boolean> { return true; }\n');
  fs.writeFileSync(path.join(root, 'src', 'process.ts'), "import fs from 'fs'; export function load(file: string) { return fs.readFileSync(file, 'utf8'); }\n");
  fs.writeFileSync(path.join(root, 'src', 'component.tsx'), "import React from 'react'; export function Title() { return <h1>Title</h1>; }\n");
  fs.writeFileSync(path.join(root, 'src', 'db.ts'), 'export const db = { find: () => null };\n');
  fs.writeFileSync(path.join(root, 'src', 'repository.ts'), "import { db } from './db'; export function findUser() { return db.find(); }\n");
  fs.writeFileSync(path.join(root, 'src', 'types.ts'), 'export interface User { id: string }\nexport const ROLE = "tester" as const;\n');
  fs.writeFileSync(path.join(root, 'src', 'private.ts'), 'function hidden() { return 1; }\n');
  return root;
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Unit Testability Classifier', () => {
  it('classifies targets by runtime boundary and inventories files without runtime tests', () => {
    const root = project();
    const analysis = analyzeUnitInput(root);
    const bySymbol = new Map(analysis.index.targets.map(target => [target.symbol, target]));

    expect(bySymbol.get('sum')?.profile).toBe('UNIT_NATIVE');
    expect(bySymbol.get('available')?.profile).toBe('UNIT_NATIVE');
    expect(bySymbol.get('load')?.profile).toBe('PROCESS_SANDBOX');
    expect(bySymbol.get('Title')?.profile).toBe('COMPONENT_DOM');
    expect(bySymbol.get('findUser')?.profile).toBe('INTEGRATION_SANDBOX');
    expect(bySymbol.get('hidden')?.profile).toBe('REFACTOR_REQUIRED');

    const selected = analysis.index.targets
      .filter(target => target.executionMode !== 'UNSUPPORTED')
      .map(target => target.id);
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'testkit-profile-artifacts-'));
    roots.push(artifactRoot);
    const prepared = createUnitSession(analysis, selected, '', artifactRoot);
    const manifest = JSON.parse(fs.readFileSync(
      path.join(prepared.session.runDirectory, 'testability-manifest.json'), 'utf-8',
    )) as { entries: Array<{ id: string; profile: string }>; summary: Record<string, number> };

    expect(manifest.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'src/types.ts', profile: 'NO_RUNTIME_TEST' }),
      expect.objectContaining({ id: 'src/private.ts#hidden', profile: 'REFACTOR_REQUIRED' }),
    ]));
    expect(manifest.summary.NO_RUNTIME_TEST).toBe(1);
    expect(fs.existsSync(path.join(prepared.session.runDirectory, 'target-partitions.json'))).toBe(true);
    expect(fs.existsSync(path.join(prepared.session.runDirectory, 'untestable-targets.json'))).toBe(true);
  });
});
