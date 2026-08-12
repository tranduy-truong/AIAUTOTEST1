import fs from 'fs';
import path from 'path';
import * as ts from 'typescript';
import type {
  UnitDependency,
  UnitExecutionMode,
  UnitRuntimeEnvironment,
  UnitTargetKind,
  UnitTestabilityEntry,
  UnitTestabilityManifest,
  UnitTestabilityProfile,
} from './schema.js';

export interface UnitProfileInput {
  sourceFile: string;
  symbol: string;
  kind: UnitTargetKind;
  exported: boolean;
  rawCode: string;
  dependencies: UnitDependency[];
  unsupportedReasons: string[];
  executionMode: UnitExecutionMode;
}

export interface UnitProfileClassification {
  profile: UnitTestabilityProfile;
  runtimeEnvironment: UnitRuntimeEnvironment;
  reasons: string[];
}

const ENTRYPOINT_NAMES = /^(?:index|main|server|app|cli|bootstrap|worker)(?:\.[^.]+)?$/i;
const COMPONENT_IMPORT = /(?:^|[/@])(?:react|react-dom|vue|@vue|angular|@angular|svelte|solid-js)(?:[/\s]|$)/i;
const BACKEND_FRAMEWORK = /(?:^|[/@])(?:express|fastify|koa|hapi|nestjs|@nestjs|next|nuxt)(?:[/\s]|$)/i;

function basenameWithoutSourceExtension(sourceFile: string): string {
  return path.basename(sourceFile).replace(/\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/i, '');
}

export function classifyUnitTarget(input: UnitProfileInput): UnitProfileClassification {
  const modules = input.dependencies.map(dependency => dependency.module).join(' ');
  if (!input.exported || input.executionMode === 'UNSUPPORTED') {
    return {
      profile: 'REFACTOR_REQUIRED', runtimeEnvironment: 'none',
      reasons: input.unsupportedReasons.length > 0
        ? input.unsupportedReasons
        : ['Target không được export nên không thể kiểm thử ổn định qua public contract.'],
    };
  }
  if (/\.(?:tsx|jsx)$/i.test(input.sourceFile) || COMPONENT_IMPORT.test(modules)) {
    return {
      profile: 'COMPONENT_DOM', runtimeEnvironment: 'jsdom',
      reasons: ['Target sử dụng UI component/JSX và cần DOM test environment.'],
    };
  }
  if (
    /^(?:main|bootstrap|start|serve|runCli)$/i.test(input.symbol.split('.').at(-1) || '')
    || (
      ENTRYPOINT_NAMES.test(basenameWithoutSourceExtension(input.sourceFile))
      && /^(?:default|main|bootstrap|start|serve|runCli)$/i.test(input.symbol.split('.').at(-1) || '')
    )
  ) {
    return {
      profile: 'ENTRYPOINT_SMOKE', runtimeEnvironment: 'node',
      reasons: ['Target là entrypoint/bootstrap; chỉ nên smoke test public startup contract.'],
    };
  }
  if (
    input.dependencies.some(dependency => dependency.boundary === 'process' || dependency.boundary === 'filesystem')
    || /\b(?:process\.(?:exit|cwd|env)|worker_threads|child_process)\b/.test(input.rawCode)
  ) {
    return {
      profile: 'PROCESS_SANDBOX', runtimeEnvironment: 'node',
      reasons: ['Target đụng process/filesystem và phải chạy với boundary được cô lập.'],
    };
  }
  if (
    input.dependencies.some(dependency => dependency.boundary === 'database')
    || BACKEND_FRAMEWORK.test(modules)
  ) {
    return {
      profile: 'INTEGRATION_SANDBOX', runtimeEnvironment: 'integration',
      reasons: ['Target phụ thuộc database/backend framework và cần sandbox tích hợp.'],
    };
  }
  if (input.dependencies.some(dependency => dependency.strategy === 'mock')) {
    return {
      profile: 'UNIT_MOCKED', runtimeEnvironment: 'node',
      reasons: ['Target có boundary bên ngoài đã xác minh và có thể cô lập bằng mock.'],
    };
  }
  return {
    profile: 'UNIT_NATIVE', runtimeEnvironment: 'node',
    reasons: ['Target chỉ dùng logic/runtime nội bộ và có thể chạy trực tiếp.'],
  };
}

function fileHasRuntimeStatements(projectRoot: string, sourceFile: string): boolean {
  const absolute = path.join(projectRoot, sourceFile);
  if (!fs.existsSync(absolute)) return false;
  const sourceText = fs.readFileSync(absolute, 'utf-8');
  const source = ts.createSourceFile(
    sourceFile, sourceText, ts.ScriptTarget.Latest, true,
    /\.(?:tsx|jsx)$/i.test(sourceFile) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const initializerExecutes = (node: ts.Node): boolean => {
    let executes = false;
    const visit = (child: ts.Node) => {
      if (
        ts.isCallExpression(child) || ts.isNewExpression(child) || ts.isAwaitExpression(child)
        || ts.isArrowFunction(child) || ts.isFunctionExpression(child)
      ) {
        executes = true;
        return;
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return executes;
  };
  return source.statements.some(statement => {
    if (
      ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
      || ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
    ) return false;
    if (ts.isModuleDeclaration(statement) && (statement.flags & ts.NodeFlags.Namespace) === 0) return false;
    if (ts.isEnumDeclaration(statement)) return false;
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some(declaration =>
        declaration.initializer ? initializerExecutes(declaration.initializer) : false,
      );
    }
    return true;
  });
}

const ALL_PROFILES: UnitTestabilityProfile[] = [
  'UNIT_NATIVE', 'UNIT_MOCKED', 'COMPONENT_DOM', 'INTEGRATION_SANDBOX',
  'PROCESS_SANDBOX', 'ENTRYPOINT_SMOKE', 'NO_RUNTIME_TEST', 'REFACTOR_REQUIRED',
];

export function buildTestabilityManifest(options: {
  projectRoot: string;
  sourceFiles: string[];
  targets: Array<{
    id: string;
    sourceFile: string;
    symbol: string;
    profile: UnitTestabilityProfile;
    runtimeEnvironment: UnitRuntimeEnvironment;
    profileReasons: string[];
  }>;
  selectedTargetIds?: string[];
  generatedAt?: string;
}): UnitTestabilityManifest {
  const selected = new Set(options.selectedTargetIds || options.targets.map(target => target.id));
  const entries: UnitTestabilityEntry[] = options.targets.map(target => ({
    id: target.id,
    sourceFile: target.sourceFile,
    symbol: target.symbol,
    profile: target.profile,
    runtimeEnvironment: target.runtimeEnvironment,
    selected: selected.has(target.id),
    generatable: !['NO_RUNTIME_TEST', 'REFACTOR_REQUIRED'].includes(target.profile),
    reasons: target.profileReasons,
  }));
  const filesWithTargets = new Set(options.targets.map(target => target.sourceFile));
  for (const sourceFile of options.sourceFiles.filter(file => !filesWithTargets.has(file))) {
    const hasRuntime = fileHasRuntimeStatements(options.projectRoot, sourceFile);
    entries.push({
      id: sourceFile,
      sourceFile,
      profile: hasRuntime ? 'REFACTOR_REQUIRED' : 'NO_RUNTIME_TEST',
      runtimeEnvironment: 'none',
      selected: false,
      generatable: false,
      reasons: [hasRuntime
        ? 'File có runtime code nhưng không có public function/class method đủ điều kiện để test.'
        : 'File chỉ chứa type/interface/import/export và không có hành vi runtime để kiểm thử.'],
    });
  }
  const summary = Object.fromEntries(ALL_PROFILES.map(profile => [
    profile,
    entries.filter(entry => entry.profile === profile).length,
  ])) as Record<UnitTestabilityProfile, number>;
  return {
    version: 1,
    projectRoot: options.projectRoot,
    generatedAt: options.generatedAt || new Date().toISOString(),
    entries: entries.sort((left, right) => left.id.localeCompare(right.id)),
    summary,
  };
}
