import * as ts from 'typescript';
import type {
  UnitExpectedResult,
  UnitPlanTarget,
  UnitPlannedTestCase,
  UnitTarget,
  UnitTestCaseGenerationResult,
} from '../schema.js';
import { buildUnitMockRegistry } from './mock-compiler.js';
import { compileDataValue } from './value-compiler.js';

const f = ts.factory;

export interface CompileUnitTestFileOptions {
  target: UnitTarget;
  planTarget: UnitPlanTarget;
  importPath: string;
  framework: 'vitest' | 'jest';
  dependencyPaths: Map<string, string>;
}

export interface CompileUnitTestFileResult {
  code?: string;
  testCases: UnitTestCaseGenerationResult[];
}

function orderedArguments(
  parameters: UnitTarget['parameters'],
  inputs: Record<string, import('../schema.js').UnitDataValue>,
): { expressions?: ts.Expression[]; error?: string } {
  const lastProvided = parameters.reduce((last, parameter, index) =>
    Object.prototype.hasOwnProperty.call(inputs, parameter.name) ? index : last, -1);
  const expressions: ts.Expression[] = [];
  for (let index = 0; index <= lastProvided; index++) {
    const parameter = parameters[index];
    if (!parameter) continue;
    if (!Object.prototype.hasOwnProperty.call(inputs, parameter.name)) {
      if (!parameter.optional) return { error: `Thiếu input bắt buộc ${parameter.name}.` };
      expressions.push(f.createIdentifier('undefined'));
    } else expressions.push(compileDataValue(inputs[parameter.name]));
  }
  for (const parameter of parameters.filter(parameter => !parameter.optional)) {
    if (!Object.prototype.hasOwnProperty.call(inputs, parameter.name)) {
      return { error: `Thiếu input bắt buộc ${parameter.name}.` };
    }
  }
  return { expressions };
}

function invocation(
  target: UnitTarget,
  testCase: UnitPlannedTestCase,
  targetBinding: string,
): { expression?: ts.Expression; error?: string } {
  const args = orderedArguments(target.parameters, testCase.inputs || {});
  if (!args.expressions) return { error: args.error };
  if (target.kind === 'function') {
    return { expression: f.createCallExpression(f.createIdentifier(targetBinding), undefined, args.expressions) };
  }
  if (target.kind !== 'class-method' || !target.classMethod) return { error: 'Target class nguyên khối chưa có invocation compiler.' };
  const owner = f.createIdentifier(targetBinding);
  if (target.classMethod.static) {
    return { expression: f.createCallExpression(f.createPropertyAccessExpression(owner, target.classMethod.methodName), undefined, args.expressions) };
  }
  const constructorArgs = orderedArguments(target.classMethod.constructorParameters, testCase.constructorInputs || {});
  if (!constructorArgs.expressions) return { error: constructorArgs.error };
  const subject = f.createNewExpression(owner, undefined, constructorArgs.expressions);
  return {
    expression: f.createCallExpression(f.createPropertyAccessExpression(subject, target.classMethod.methodName), undefined, args.expressions),
  };
}

function expectCall(value: ts.Expression, matcher: string, args: ts.Expression[]): ts.ExpressionStatement {
  const expectation = f.createCallExpression(f.createIdentifier('expect'), undefined, [value]);
  return f.createExpressionStatement(f.createCallExpression(f.createPropertyAccessExpression(expectation, matcher), undefined, args));
}

function compilePrimaryAssertion(
  invocationExpression: ts.Expression,
  expected: UnitExpectedResult,
): { statements?: ts.Statement[]; needsOracle?: string } {
  if ((expected.kind === 'return' || expected.kind === 'resolve') && expected.value === undefined) {
    return { needsOracle: `${expected.kind} cần expected.value có bằng chứng.` };
  }
  if ((expected.kind === 'throw' || expected.kind === 'reject')
    && expected.message === undefined && expected.value === undefined && expected.error === undefined) {
    return { needsOracle: `${expected.kind} cần error matcher hoặc value có bằng chứng.` };
  }
  if (expected.kind === 'side-effect') return { statements: [] };
  if (expected.kind === 'return') {
    return { statements: [expectCall(invocationExpression, 'toEqual', [compileDataValue(expected.value!)])] };
  }
  if (expected.kind === 'throw' || expected.kind === 'reject') {
    const caughtError = f.createIdentifier('caughtError');
    const caughtBinding = f.createVariableStatement(undefined, f.createVariableDeclarationList([
      f.createVariableDeclaration(caughtError, undefined, f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)),
    ], ts.NodeFlags.Let));
    const execute = f.createExpressionStatement(
      expected.kind === 'reject' ? f.createAwaitExpression(invocationExpression) : invocationExpression,
    );
    const errorParameter = f.createVariableDeclaration(f.createIdentifier('error'));
    const catchClause = f.createCatchClause(errorParameter, f.createBlock([
      f.createExpressionStatement(f.createBinaryExpression(
        caughtError, f.createToken(ts.SyntaxKind.EqualsToken), f.createIdentifier('error'),
      )),
    ], true));
    const statements: ts.Statement[] = [
      caughtBinding,
      f.createTryStatement(f.createBlock([execute], true), catchClause, undefined),
      expectCall(caughtError, 'toBeDefined', []),
    ];
    if (expected.error?.className) {
      statements.push(expectCall(caughtError, 'toBeInstanceOf', [f.createIdentifier(expected.error.className)]));
    }
    const messageMatcher = expected.error?.message;
    if (messageMatcher?.match === 'equals') {
      statements.push(expectCall(caughtError, 'toMatchObject', [f.createObjectLiteralExpression([
        f.createPropertyAssignment('message', f.createStringLiteral(messageMatcher.value)),
      ])]));
    } else if (messageMatcher?.match === 'contains') {
      const stringContaining = f.createCallExpression(
        f.createPropertyAccessExpression(f.createIdentifier('expect'), 'stringContaining'), undefined,
        [f.createStringLiteral(messageMatcher.value)],
      );
      const objectContaining = f.createCallExpression(
        f.createPropertyAccessExpression(f.createIdentifier('expect'), 'objectContaining'), undefined,
        [f.createObjectLiteralExpression([f.createPropertyAssignment('message', stringContaining)])],
      );
      statements.push(expectCall(caughtError, 'toEqual', [objectContaining]));
    } else if (messageMatcher?.match === 'regexp') {
      const errorMessage = f.createPropertyAccessExpression(
        f.createAsExpression(caughtError, f.createTypeReferenceNode('Error')), 'message',
      );
      statements.push(expectCall(errorMessage, 'toMatch', [
        f.createNewExpression(f.createIdentifier('RegExp'), undefined, [
          f.createStringLiteral(messageMatcher.value), f.createStringLiteral(messageMatcher.flags || ''),
        ]),
      ]));
    } else if (expected.message !== undefined) {
      statements.push(expectCall(caughtError, 'toMatchObject', [f.createObjectLiteralExpression([
        f.createPropertyAssignment('message', f.createStringLiteral(expected.message)),
      ])]));
    } else if (expected.value !== undefined) {
      statements.push(expectCall(caughtError, 'toEqual', [compileDataValue(expected.value)]));
    }
    return { statements };
  }
  const promiseExpectation = f.createPropertyAccessExpression(
    f.createCallExpression(f.createIdentifier('expect'), undefined, [invocationExpression]),
    'resolves',
  );
  const matcher = 'toEqual';
  const argument = compileDataValue(expected.value!);
  return { statements: [f.createExpressionStatement(f.createAwaitExpression(
    f.createCallExpression(f.createPropertyAccessExpression(promiseExpectation, matcher), undefined, [argument]),
  ))] };
}

export function compileUnitTestFile(options: CompileUnitTestFileOptions): CompileUnitTestFileResult {
  if (options.framework !== 'vitest') {
    return {
      testCases: options.planTarget.testCases.map(testCase => ({
        testCaseId: testCase.id, status: 'INVALID_FIXTURE',
        errors: ['Deterministic compiler hiện chỉ hỗ trợ Vitest; Jest cần compiler riêng.'],
      })),
    };
  }
  const registry = buildUnitMockRegistry(options.target, options.planTarget, options.dependencyPaths);
  const importedSymbol = options.target.classMethod?.className || options.target.symbol;
  const targetBinding = importedSymbol === 'default' ? 'UnitTarget' : importedSymbol;
  const compiledTests: ts.Statement[] = [];
  const results: UnitTestCaseGenerationResult[] = [];

  for (const testCase of options.planTarget.testCases) {
    const setup: ts.Statement[] = [...registry.resetStatements];
    const mockErrors: string[] = [];
    for (const mock of testCase.mocks || []) {
      const configured = registry.configure(mock);
      setup.push(...configured.statements);
      if (configured.error) mockErrors.push(configured.error);
    }
    if (mockErrors.length > 0) {
      results.push({ testCaseId: testCase.id, status: 'INVALID_MOCK', errors: mockErrors });
      continue;
    }
    const invoked = invocation(options.target, testCase, targetBinding);
    if (!invoked.expression) {
      results.push({ testCaseId: testCase.id, status: 'INVALID_FIXTURE', errors: [invoked.error || 'Không dựng được invocation.'] });
      continue;
    }
    const primary = compilePrimaryAssertion(invoked.expression, testCase.expected);
    if (!primary.statements) {
      results.push({ testCaseId: testCase.id, status: 'NEEDS_ORACLE', errors: [primary.needsOracle || 'Thiếu oracle.'] });
      continue;
    }
    const callAssertions: ts.Statement[] = [];
    const assertionErrors: string[] = [];
    for (const expectedCall of testCase.expected.calls || []) {
      const resolved = registry.assertionHandle(expectedCall.dependency, expectedCall.method);
      if (!resolved.expression) {
        assertionErrors.push(resolved.error || `Không dựng được assertion cho ${expectedCall.dependency}.`);
        continue;
      }
      if (expectedCall.arguments) {
        callAssertions.push(expectCall(resolved.expression, 'toHaveBeenCalledWith', expectedCall.arguments.map(compileDataValue)));
      }
      if (expectedCall.times !== undefined) {
        callAssertions.push(expectCall(resolved.expression, 'toHaveBeenCalledTimes', [f.createNumericLiteral(expectedCall.times)]));
      }
    }
    if (testCase.expected.kind === 'side-effect' && callAssertions.length === 0) {
      results.push({ testCaseId: testCase.id, status: 'NEEDS_ORACLE', errors: ['side-effect cần ít nhất một expected.calls.'] });
      continue;
    }
    if (assertionErrors.length > 0) {
      results.push({ testCaseId: testCase.id, status: 'INVALID_MOCK', errors: assertionErrors });
      continue;
    }
    const invocationStatement = testCase.expected.kind === 'side-effect'
      ? f.createExpressionStatement(options.target.async ? f.createAwaitExpression(invoked.expression) : invoked.expression)
      : undefined;
    const callback = f.createArrowFunction(
      options.target.async ? [f.createModifier(ts.SyntaxKind.AsyncKeyword)] : undefined,
      undefined, [], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      f.createBlock([
        ...setup,
        ...(invocationStatement ? [invocationStatement] : []),
        ...primary.statements,
        ...callAssertions,
      ], true),
    );
    compiledTests.push(f.createExpressionStatement(f.createCallExpression(f.createIdentifier('it'), undefined, [
      f.createStringLiteral(`${testCase.id} - ${testCase.name}`), callback,
    ])));
    results.push({ testCaseId: testCase.id, status: 'GENERATED', errors: [] });
  }

  if (compiledTests.length === 0) return { testCases: results };
  const targetImport = options.target.defaultExport
    ? f.createImportDeclaration(undefined, f.createImportClause(false, f.createIdentifier(targetBinding), undefined), f.createStringLiteral(options.importPath))
    : f.createImportDeclaration(undefined, f.createImportClause(false, undefined,
      f.createNamedImports([f.createImportSpecifier(false, undefined, f.createIdentifier(importedSymbol))])), f.createStringLiteral(options.importPath));
  const vitestImport = f.createImportDeclaration(undefined, f.createImportClause(false, undefined,
    f.createNamedImports(['describe', 'expect', 'it', 'vi'].map(name =>
      f.createImportSpecifier(false, undefined, f.createIdentifier(name))))), f.createStringLiteral('vitest'));
  const describe = f.createExpressionStatement(f.createCallExpression(f.createIdentifier('describe'), undefined, [
    f.createStringLiteral(options.target.symbol),
    f.createArrowFunction(undefined, undefined, [], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      f.createBlock(compiledTests, true)),
  ]));
  const source = f.createSourceFile(
    [vitestImport, targetImport, ...registry.statements, describe],
    f.createToken(ts.SyntaxKind.EndOfFileToken), ts.NodeFlags.None,
  );
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  return { code: printer.printFile(source), testCases: results };
}
