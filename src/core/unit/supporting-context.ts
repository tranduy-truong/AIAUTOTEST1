import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as ts from 'typescript';
import type {
  UnitSupportingContext,
  UnitSupportingDefinition,
} from './schema.js';

const MAX_GRAPH_DEPTH = 4;
const MAX_DEFINITIONS = 16;
const MAX_CONTEXT_CHARS = 14_000;

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
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
    ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].map(extension => `${sourceBase}${extension}`),
    ...['.ts', '.tsx', '.js', '.jsx'].map(extension => path.join(sourceBase, `index${extension}`)),
  ];
  const found = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  return found ? toPosix(path.relative(root, found)) : undefined;
}

interface ImportBinding {
  localName: string;
  importedName: string;
  module: string;
  resolvedFile?: string;
  namespace: boolean;
}

interface ParsedFile {
  relativeFile: string;
  sourceText: string;
  sourceHash: string;
  source: ts.SourceFile;
  declarations: Map<string, ts.Statement>;
  imports: Map<string, ImportBinding>;
}

function declarationName(statement: ts.Statement): string | undefined {
  if (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
      || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
      || ts.isEnumDeclaration(statement))
    && statement.name
  ) return statement.name.text;
  return undefined;
}

function parseFile(root: string, relativeFile: string): ParsedFile | undefined {
  const absolute = path.join(root, relativeFile);
  if (!fs.existsSync(absolute)) return undefined;
  const sourceText = fs.readFileSync(absolute, 'utf-8');
  const scriptKind = /\.(?:tsx|jsx)$/i.test(relativeFile) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(relativeFile, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const declarations = new Map<string, ts.Statement>();
  const imports = new Map<string, ImportBinding>();

  for (const statement of source.statements) {
    const name = declarationName(statement);
    if (name) declarations.set(name, statement);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, statement);
      }
    }
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    const resolvedFile = resolveInternalModule(root, relativeFile, module);
    const clause = statement.importClause;
    if (clause?.name) {
      imports.set(clause.name.text, {
        localName: clause.name.text, importedName: 'default', module, resolvedFile, namespace: false,
      });
    }
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      const localName = clause.namedBindings.name.text;
      imports.set(localName, { localName, importedName: '*', module, resolvedFile, namespace: true });
    } else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        imports.set(element.name.text, {
          localName: element.name.text,
          importedName: element.propertyName?.text || element.name.text,
          module,
          resolvedFile,
          namespace: false,
        });
      }
    }
  }
  return { relativeFile, sourceText, sourceHash: hash(sourceText), source, declarations, imports };
}

function definitionKind(statement: ts.Statement): UnitSupportingDefinition['kind'] | undefined {
  if (ts.isFunctionDeclaration(statement)) return 'function';
  if (ts.isClassDeclaration(statement)) return 'class';
  if (ts.isInterfaceDeclaration(statement)) return 'interface';
  if (ts.isTypeAliasDeclaration(statement)) return 'type';
  if (ts.isEnumDeclaration(statement)) return 'enum';
  if (ts.isVariableStatement(statement)) {
    const declaration = statement.declarationList.declarations[0];
    if (declaration?.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
      return 'function';
    }
    return 'constant';
  }
  return undefined;
}

function symbolForStatement(statement: ts.Statement, fallback: string): string {
  return declarationName(statement)
    || (ts.isVariableStatement(statement)
      && statement.declarationList.declarations.find(declaration => ts.isIdentifier(declaration.name))?.name.getText())
    || fallback;
}

function definition(file: ParsedFile, statement: ts.Statement, symbol: string): UnitSupportingDefinition | undefined {
  const kind = definitionKind(statement);
  if (!kind) return undefined;
  return {
    sourceFile: file.relativeFile,
    sourceHash: file.sourceHash,
    symbol: symbolForStatement(statement, symbol),
    kind,
    code: redactPotentialSecrets(statement.getText(file.source)),
  };
}

interface References {
  calls: Array<{ localName: string; member?: string }>;
  types: string[];
  values: string[];
}

function referencesIn(node: ts.Node): References {
  const calls: References['calls'] = [];
  const types = new Set<string>();
  const values = new Set<string>();
  const visit = (child: ts.Node) => {
    if (ts.isCallExpression(child) || ts.isNewExpression(child)) {
      const expression = child.expression;
      if (ts.isIdentifier(expression)) calls.push({ localName: expression.text });
      else if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
        calls.push({ localName: expression.expression.text, member: expression.name.text });
      }
    }
    if (ts.isTypeReferenceNode(child)) {
      const typeName = child.typeName;
      if (ts.isIdentifier(typeName)) types.add(typeName.text);
      else if (ts.isQualifiedName(typeName)) types.add(typeName.left.getText());
    }
    if (ts.isIdentifier(child)) values.add(child.text);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return { calls, types: [...types], values: [...values] };
}

function exportedDeclaration(file: ParsedFile, symbol: string): ts.Statement | undefined {
  if (symbol !== 'default') return file.declarations.get(symbol);
  for (const statement of file.source.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return statement;
  }
  return undefined;
}

export function buildSupportingContext(
  projectRoot: string,
  sourceFile: string,
  targetSymbol: string,
  targetMember?: string,
): UnitSupportingContext {
  const cache = new Map<string, ParsedFile | undefined>();
  const load = (relativeFile: string) => {
    if (!cache.has(relativeFile)) cache.set(relativeFile, parseFile(projectRoot, relativeFile));
    return cache.get(relativeFile);
  };
  const rootFile = load(sourceFile);
  const empty: UnitSupportingContext = {
    callGraph: [], helperDefinitions: [], typeDefinitions: [], constantDefinitions: [],
    reachableImports: [], unresolvedSymbols: [], truncated: false,
  };
  if (!rootFile) return { ...empty, unresolvedSymbols: [targetSymbol] };
  const targetDeclaration = exportedDeclaration(rootFile, targetSymbol) || rootFile.declarations.get(targetSymbol);
  let target: ts.Node | undefined = targetDeclaration;
  if (targetMember && targetDeclaration && ts.isClassDeclaration(targetDeclaration)) {
    target = targetDeclaration.members.find(member => {
      if (targetMember === 'constructor') return ts.isConstructorDeclaration(member);
      if (!ts.isMethodDeclaration(member) || !member.name) return false;
      return (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name))
        && member.name.text === targetMember;
    });
  }
  const targetLabel = targetMember ? `${targetSymbol}.${targetMember}` : targetSymbol;
  if (!target) return { ...empty, unresolvedSymbols: [targetLabel] };

  const helperDefinitions: UnitSupportingDefinition[] = [];
  const typeDefinitions: UnitSupportingDefinition[] = [];
  const constantDefinitions: UnitSupportingDefinition[] = [];
  const callGraph: UnitSupportingContext['callGraph'] = [];
  const reachableImports = new Map<string, UnitSupportingContext['reachableImports'][number]>();
  const unresolvedSymbols = new Set<string>();
  const visited = new Set<string>([`${sourceFile}#${targetLabel}`]);
  let usedChars = 0;
  let truncated = false;

  const append = (collection: UnitSupportingDefinition[], item: UnitSupportingDefinition | undefined) => {
    if (!item) return false;
    const key = `${item.sourceFile}#${item.symbol}#${item.kind}`;
    if ([...helperDefinitions, ...typeDefinitions, ...constantDefinitions]
      .some(existing => `${existing.sourceFile}#${existing.symbol}#${existing.kind}` === key)) return true;
    if (helperDefinitions.length + typeDefinitions.length + constantDefinitions.length >= MAX_DEFINITIONS
      || usedChars + item.code.length > MAX_CONTEXT_CHARS) {
      truncated = true;
      return false;
    }
    collection.push(item);
    usedChars += item.code.length;
    return true;
  };

  const resolveImported = (file: ParsedFile, localName: string, member?: string) => {
    const binding = file.imports.get(localName);
    if (!binding) return undefined;
    const importKey = `${file.relativeFile}#${binding.module}`;
    const existing = reachableImports.get(importKey);
    reachableImports.set(importKey, {
      sourceFile: file.relativeFile,
      module: binding.module,
      importedNames: [...new Set([...(existing?.importedNames || []), binding.importedName])],
      resolvedFile: binding.resolvedFile,
    });
    if (!binding.resolvedFile) return undefined;
    const dependencyFile = load(binding.resolvedFile);
    if (!dependencyFile) return undefined;
    const symbol = binding.namespace ? member : binding.importedName;
    if (!symbol) return undefined;
    return { file: dependencyFile, symbol, statement: exportedDeclaration(dependencyFile, symbol) || dependencyFile.declarations.get(symbol) };
  };

  const walk = (file: ParsedFile, symbol: string, statement: ts.Node, depth: number) => {
    const refs = referencesIn(statement);
    for (const call of refs.calls) {
      let calleeFile = file;
      let calleeSymbol = call.localName;
      let callee = file.declarations.get(call.localName);
      let resolution: 'same-file' | 'internal-import' = 'same-file';
      const imported = resolveImported(file, call.localName, call.member);
      if (imported) {
        calleeFile = imported.file;
        calleeSymbol = imported.symbol;
        callee = imported.statement;
        resolution = 'internal-import';
      }
      if (!callee) continue;
      const calleeKind = definitionKind(callee);
      if (calleeKind !== 'function' && calleeKind !== 'class') continue;
      callGraph.push({ caller: symbol, callee: calleeSymbol, sourceFile: calleeFile.relativeFile, resolution });
      const key = `${calleeFile.relativeFile}#${calleeSymbol}`;
      if (visited.has(key)) continue;
      visited.add(key);
      if (!append(helperDefinitions, definition(calleeFile, callee, calleeSymbol))) continue;
      if (depth < MAX_GRAPH_DEPTH) walk(calleeFile, calleeSymbol, callee, depth + 1);
      else truncated = true;
    }

    for (const typeName of refs.types) {
      let typeFile = file;
      let typeSymbol = typeName;
      let typeStatement = file.declarations.get(typeName);
      const imported = resolveImported(file, typeName);
      if (imported) {
        typeFile = imported.file;
        typeSymbol = imported.symbol;
        typeStatement = imported.statement;
      }
      if (!typeStatement) {
        if (!['string', 'number', 'boolean', 'unknown', 'any', 'void', 'Promise', 'Map', 'Set', 'Array', 'Record'].includes(typeName)) {
          unresolvedSymbols.add(typeName);
        }
        continue;
      }
      const kind = definitionKind(typeStatement);
      if (!['interface', 'type', 'enum', 'class'].includes(String(kind))) continue;
      if (append(typeDefinitions, definition(typeFile, typeStatement, typeSymbol)) && depth < MAX_GRAPH_DEPTH) {
        const nestedRefs = referencesIn(typeStatement);
        for (const nestedType of nestedRefs.types) {
          const nested = typeFile.declarations.get(nestedType);
          if (nested) append(typeDefinitions, definition(typeFile, nested, nestedType));
        }
      }
    }

    for (const valueName of refs.values) {
      const importedValue = file.imports.get(valueName);
      if (importedValue) resolveImported(file, valueName);
      const valueStatement = file.declarations.get(valueName);
      if (!valueStatement || valueName === symbol) continue;
      const kind = definitionKind(valueStatement);
      if (kind === 'constant') {
        append(constantDefinitions, definition(file, valueStatement, valueName));
        continue;
      }
      // Functions can be passed as callbacks instead of called directly
      // (for example array.map(compactAction)). They are still reachable and
      // must be included in the behavior trace.
      if (kind === 'function' || kind === 'class') {
        callGraph.push({ caller: symbol, callee: valueName, sourceFile: file.relativeFile, resolution: 'same-file' });
        const key = `${file.relativeFile}#${valueName}`;
        if (visited.has(key)) continue;
        visited.add(key);
        if (!append(helperDefinitions, definition(file, valueStatement, valueName))) continue;
        if (depth < MAX_GRAPH_DEPTH) walk(file, valueName, valueStatement, depth + 1);
        else truncated = true;
      }
    }
  };

  walk(rootFile, targetLabel, target, 0);
  return {
    callGraph,
    helperDefinitions,
    typeDefinitions,
    constantDefinitions,
    reachableImports: [...reachableImports.values()].sort((left, right) =>
      `${left.sourceFile}#${left.module}`.localeCompare(`${right.sourceFile}#${right.module}`)),
    unresolvedSymbols: [...unresolvedSymbols].sort(),
    truncated,
  };
}
