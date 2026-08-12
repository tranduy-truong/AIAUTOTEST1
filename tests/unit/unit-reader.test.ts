import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeUnitInput } from '../../src/core/unit/artifacts.js';

const temporaryDirectories: string[] = [];

function createProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testkit-unit-reader-'));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'sample-business-project',
    type: 'module',
    devDependencies: { vitest: '^4.0.0' },
  }));
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=do-not-read');
  fs.writeFileSync(path.join(root, 'tests', 'old.test.ts'), 'export const ignored = true;');
  fs.writeFileSync(path.join(root, 'src', 'order-repository.ts'), 'export const orderRepository = { find: async () => null };');
  fs.writeFileSync(path.join(root, 'src', 'discount.ts'), `
import { orderRepository } from './order-repository';

export async function applyDiscount(total: number, code: string): Promise<number> {
  const password = 'hard-coded-secret';
  await orderRepository.find();
  if (total <= 0) throw new Error('INVALID_TOTAL');
  return code === 'SALE10' ? total * 0.9 : total;
}

function privateHelper(value: number) {
  return value * 2;
}
`);
  return root;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('Unit Code Reader', () => {
  it('scans a JS/TS project without reading secrets, tests, or node_modules', () => {
    const root = createProject();
    const analysis = analyzeUnitInput(root);

    expect(analysis.manifest.projectName).toBe('sample-business-project');
    expect(analysis.manifest.testFramework).toBe('vitest');
    expect(analysis.manifest.sourceFiles).toEqual([
      'src/discount.ts',
      'src/order-repository.ts',
    ]);
    expect(analysis.manifest.sourceFiles).not.toContain('.env');
    expect(analysis.manifest.sourceFiles).not.toContain('tests/old.test.ts');
  });

  it('extracts exported targets, branches, hashes, and mock boundaries from AST', () => {
    const root = createProject();
    const analysis = analyzeUnitInput(path.join(root, 'src', 'discount.ts'));
    const target = analysis.index.targets.find(item => item.symbol === 'applyDiscount');

    expect(target).toBeDefined();
    expect(target?.exported).toBe(true);
    expect(target?.async).toBe(true);
    expect(target?.parameters.map(parameter => parameter.name)).toEqual(['total', 'code']);
    expect(target?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(target?.branches.map(branch => branch.id)).toEqual([
      'B001_TRUE', 'B001_FALSE', 'B002_TRUE', 'B002_FALSE',
    ]);
    expect(target?.dependencies).toEqual([
      expect.objectContaining({
        module: './order-repository',
        boundary: 'database',
        strategy: 'mock',
        resolvedFile: 'src/order-repository.ts',
      }),
    ]);
    expect(target?.executionMode).toBe('NATIVE_WITH_MOCKS');
    expect(target?.rawCode).toContain("password = '<REDACTED>'");
    expect(target?.rawCode).not.toContain('hard-coded-secret');

    const privateTarget = analysis.index.targets.find(item => item.symbol === 'privateHelper');
    expect(privateTarget?.executionMode).toBe('UNSUPPORTED');
  });

  it('isolates browser/API/filesystem imports used through same-file helpers', () => {
    const root = createProject();
    const file = path.join(root, 'src', 'runner.ts');
    fs.writeFileSync(file, `
import fs from 'fs';
import { chromium } from 'playwright';
import OpenAI from 'openai';

function save(value: string) { fs.writeFileSync('result.txt', value); }
export async function execute() {
  const browser = await chromium.launch();
  save('done');
  return new OpenAI({ apiKey: 'test' });
}
`);
    const analysis = analyzeUnitInput(file);
    const execute = analysis.index.targets.find(item => item.symbol === 'execute');

    expect(execute?.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ module: 'fs', boundary: 'filesystem', strategy: 'mock' }),
      expect.objectContaining({ module: 'playwright', boundary: 'network', strategy: 'mock' }),
      expect.objectContaining({ module: 'openai', boundary: 'network', strategy: 'mock' }),
    ]));
    expect(execute?.executionMode).toBe('NATIVE_WITH_MOCKS');
  });

  it('splits exported classes into method-level targets with independent async/input/dependency contracts', () => {
    const root = createProject();
    const file = path.join(root, 'src', 'adapter.ts');
    fs.writeFileSync(file, `
import { execSync } from 'child_process';
import fs from 'fs';

export class Adapter {
  constructor(private model = 'default') {}
  async isAvailable(): Promise<boolean> {
    try { execSync('tool --version'); return true; } catch { return false; }
  }
  async run(opts: { promptDir: string }): Promise<string> {
    return fs.existsSync(opts.promptDir) ? fs.readFileSync(opts.promptDir, 'utf8') : this.model;
  }
  private hidden() { return 'hidden'; }
}
`);

    const analysis = analyzeUnitInput(file);
    const available = analysis.index.targets.find(item => item.symbol === 'Adapter.isAvailable');
    const run = analysis.index.targets.find(item => item.symbol === 'Adapter.run');

    expect(analysis.index.targets.map(item => item.symbol)).toEqual([
      'Adapter.isAvailable',
      'Adapter.run',
    ]);
    expect(available).toEqual(expect.objectContaining({
      kind: 'class-method', async: true, parameters: [], returnType: 'Promise<boolean>',
    }));
    expect(available?.dependencies).toEqual([
      expect.objectContaining({ module: 'child_process', boundary: 'process', strategy: 'mock' }),
    ]);
    expect(available?.branches.map(branch => branch.id)).toEqual(['B001_TRY', 'B001_CATCH']);

    expect(run?.parameters.map(parameter => parameter.name)).toEqual(['opts']);
    expect(run?.classMethod).toEqual(expect.objectContaining({
      className: 'Adapter', methodName: 'run', static: false,
      constructorParameters: [expect.objectContaining({ name: 'model', optional: true })],
    }));
    expect(run?.dependencies).toEqual([
      expect.objectContaining({ module: 'fs', boundary: 'filesystem', strategy: 'mock' }),
    ]);
  });
});
