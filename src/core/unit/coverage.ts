import fs from 'fs';
import path from 'path';
import type { UnitTarget } from './schema.js';

interface IstanbulLocation {
  start: { line: number; column?: number };
  end?: { line: number; column?: number };
}

interface IstanbulFileCoverage {
  statementMap?: Record<string, IstanbulLocation>;
  s?: Record<string, number>;
  branchMap?: Record<string, IstanbulLocation & { locations?: IstanbulLocation[] }>;
  b?: Record<string, number[]>;
}

export interface UnitTargetCoverageGap {
  target: string;
  sourceFile: string;
  symbol: string;
  statementCoverage: number;
  branchCoverage: number;
  effectiveCoverage: number;
  uncoveredLines: number[];
  uncoveredBranchIds: string[];
  uncoveredBranchLocations: Array<{ line: number; armIndexes: number[] }>;
  needsImprovement: boolean;
}

export interface UnitCoverageGapReport {
  version: 1;
  status: 'COVERAGE_ANALYZED' | 'COVERAGE_REPORT_INVALID';
  threshold: number;
  coverageFile: string;
  generatedAt: string;
  targets: UnitTargetCoverageGap[];
  summary: {
    analyzed: number;
    belowThreshold: number;
    averageEffectiveCoverage: number;
  };
  error?: string;
}

function normalizedAbsolute(value: string): string {
  return path.resolve(value).replace(/\\/g, '/').toLowerCase();
}

function percent(covered: number, total: number): number {
  return total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2));
}

function fileCoverageFor(
  finalCoverage: Record<string, IstanbulFileCoverage>,
  projectRoot: string,
  sourceFile: string,
): IstanbulFileCoverage | undefined {
  const expected = normalizedAbsolute(path.join(projectRoot, sourceFile));
  const entry = Object.entries(finalCoverage).find(([file]) => normalizedAbsolute(file) === expected);
  return entry?.[1];
}

export function analyzeUnitCoverage(options: {
  projectRoot: string;
  coverageFile: string;
  targets: UnitTarget[];
  threshold?: number;
}): UnitCoverageGapReport {
  const threshold = options.threshold ?? 80;
  let finalCoverage: Record<string, IstanbulFileCoverage>;
  try {
    finalCoverage = JSON.parse(fs.readFileSync(options.coverageFile, 'utf-8')) as Record<string, IstanbulFileCoverage>;
  } catch (error) {
    return {
      version: 1, status: 'COVERAGE_REPORT_INVALID', threshold,
      coverageFile: options.coverageFile, generatedAt: new Date().toISOString(),
      targets: [], summary: { analyzed: 0, belowThreshold: 0, averageEffectiveCoverage: 0 },
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const targets: UnitTargetCoverageGap[] = [];
  for (const target of options.targets) {
    const coverage = fileCoverageFor(finalCoverage, options.projectRoot, target.sourceFile);
    if (!coverage) continue;
    const statementEntries = Object.entries(coverage.statementMap || {})
      .filter(([, location]) => location.start.line >= target.startLine && location.start.line <= target.endLine);
    const uncoveredLines = statementEntries
      .filter(([id]) => Number(coverage.s?.[id] || 0) === 0)
      .map(([, location]) => location.start.line);
    const statementCovered = statementEntries.filter(([id]) => Number(coverage.s?.[id] || 0) > 0).length;

    let branchTotal = 0;
    let branchCovered = 0;
    const uncoveredBranchLocations: Array<{ line: number; armIndexes: number[] }> = [];
    const uncoveredBranchIds = new Set<string>();
    for (const [id, branch] of Object.entries(coverage.branchMap || {})) {
      const line = branch.start?.line || branch.locations?.[0]?.start.line;
      if (!line || line < target.startLine || line > target.endLine) continue;
      const counts = coverage.b?.[id] || [];
      branchTotal += counts.length;
      branchCovered += counts.filter(count => count > 0).length;
      const armIndexes = counts.flatMap((count, index) => count === 0 ? [index] : []);
      if (armIndexes.length === 0) continue;
      uncoveredBranchLocations.push({ line, armIndexes });
      const branchIdsAtLine = target.branches.filter(item => item.line === line).map(item => item.id);
      if (branchIdsAtLine.length === counts.length) {
        for (const index of armIndexes) {
          if (branchIdsAtLine[index]) uncoveredBranchIds.add(branchIdsAtLine[index]);
        }
      } else {
        for (const branchId of branchIdsAtLine) uncoveredBranchIds.add(branchId);
      }
    }
    const statementCoverage = percent(statementCovered, statementEntries.length);
    const branchCoverage = percent(branchCovered, branchTotal);
    const effectiveCoverage = branchTotal > 0
      ? Number(((statementCoverage + branchCoverage) / 2).toFixed(2))
      : statementCoverage;
    targets.push({
      target: target.id,
      sourceFile: target.sourceFile,
      symbol: target.symbol,
      statementCoverage,
      branchCoverage,
      effectiveCoverage,
      uncoveredLines: [...new Set(uncoveredLines)].sort((a, b) => a - b),
      uncoveredBranchIds: [...uncoveredBranchIds].sort(),
      uncoveredBranchLocations,
      needsImprovement: effectiveCoverage < threshold,
    });
  }
  const average = targets.length === 0
    ? 0
    : Number((targets.reduce((sum, target) => sum + target.effectiveCoverage, 0) / targets.length).toFixed(2));
  return {
    version: 1,
    status: 'COVERAGE_ANALYZED',
    threshold,
    coverageFile: options.coverageFile,
    generatedAt: new Date().toISOString(),
    targets,
    summary: {
      analyzed: targets.length,
      belowThreshold: targets.filter(target => target.needsImprovement).length,
      averageEffectiveCoverage: average,
    },
  };
}

