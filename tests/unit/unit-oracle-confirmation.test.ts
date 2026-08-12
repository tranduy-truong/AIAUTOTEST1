import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  applyUnitOracleConfirmations,
  formatExpectedForTester,
  formatInputsForTester,
  humanizeUnitTarget,
  loadPendingUnitOracleRequests,
  parseTesterDataValue,
} from '../../src/core/unit/oracle/oracle-confirmation.js';
import type { StructuredUnitPlan, UnitSession } from '../../src/core/unit/schema.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testkit-oracle-review-'));
  const runDirectory = path.join(root, 'run');
  fs.mkdirSync(runDirectory, { recursive: true });
  const session: UnitSession = {
    version: 1,
    runId: '20260812_120000_000',
    createdAt: '2026-08-12T05:00:00.000Z',
    projectRoot: root,
    projectName: 'fixture',
    testFramework: 'vitest',
    runDirectory,
    contextPath: path.join(runDirectory, 'context-bundle.json'),
    planPath: path.join(runDirectory, 'test-plan-unit.json'),
    generatedFiles: [],
  };
  const plan: StructuredUnitPlan = {
    version: 1,
    source: 'deterministic-planner',
    project: { name: 'fixture', root, testFramework: 'vitest' },
    clarifications: [],
    targets: [{
      sourceFile: 'src/flags.ts',
      symbol: 'guidedLearningEnabled',
      sourceHash: 'hash',
      executionMode: 'NATIVE_DIRECT',
      profile: 'UNIT_NATIVE',
      testCases: [{
        id: 'UT_FLAG_001',
        name: 'trả về true khi cờ được bật',
        branchIds: ['B001_TRUE'],
        inputs: { value: 'true' },
        expected: { kind: 'return', value: true },
        oracleSource: 'implementation',
        oracleEvidence: { status: 'proposed', source: 'ai-inference' },
        mocks: [],
      }],
    }],
  };
  fs.writeFileSync(session.planPath, `${JSON.stringify(plan, null, 2)}\n`);
  fs.writeFileSync(path.join(runDirectory, 'oracle-requests.json'), `${JSON.stringify({
    version: 1,
    requests: [{
      target: 'src/flags.ts#guidedLearningEnabled',
      testCaseId: 'UT_FLAG_001',
      proposedExpected: { kind: 'return', value: true },
    }],
  }, null, 2)}\n`);
  return { root, session };
}

describe('Unit Oracle confirmation workflow', () => {
  it('loads pending requests, updates the plan and writes an audit artifact', () => {
    const { root, session } = fixture();
    expect(loadPendingUnitOracleRequests(session)).toHaveLength(1);

    const result = applyUnitOracleConfirmations([{
      target: 'src/flags.ts#guidedLearningEnabled',
      testCaseId: 'UT_FLAG_001',
      status: 'CONFIRMED',
      expected: { kind: 'return', value: false },
      confirmedAt: '2026-08-12T05:01:00.000Z',
    }], session, root);

    expect(result).toMatchObject({
      confirmedCount: 1,
      confirmedTargetIds: ['src/flags.ts#guidedLearningEnabled'],
    });
    const savedPlan = JSON.parse(fs.readFileSync(session.planPath, 'utf-8'));
    expect(savedPlan.targets[0].testCases[0]).toMatchObject({
      expected: { kind: 'return', value: false },
      oracleSource: 'tester-confirmation',
      oracleEvidence: { status: 'verified', source: 'tester-confirmation' },
    });
    const audit = JSON.parse(fs.readFileSync(path.join(session.runDirectory, 'oracle-confirmations.json'), 'utf-8'));
    expect(audit.confirmations).toHaveLength(1);
    expect(fs.existsSync(path.join(root, 'artifacts', 'test-plan-unit.json'))).toBe(true);
  });

  it('keeps skipped cases out of the verified plan while recording the choice', () => {
    const { root, session } = fixture();
    const result = applyUnitOracleConfirmations([{
      target: 'src/flags.ts#guidedLearningEnabled',
      testCaseId: 'UT_FLAG_001',
      status: 'SKIPPED',
      confirmedAt: '2026-08-12T05:01:00.000Z',
    }], session, root);
    expect(result).toMatchObject({ confirmedCount: 0, skippedCount: 1 });
    const savedPlan = JSON.parse(fs.readFileSync(session.planPath, 'utf-8'));
    expect(savedPlan.targets[0].testCases[0].oracleSource).toBe('implementation');
  });

  it('formats values for non-technical CLI users and parses their edits safely', () => {
    expect(humanizeUnitTarget('src/live.ts#OllamaAdapter.isAvailable')).toBe('Ollama Adapter › is Available');
    expect(formatExpectedForTester({ kind: 'return', value: true })).toBe('Trả về Đúng (true)');
    expect(formatInputsForTester({ enabled: false })).toEqual(['enabled: Sai (false)']);
    expect(parseTesterDataValue('đúng')).toBe(true);
    expect(parseTesterDataValue('{"ok":true}')).toEqual({ ok: true });
    expect(() => parseTesterDataValue('{invalid}')).toThrow('JSON không hợp lệ');
  });
});
