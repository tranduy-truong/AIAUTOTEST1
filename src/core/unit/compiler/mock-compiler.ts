import * as ts from 'typescript';
import type {
  UnitDependency,
  UnitMockBehavior,
  UnitMockOutcome,
  UnitMockPlan,
  UnitPlanTarget,
  UnitTarget,
} from '../schema.js';
import { compileDataValue, objectPropertyName } from './value-compiler.js';

const f = ts.factory;

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9_$]+/g, '_').replace(/^\d/, '_$&') || 'default';
}

function call(receiver: ts.Expression, method: string, args: ts.Expression[] = []): ts.CallExpression {
  return f.createCallExpression(f.createPropertyAccessExpression(receiver, method), undefined, args);
}

function errorExpression(outcome: UnitMockOutcome): ts.Expression {
  if (outcome.value !== undefined) return compileDataValue(outcome.value);
  return f.createNewExpression(f.createIdentifier('Error'), undefined, [f.createStringLiteral(outcome.message || 'Mock error')]);
}

function outcomeValue(outcome: UnitMockOutcome): ts.Expression {
  const properties = Object.entries(outcome.properties || {}).map(([key, value]) =>
    f.createPropertyAssignment(objectPropertyName(key), compileDataValue(value)));
  const methods = Object.entries(outcome.methods || {}).map(([key, behavior]) => {
    let method = call(f.createPropertyAccessExpression(f.createIdentifier('vi'), 'fn'), 'call');
    // Replace the temporary expression with vi.fn(), then attach the configured behavior.
    const fn = f.createCallExpression(f.createPropertyAccessExpression(f.createIdentifier('vi'), 'fn'), undefined, []);
    if (behavior.kind === 'resolve') method = call(fn, 'mockResolvedValue', [outcomeValue(behavior)]);
    else if (behavior.kind === 'reject') method = call(fn, 'mockRejectedValue', [errorExpression(behavior)]);
    else if (behavior.kind === 'throw') {
      method = call(fn, 'mockImplementation', [
        f.createArrowFunction(undefined, undefined, [], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
          f.createBlock([f.createThrowStatement(errorExpression(behavior))], true)),
      ]);
    } else method = call(fn, 'mockReturnValue', [outcomeValue(behavior)]);
    return f.createPropertyAssignment(objectPropertyName(key), method);
  });
  if (properties.length > 0 || methods.length > 0) {
    return f.createObjectLiteralExpression([...properties, ...methods], true);
  }
  return outcome.value === undefined ? f.createIdentifier('undefined') : compileDataValue(outcome.value);
}

interface MockOperation {
  dependency: UnitDependency;
  operation: string;
  handle: string;
}

export interface UnitMockRegistry {
  statements: ts.Statement[];
  resetStatements: ts.Statement[];
  configure(mock: UnitMockPlan): { statements: ts.Statement[]; error?: string };
  assertionHandle(dependency: string, method?: string): { expression?: ts.Expression; error?: string };
}

function operationsFor(dependency: UnitDependency, planTarget: UnitPlanTarget): string[] {
  const planned = planTarget.testCases.flatMap(testCase => testCase.mocks)
    .filter(mock => mock.module === dependency.module && mock.symbol)
    .map(mock => mock.symbol as string);
  const detected = dependency.usedMembers || [];
  const fallback = dependency.mockKind === 'global'
    ? [dependency.globalName || dependency.module]
    : dependency.importedNames;
  const verified = [...new Set([...detected, ...planned])];
  return verified.length > 0 ? verified : [...new Set(fallback)];
}

function moduleFactory(dependency: UnitDependency, operations: MockOperation[]): ts.Expression {
  const operationProperties = operations.map(operation =>
    f.createPropertyAssignment(
      objectPropertyName(operation.operation),
      f.createPropertyAccessExpression(f.createIdentifier('unitMocks'), operation.handle),
    ));
  const defaultBinding = dependency.importBindings?.find(binding => binding.kind === 'default');
  const directlyCalledDefault = defaultBinding
    ? operations.find(operation => operation.operation === defaultBinding.localName)
    : undefined;
  // Node/CommonJS interop may read a synthetic default even for named imports.
  // Without a real default import, expose the complete module object instead
  // of incorrectly making the first named function the default export.
  const defaultValue = directlyCalledDefault
    ? f.createPropertyAccessExpression(f.createIdentifier('unitMocks'), directlyCalledDefault.handle)
    : f.createObjectLiteralExpression(operationProperties, true);
  return f.createArrowFunction(
    undefined, undefined, [], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    f.createParenthesizedExpression(f.createObjectLiteralExpression([
      f.createPropertyAssignment('default', defaultValue),
      ...operationProperties,
    ], true)),
  );
}

function behaviorStatements(handle: ts.Expression, behavior: UnitMockBehavior): ts.Statement[] {
  const statements: ts.Statement[] = [];
  const apply = (outcome: UnitMockOutcome, once: boolean) => {
    const suffix = once ? 'Once' : '';
    if (outcome.kind === 'resolve') {
      statements.push(f.createExpressionStatement(call(handle, `mockResolvedValue${suffix}`, [outcomeValue(outcome)])));
    } else if (outcome.kind === 'reject') {
      statements.push(f.createExpressionStatement(call(handle, `mockRejectedValue${suffix}`, [errorExpression(outcome)])));
    } else if (outcome.kind === 'throw') {
      const implementation = f.createArrowFunction(
        undefined, undefined, [], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        f.createBlock([f.createThrowStatement(errorExpression(outcome))], true),
      );
      statements.push(f.createExpressionStatement(call(handle, `mockImplementation${suffix}`, [implementation])));
    } else {
      statements.push(f.createExpressionStatement(call(handle, `mockReturnValue${suffix}`, [outcomeValue(outcome)])));
    }
  };
  for (const outcome of behavior.sequence || []) apply(outcome, true);
  apply(behavior, false);
  return statements;
}

export function buildUnitMockRegistry(
  target: UnitTarget,
  planTarget: UnitPlanTarget,
  dependencyPaths: Map<string, string>,
): UnitMockRegistry {
  const dependencies = target.dependencies.filter(dependency => dependency.strategy === 'mock');
  const operations: MockOperation[] = dependencies.flatMap((dependency, dependencyIndex) =>
    operationsFor(dependency, planTarget).map(operation => ({
      dependency,
      operation,
      handle: `dep_${dependencyIndex}_${slug(operation)}`,
    })));
  const statements: ts.Statement[] = [];
  if (operations.length > 0) {
    const hoistedFactory = f.createArrowFunction(
      undefined, undefined, [], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      f.createParenthesizedExpression(f.createObjectLiteralExpression(operations.map(operation =>
        f.createPropertyAssignment(
          operation.handle,
          f.createCallExpression(f.createPropertyAccessExpression(f.createIdentifier('vi'), 'fn'), undefined, []),
        )), true)),
    );
    statements.push(f.createVariableStatement(undefined, f.createVariableDeclarationList([
      f.createVariableDeclaration('unitMocks', undefined, undefined,
        f.createCallExpression(f.createPropertyAccessExpression(f.createIdentifier('vi'), 'hoisted'), undefined, [hoistedFactory])),
    ], ts.NodeFlags.Const)));
  }

  for (const dependency of dependencies) {
    const dependencyOperations = operations.filter(operation => operation.dependency === dependency);
    if (dependency.mockKind === 'global') {
      const operation = dependencyOperations[0];
      if (!operation) continue;
      const handle = f.createPropertyAccessExpression(f.createIdentifier('unitMocks'), operation.handle);
      if (dependency.globalName === 'fetch') {
        statements.push(f.createExpressionStatement(call(f.createIdentifier('vi'), 'stubGlobal', [f.createStringLiteral('fetch'), handle])));
      } else if (dependency.globalName === 'Date.now') {
        statements.push(f.createExpressionStatement(call(
          call(f.createIdentifier('vi'), 'spyOn', [f.createIdentifier('Date'), f.createStringLiteral('now')]),
          'mockImplementation', [handle],
        )));
      } else if (dependency.globalName === 'Math.random') {
        statements.push(f.createExpressionStatement(call(
          call(f.createIdentifier('vi'), 'spyOn', [f.createIdentifier('Math'), f.createStringLiteral('random')]),
          'mockImplementation', [handle],
        )));
      }
      continue;
    }
    statements.push(f.createExpressionStatement(f.createCallExpression(
      f.createPropertyAccessExpression(f.createIdentifier('vi'), 'mock'), undefined,
      [f.createStringLiteral(dependencyPaths.get(dependency.module) || dependency.module), moduleFactory(dependency, dependencyOperations)],
    )));
  }

  const findOperation = (dependency: string, method?: string) => {
    const candidates = operations.filter(operation => operation.dependency.module === dependency);
    if (method) return candidates.find(operation => operation.operation === method);
    return candidates.length === 1 ? candidates[0] : undefined;
  };

  return {
    statements,
    resetStatements: operations.map(operation => f.createExpressionStatement(call(
      f.createPropertyAccessExpression(f.createIdentifier('unitMocks'), operation.handle), 'mockReset', [],
    ))),
    configure(mock) {
      const operation = findOperation(mock.module, mock.symbol);
      if (!operation) {
        const available = operations.filter(item => item.dependency.module === mock.module).map(item => item.operation);
        return { statements: [], error: `Mock ${mock.module} cần symbol chính xác (${available.join(', ') || 'không có operation'}).` };
      }
      if (!mock.behavior || typeof mock.behavior !== 'object') {
        return { statements: [], error: `Mock ${mock.module}#${operation.operation} chưa có behavior có cấu trúc.` };
      }
      return {
        statements: behaviorStatements(
          f.createPropertyAccessExpression(f.createIdentifier('unitMocks'), operation.handle),
          mock.behavior,
        ),
      };
    },
    assertionHandle(dependency, method) {
      const operation = findOperation(dependency, method);
      return operation
        ? { expression: f.createPropertyAccessExpression(f.createIdentifier('unitMocks'), operation.handle) }
        : { error: `Không xác định được mock handle cho ${dependency}${method ? `#${method}` : ''}.` };
    },
  };
}
