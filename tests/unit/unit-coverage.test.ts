import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeUnitCoverage } from '../../src/core/unit/coverage.js';
import type { UnitTarget } from '../../src/core/unit/schema.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Unit coverage feedback', () => {
  it('maps Istanbul uncovered branch arms and statements back to target branch IDs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testkit-coverage-'));
    roots.push(root);
    const sourceFile = 'src/price.ts';
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, sourceFile), 'export function price(ok: boolean) {\n  if (ok) return 1;\n  return 0;\n}\n');
    const coverageFile = path.join(root, 'coverage-final.json');
    fs.writeFileSync(coverageFile, JSON.stringify({
      [path.join(root, sourceFile)]: {
        statementMap: {
          0: { start: { line: 2 }, end: { line: 2 } },
          1: { start: { line: 3 }, end: { line: 3 } },
        },
        s: { 0: 1, 1: 0 },
        branchMap: {
          0: {
            start: { line: 2 }, end: { line: 2 },
            locations: [{ start: { line: 2 } }, { start: { line: 2 } }],
          },
        },
        b: { 0: [1, 0] },
      },
    }));
    const target: UnitTarget = {
      id: `${sourceFile}#price`, sourceFile, sourceHash: 'hash', symbol: 'price', kind: 'function',
      exported: true, defaultExport: false, async: false,
      parameters: [{ name: 'ok', type: 'boolean', optional: false }], returnType: 'number',
      startLine: 1, endLine: 4, rawCode: 'export function price(ok: boolean) {}', dependencies: [],
      supportingContext: { callGraph: [], helperDefinitions: [], typeDefinitions: [], constantDefinitions: [], reachableImports: [], unresolvedSymbols: [], truncated: false },
      branches: [
        { id: 'B001_TRUE', kind: 'if', condition: 'ok', outcome: 'true', line: 2 },
        { id: 'B001_FALSE', kind: 'if', condition: 'ok', outcome: 'false', line: 2 },
      ],
      executionMode: 'NATIVE_DIRECT', profile: 'UNIT_NATIVE', runtimeEnvironment: 'node',
      profileReasons: ['pure'], unsupportedReasons: [],
    };

    const report = analyzeUnitCoverage({ projectRoot: root, coverageFile, targets: [target], threshold: 80 });

    expect(report.status).toBe('COVERAGE_ANALYZED');
    expect(report.targets[0]).toEqual(expect.objectContaining({
      statementCoverage: 50,
      branchCoverage: 50,
      effectiveCoverage: 50,
      uncoveredLines: [3],
      uncoveredBranchIds: ['B001_FALSE'],
      needsImprovement: true,
    }));
  });
});

