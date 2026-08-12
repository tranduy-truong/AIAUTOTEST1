import fs from 'fs';
import path from 'path';
import { runUnitGenerator } from '../generator/unit-generator.js';
import {
  loadUnitContext,
  loadUnitSession,
  updateUnitSession,
} from '../../core/unit/artifacts.js';
import type { UnitCoverageGapReport } from '../../core/unit/coverage.js';
import { runLastGeneratedUnitTests, type UnitRunResult } from '../../core/unit/runner.js';
import type { UnitContextBundle } from '../../core/unit/schema.js';
import { runPlanner } from './run.js';

interface CoverageLoopRound {
  iteration: number;
  targetIds: string[];
  beforeCoverage: number;
  afterCoverage?: number;
  plannerOk: boolean;
  generatorOk: boolean;
  testsOk: boolean;
  stopReason?: string;
}

export interface UnitCoverageLoopResult {
  ok: boolean;
  status: 'DISABLED' | 'NOT_AVAILABLE' | 'TARGET_REACHED' | 'IMPROVED' | 'NO_PROGRESS' | 'FAILED';
  rounds: CoverageLoopRound[];
  finalRun: UnitRunResult;
}

function readGapReport(file?: string): UnitCoverageGapReport | undefined {
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as UnitCoverageGapReport;
    return parsed.status === 'COVERAGE_ANALYZED' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function coverageRequirements(
  original: string | undefined,
  report: UnitCoverageGapReport,
  iteration: number,
): string {
  const gaps = report.targets.filter(target => target.needsImprovement).map(target => ({
    target: target.target,
    currentCoverage: target.effectiveCoverage,
    uncoveredBranchIds: target.uncoveredBranchIds,
    uncoveredLines: target.uncoveredLines,
  }));
  return [
    original || '',
    `[COVERAGE FEEDBACK ROUND ${iteration}]`,
    'Giữ nguyên oracle đã suy ra từ requirement/type/implementation. Bổ sung dữ liệu để phủ các branch/dòng còn thiếu; không đổi expected chỉ để tăng coverage.',
    JSON.stringify(gaps),
  ].filter(Boolean).join('\n');
}

function writeLoopArtifact(runDirectory: string, result: Omit<UnitCoverageLoopResult, 'finalRun'>): void {
  fs.writeFileSync(
    path.join(runDirectory, 'coverage-loop.json'),
    `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), ...result }, null, 2)}\n`,
  );
}

export async function runUnitCoverageGuidedLoop(
  initialRun: UnitRunResult,
  options: { maxIterations?: number; minimumImprovement?: number } = {},
): Promise<UnitCoverageLoopResult> {
  const session = loadUnitSession();
  const maxIterations = options.maxIterations ?? 3;
  const minimumImprovement = options.minimumImprovement ?? 0.1;
  const disabled = process.env.UNIT_COVERAGE_LOOP === '0';
  if (disabled) {
    const result = { ok: true, status: 'DISABLED' as const, rounds: [] };
    writeLoopArtifact(session.runDirectory, result);
    return { ...result, finalRun: initialRun };
  }
  let run = initialRun;
  let report = readGapReport(run.coverageGapReportPath);
  if (!run.ok || !run.coverageEnabled || !report) {
    const result = { ok: run.ok, status: 'NOT_AVAILABLE' as const, rounds: [] };
    writeLoopArtifact(session.runDirectory, result);
    return { ...result, finalRun: run };
  }
  if (report.summary.belowThreshold === 0) {
    const result = { ok: true, status: 'TARGET_REACHED' as const, rounds: [] };
    writeLoopArtifact(session.runDirectory, result);
    return { ...result, finalRun: run };
  }

  const rounds: CoverageLoopRound[] = [];
  const originalContext = loadUnitContext(session);
  let iteration = session.coverageIteration || 0;
  let previousAverage = report.summary.averageEffectiveCoverage;
  let status: UnitCoverageLoopResult['status'] = 'IMPROVED';
  while (iteration < maxIterations && report.summary.belowThreshold > 0) {
    iteration++;
    const targetIds = report.targets.filter(target => target.needsImprovement).map(target => target.target);
    const selectedTargets = originalContext.targets.filter(target => targetIds.includes(target.id));
    if (selectedTargets.length === 0) {
      status = 'NO_PROGRESS';
      break;
    }
    const deltaContext: UnitContextBundle = {
      ...originalContext,
      targets: selectedTargets,
      requirements: coverageRequirements(originalContext.requirements, report, iteration),
    };
    console.log(`\n🔁 [Coverage Loop ${iteration}/${maxIterations}] ${selectedTargets.length} target dưới ngưỡng ${report.threshold}%...`);
    const round: CoverageLoopRound = {
      iteration,
      targetIds,
      beforeCoverage: previousAverage,
      plannerOk: false,
      generatorOk: false,
      testsOk: false,
    };
    round.plannerOk = await runPlanner('unit', JSON.stringify(deltaContext));
    if (!round.plannerOk) {
      round.stopReason = 'PLANNER_FAILED';
      rounds.push(round);
      status = 'FAILED';
      break;
    }
    round.generatorOk = await runUnitGenerator({ preserveExistingFiles: true, onlyTargetIds: targetIds });
    if (!round.generatorOk) {
      round.stopReason = 'GENERATOR_PRODUCED_NO_REPLACEMENT';
      rounds.push(round);
      status = 'FAILED';
      break;
    }
    run = runLastGeneratedUnitTests();
    round.testsOk = run.ok;
    if (!run.ok) {
      round.stopReason = 'GENERATED_TEST_RUN_FAILED';
      rounds.push(round);
      status = 'FAILED';
      break;
    }
    const nextReport = readGapReport(run.coverageGapReportPath);
    if (!nextReport) {
      round.stopReason = 'COVERAGE_REPORT_MISSING';
      rounds.push(round);
      status = 'FAILED';
      break;
    }
    round.afterCoverage = nextReport.summary.averageEffectiveCoverage;
    rounds.push(round);
    updateUnitSession({ coverageIteration: iteration }, loadUnitSession());
    const improvement = nextReport.summary.averageEffectiveCoverage - previousAverage;
    report = nextReport;
    previousAverage = nextReport.summary.averageEffectiveCoverage;
    if (report.summary.belowThreshold === 0) {
      status = 'TARGET_REACHED';
      break;
    }
    if (improvement < minimumImprovement) {
      round.stopReason = 'COVERAGE_DID_NOT_IMPROVE';
      status = 'NO_PROGRESS';
      break;
    }
  }
  const result = { ok: run.ok, status, rounds };
  writeLoopArtifact(session.runDirectory, result);
  return { ...result, finalRun: run };
}

