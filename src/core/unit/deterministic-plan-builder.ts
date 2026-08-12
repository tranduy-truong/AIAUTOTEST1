import * as ts from 'typescript';
import type {
  StructuredUnitPlan,
  UnitContextBundle,
  UnitDataValue,
  UnitDependency,
  UnitMockBehavior,
  UnitMockPlan,
  UnitParameter,
  UnitPlannedTestCase,
  UnitTarget,
} from './schema.js';
import { evaluateTargetStatically, runtimeToDataValue } from './oracle/ast-evaluator.js';

function slug(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'TARGET';
}

function typeDefinitions(target: UnitTarget): Map<string, string> {
  return new Map(target.supportingContext.typeDefinitions.map(definition => [definition.symbol, definition.code]));
}

function objectFixtureFromDefinition(
  name: string,
  definitions: Map<string, string>,
  depth: number,
): UnitDataValue | undefined {
  const code = definitions.get(name);
  if (!code || depth > 4) return undefined;
  const source = ts.createSourceFile('unit-fixture.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.find(statement =>
    (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name.text === name);
  if (!declaration) return undefined;
  let members: ts.NodeArray<ts.TypeElement> | undefined;
  if (ts.isInterfaceDeclaration(declaration)) members = declaration.members;
  if (ts.isTypeAliasDeclaration(declaration) && ts.isTypeLiteralNode(declaration.type)) members = declaration.type.members;
  if (!members) return undefined;
  const output: Record<string, UnitDataValue> = {};
  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.type || member.questionToken) continue;
    const property = member.name && (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name))
      ? member.name.text : undefined;
    if (!property) continue;
    output[property] = fixtureForType(member.type.getText(source), definitions, depth + 1);
  }
  return output;
}

function fixtureForType(type: string, definitions: Map<string, string>, depth = 0): UnitDataValue {
  const normalized = type.replace(/\s+/g, ' ').trim();
  const candidates = normalized.split('|').map(item => item.trim())
    .filter(item => !['undefined', 'null', 'never'].includes(item));
  const selected = candidates[0] || normalized;
  const promise = selected.match(/^Promise\s*<([\s\S]+)>$/);
  if (promise) return fixtureForType(promise[1], definitions, depth + 1);
  if (/^(?:string|String)$/.test(selected)) return 'fixture';
  if (/^(?:number|Number)$/.test(selected)) return 1;
  if (/^(?:boolean|Boolean)$/.test(selected)) return true;
  if (/^(?:bigint|BigInt)$/.test(selected)) return { $type: 'bigint', value: '1' };
  if (/^(?:void|undefined)$/.test(selected)) return { $type: 'undefined' };
  if (/^(?:unknown|any|object)$/.test(selected)) return {};
  if (/\[\]$/.test(selected) || /^(?:Readonly)?Array\s*</.test(selected)) return [];
  if (/^(?:Readonly)?Map\s*</.test(selected)) return { $type: 'map', entries: [] };
  if (/^(?:Readonly)?Set\s*</.test(selected)) return { $type: 'set', values: [] };
  if (/^['"`]/.test(selected)) return selected.slice(1, -1);
  if (/^-?\d+(?:\.\d+)?$/.test(selected)) return Number(selected);
  const object = objectFixtureFromDefinition(selected.replace(/<.*>$/, ''), definitions, depth);
  return object ?? {};
}

function inferredPropertyValue(property: string, usage: string): UnitDataValue {
  if (
    /\bpath\.(?:join|resolve|dirname|basename|extname|normalize)\s*\([^)]*$/s.test(usage)
    || /\bfs\.(?:readFileSync|writeFileSync|existsSync|mkdirSync|statSync)\s*\([^)]*$/s.test(usage)
    || /(?:path|dir|file|folder|url|uri|name|prompt|work|root|cwd)$/i.test(property)
  ) return 'fixture';
  if (/(?:timeout|duration|delay|count|limit|max|min|size|port|turns?|ms)$/i.test(property)) return 1;
  if (/^(?:is|has|can|should|enable|disable)|(?:enabled|disabled|active|valid)$/i.test(property)) return true;
  if (/(?:items|tools|files|paths|values|entries|args)$/i.test(property)) return [];
  return 'fixture';
}

/**
 * Pasted snippets often keep a type-only import whose sibling file was not
 * pasted. In that case the type graph cannot describe the parameter object.
 * Derive only properties that the target actually reads, and choose a safe
 * primitive from the API usage/name. This avoids silently compiling `run({})`
 * when runtime code immediately calls path.join(opts.promptDir, ...).
 */
function enrichFixtureFromParameterUsage(
  parameter: UnitParameter,
  fixture: UnitDataValue,
  rawCode: string,
): UnitDataValue {
  if (!/^[A-Za-z_$][\w$]*$/.test(parameter.name)) return fixture;
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture) || '$type' in fixture) return fixture;
  const output = { ...(fixture as Record<string, UnitDataValue>) };
  const escaped = parameter.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const memberPattern = new RegExp(`\\b${escaped}\\s*(?:\\?\\.|\\.)\\s*([A-Za-z_$][\\w$]*)`, 'g');
  for (const match of rawCode.matchAll(memberPattern)) {
    const property = match[1];
    if (property in output) continue;
    const usagePrefix = rawCode.slice(Math.max(0, match.index! - 100), match.index! + match[0].length);
    output[property] = inferredPropertyValue(property, usagePrefix);
  }
  return output;
}

function parameterFixtures(parameters: UnitParameter[], target: UnitTarget): Record<string, UnitDataValue> {
  const definitions = typeDefinitions(target);
  return Object.fromEntries(parameters.filter(parameter => !parameter.optional)
    .map(parameter => {
      const fixture = fixtureForType(parameter.type, definitions);
      return [parameter.name, enrichFixtureFromParameterUsage(parameter, fixture, target.rawCode)];
    }));
}

function operationIsAwaited(target: UnitTarget, operation: string): boolean {
  const escaped = operation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\bawait\\s+(?:[A-Za-z_$][\\w$]*\\.)?${escaped}\\s*\\(`).test(target.rawCode);
}

function defaultMockBehavior(target: UnitTarget, dependency: UnitDependency, operation: string): UnitMockBehavior {
  if (dependency.globalName === 'Date.now' || operation === 'Date.now') {
    return {
      kind: 'return', value: 150,
      sequence: [{ kind: 'return', value: 100 }, { kind: 'return', value: 150 }],
    };
  }
  if (dependency.globalName === 'Math.random' || operation === 'Math.random') {
    return { kind: 'return', value: 0.5 };
  }
  if (dependency.globalName === 'fetch' || operation === 'fetch') {
    return {
      kind: 'resolve',
      methods: { json: { kind: 'resolve', value: { response: 'fixture' } } },
    };
  }
  if (/^(?:exists|has|is|can|should|includes|startsWith|endsWith)/i.test(operation)) {
    return { kind: 'return', value: true };
  }
  if (/^(?:read|load|get|find)/i.test(operation)) {
    return { kind: operationIsAwaited(target, operation) ? 'resolve' : 'return', value: 'fixture' };
  }
  return { kind: operationIsAwaited(target, operation) ? 'resolve' : 'return', value: { $type: 'undefined' } };
}

function defaultMocks(target: UnitTarget): UnitMockPlan[] {
  return target.dependencies.filter(dependency => dependency.strategy === 'mock').flatMap(dependency => {
    const operations = dependency.usedMembers?.length
      ? dependency.usedMembers
      : dependency.mockKind === 'global'
        ? [dependency.globalName || dependency.module]
        : dependency.importedNames;
    return operations.map(operation => ({
      module: dependency.module,
      symbol: operation,
      behavior: defaultMockBehavior(target, dependency, operation),
    }));
  });
}

function withBooleanOperation(
  mocks: UnitMockPlan[],
  condition: string,
  value: boolean,
): { mocks: UnitMockPlan[]; changed: boolean } {
  const matching = mocks.find(mock => mock.symbol && new RegExp(`\\b${mock.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(condition));
  if (!matching) return { mocks, changed: false };
  return {
    mocks: mocks.map(mock => mock === matching
      ? { ...mock, behavior: { kind: 'return', value } }
      : mock),
    changed: true,
  };
}

function withFailure(mocks: UnitMockPlan[], target: UnitTarget): UnitMockPlan[] {
  const preferred = mocks.find(mock => {
    const operation = mock.symbol || '';
    return operation === 'fetch' || operationIsAwaited(target, operation);
  }) || mocks.find(mock => !/^(?:Date\.now|Math\.random)$/.test(mock.symbol || ''));
  if (!preferred) return mocks;
  const rejected = preferred.symbol === 'fetch' || operationIsAwaited(target, preferred.symbol || '');
  return mocks.map(mock => mock === preferred
    ? { ...mock, behavior: { kind: rejected ? 'reject' : 'throw', message: 'fixture failure' } }
    : mock);
}

interface Candidate {
  label: string;
  branchIds: string[];
  inputs: Record<string, UnitDataValue>;
  mocks: UnitMockPlan[];
}

function expressionPath(node: ts.Expression): string[] | undefined {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isPropertyAccessExpression(node)) {
    const parent = expressionPath(node.expression);
    return parent ? [...parent, node.name.text] : undefined;
  }
  return undefined;
}

function literalValue(node: ts.Expression): UnitDataValue | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    if (node.operator === ts.SyntaxKind.MinusToken) return -Number(node.operand.text);
    if (node.operator === ts.SyntaxKind.PlusToken) return Number(node.operand.text);
  }
  return undefined;
}

function alternativeValue(value: UnitDataValue): UnitDataValue {
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'string') return `${value}_other`;
  if (value === null) return 'not-null';
  return { $type: 'undefined' };
}

function setInputPath(
  inputs: Record<string, UnitDataValue>,
  path: string[],
  value: UnitDataValue,
): boolean {
  if (path.length === 0 || !(path[0] in inputs)) return false;
  if (path.length === 1) {
    inputs[path[0]] = value;
    return true;
  }
  let current = inputs[path[0]];
  if (!current || typeof current !== 'object' || Array.isArray(current) || '$type' in current) {
    current = {};
    inputs[path[0]] = current;
  }
  let object = current as Record<string, UnitDataValue>;
  for (let index = 1; index < path.length - 1; index++) {
    const child = object[path[index]];
    if (!child || typeof child !== 'object' || Array.isArray(child) || '$type' in child) {
      object[path[index]] = {};
    }
    object = object[path[index]] as Record<string, UnitDataValue>;
  }
  object[path[path.length - 1]] = value;
  return true;
}

function solveConditionInputs(
  condition: string,
  desired: boolean,
  baseInputs: Record<string, UnitDataValue>,
): { inputs: Record<string, UnitDataValue>; changed: boolean } {
  const inputs = JSON.parse(JSON.stringify(baseInputs)) as Record<string, UnitDataValue>;
  const source = ts.createSourceFile('unit-condition.ts', `const __value = (${condition});`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.flatMap(statement =>
    ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])[0];
  const expression = declaration?.initializer;
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics || [];
  if (!expression || parseDiagnostics.length > 0) return { inputs, changed: false };

  const solve = (node: ts.Expression, wanted: boolean): boolean => {
    if (ts.isParenthesizedExpression(node)) return solve(node.expression, wanted);
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      return solve(node.operand, !wanted);
    }
    const directPath = expressionPath(node);
    if (directPath) return setInputPath(inputs, directPath, wanted);
    if (!ts.isBinaryExpression(node)) return false;
    let path = expressionPath(node.left);
    let literal = literalValue(node.right);
    let operator: ts.SyntaxKind = node.operatorToken.kind;
    if (!path || literal === undefined) {
      path = expressionPath(node.right);
      literal = literalValue(node.left);
      const reversed = new Map<ts.SyntaxKind, ts.SyntaxKind>([
        [ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken],
        [ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken],
        [ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanToken],
        [ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.LessThanEqualsToken],
      ]);
      operator = reversed.get(operator) || operator;
    }
    if (!path || literal === undefined) return false;
    let value: UnitDataValue;
    switch (operator) {
      case ts.SyntaxKind.EqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
        value = wanted ? literal : alternativeValue(literal); break;
      case ts.SyntaxKind.ExclamationEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        value = wanted ? alternativeValue(literal) : literal; break;
      case ts.SyntaxKind.LessThanToken:
        if (typeof literal !== 'number') return false;
        value = wanted ? literal - 1 : literal; break;
      case ts.SyntaxKind.LessThanEqualsToken:
        if (typeof literal !== 'number') return false;
        value = wanted ? literal : literal + 1; break;
      case ts.SyntaxKind.GreaterThanToken:
        if (typeof literal !== 'number') return false;
        value = wanted ? literal + 1 : literal; break;
      case ts.SyntaxKind.GreaterThanEqualsToken:
        if (typeof literal !== 'number') return false;
        value = wanted ? literal : literal - 1; break;
      default: return false;
    }
    return setInputPath(inputs, path, value);
  };
  return { inputs, changed: solve(expression, desired) };
}

function candidatesFor(target: UnitTarget): Candidate[] {
  const baseline = defaultMocks(target);
  const baseInputs = parameterFixtures(target.parameters, target);
  const candidates: Candidate[] = [];
  for (const branch of target.branches) {
    if (/_CATCH$/.test(branch.id)) {
      candidates.push({ label: `branch ${branch.id}`, branchIds: [branch.id], inputs: baseInputs, mocks: withFailure(baseline, target) });
      continue;
    }
    if (/_TRY$/.test(branch.id) || !/_(?:TRUE|FALSE)$/.test(branch.id)) {
      candidates.push({ label: `branch ${branch.id}`, branchIds: [branch.id], inputs: baseInputs, mocks: baseline });
      continue;
    }
    const desired = /_TRUE$/.test(branch.id);
    const mockVariant = withBooleanOperation(baseline, branch.condition, desired);
    const inputVariant = solveConditionInputs(branch.condition, desired, baseInputs);
    candidates.push({
      label: `branch ${branch.id}`,
      branchIds: [branch.id],
      inputs: inputVariant.inputs,
      mocks: mockVariant.mocks,
    });
  }
  if (candidates.length === 0) candidates.push({ label: 'default path', branchIds: [], inputs: baseInputs, mocks: baseline });
  return candidates.filter((candidate, index, all) => all.findIndex(item =>
    JSON.stringify(item.mocks) === JSON.stringify(candidate.mocks)
    && JSON.stringify(item.inputs) === JSON.stringify(candidate.inputs)
    && JSON.stringify(item.branchIds) === JSON.stringify(candidate.branchIds)) === index);
}

function fallbackExpected(target: UnitTarget): UnitDataValue {
  const returnType = target.returnType.replace(/^Promise\s*<([\s\S]+)>$/, '$1');
  return fixtureForType(returnType, typeDefinitions(target));
}

function plannedCase(target: UnitTarget, candidate: Candidate, index: number): UnitPlannedTestCase {
  const inputs = candidate.inputs;
  const evaluated = evaluateTargetStatically(target, inputs, candidate.mocks);
  const value = evaluated.supported && evaluated.kind === 'return'
    ? runtimeToDataValue(evaluated.value)
    : undefined;
  const expectedKind = target.async ? 'resolve' : 'return';
  return {
    id: `UT_${slug(target.symbol)}_${String(index + 1).padStart(3, '0')}`,
    name: `${target.symbol} - ${candidate.label}`,
    branchIds: candidate.branchIds,
    inputs,
    constructorInputs: target.kind === 'class-method'
      ? parameterFixtures(target.classMethod?.constructorParameters || [], target)
      : undefined,
    expected: { kind: expectedKind, value: value ?? fallbackExpected(target) },
    oracleSource: 'implementation',
    oracleEvidence: { status: 'proposed', source: 'ai-inference' },
    mocks: candidate.mocks,
    notes: [evaluated.supported
      ? 'Deterministic Planner derived this intent from AST and structured mock trace.'
      : `Oracle remains provisional: ${evaluated.reason}`],
  };
}

export function buildDeterministicUnitTarget(target: UnitTarget) {
  return {
    sourceFile: target.sourceFile,
    symbol: target.symbol,
    sourceHash: target.sourceHash,
    executionMode: target.executionMode,
    profile: target.profile,
    testCases: candidatesFor(target).map((candidate, index) => plannedCase(target, candidate, index)),
  };
}

export function buildDeterministicUnitPlan(context: UnitContextBundle): StructuredUnitPlan {
  return {
    version: 1,
    source: 'deterministic-planner',
    project: {
      name: context.project.projectName,
      root: context.project.projectRoot,
      testFramework: context.project.testFramework,
    },
    targets: context.targets.map(buildDeterministicUnitTarget),
    clarifications: [],
  };
}
