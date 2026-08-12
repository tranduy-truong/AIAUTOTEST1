import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildUnitRunnerArgs,
  resolveUnitRunnerInvocation,
  resolveVitestProjectConfig,
  summarizeUnitRunOutput,
} from '../../src/core/unit/runner.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createWindowsRunner(framework: 'vitest' | 'jest'): {
  shim: string;
  entryPoint: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-runner-'));
  temporaryDirectories.push(root);
  const shim = path.join(root, 'node_modules', '.bin', `${framework}.cmd`);
  const entryPoint = framework === 'vitest'
    ? path.join(root, 'node_modules', 'vitest', 'vitest.mjs')
    : path.join(root, 'node_modules', 'jest', 'bin', 'jest.js');
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.mkdirSync(path.dirname(entryPoint), { recursive: true });
  fs.writeFileSync(shim, '@echo off\n');
  fs.writeFileSync(entryPoint, '// test CLI entry\n');
  return { shim, entryPoint };
}

describe('Unit runner invocation', () => {
  it('summarizes noisy Vitest failures for the CLI while retaining useful cause and names', () => {
    const output = `
 ❯ tests/unit/adapter.test.ts (2 tests | 1 failed)
     × UT_ADAPTER_001 - invalid fixture 10ms
     ✓ UT_ADAPTER_002 - success 1ms
 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 2 passed (3)
Caused by: TypeError: The "path" argument must be of type string. Received undefined
`;
    expect(summarizeUnitRunOutput(output)).toEqual({
      totalFiles: 2, passedFiles: 1, failedFiles: 1,
      totalTests: 3, passedTests: 2, failedTests: 1,
      failedNames: ['UT_ADAPTER_001 - invalid fixture'],
      primaryError: 'TypeError: The "path" argument must be of type string. Received undefined',
    });
  });

  it.each(['vitest', 'jest'] as const)(
    'runs the real %s JavaScript CLI through Node on Windows',
    framework => {
      const { shim, entryPoint } = createWindowsRunner(framework);
      expect(resolveUnitRunnerInvocation(shim, framework, 'win32', 'node.exe')).toEqual({
        executable: 'node.exe',
        argsPrefix: [entryPoint],
      });
    },
  );

  it('keeps the executable shim on non-Windows platforms', () => {
    expect(resolveUnitRunnerInvocation('/project/node_modules/.bin/vitest', 'vitest', 'linux')).toEqual({
      executable: '/project/node_modules/.bin/vitest',
      argsPrefix: [],
    });
  });

  it('fails clearly when the installed Windows package has no CLI entry', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-runner-'));
    temporaryDirectories.push(root);
    const shim = path.join(root, 'node_modules', '.bin', 'vitest.cmd');
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(shim, '@echo off\n');

    expect(() => resolveUnitRunnerInvocation(shim, 'vitest', 'win32', 'node.exe'))
      .toThrow('Không tìm thấy JavaScript CLI của vitest');
  });

  it('forces machine-readable JSON coverage reporters for feedback analysis', () => {
    expect(buildUnitRunnerArgs('vitest', ['tests/unit/a.test.ts'], true)).toEqual([
      'run', 'tests/unit/a.test.ts', '--coverage',
      '--coverage.reporter=json', '--coverage.reporter=json-summary',
      '--coverage.thresholds.perFile=false',
      '--coverage.thresholds.lines=0', '--coverage.thresholds.functions=0',
      '--coverage.thresholds.branches=0', '--coverage.thresholds.statements=0',
    ]);
    expect(buildUnitRunnerArgs('jest', ['tests/unit/a.test.ts'], true)).toEqual([
      'tests/unit/a.test.ts', '--coverage',
      '--coverageReporters=json', '--coverageReporters=json-summary',
      '--coverageThreshold={"global":{"branches":0,"functions":0,"lines":0,"statements":0}}',
    ]);
  });

  it('pins Vitest to the target project instead of inheriting a parent config', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-runner-project-'));
    const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-runner-artifacts-'));
    temporaryDirectories.push(root, artifacts);
    const generated = resolveVitestProjectConfig(root, artifacts);
    expect(generated).toBe(path.join(artifacts, 'vitest.testkit.config.mjs'));
    expect(fs.readFileSync(generated, 'utf-8')).toContain("environment: 'node'");
    expect(buildUnitRunnerArgs('vitest', ['a.test.ts'], false, generated)).toEqual([
      'run', 'a.test.ts', '--config', generated,
    ]);

    const projectConfig = path.join(root, 'vitest.config.ts');
    fs.writeFileSync(projectConfig, 'export default {};\n');
    expect(resolveVitestProjectConfig(root, artifacts)).toBe(projectConfig);
  });
});
