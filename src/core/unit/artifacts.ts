import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { buildUnitCodeIndex } from './ast-reader.js';
import { scanUnitProject } from './project-scanner.js';
import { buildTestabilityManifest } from './testability-classifier.js';
import type {
  StructuredUnitPlan,
  UnitCodeIndex,
  UnitContextBundle,
  UnitProjectManifest,
  UnitSession,
  UnitTarget,
} from './schema.js';

export const UNIT_CURRENT_SESSION_PATH = 'artifacts/unit/current.json';

function slug(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unit-project';
}

function compactRunId(now = new Date()): string {
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
    .join('');
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(part => String(part).padStart(2, '0'))
    .join('');
  return `${date}_${time}_${String(now.getMilliseconds()).padStart(3, '0')}`;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function branchMap(index: UnitCodeIndex) {
  return {
    version: 1,
    targets: index.targets.map(target => ({
      id: target.id,
      sourceFile: target.sourceFile,
      symbol: target.symbol,
      sourceHash: target.sourceHash,
      branches: target.branches,
    })),
  };
}

function dependencyMap(index: UnitCodeIndex) {
  return {
    version: 1,
    targets: index.targets.map(target => ({
      id: target.id,
      sourceFile: target.sourceFile,
      symbol: target.symbol,
      executionMode: target.executionMode,
      profile: target.profile,
      runtimeEnvironment: target.runtimeEnvironment,
      dependencies: target.dependencies,
      unsupportedReasons: target.unsupportedReasons,
    })),
  };
}

export interface PreparedUnitAnalysis {
  manifest: UnitProjectManifest;
  index: UnitCodeIndex;
}

export function analyzeUnitInput(inputPath: string): PreparedUnitAnalysis {
  const manifest = scanUnitProject(inputPath);
  const index = buildUnitCodeIndex(manifest);
  return { manifest, index };
}

export function createUnitSession(
  analysis: PreparedUnitAnalysis,
  selectedTargetIds: string[],
  requirements = '',
  cwd = process.cwd(),
): { session: UnitSession; context: UnitContextBundle } {
  const selected = analysis.index.targets.filter(target => selectedTargetIds.includes(target.id));
  if (selected.length === 0) throw new Error('Chưa chọn target Unit Test nào để Planner phân tích.');
  const unsupported = selected.filter(target => target.executionMode === 'UNSUPPORTED');
  if (unsupported.length > 0) {
    throw new Error(`Không thể sinh test bền vững cho target chưa export: ${unsupported.map(target => target.id).join(', ')}`);
  }

  const runId = compactRunId();
  const runDirectory = path.join(cwd, 'artifacts', 'unit', slug(analysis.manifest.projectName), runId);
  const contextPath = path.join(runDirectory, 'context-bundle.json');
  const planPath = path.join(runDirectory, 'test-plan-unit.json');
  const context: UnitContextBundle = {
    version: 1,
    project: analysis.manifest,
    targets: selected,
    requirements: requirements.trim() || undefined,
  };
  const session: UnitSession = {
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    projectRoot: analysis.manifest.projectRoot,
    projectName: analysis.manifest.projectName,
    testFramework: analysis.manifest.testFramework,
    runDirectory,
    contextPath,
    planPath,
    generatedFiles: [],
  };

  fs.mkdirSync(runDirectory, { recursive: true });
  const testability = buildTestabilityManifest({
    projectRoot: analysis.manifest.projectRoot,
    sourceFiles: analysis.manifest.sourceFiles,
    targets: analysis.index.targets,
    selectedTargetIds,
  });
  const selectedEntries = testability.entries.filter(entry => entry.selected);
  const partitions = Object.fromEntries(
    [...new Set(selectedEntries.map(entry => entry.profile))].map(profile => [
      profile,
      selectedEntries.filter(entry => entry.profile === profile).map(entry => entry.id),
    ]),
  );
  writeJson(path.join(runDirectory, 'project-manifest.json'), analysis.manifest);
  writeJson(path.join(runDirectory, 'testability-manifest.json'), testability);
  writeJson(path.join(runDirectory, 'target-partitions.json'), {
    version: 1,
    generatedAt: new Date().toISOString(),
    partitions,
  });
  writeJson(path.join(runDirectory, 'untestable-targets.json'), {
    version: 1,
    generatedAt: new Date().toISOString(),
    targets: testability.entries
      .filter(entry => !entry.generatable)
      .map(entry => ({
        target: entry.id,
        profile: entry.profile,
        status: entry.profile === 'NO_RUNTIME_TEST' ? 'NO_RUNTIME' : 'REFACTOR_REQUIRED',
        reasons: entry.reasons,
      })),
  });
  writeJson(path.join(runDirectory, 'code-index.json'), { ...analysis.index, targets: selected });
  writeJson(path.join(runDirectory, 'branch-map.json'), branchMap({ ...analysis.index, targets: selected }));
  writeJson(path.join(runDirectory, 'dependency-map.json'), dependencyMap({ ...analysis.index, targets: selected }));
  writeJson(path.join(runDirectory, 'supporting-context.json'), {
    version: 1,
    targets: selected.map(target => ({
      id: target.id,
      sourceFile: target.sourceFile,
      symbol: target.symbol,
      sourceHash: target.sourceHash,
      supportingContext: target.supportingContext,
    })),
  });
  writeJson(contextPath, context);
  writeJson(path.join(cwd, UNIT_CURRENT_SESSION_PATH), session);
  return { session, context };
}

export function loadUnitSession(
  sessionPath = path.join(process.cwd(), UNIT_CURRENT_SESSION_PATH),
): UnitSession {
  const parsed = JSON.parse(fs.readFileSync(sessionPath, 'utf-8')) as UnitSession;
  if (parsed.version !== 1 || !parsed.projectRoot || !parsed.contextPath || !parsed.runDirectory) {
    throw new Error(`Unit session không hợp lệ: ${sessionPath}`);
  }
  return parsed;
}

export function loadUnitContext(session = loadUnitSession()): UnitContextBundle {
  const parsed = JSON.parse(fs.readFileSync(session.contextPath, 'utf-8')) as UnitContextBundle;
  if (parsed.version !== 1 || !parsed.project || !Array.isArray(parsed.targets)) {
    throw new Error(`Unit context không hợp lệ: ${session.contextPath}`);
  }
  return parsed;
}

export function updateUnitSession(update: Partial<UnitSession>, session = loadUnitSession()): UnitSession {
  const next = { ...session, ...update };
  writeJson(path.join(process.cwd(), UNIT_CURRENT_SESSION_PATH), next);
  return next;
}

export function saveUnitPlan(
  plan: StructuredUnitPlan,
  session = loadUnitSession(),
  cwd = process.cwd(),
): void {
  writeJson(session.planPath, plan);
  writeJson(path.join(cwd, 'artifacts', 'test-plan-unit.json'), plan);
}

export function freshSourceHash(target: UnitTarget, projectRoot: string): string {
  return freshUnitFileHash(target.sourceFile, projectRoot);
}

export function freshUnitFileHash(sourceFile: string, projectRoot: string): string {
  const absolute = path.join(projectRoot, sourceFile);
  if (!fs.existsSync(absolute)) return '';
  const source = fs.readFileSync(absolute, 'utf-8');
  return crypto.createHash('sha256').update(source).digest('hex');
}
