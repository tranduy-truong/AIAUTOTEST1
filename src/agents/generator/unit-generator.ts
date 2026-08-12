import fs from 'fs';
import path from 'path';
import * as ts from 'typescript';
import { compileUnitTestFile } from '../../core/unit/compiler/test-file-compiler.js';
import {
  resolveTargetOracles,
  type UnitOracleResolution,
} from '../../core/unit/oracle/oracle-resolver.js';
import {
  freshSourceHash,
  freshUnitFileHash,
  loadUnitContext,
  loadUnitSession,
  updateUnitSession,
} from '../../core/unit/artifacts.js';
import type {
  StructuredUnitPlan,
  UnitContextBundle,
  UnitDependency,
  UnitGenerationTargetResult,
  UnitPlanTarget,
  UnitTarget,
  UnitTestCaseGenerationResult,
} from '../../core/unit/schema.js';
import {
  artifact,
  detail,
  error as uiError,
  progress,
  success,
  summary,
  warning,
} from '../../core/cli-ui.js';

function profileCapability(target: UnitTarget): { supported: boolean; reason?: string } {
  if (['UNIT_NATIVE', 'UNIT_MOCKED', 'PROCESS_SANDBOX'].includes(target.profile)) return { supported: true };
  if (target.profile === 'COMPONENT_DOM') {
    return {
      supported: false,
      reason: 'COMPONENT_DOM cần compiler adapter theo framework; không dùng template function thông thường để tránh test sai.',
    };
  }
  if (target.profile === 'INTEGRATION_SANDBOX') {
    return { supported: false, reason: 'Chưa phát hiện sandbox database/backend an toàn; không tự kết nối hạ tầng thật.' };
  }
  if (target.profile === 'ENTRYPOINT_SMOKE') {
    return { supported: false, reason: 'Entrypoint có thể chạy top-level side effect; cần startup harness được dự án khai báo.' };
  }
  return { supported: false, reason: target.profile === 'NO_RUNTIME_TEST'
    ? 'Target không có hành vi runtime.'
    : 'Target cần refactor để có public test seam.' };
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function slug(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unit_target';
}

function withoutSourceExtension(value: string): string {
  return value.replace(/\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/i, '');
}

function relativeModulePath(fromDirectory: string, absoluteModule: string): string {
  let relative = toPosix(path.relative(fromDirectory, absoluteModule));
  if (!relative.startsWith('.')) relative = `./${relative}`;
  if (/\.(?:ts|tsx|mts|cts)$/i.test(relative)) return relative.replace(/\.(?:ts|tsx|mts|cts)$/i, '.js');
  return relative;
}

function sourceImportPath(target: UnitTarget, projectRoot: string, outputDirectory: string): string {
  return relativeModulePath(outputDirectory, path.join(projectRoot, target.sourceFile));
}

function dependencyTestImportPath(
  dependency: UnitDependency,
  projectRoot: string,
  outputDirectory: string,
): string {
  if (dependency.external || !dependency.resolvedFile) return dependency.module;
  return relativeModulePath(outputDirectory, path.join(projectRoot, dependency.resolvedFile));
}

function datedUniqueTestPath(
  outputDirectory: string,
  target: UnitTarget,
  extension: '.test.ts' | '.test.js',
  now = new Date(),
): string {
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
    .join('_');
  const moduleName = path.basename(withoutSourceExtension(target.sourceFile));
  const base = `${slug(moduleName)}_${slug(target.symbol)}_${date}`;
  let candidate = path.join(outputDirectory, `${base}${extension}`);
  let version = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(outputDirectory, `${base}_${String(version).padStart(2, '0')}${extension}`);
    version++;
  }
  return candidate;
}

function findTsConfig(projectRoot: string): string | undefined {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const candidate = path.join(projectRoot, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
  if (!diagnostic.file || diagnostic.start === undefined) return message;
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${position.line + 1}:${position.character + 1} ${message}`;
}

export function typecheckGeneratedUnitFile(projectRoot: string, testFile: string): string[] {
  const configPath = findTsConfig(projectRoot);
  let options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    esModuleInterop: true,
    allowJs: true,
    skipLibCheck: true,
    noEmit: true,
  };
  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!config.error) {
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
      options = { ...parsed.options, noEmit: true, incremental: false, composite: false };
    }
  }
  const normalizedTestFile = path.resolve(testFile);
  const program = ts.createProgram({ rootNames: [normalizedTestFile], options });
  return ts.getPreEmitDiagnostics(program)
    .filter(diagnostic => diagnostic.file && path.resolve(diagnostic.file.fileName) === normalizedTestFile)
    .map(formatDiagnostic);
}

export interface UnitGeneratedCodeValidation {
  ok: boolean;
  errors: string[];
}

interface GeneratedMockCall {
  module?: string;
  topLevel: boolean;
  freeFactoryReferences: string[];
}

function collectBindingNames(name: ts.BindingName, output: Set<string>): void {
  if (ts.isIdentifier(name)) {
    output.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) collectBindingNames(element.name, output);
  }
}

function isIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node)
    || (ts.isPropertyAssignment(parent) && parent.name === node)
    || (ts.isMethodDeclaration(parent) && parent.name === node)
    || (ts.isVariableDeclaration(parent) && parent.name === node)
    || (ts.isParameter(parent) && parent.name === node)
    || (ts.isBindingElement(parent) && parent.name === node)
    || ts.isTypeReferenceNode(parent)
    || ts.isTypeQueryNode(parent)
  ) return false;
  return true;
}

function topLevelHoistedNames(source: ts.SourceFile, frameworkApi: 'vi' | 'jest'): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (
        initializer && ts.isCallExpression(initializer)
        && ts.isPropertyAccessExpression(initializer.expression)
        && ts.isIdentifier(initializer.expression.expression)
        && initializer.expression.expression.text === frameworkApi
        && initializer.expression.name.text === 'hoisted'
      ) collectBindingNames(declaration.name, names);
    }
  }
  return names;
}

function mockFactoryFreeReferences(
  factory: ts.ArrowFunction | ts.FunctionExpression,
  allowedHoisted: Set<string>,
  frameworkApi: 'vi' | 'jest',
): string[] {
  const local = new Set<string>();
  for (const parameter of factory.parameters) collectBindingNames(parameter.name, local);
  const collectDeclarations = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) collectBindingNames(node.name, local);
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) local.add(node.name.text);
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(factory.body);

  const allowedGlobals = new Set([
    frameworkApi, 'undefined', 'Promise', 'Error', 'TypeError', 'Object', 'Array',
    'Map', 'Set', 'Date', 'RegExp', 'JSON', 'Math', 'Number', 'String', 'Boolean',
    'BigInt', 'Symbol', 'console', 'globalThis',
  ]);
  const free = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) && isIdentifierReference(node)
      && !local.has(node.text) && !allowedGlobals.has(node.text) && !allowedHoisted.has(node.text)
    ) free.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(factory.body);
  return [...free].sort();
}

function inspectGeneratedMocks(code: string, framework: 'vitest' | 'jest'): {
  calls: GeneratedMockCall[];
  syntaxErrors: string[];
} {
  const source = ts.createSourceFile('generated-unit.test.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics || [];
  const syntaxErrors = parseDiagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
  const frameworkApi = framework === 'vitest' ? 'vi' : 'jest';
  const hoisted = topLevelHoistedNames(source, frameworkApi);
  const calls: GeneratedMockCall[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === frameworkApi
      && node.expression.name.text === 'mock'
    ) {
      const moduleArgument = node.arguments[0];
      const factory = node.arguments[1];
      calls.push({
        module: moduleArgument && ts.isStringLiteralLike(moduleArgument) ? moduleArgument.text : undefined,
        topLevel: ts.isExpressionStatement(node.parent) && ts.isSourceFile(node.parent.parent),
        freeFactoryReferences: factory && (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory))
          ? mockFactoryFreeReferences(factory, hoisted, frameworkApi)
          : [],
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { calls, syntaxErrors };
}

function targetImportIsPresent(code: string, target: UnitTarget, importPath: string): boolean {
  const escapedPath = importPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const importSymbol = target.classMethod?.className || target.symbol;
  if (target.defaultExport) {
    return new RegExp(`import\\s+[A-Za-z_$][\\w$]*\\s+from\\s+['"]${escapedPath}['"]`).test(code);
  }
  const escapedSymbol = importSymbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`import\\s*\\{[^}]*\\b${escapedSymbol}\\b[^}]*\\}\\s*from\\s*['"]${escapedPath}['"]`).test(code);
}

function globalMockIsPresent(code: string, dependency: UnitDependency): boolean {
  if (dependency.globalName === 'fetch') {
    return /(?:stubGlobal\s*\(\s*['"]fetch['"]|spyOn\s*\(\s*globalThis\s*,\s*['"]fetch['"]|globalThis\.fetch\s*=)/.test(code);
  }
  if (dependency.globalName === 'Date.now') {
    return /spyOn\s*\(\s*Date\s*,\s*['"]now['"]/.test(code);
  }
  if (dependency.globalName === 'Math.random') {
    return /spyOn\s*\(\s*Math\s*,\s*['"]random['"]/.test(code);
  }
  return false;
}

export function validateGeneratedUnitCode(options: {
  code: string;
  target: UnitTarget;
  planTarget: UnitPlanTarget;
  importPath: string;
  framework: 'vitest' | 'jest';
  dependencyPaths: Map<string, string>;
}): UnitGeneratedCodeValidation {
  const { code, target, planTarget, importPath, framework, dependencyPaths } = options;
  const errors: string[] = [];
  if (!targetImportIsPresent(code, target, importPath)) {
    errors.push(`Test không import đúng target từ source thật: ${target.symbol} tại ${importPath}`);
  }
  if (framework === 'vitest' && !/from\s+['"]vitest['"]/.test(code)) errors.push('Thiếu import Vitest.');
  if (framework === 'jest' && !/(?:from\s+['"]@jest\/globals['"]|\bdescribe\s*\()/.test(code)) errors.push('Thiếu Jest test API.');
  if (/\.(?:skip|only)\s*\(|\b(?:it|test)\.todo\s*\(/.test(code)) errors.push('Cấm skip/only/todo trong test được sinh.');
  if (/(?:\/\/|\/\*)\s*(?:TODO|\.\.\.)|^\s*\.\.\.\s*;?\s*$/m.test(code)) {
    errors.push('Test chứa TODO hoặc placeholder rút gọn.');
  }
  if (
    target.profile === 'COMPONENT_DOM' && framework === 'vitest'
    && !/^\s*\/\/\s*@vitest-environment\s+(?:jsdom|happy-dom)\s*$/m.test(code)
  ) {
    errors.push('COMPONENT_DOM phải khai báo Vitest DOM environment ở đầu file.');
  }

  const inspectedMocks = inspectGeneratedMocks(code, framework);
  for (const syntaxError of inspectedMocks.syntaxErrors) errors.push(`File test sai cú pháp: ${syntaxError}`);
  const allowedMockPaths = new Set(
    target.dependencies
      .filter(dependency => dependency.strategy === 'mock' && dependency.mockKind !== 'global')
      .map(dependency => dependencyPaths.get(dependency.module))
      .filter((value): value is string => Boolean(value)),
  );
  const mockCounts = new Map<string, number>();
  for (const mockCall of inspectedMocks.calls) {
    if (!mockCall.module) {
      errors.push('vi.mock/jest.mock phải dùng module path dạng chuỗi tĩnh.');
      continue;
    }
    mockCounts.set(mockCall.module, (mockCounts.get(mockCall.module) || 0) + 1);
    if (!mockCall.topLevel) errors.push(`Mock ${mockCall.module} phải nằm ở top-level, ngoài describe/it/hook.`);
    if (!allowedMockPaths.has(mockCall.module)) errors.push(`Generator mock dependency không có strategy=mock: ${mockCall.module}`);
    if (mockCall.freeFactoryReferences.length > 0) {
      errors.push(
        `Factory mock ${mockCall.module} tham chiếu biến chưa vi.hoisted/jest-safe: ${mockCall.freeFactoryReferences.join(', ')}`,
      );
    }
  }
  for (const mockPath of allowedMockPaths) {
    const count = mockCounts.get(mockPath) || 0;
    if (count === 0) errors.push(`Thiếu top-level mock bắt buộc cho dependency: ${mockPath}`);
    if (count > 1) errors.push(`Dependency ${mockPath} chỉ được mock một lần (hiện tại: ${count}).`);
  }
  for (const dependency of target.dependencies.filter(item => item.strategy === 'mock' && item.mockKind === 'global')) {
    if (!globalMockIsPresent(code, dependency)) {
      errors.push(`Thiếu mock global bắt buộc cho dependency: ${dependency.module}`);
    }
  }

  const productionSymbol = target.classMethod?.className || target.symbol;
  const escaped = productionSymbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (target.kind === 'function' && new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`).test(code)) {
    errors.push('Generator đã copy hàm vào test thay vì import source thật.');
  }
  if (new RegExp(`\\bclass\\s+${escaped}\\b`).test(code)) errors.push('Generator đã copy class vào test thay vì import source thật.');
  if (new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=`).test(code)) errors.push('Generator đã khai báo lại target trong test.');

  for (const testCase of planTarget.testCases) {
    const count = [...code.matchAll(new RegExp(`\\b${testCase.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'))].length;
    if (count !== 1) errors.push(`${testCase.id} phải xuất hiện đúng một lần trong file test (hiện tại: ${count}).`);
    for (const mock of testCase.mocks || []) {
      const dependency = target.dependencies.find(item => item.module === mock.module);
      if (dependency?.mockKind === 'global') {
        if (!globalMockIsPresent(code, dependency)) {
          errors.push(`${testCase.id} chưa mock global đã xác minh: ${mock.module}`);
        }
        continue;
      }
      const mapped = dependencyPaths.get(mock.module);
      if (!mapped) errors.push(`${testCase.id} tham chiếu mock chưa được Dependency Resolver xác minh: ${mock.module}`);
      else if (!code.includes(mapped)) errors.push(`${testCase.id} chưa mock dependency theo đường dẫn đã xác minh: ${mapped}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function buildGenerationManifest(results: UnitGenerationTargetResult[]) {
  const generatedFiles = results.flatMap(result => result.file ? [result.file] : []);
  const statusCounts = Object.fromEntries(
    [...new Set(results.map(result => result.status))].map(status => [
      status,
      results.filter(result => result.status === status).length,
    ]),
  );
  return {
    version: 1 as const,
    generatedAt: new Date().toISOString(),
    summary: {
      total: results.length,
      generated: results.filter(result => Boolean(result.file)).length,
      notGenerated: results.filter(result => !result.file).length,
      statusCounts,
    },
    generatedFiles,
    targets: results,
  };
}

function writeGenerationManifest(sessionDirectory: string, results: UnitGenerationTargetResult[]): void {
  fs.writeFileSync(
    path.join(sessionDirectory, 'generation-manifest.json'),
    `${JSON.stringify(buildGenerationManifest(results), null, 2)}\n`,
  );
}

function updateUntestableTargets(sessionDirectory: string, results: UnitGenerationTargetResult[]): void {
  const file = path.join(sessionDirectory, 'untestable-targets.json');
  let existing: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { targets?: Array<Record<string, unknown>> };
    existing = parsed.targets || [];
  } catch {}
  const generatedIds = new Set(results.map(result => result.target));
  const targets = [
    ...existing.filter(item => !generatedIds.has(String(item.target))),
    ...results.filter(result => !result.file).map(result => ({
      target: result.target,
      profile: result.profile,
      status: result.status,
      reasons: result.errors,
    })),
  ];
  fs.writeFileSync(file, `${JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    targets,
  }, null, 2)}\n`);
}

export function prepareOracleVerifiedPlan(
  context: Pick<UnitContextBundle, 'requirements'>,
  target: UnitTarget,
  planTarget: UnitPlanTarget,
): {
  planTarget: UnitPlanTarget;
  resolutions: UnitOracleResolution[];
  unresolvedCases: UnitTestCaseGenerationResult[];
} {
  const resolutions = resolveTargetOracles(context, target, planTarget.testCases);
  const verifiedIds = new Set(resolutions
    .filter(result => result.status === 'VERIFIED')
    .map(result => result.testCaseId));
  return {
    resolutions,
    planTarget: {
      ...planTarget,
      testCases: planTarget.testCases
        .filter(testCase => verifiedIds.has(testCase.id))
        .map(testCase => ({
          ...testCase,
          oracleEvidence: resolutions.find(result => result.testCaseId === testCase.id)?.evidence
            || testCase.oracleEvidence,
        })),
    },
    unresolvedCases: resolutions
      .filter(result => result.status === 'NEEDS_ORACLE')
      .map(result => ({
        testCaseId: result.testCaseId,
        status: 'NEEDS_ORACLE',
        errors: result.errors,
      })),
  };
}

export async function runUnitGenerator(options: {
  preserveExistingFiles?: boolean;
  onlyTargetIds?: string[];
} = {}): Promise<boolean> {
  const session = loadUnitSession();
  const context = loadUnitContext(session);
  if (context.project.testFramework === 'unknown') {
    uiError('Dự án chưa có Vitest/Jest nên chưa thể sinh test chạy được.');
    detail('Hành động', 'Cấu hình test runner trong dự án đích rồi quét lại.');
    return false;
  }
  const framework = context.project.testFramework;
  const plan = JSON.parse(fs.readFileSync(session.planPath, 'utf-8')) as StructuredUnitPlan;
  const outputDirectory = path.join(context.project.projectRoot, 'tests', 'unit', 'ai-generated');
  fs.mkdirSync(outputDirectory, { recursive: true });

  const generatedFiles: string[] = [];
  const results: UnitGenerationTargetResult[] = [];
  const oracleResults: Array<{ target: string; testCases: UnitOracleResolution[] }> = [];
  const allowedTargets = options.onlyTargetIds ? new Set(options.onlyTargetIds) : undefined;
  const selectedPlanTargets = plan.targets.filter(
    item => !allowedTargets || allowedTargets.has(`${item.sourceFile}#${item.symbol}`),
  );
  for (const [targetIndex, planTarget] of selectedPlanTargets.entries()) {
    const target = context.targets.find(
      item => item.sourceFile === planTarget.sourceFile && item.symbol === planTarget.symbol,
    );
    const label = `${planTarget.sourceFile}#${planTarget.symbol}`;
    if (!target) {
      results.push({ target: label, profile: planTarget.profile || 'REFACTOR_REQUIRED', status: 'STATIC_VALIDATION_FAILED', errors: ['Unit Context không chứa target của Planner.'] });
      continue;
    }
    const capability = profileCapability(target);
    if (!capability.supported) {
      const status = target.profile === 'NO_RUNTIME_TEST'
        ? 'NO_RUNTIME'
        : target.profile === 'REFACTOR_REQUIRED' ? 'REFACTOR_REQUIRED' : 'PROFILE_NOT_SUPPORTED';
      results.push({ target: label, profile: target.profile, status, errors: [capability.reason || 'Profile chưa được hỗ trợ.'] });
      continue;
    }
    if (framework !== 'vitest') {
      results.push({
        target: label,
        profile: target.profile,
        status: 'PROFILE_NOT_SUPPORTED',
        errors: ['Deterministic Unit Compiler hiện hỗ trợ Vitest. Dự án Jest cần compiler adapter riêng.'],
      });
      continue;
    }
    const currentHash = freshSourceHash(target, context.project.projectRoot);
    if (currentHash !== target.sourceHash || planTarget.sourceHash !== target.sourceHash) {
      results.push({ target: label, profile: target.profile, status: 'STALE_SOURCE', errors: ['Source đã thay đổi sau khi Planner lập kế hoạch. Hãy chạy Planner lại.'] });
      continue;
    }
    const supportingDefinitions = [
      ...target.supportingContext.helperDefinitions,
      ...target.supportingContext.typeDefinitions,
      ...target.supportingContext.constantDefinitions,
    ];
    const staleSupportingFile = supportingDefinitions.find(definition =>
      freshUnitFileHash(definition.sourceFile, context.project.projectRoot) !== definition.sourceHash,
    );
    if (staleSupportingFile) {
      results.push({
        target: label,
        profile: target.profile,
        status: 'STALE_SOURCE',
        errors: [`Supporting source đã thay đổi sau Planner: ${staleSupportingFile.sourceFile}. Hãy quét và lập kế hoạch lại.`],
      });
      continue;
    }
    const importPath = sourceImportPath(target, context.project.projectRoot, outputDirectory);
    const dependencyPaths = new Map(
      target.dependencies.map(dependency => [
        dependency.module,
        dependencyTestImportPath(dependency, context.project.projectRoot, outputDirectory),
      ]),
    );
    const oraclePreparation = prepareOracleVerifiedPlan(context, target, planTarget);
    const resolvedOracles = oraclePreparation.resolutions;
    oracleResults.push({ target: label, testCases: resolvedOracles });
    const verifiedPlanTarget = oraclePreparation.planTarget;
    const unresolvedCases = oraclePreparation.unresolvedCases;
    progress(
      targetIndex + 1,
      selectedPlanTargets.length,
      `${planTarget.sourceFile} › ${planTarget.symbol} [${target.profile}]`,
    );
    const compiled = compileUnitTestFile({
      target,
      planTarget: verifiedPlanTarget,
      framework,
      importPath,
      dependencyPaths,
    });
    const compiledById = new Map(compiled.testCases.map(result => [result.testCaseId, result]));
    const unresolvedById = new Map(unresolvedCases.map(result => [result.testCaseId, result]));
    const allTestCaseResults = planTarget.testCases.map(testCase =>
      compiledById.get(testCase.id) || unresolvedById.get(testCase.id) || {
        testCaseId: testCase.id,
        status: 'NEEDS_ORACLE' as const,
        errors: ['Không có kết quả Oracle/Compiler cho test case.'],
      });
    if (!compiled.code) {
      const onlyNeedsOracle = allTestCaseResults.length > 0
        && allTestCaseResults.every(testCase => testCase.status === 'NEEDS_ORACLE');
      results.push({
        target: label,
        profile: target.profile,
        status: onlyNeedsOracle ? 'NEEDS_ORACLE' : 'STATIC_VALIDATION_FAILED',
        errors: allTestCaseResults.flatMap(testCase => testCase.errors),
        testCases: allTestCaseResults,
      });
      continue;
    }
    const generatedIds = new Set(allTestCaseResults
      .filter(testCase => testCase.status === 'GENERATED')
      .map(testCase => testCase.testCaseId));
    const generatedPlanTarget = {
      ...planTarget,
      testCases: planTarget.testCases.filter(testCase => generatedIds.has(testCase.id)),
    };
    const validation = validateGeneratedUnitCode({
      code: compiled.code,
      target,
      planTarget: generatedPlanTarget,
      importPath,
      framework,
      dependencyPaths,
    });
    if (!validation.ok) {
      results.push({
        target: label,
        profile: target.profile,
        status: 'STATIC_VALIDATION_FAILED',
        errors: [`Lỗi nội bộ deterministic compiler: ${validation.errors.join(' | ')}`],
        testCases: allTestCaseResults,
      });
      fs.writeFileSync(path.join(session.runDirectory, `${slug(target.symbol)}.compiler-invalid.ts`), compiled.code);
      continue;
    }
    const testPath = datedUniqueTestPath(
      outputDirectory,
      target,
      /\.(?:js|jsx|mjs|cjs)$/i.test(target.sourceFile) ? '.test.js' : '.test.ts',
    );
    fs.writeFileSync(testPath, `${compiled.code.trim()}\n`);
    const typeErrors = typecheckGeneratedUnitFile(context.project.projectRoot, testPath);
    if (typeErrors.length > 0) {
      fs.rmSync(testPath, { force: true });
      results.push({
        target: label,
        profile: target.profile,
        status: 'TYPECHECK_FAILED',
        errors: typeErrors.map(error => `TypeScript preflight: ${error}`),
        testCases: allTestCaseResults,
      });
      fs.writeFileSync(path.join(session.runDirectory, `${slug(target.symbol)}.typecheck-errors.json`), `${JSON.stringify(typeErrors, null, 2)}\n`);
      continue;
    }
    generatedFiles.push(testPath);
    const skippedCases = allTestCaseResults.filter(testCase => testCase.status !== 'GENERATED');
    results.push({
      target: label,
      profile: target.profile,
      status: skippedCases.length > 0 ? 'PARTIAL' : 'GENERATED',
      file: testPath,
      errors: skippedCases.flatMap(testCase => testCase.errors),
      testCases: allTestCaseResults,
    });
    success(`Đã tạo ${path.basename(testPath)}`);
  }

  // A run must be reproducible from its own generation manifest. Replacing
  // instead of accumulating prevents a repaired generation from re-running an
  // older invalid file produced earlier in the same session.
  const generatedTargetFiles = {
    ...(options.preserveExistingFiles ? session.generatedTargetFiles || {} : {}),
    ...Object.fromEntries(results.flatMap(result => result.file ? [[result.target, result.file]] : [])),
  };
  updateUnitSession({
    generatedFiles: [...new Set(Object.values(generatedTargetFiles).filter(file => fs.existsSync(file)))],
    generatedTargetFiles,
  }, session);
  writeGenerationManifest(session.runDirectory, results);
  fs.writeFileSync(path.join(session.runDirectory, 'oracle-resolution.json'), `${JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    policy: 'Only requirement references and deterministic static evaluation can verify an oracle. Sandbox observations are characterization only.',
    targets: oracleResults,
  }, null, 2)}\n`);
  const oracleRequests = results.flatMap(result => (result.testCases || [])
    .filter(testCase => testCase.status === 'NEEDS_ORACLE')
    .map(testCase => {
      const planTarget = plan.targets.find(item => `${item.sourceFile}#${item.symbol}` === result.target);
      const plannedCase = planTarget?.testCases.find(item => item.id === testCase.testCaseId);
      return {
        target: result.target,
        testCaseId: testCase.testCaseId,
        name: plannedCase?.name,
        inputs: plannedCase?.inputs,
        proposedExpected: plannedCase?.expected,
        proposedOracleSource: plannedCase?.oracleSource,
        reasons: testCase.errors,
        nextAction: 'Xác nhận trực tiếp trên CLI; hệ thống sẽ tự lưu và chạy lại Generator.',
      };
    }));
  fs.writeFileSync(path.join(session.runDirectory, 'oracle-requests.json'), `${JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    count: oracleRequests.length,
    requests: oracleRequests,
  }, null, 2)}\n`);
  updateUntestableTargets(session.runDirectory, results);
  const notGenerated = results.filter(result => !result.file);
  const partialTargets = results.filter(result => result.status === 'PARTIAL');
  const testCaseResults = results.flatMap(result => result.testCases || []);
  const generatedCases = testCaseResults.filter(testCase => testCase.status === 'GENERATED').length;
  const targetReadyCount = results.length - notGenerated.length;
  const resultTone = generatedFiles.length === results.length && oracleRequests.length === 0
    ? 'success'
    : oracleRequests.length > 0 || generatedFiles.length > 0
      ? 'warning'
      : 'error';
  summary('Kết quả sinh Unit Test', [
    ['Target sẵn sàng', `${targetReadyCount}/${results.length}`],
    ['File test đã tạo', String(generatedFiles.length)],
    ['Test case sẵn sàng', `${generatedCases}/${testCaseResults.length}`],
    ['Cần xác nhận expected', String(oracleRequests.length)],
  ], resultTone);

  if (oracleRequests.length > 0) {
    warning(`${oracleRequests.length} test case chưa có kết quả mong đợi đủ tin cậy.`);
    detail('Làm tiếp', 'CLI sẽ hiển thị từng trường hợp để tester xác nhận ngay.');
  }
  if (partialTargets.length > 0) {
    warning(`${partialTargets.length} target mới sinh được một phần.`);
  }
  const blockedWithoutOracle = notGenerated.length - results.filter(
    result => !result.file && result.status === 'NEEDS_ORACLE',
  ).length;
  if (blockedWithoutOracle > 0) {
    uiError(`${blockedWithoutOracle} target gặp lỗi kỹ thuật và chưa tạo được file test.`);
    artifact('Chi tiết kỹ thuật', 'generation-manifest.json');
  } else if (notGenerated.length > 0 && oracleRequests.length === 0) {
    warning(`${notGenerated.length} target chưa tạo được file test.`);
    artifact('Chi tiết kỹ thuật', 'generation-manifest.json');
  }
  if (generatedFiles.length > 0) {
    success(`Hoàn tất ${generatedFiles.length} file Unit Test.`);
    artifact('Thư mục kết quả', outputDirectory);
  } else if (oracleRequests.length > 0) {
    warning('Chưa tạo file test vì các kết quả nghiệp vụ đang chờ tester xác nhận trên CLI.');
  }
  return generatedFiles.length > 0;
}
