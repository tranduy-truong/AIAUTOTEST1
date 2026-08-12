import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { loadUnitContext, loadUnitSession } from './artifacts.js';
import { analyzeUnitCoverage } from './coverage.js';

export interface UnitRunResult {
  ok: boolean;
  framework: 'vitest' | 'jest' | 'unknown';
  command: string[];
  cwd: string;
  generatedFiles: string[];
  coverageEnabled: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  coverageGapReportPath?: string;
}

export interface UnitRunSummary {
  totalFiles: number;
  passedFiles: number;
  failedFiles: number;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  failedNames: string[];
  primaryError?: string;
}

interface RunnerInvocation {
  executable: string;
  argsPrefix: string[];
}

function stripTerminalFormatting(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '').replace(/\r/g, '');
}

function countsFromSummaryLine(
  output: string,
  label: 'Test Files' | 'Tests',
): { total: number; passed: number; failed: number } {
  const line = output.split('\n').find(item => item.trimStart().startsWith(label));
  if (!line) return { total: 0, passed: 0, failed: 0 };
  const passed = Number(line.match(/(\d+)\s+passed/)?.[1] || 0);
  const failed = Number(line.match(/(\d+)\s+failed/)?.[1] || 0);
  const total = Number(line.match(/\((\d+)\)/)?.[1] || passed + failed);
  return { total, passed, failed };
}

/** Keeps the complete runner log in test-results.json while giving the CLI a
 * stable, short result suitable for non-technical testers. */
export function summarizeUnitRunOutput(stdout: string, stderr = ''): UnitRunSummary {
  const output = stripTerminalFormatting(`${stdout}\n${stderr}`);
  const files = countsFromSummaryLine(output, 'Test Files');
  const tests = countsFromSummaryLine(output, 'Tests');
  const failedNames = [...output.matchAll(/^\s*[×✗]\s+(.+?)(?:\s+\d+(?:\.\d+)?ms)?\s*$/gm)]
    .map(match => match[1].trim())
    .filter((name, index, all) => all.indexOf(name) === index);
  const primaryError = output.match(/^Caused by:\s*(.+)$/m)?.[1]?.trim()
    || output.match(/^(?:AssertionError|TypeError|Error):\s*(.+)$/m)?.[0]?.trim();
  return {
    totalFiles: files.total,
    passedFiles: files.passed,
    failedFiles: files.failed,
    totalTests: tests.total,
    passedTests: tests.passed,
    failedTests: tests.failed,
    failedNames,
    primaryError,
  };
}

function packageJson(root: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function hasVitestCoverage(root: string): boolean {
  const pkg = packageJson(root) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  return Boolean(dependencies['@vitest/coverage-v8'] || dependencies['@vitest/coverage-istanbul']);
}

function findLocalRunner(root: string, framework: 'vitest' | 'jest'): string | undefined {
  const executable = process.platform === 'win32' ? `${framework}.cmd` : framework;
  let current = root;
  while (true) {
    const candidate = path.join(current, 'node_modules', '.bin', executable);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function resolveVitestProjectConfig(projectRoot: string, runDirectory: string): string {
  const candidates = [
    'vitest.config.ts', 'vitest.config.mts', 'vitest.config.cts',
    'vitest.config.js', 'vitest.config.mjs', 'vitest.config.cjs',
    'vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs',
  ].map(name => path.join(projectRoot, name));
  const existing = candidates.find(candidate => fs.existsSync(candidate));
  if (existing) return existing;
  const generated = path.join(runDirectory, 'vitest.testkit.config.mjs');
  fs.mkdirSync(path.dirname(generated), { recursive: true });
  fs.writeFileSync(generated, "export default { test: { environment: 'node', globals: false } };\n");
  return generated;
}

/**
 * Windows cannot execute npm's `.cmd` shims with `spawnSync(..., { shell: false })`.
 * Launch the package's real JavaScript entry point with Node instead. This also
 * avoids passing project-controlled paths through a command shell.
 */
export function resolveUnitRunnerInvocation(
  runnerShim: string,
  framework: 'vitest' | 'jest',
  platform = process.platform,
  nodeExecutable = process.execPath,
): RunnerInvocation {
  if (platform !== 'win32') {
    return { executable: runnerShim, argsPrefix: [] };
  }

  const nodeModulesDirectory = path.dirname(path.dirname(runnerShim));
  const entryCandidates = framework === 'vitest'
    ? [
        path.join(nodeModulesDirectory, 'vitest', 'vitest.mjs'),
        path.join(nodeModulesDirectory, 'vitest', 'dist', 'cli.js'),
      ]
    : [path.join(nodeModulesDirectory, 'jest', 'bin', 'jest.js')];
  const entryPoint = entryCandidates.find(candidate => fs.existsSync(candidate));
  if (!entryPoint) {
    throw new Error(
      `Không tìm thấy JavaScript CLI của ${framework} cạnh ${runnerShim}. `
      + 'Hãy cài lại dependency trong dự án đích.',
    );
  }
  return { executable: nodeExecutable, argsPrefix: [entryPoint] };
}

export function buildUnitRunnerArgs(
  framework: 'vitest' | 'jest',
  relativeFiles: string[],
  coverageEnabled: boolean,
  configPath?: string,
): string[] {
  if (framework === 'vitest') {
    return ['run', ...relativeFiles, ...(configPath ? ['--config', configPath] : []), ...(coverageEnabled
      ? [
          '--coverage', '--coverage.reporter=json', '--coverage.reporter=json-summary',
          '--coverage.thresholds.perFile=false',
          '--coverage.thresholds.lines=0', '--coverage.thresholds.functions=0',
          '--coverage.thresholds.branches=0', '--coverage.thresholds.statements=0',
        ]
      : [])];
  }
  return [...relativeFiles, ...(coverageEnabled
    ? [
        '--coverage', '--coverageReporters=json', '--coverageReporters=json-summary',
        '--coverageThreshold={"global":{"branches":0,"functions":0,"lines":0,"statements":0}}',
      ]
    : [])];
}

export function runLastGeneratedUnitTests(): UnitRunResult {
  const session = loadUnitSession();
  const generatedFiles = session.generatedFiles.filter(file => fs.existsSync(file));
  if (generatedFiles.length === 0) {
    return {
      ok: false,
      framework: session.testFramework,
      command: [],
      cwd: session.projectRoot,
      generatedFiles: [],
      coverageEnabled: false,
      stdout: '',
      stderr: 'Unit session chưa có file test đã sinh hoặc file đã bị xoá.',
      exitCode: null,
    };
  }
  if (session.testFramework === 'unknown') {
    return {
      ok: false,
      framework: 'unknown',
      command: [],
      cwd: session.projectRoot,
      generatedFiles,
      coverageEnabled: false,
      stdout: '',
      stderr: 'Dự án chưa cấu hình Vitest/Jest.',
      exitCode: null,
    };
  }

  const coverageEnabled = session.testFramework === 'jest' || hasVitestCoverage(session.projectRoot);
  const relativeFiles = generatedFiles.map(file => path.relative(session.projectRoot, file));
  const executable = findLocalRunner(session.projectRoot, session.testFramework);
  if (!executable) {
    return {
      ok: false,
      framework: session.testFramework,
      command: [],
      cwd: session.projectRoot,
      generatedFiles,
      coverageEnabled: false,
      stdout: '',
      stderr: `${session.testFramework} được khai báo nhưng chưa có trong node_modules. Hãy chạy lệnh cài dependency của dự án đích; TestKit không tự tải package.`,
      exitCode: null,
    };
  }
  const configPath = session.testFramework === 'vitest'
    ? resolveVitestProjectConfig(session.projectRoot, session.runDirectory)
    : undefined;
  const frameworkArgs = buildUnitRunnerArgs(session.testFramework, relativeFiles, coverageEnabled, configPath);
  let invocation: RunnerInvocation;
  try {
    invocation = resolveUnitRunnerInvocation(executable, session.testFramework);
  } catch (error) {
    return {
      ok: false,
      framework: session.testFramework,
      command: [executable, ...frameworkArgs],
      cwd: session.projectRoot,
      generatedFiles,
      coverageEnabled,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: null,
    };
  }
  const args = [...invocation.argsPrefix, ...frameworkArgs];
  const result = spawnSync(invocation.executable, args, {
    cwd: session.projectRoot,
    encoding: 'utf-8',
    windowsHide: false,
    shell: false,
    env: { ...process.env, NODE_ENV: 'test' },
  });
  const runResult: UnitRunResult = {
    ok: result.status === 0,
    framework: session.testFramework,
    command: [invocation.executable, ...args],
    cwd: session.projectRoot,
    generatedFiles,
    coverageEnabled,
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
    exitCode: result.status,
  };
  fs.writeFileSync(
    path.join(session.runDirectory, 'test-results.json'),
    `${JSON.stringify({ ...runResult, ranAt: new Date().toISOString() }, null, 2)}\n`,
  );
  const coverageCandidates = [path.join(session.projectRoot, 'coverage', 'coverage-final.json')];
  const coverageFile = coverageCandidates.find(file => fs.existsSync(file));
  const coverageGapReportPath = path.join(session.runDirectory, 'coverage-gaps.json');
  const coverageArtifact = coverageFile
    ? analyzeUnitCoverage({
        projectRoot: session.projectRoot,
        coverageFile,
        targets: loadUnitContext(session).targets,
        threshold: 80,
      })
    : {
      version: 1,
      coverageEnabled,
      coverageFile: coverageFile || null,
      status: coverageEnabled
        ? coverageFile ? 'COVERAGE_AVAILABLE' : 'COVERAGE_REPORT_NOT_FOUND'
        : 'COVERAGE_PLUGIN_NOT_INSTALLED',
      note: coverageEnabled
        ? 'Runner đã yêu cầu JSON reporter nhưng chưa tìm thấy coverage-final.json.'
        : 'Test vẫn được chạy, nhưng cần cài coverage provider tương ứng để đo coverage.',
    };
  fs.writeFileSync(coverageGapReportPath, `${JSON.stringify(coverageArtifact, null, 2)}\n`);
  runResult.coverageGapReportPath = coverageGapReportPath;
  return runResult;
}
