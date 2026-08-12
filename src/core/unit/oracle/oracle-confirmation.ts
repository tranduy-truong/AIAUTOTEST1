import fs from 'fs';
import path from 'path';
import { loadUnitSession, saveUnitPlan } from '../artifacts.js';
import type {
  StructuredUnitPlan,
  UnitDataValue,
  UnitExpectedResult,
  UnitSession,
} from '../schema.js';
import { validateExpectedIntent } from '../test-intent.schema.js';
import {
  promoteToSpecificationByTester,
  replaceExpectedByTester,
} from './oracle-taxonomy.js';
import { migratePlanV1ToV2 } from '../plan-migrator.js';

export interface UnitOracleRequest {
  target: string;
  testCaseId: string;
  name?: string;
  inputs?: Record<string, UnitDataValue>;
  proposedExpected?: UnitExpectedResult;
  proposedOracleSource?: string;
  reasons?: string[];
  nextAction?: string;
}

export type UnitOracleReviewStatus = 'CONFIRMED' | 'REPLACED' | 'SKIPPED' | 'NEEDS_REVIEW';

export interface UnitOracleConfirmation {
  target: string;
  testCaseId: string;
  status: UnitOracleReviewStatus;
  expected?: UnitExpectedResult;
  confirmedAt: string;
  note?: string;
  actorType?: 'LOCAL_TESTER' | 'CI_USER';
}

export interface ApplyOracleConfirmationsResult {
  confirmedCount: number;
  skippedCount: number;
  needsReviewCount: number;
  confirmedTargetIds: string[];
}

interface OracleRequestArtifact {
  version: 1;
  requests: UnitOracleRequest[];
}

interface OracleConfirmationArtifact {
  version: 1 | 2;
  updatedAt: string;
  confirmations: UnitOracleConfirmation[];
}

export function oracleRequestsPath(session = loadUnitSession()): string {
  return path.join(session.runDirectory, 'oracle-requests.json');
}

export function oracleConfirmationsPath(session = loadUnitSession()): string {
  return path.join(session.runDirectory, 'oracle-confirmations.json');
}

export function loadPendingUnitOracleRequests(session = loadUnitSession()): UnitOracleRequest[] {
  const filePath = oracleRequestsPath(session);
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as OracleRequestArtifact;
  return Array.isArray(parsed.requests) ? parsed.requests : [];
}

function loadUnitPlan(session: UnitSession): StructuredUnitPlan {
  const raw = JSON.parse(fs.readFileSync(session.planPath, 'utf-8')) as StructuredUnitPlan;
  return migratePlanV1ToV2(raw);
}

function loadPreviousConfirmations(session: UnitSession): UnitOracleConfirmation[] {
  const filePath = oracleConfirmationsPath(session);
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as OracleConfirmationArtifact;
  return Array.isArray(parsed.confirmations) ? parsed.confirmations : [];
}

function confirmationKey(value: Pick<UnitOracleConfirmation, 'target' | 'testCaseId'>): string {
  return `${value.target}::${value.testCaseId}`;
}

export function applyUnitOracleConfirmations(
  confirmations: UnitOracleConfirmation[],
  session = loadUnitSession(),
  cwd = process.cwd(),
): ApplyOracleConfirmationsResult {
  const plan = loadUnitPlan(session);
  const confirmedTargetIds = new Set<string>();
  let confirmedCount = 0;
  let skippedCount = 0;
  let needsReviewCount = 0;

  for (const confirmation of confirmations) {
    if (confirmation.status === 'SKIPPED') {
      skippedCount += 1;
      continue;
    }
    if (confirmation.status === 'NEEDS_REVIEW') {
      needsReviewCount += 1;
      continue;
    }
    if (!confirmation.expected) {
      throw new Error(`${confirmation.testCaseId}: xác nhận thiếu expected result.`);
    }
    const expectedIssues = validateExpectedIntent(confirmation.expected);
    if (expectedIssues.length > 0) {
      throw new Error(`${confirmation.testCaseId}: expected không hợp lệ (${expectedIssues.map(issue => issue.message).join('; ')}).`);
    }
    const planTarget = plan.targets.find(target =>
      `${target.sourceFile}#${target.symbol}` === confirmation.target,
    );
    const testCase = planTarget?.testCases.find(item => item.id === confirmation.testCaseId);
    if (!planTarget || !testCase) {
      throw new Error(`${confirmation.testCaseId}: không còn tồn tại trong Unit Plan hiện tại.`);
    }

    const previousExpected = testCase.expected;
    const actorType = confirmation.actorType || 'LOCAL_TESTER';
    const note = confirmation.note?.trim() || 'Expected đã được xác nhận và nâng cấp thành Specification qua CLI.';

    testCase.expected = confirmation.expected;
    testCase.oracleSource = 'tester-confirmation';
    testCase.oracleEvidence = {
      status: 'verified',
      source: 'tester-confirmation',
      reference: `CLI-${session.runId}-${confirmation.testCaseId}-${confirmation.confirmedAt}`,
    };

    if (confirmation.status === 'REPLACED') {
      testCase.oracle = replaceExpectedByTester(
        testCase.oracle!,
        previousExpected,
        confirmation.expected,
        actorType,
        note,
      );
    } else {
      testCase.oracle = promoteToSpecificationByTester(
        testCase.oracle!,
        actorType,
        note,
      );
    }

    testCase.gate = {
      status: 'READY_SPECIFICATION',
      specExpected: testCase.expected,
    };

    if (confirmation.note?.trim()) {
      testCase.notes = [...(testCase.notes || []), `Tester: ${confirmation.note.trim()}`];
    }
    confirmedTargetIds.add(confirmation.target);
    confirmedCount += 1;
  }

  if (confirmedCount > 0) saveUnitPlan(plan, session, cwd);

  const merged = new Map(loadPreviousConfirmations(session).map(item => [confirmationKey(item), item]));
  for (const confirmation of confirmations) merged.set(confirmationKey(confirmation), confirmation);
  const artifact: OracleConfirmationArtifact = {
    version: 2,
    updatedAt: new Date().toISOString(),
    confirmations: [...merged.values()],
  };
  fs.writeFileSync(oracleConfirmationsPath(session), `${JSON.stringify(artifact, null, 2)}\n`);

  return {
    confirmedCount,
    skippedCount,
    needsReviewCount,
    confirmedTargetIds: [...confirmedTargetIds],
  };
}

export function formatUnitDataValue(value: UnitDataValue | undefined): string {
  if (value === undefined) return 'Không có giá trị';
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'Đúng (true)' : 'Sai (false)';
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(item => formatUnitDataValue(item)).join(', ')}]`;
  if ('$type' in value) {
    const tagged = value as Record<string, unknown>;
    const tag = String(tagged.$type);
    if (tag === 'undefined') return 'Không có giá trị (undefined)';
    if (tag === 'nan') return 'Không phải số (NaN)';
    if (tag === 'infinity') return 'Vô cực';
    if (tag === 'negative-infinity') return 'Âm vô cực';
    if (tag === 'map') return `Map (${Array.isArray(tagged.entries) ? tagged.entries.length : 0} phần tử)`;
    if (tag === 'set') return `Set (${Array.isArray(tagged.values) ? tagged.values.length : 0} phần tử)`;
    return tagged.value !== undefined ? `${tag}: ${String(tagged.value)}` : tag;
  }
  return JSON.stringify(value, null, 2);
}

export function formatExpectedForTester(expected: UnitExpectedResult | undefined): string {
  if (!expected) return 'Chưa có đề xuất';
  if (expected.kind === 'return') return `Trả về ${formatUnitDataValue(expected.value)}`;
  if (expected.kind === 'resolve') return `Hoàn tất và trả về ${formatUnitDataValue(expected.value)}`;
  if (expected.kind === 'throw' || expected.kind === 'reject') {
    const message = expected.error?.message?.value || expected.message
      || (typeof expected.value === 'string' ? expected.value : undefined);
    return message ? `Báo lỗi có nội dung "${message}"` : 'Báo lỗi';
  }
  const calls = expected.calls || [];
  return calls.length > 0
    ? `Thực hiện ${calls.map(call => `${call.dependency}${call.method ? `.${call.method}` : ''}`).join(', ')}`
    : 'Có thay đổi phụ thuộc bên ngoài';
}

export function formatInputsForTester(inputs?: Record<string, UnitDataValue>): string[] {
  const entries = Object.entries(inputs || {});
  if (entries.length === 0) return ['Không có dữ liệu đầu vào'];
  return entries.map(([name, value]) => `${name}: ${formatUnitDataValue(value)}`);
}

export function humanizeUnitTarget(target: string): string {
  const symbol = target.split('#').pop() || target;
  return symbol
    .replace(/\./g, ' › ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
}

export function parseTesterDataValue(input: string): UnitDataValue {
  const value = input.trim();
  if (/^(true|đúng)$/iu.test(value)) return true;
  if (/^(false|sai)$/iu.test(value)) return false;
  if (/^null$/i.test(value)) return null;
  if (/^(undefined|không có giá trị)$/iu.test(value)) return { $type: 'undefined' };
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('{') && value.endsWith('}'))
    || (value.startsWith('[') && value.endsWith(']'))) {
    try { return JSON.parse(value) as UnitDataValue; }
    catch { throw new Error('JSON không hợp lệ. Hãy kiểm tra dấu ngoặc và dấu phẩy.'); }
  }
  return value;
}
