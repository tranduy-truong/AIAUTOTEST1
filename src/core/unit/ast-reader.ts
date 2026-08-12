import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as ts from 'typescript';
import { buildSupportingContext } from './supporting-context.js';
import { classifyUnitTarget } from './testability-classifier.js';
import type {
  UnitBranch,
  UnitCodeIndex,
  UnitDependency,
  UnitExecutionMode,
  UnitParameter,
  UnitProjectManifest,
  UnitSupportingContext,
  UnitTarget,
} from './schema.js';

const MAX_TARGET_CODE_CHARS = 24_000;

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === kind));
}

function isExported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword) || hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}

function collectNamedExports(source: ts.SourceFile): { named: Set<string>; defaultName?: string } {
  const named = new Set<string>();
  let defaultName: string | undefined;
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        named.add(element.propertyName?.text || element.name.text);
      }
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) {
      defaultName = statement.expression.text;
      named.add(defaultName);
    }
  }
  return { named, defaultName };
}

function redactPotentialSecrets(rawCode: string): string {
  return rawCode.replace(
    /(\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password)\b\s*(?::|=(?!=))\s*)(['"`])(?:\\.|(?!\2)[\s\S])*?\2/gi,
    "$1'<REDACTED>'",
  );
}

function resolveInternalModule(root: string, sourceFile: string, moduleName: string): string | undefined {
  if (!moduleName.startsWith('.')) return undefined;
  const base = path.resolve(root, path.dirname(sourceFile), moduleName);
  const sourceBase = /\.(?:mjs|cjs|js)$/i.test(base) ? base.replace(/\.(?:mjs|cjs|js)$/i, '') : base;
  const candidates = [
    base,
    ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].map(ext => `${sourceBase}${ext}`),
    ...['.ts', '.tsx', '.js', '.jsx'].map(ext => path.join(sourceBase, `index${ext}`)),
  ];
  const found = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  return found ? toPosix(path.relative(root, found)) : undefined;
}

function classifyBoundary(moduleName: string): UnitDependency['boundary'] {
  const normalized = moduleName.toLowerCase();
  if (/(repository|database|\bdb\b|prisma|sequelize|typeorm|mongoose|redis)/.test(normalized)) return 'database';
  if (/(axios|fetch|http|api|graphql|email|mailer|sms|queue|playwright|puppeteer|selenium|openai|groq|anthropic|gemini)/.test(normalized)) return 'network';
  if (/^(?:node:)?fs(?:\/|\s|$)|filesystem/.test(normalized)) return 'filesystem';
  if (/^(?:node:)?(?:child_process|worker_threads)(?:\/|\s|$)|\bexecsync\b|\bspawn(?:sync)?\b/.test(normalized)) return 'process';
  if (/(date|clock|time|random|uuid|nanoid)/.test(normalized)) return 'time-random';
  if (/(react|vue|angular|next|nuxt|nestjs|express|fastify)/.test(normalized)) return 'framework';
  return 'internal';
}

interface ImportInfo {
  module: string;
  importedNames: string[];
  importBindings?: NonNullable<UnitDependency['importBindings']>;
  external: boolean;
  boundary: UnitDependency['boundary'];
  resolvedFile?: string;
}

function importsForFile(source: ts.SourceFile, root: string, relativeFile: string): ImportInfo[] {
  const imports: ImportInfo[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleName = statement.moduleSpecifier.text;
    const importedNames: string[] = [];
    const importBindings: NonNullable<UnitDependency['importBindings']> = [];
    const clause = statement.importClause;
    if (clause?.name) {
      importedNames.push(clause.name.text);
      importBindings.push({ kind: 'default', localName: clause.name.text, importedName: 'default' });
    }
    if (clause?.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        importedNames.push(clause.namedBindings.name.text);
        importBindings.push({ kind: 'namespace', localName: clause.namedBindings.name.text, importedName: '*' });
      } else {
        importedNames.push(...clause.namedBindings.elements.map(element => element.name.text));
        importBindings.push(...clause.namedBindings.elements.map(element => ({
          kind: 'named' as const,
          localName: element.name.text,
          importedName: element.propertyName?.text || element.name.text,
        })));
      }
    }
    imports.push({
      module: moduleName,
      importedNames,
      importBindings,
      external: !moduleName.startsWith('.'),
      boundary: classifyBoundary(`${moduleName} ${importedNames.join(' ')}`),
      resolvedFile: resolveInternalModule(root, relativeFile, moduleName),
    });
  }
  return imports;
}

function dependenciesForTarget(
  rootImports: ImportInfo[],
  reachableImports: UnitTarget['supportingContext']['reachableImports'],
  evidenceCode = '',
): UnitDependency[] {
  const aggregated = new Map<string, ImportInfo>();
  for (const item of reachableImports) {
    const key = item.resolvedFile || item.module;
    const existing = aggregated.get(key);
    const importedNames = item.importedNames.filter(name => name !== '*');
    aggregated.set(key, {
      module: item.module,
      importedNames: [...new Set([...(existing?.importedNames || []), ...importedNames])],
      importBindings: existing?.importBindings,
      external: !item.module.startsWith('.'),
      boundary: classifyBoundary(`${item.module} ${item.importedNames.join(' ')}`),
      resolvedFile: item.resolvedFile,
    });
  }
  // Supporting-context resolution stores source export names, while member
  // access detection needs the local binding used in the target (for example
  // default import `fs` in `fs.readFileSync`). Merge both views here.
  for (const item of rootImports) {
    const key = item.resolvedFile || item.module;
    const existing = aggregated.get(key);
    if (!existing) continue;
    aggregated.set(key, {
      ...existing,
      importedNames: [...new Set([
        ...existing.importedNames.filter(name => name !== 'default' && name !== '*'),
        ...item.importedNames,
      ])],
      importBindings: [...new Map([
        ...(existing.importBindings || []),
        ...(item.importBindings || []),
      ].map(binding => [`${binding.kind}:${binding.localName}:${binding.importedName}`, binding])).values()],
    });
  }
  // Side-effect imports in the target module execute as soon as the real target
  // is imported, even though they have no local binding in the call graph.
  for (const item of rootImports.filter(candidate => candidate.importedNames.length === 0)) {
    aggregated.set(item.resolvedFile || item.module, item);
  }
  const dependencies: UnitDependency[] = [...aggregated.values()]
    .map(item => {
      const needsNativeEnvironment = item.boundary === 'framework';
      const needsMock = item.boundary !== 'internal' && !needsNativeEnvironment;
      return {
        ...item,
        strategy: needsNativeEnvironment ? 'native-environment' : needsMock ? 'mock' : 'real',
        mockKind: needsMock ? 'module' : undefined,
        usedMembers: [...new Set(item.importedNames.flatMap(localName => {
          const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const members = [...evidenceCode.matchAll(new RegExp(`\\b${escaped}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g'))]
            .map(match => match[1]);
          if (members.length > 0) return members;
          return new RegExp(`\\b${escaped}\\b`).test(evidenceCode) ? [localName] : [];
        }))],
      };
    });
  const addGlobal = (module: string, globalName: string, boundary: UnitDependency['boundary']) => {
    if (dependencies.some(dependency => dependency.module === module)) return;
    dependencies.push({
      module, importedNames: [globalName], external: true, boundary,
      strategy: 'mock', mockKind: 'global', globalName, usedMembers: [globalName],
    });
  };
  if (/\bfetch\s*\(/.test(evidenceCode)) addGlobal('globalThis.fetch', 'fetch', 'network');
  if (/\bDate\.now\s*\(/.test(evidenceCode)) addGlobal('Date.now', 'Date.now', 'time-random');
  if (/\bMath\.random\s*\(/.test(evidenceCode)) addGlobal('Math.random', 'Math.random', 'time-random');
  return dependencies;
}

function dependencyEvidence(rawCode: string, supportingContext: UnitSupportingContext): string {
  return [
    rawCode,
    ...supportingContext.helperDefinitions.map(definition => definition.code),
    ...supportingContext.constantDefinitions.map(definition => definition.code),
  ].join('\n');
}

function nodeLine(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function compactText(node: ts.Node, source: ts.SourceFile, max = 180): string {
  const value = node.getText(source).replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function branchesForNode(target: ts.Node, source: ts.SourceFile): UnitBranch[] {
  const branches: UnitBranch[] = [];
  let counter = 1;
  const addPair = (kind: UnitBranch['kind'], condition: ts.Node, lineNode: ts.Node, trueOutcome: string, falseOutcome: string) => {
    const base = `B${String(counter++).padStart(3, '0')}`;
    const text = compactText(condition, source);
    const line = nodeLine(source, lineNode);
    branches.push({ id: `${base}_TRUE`, kind, condition: text, outcome: trueOutcome, line });
    branches.push({ id: `${base}_FALSE`, kind, condition: text, outcome: falseOutcome, line });
  };

  const visit = (node: ts.Node) => {
    if (node !== target && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) {
      return;
    }
    if (ts.isIfStatement(node)) {
      addPair('if', node.expression, node, 'condition true', node.elseStatement ? 'condition false / else' : 'condition false / continue');
    } else if (ts.isConditionalExpression(node)) {
      addPair('ternary', node.condition, node, 'whenTrue', 'whenFalse');
    } else if (ts.isSwitchStatement(node)) {
      for (const clause of node.caseBlock.clauses) {
        const id = `B${String(counter++).padStart(3, '0')}_CASE`;
        branches.push({
          id,
          kind: 'switch',
          condition: ts.isDefaultClause(clause) ? 'default' : compactText(clause.expression, source),
          outcome: ts.isDefaultClause(clause) ? 'default clause' : 'matching case',
          line: nodeLine(source, clause),
        });
      }
    } else if (ts.isCatchClause(node)) {
      const base = `B${String(counter++).padStart(3, '0')}`;
      branches.push({
        id: `${base}_TRY`,
        kind: 'catch',
        condition: 'try block completes without exception',
        outcome: 'success path continues',
        line: nodeLine(source, node.parent),
      });
      branches.push({
        id: `${base}_CATCH`,
        kind: 'catch',
        condition: 'exception thrown in try block',
        outcome: 'catch handler',
        line: nodeLine(source, node),
      });
    } else if (
      ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) || ts.isDoStatement(node)
    ) {
      const condition = ts.isForStatement(node) ? node.condition : ts.isWhileStatement(node) || ts.isDoStatement(node) ? node.expression : node.expression;
      if (condition) addPair('loop', condition, node, 'loop executes', 'zero iterations / loop ends');
    }
    ts.forEachChild(node, visit);
  };
  visit(target);
  if (branches.length === 0) {
    branches.push({
      id: 'B001_PATH',
      kind: 'if',
      condition: 'default execution path',
      outcome: 'function/class behavior completes',
      line: nodeLine(source, target),
    });
  }
  return branches;
}

function parametersOf(node: ts.FunctionLikeDeclarationBase, source: ts.SourceFile): UnitParameter[] {
  return node.parameters.map(parameter => ({
    name: parameter.name.getText(source),
    type: parameter.type?.getText(source) || 'unknown',
    optional: Boolean(parameter.questionToken || parameter.initializer),
  }));
}

function methodNameOf(method: ts.MethodDeclaration): string | undefined {
  if (ts.isIdentifier(method.name) || ts.isStringLiteralLike(method.name)) return method.name.text;
  return undefined;
}

function isPublicMethod(method: ts.MethodDeclaration): boolean {
  const modifiers = ts.canHaveModifiers(method) ? ts.getModifiers(method) : undefined;
  return !modifiers?.some(modifier =>
    modifier.kind === ts.SyntaxKind.PrivateKeyword
    || modifier.kind === ts.SyntaxKind.ProtectedKeyword
    || modifier.kind === ts.SyntaxKind.AbstractKeyword,
  );
}

function mergeSupportingContexts(...contexts: UnitSupportingContext[]): UnitSupportingContext {
  const unique = <T>(items: T[], key: (item: T) => string) =>
    [...new Map(items.map(item => [key(item), item])).values()];
  return {
    callGraph: unique(contexts.flatMap(context => context.callGraph), item =>
      `${item.caller}#${item.callee}#${item.sourceFile}#${item.resolution}`),
    helperDefinitions: unique(contexts.flatMap(context => context.helperDefinitions), item =>
      `${item.sourceFile}#${item.symbol}#${item.kind}`),
    typeDefinitions: unique(contexts.flatMap(context => context.typeDefinitions), item =>
      `${item.sourceFile}#${item.symbol}#${item.kind}`),
    constantDefinitions: unique(contexts.flatMap(context => context.constantDefinitions), item =>
      `${item.sourceFile}#${item.symbol}#${item.kind}`),
    reachableImports: unique(contexts.flatMap(context => context.reachableImports), item =>
      `${item.sourceFile}#${item.module}`),
    unresolvedSymbols: [...new Set(contexts.flatMap(context => context.unresolvedSymbols))].sort(),
    truncated: contexts.some(context => context.truncated),
  };
}

function classifyExecution(
  relativeFile: string,
  exported: boolean,
  kind: UnitTarget['kind'],
  dependencies: UnitDependency[],
  rawCode: string,
): { mode: UnitExecutionMode; reasons: string[] } {
  const reasons: string[] = [];
  if (!exported) return { mode: 'UNSUPPORTED', reasons: ['Target không được export nên test bền vững không thể import source thật.'] };
  if (rawCode.length > MAX_TARGET_CODE_CHARS) {
    return {
      mode: 'UNSUPPORTED',
      reasons: [`Target dài hơn ${MAX_TARGET_CODE_CHARS} ký tự; hãy chọn hàm nhỏ hơn hoặc tách module để giữ context chính xác.`],
    };
  }
  if (/\.tsx$|\.jsx$/i.test(relativeFile)) reasons.push('File giao diện cần runtime/framework thật.');
  if (kind === 'class' && /(^|\n)\s*@\w+/.test(rawCode)) reasons.push('Class có decorator cần runtime/framework thật.');
  if (dependencies.some(dependency => dependency.strategy === 'native-environment')) reasons.push('Có dependency framework cần môi trường dự án thật.');
  if (reasons.length > 0) return { mode: 'NATIVE_REQUIRED', reasons };
  if (dependencies.some(dependency => dependency.strategy === 'mock')) return { mode: 'NATIVE_WITH_MOCKS', reasons: [] };
  return { mode: 'NATIVE_DIRECT', reasons: [] };
}

function targetId(relativeFile: string, symbol: string): string {
  return `${relativeFile}#${symbol}`;
}

function profiledTarget(
  target: Omit<UnitTarget, 'profile' | 'runtimeEnvironment' | 'profileReasons'>,
): UnitTarget {
  const classification = classifyUnitTarget({
    sourceFile: target.sourceFile,
    symbol: target.symbol,
    kind: target.kind,
    exported: target.exported,
    rawCode: target.rawCode,
    dependencies: target.dependencies,
    unsupportedReasons: target.unsupportedReasons,
    executionMode: target.executionMode,
  });
  return {
    ...target,
    profile: classification.profile,
    runtimeEnvironment: classification.runtimeEnvironment,
    profileReasons: classification.reasons,
  };
}

export function buildUnitCodeIndex(manifest: UnitProjectManifest): UnitCodeIndex {
  const targets: UnitTarget[] = [];
  const skippedFiles: UnitCodeIndex['skippedFiles'] = [];

  for (const relativeFile of manifest.sourceFiles) {
    const absoluteFile = path.join(manifest.projectRoot, relativeFile);
    let sourceText: string;
    try {
      sourceText = fs.readFileSync(absoluteFile, 'utf-8');
    } catch (error) {
      skippedFiles.push({ file: relativeFile, reason: error instanceof Error ? error.message : 'Không đọc được file.' });
      continue;
    }
    const scriptKind = /\.(?:tsx|jsx)$/.test(relativeFile) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(relativeFile, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
    const fileHash = hash(sourceText);
    const imports = importsForFile(source, manifest.projectRoot, relativeFile);
    const exportInfo = collectNamedExports(source);

    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && (statement.name || hasModifier(statement, ts.SyntaxKind.DefaultKeyword))) {
        const symbol = statement.name?.text || 'default';
        const originalRawCode = statement.getText(source);
        const rawCode = redactPotentialSecrets(originalRawCode);
        const exported = isExported(statement) || exportInfo.named.has(symbol);
        const defaultExport = hasModifier(statement, ts.SyntaxKind.DefaultKeyword) || exportInfo.defaultName === symbol;
        const supportingContext = buildSupportingContext(manifest.projectRoot, relativeFile, symbol);
        const dependencies = dependenciesForTarget(
          imports, supportingContext.reachableImports, dependencyEvidence(rawCode, supportingContext),
        );
        const classification = classifyExecution(relativeFile, exported, 'function', dependencies, rawCode);
        targets.push(profiledTarget({
          id: targetId(relativeFile, symbol), sourceFile: relativeFile, sourceHash: fileHash,
          symbol, kind: 'function', exported,
          defaultExport,
          async: hasModifier(statement, ts.SyntaxKind.AsyncKeyword),
          parameters: parametersOf(statement, source), returnType: statement.type?.getText(source) || 'inferred',
          startLine: nodeLine(source, statement), endLine: source.getLineAndCharacterOfPosition(statement.end).line + 1,
          rawCode, dependencies, supportingContext, branches: branchesForNode(statement, source),
          executionMode: classification.mode, unsupportedReasons: classification.reasons,
        }));
      }

      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
          if (!ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer)) continue;
          const originalRawCode = statement.getText(source);
          const rawCode = redactPotentialSecrets(originalRawCode);
          const exported = isExported(statement) || exportInfo.named.has(declaration.name.text);
          const defaultExport = exportInfo.defaultName === declaration.name.text;
          const supportingContext = buildSupportingContext(manifest.projectRoot, relativeFile, declaration.name.text);
          const dependencies = dependenciesForTarget(
            imports, supportingContext.reachableImports, dependencyEvidence(rawCode, supportingContext),
          );
          const classification = classifyExecution(relativeFile, exported, 'function', dependencies, rawCode);
          targets.push(profiledTarget({
            id: targetId(relativeFile, declaration.name.text), sourceFile: relativeFile, sourceHash: fileHash,
            symbol: declaration.name.text, kind: 'function', exported,
            defaultExport, async: hasModifier(declaration.initializer, ts.SyntaxKind.AsyncKeyword),
            parameters: parametersOf(declaration.initializer, source), returnType: declaration.type?.getText(source) || declaration.initializer.type?.getText(source) || 'inferred',
            startLine: nodeLine(source, statement), endLine: source.getLineAndCharacterOfPosition(statement.end).line + 1,
            rawCode, dependencies, supportingContext, branches: branchesForNode(declaration.initializer, source),
            executionMode: classification.mode, unsupportedReasons: classification.reasons,
          }));
        }
      }

      if (ts.isClassDeclaration(statement) && (statement.name || hasModifier(statement, ts.SyntaxKind.DefaultKeyword))) {
        const symbol = statement.name?.text || 'default';
        const exported = isExported(statement) || exportInfo.named.has(symbol);
        const defaultExport = hasModifier(statement, ts.SyntaxKind.DefaultKeyword) || exportInfo.defaultName === symbol;
        const constructor = statement.members.find(ts.isConstructorDeclaration);
        const constructorParameters = constructor ? parametersOf(constructor, source) : [];
        const constructorCode = constructor ? redactPotentialSecrets(constructor.getText(source)) : undefined;
        const constructorContext = constructor
          ? buildSupportingContext(manifest.projectRoot, relativeFile, symbol, 'constructor')
          : undefined;
        for (const member of statement.members) {
          if (!ts.isMethodDeclaration(member) || !isPublicMethod(member)) continue;
          const methodName = methodNameOf(member);
          if (!methodName) continue;
          const targetSymbol = `${symbol}.${methodName}`;
          const rawCode = redactPotentialSecrets(member.getText(source));
          const methodContext = buildSupportingContext(manifest.projectRoot, relativeFile, symbol, methodName);
          const supportingContext = constructorContext
            ? mergeSupportingContexts(methodContext, constructorContext)
            : methodContext;
          const dependencies = dependenciesForTarget(
            imports, supportingContext.reachableImports, dependencyEvidence(rawCode, supportingContext),
          );
          const classification = classifyExecution(relativeFile, exported, 'class-method', dependencies, rawCode);
          const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
          targets.push(profiledTarget({
            id: targetId(relativeFile, targetSymbol), sourceFile: relativeFile, sourceHash: fileHash,
            symbol: targetSymbol, kind: 'class-method', exported,
            defaultExport, async: hasModifier(member, ts.SyntaxKind.AsyncKeyword),
            parameters: parametersOf(member, source), returnType: member.type?.getText(source) || 'inferred',
            classMethod: {
              className: symbol,
              methodName,
              static: Boolean(modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)),
              constructorParameters,
              constructorCode,
            },
            startLine: nodeLine(source, member), endLine: source.getLineAndCharacterOfPosition(member.end).line + 1,
            rawCode, dependencies, supportingContext, branches: branchesForNode(member, source),
            executionMode: classification.mode, unsupportedReasons: classification.reasons,
          }));
        }
      }
    }
  }

  return { version: 1, projectRoot: manifest.projectRoot, targets, skippedFiles };
}
