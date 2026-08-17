import fs from 'fs';
import path from 'path';
import { sendApiRequest } from './client.js';
import { evaluateApiAssertion } from './assertions.js';
import type { ApiTestResult, ApiTestRunResult, ApiTestSuite } from './schema.js';

export async function runApiTestSuite(suite: ApiTestSuite): Promise<ApiTestRunResult> {
  if (!suite.baseUrl) throw new Error('API baseUrl không được để trống.');
  if (!suite.tests.length) throw new Error('API test suite không có test case.');

  const startedAt = new Date().toISOString();
  const start = Date.now();
  const tests: ApiTestResult[] = [];

  for (const testCase of suite.tests) {
    const testStart = Date.now();
    const requestUrl = /^https?:\/\//i.test(testCase.request.path)
      ? testCase.request.path
      : new URL(
          testCase.request.path.replace(/^\/+/, ''),
          `${suite.baseUrl.replace(/\/+$/, '')}/`,
        ).toString();

    try {
      const response = await sendApiRequest(
        suite.baseUrl,
        testCase.request,
        suite.defaultHeaders || {},
      );
      const assertions = testCase.assertions.map(assertion => evaluateApiAssertion(assertion, response));

      tests.push({
        id: testCase.id,
        name: testCase.name,
        ok: assertions.every(assertion => assertion.ok),
        durationMs: Date.now() - testStart,
        request: { method: testCase.request.method, url: requestUrl },
        response,
        assertions,
      });
    } catch (error: any) {
      tests.push({
        id: testCase.id,
        name: testCase.name,
        ok: false,
        durationMs: Date.now() - testStart,
        request: { method: testCase.request.method, url: requestUrl },
        assertions: [],
        error: error?.name === 'AbortError'
          ? `Request timeout sau ${testCase.request.timeoutMs ?? 15000}ms`
          : error?.message || String(error),
      });
    }
  }

  const passedTests = tests.filter(test => test.ok).length;
  const failedTests = tests.length - passedTests;

  return {
    ok: failedTests === 0,
    baseUrl: suite.baseUrl,
    startedAt,
    durationMs: Date.now() - start,
    totalTests: tests.length,
    passedTests,
    failedTests,
    tests,
  };
}

function redactReportValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactReportValue);
  if (!value || typeof value !== 'object') return value;

  const secretNames = /authorization|cookie|set-cookie|api[-_]?key|token|password|secret/i;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      secretNames.test(key) ? '[REDACTED_SECRET]' : redactReportValue(entry),
    ]),
  );
}

export function writeApiRunArtifacts(
  result: ApiTestRunResult,
  runDirectory: string,
): { jsonPath: string; markdownPath: string } {
  fs.mkdirSync(runDirectory, { recursive: true });
  const safeResult = redactReportValue(result);
  const jsonPath = path.join(runDirectory, 'api-test-results.json');
  const markdownPath = path.join(runDirectory, 'api-test-results.md');

  fs.writeFileSync(jsonPath, JSON.stringify(safeResult, null, 2) + '\n');

  const rows = result.tests.map(test => {
    const status = test.ok ? '✅ PASS' : '❌ FAIL';
    const failedAssertions = test.assertions.filter(assertion => !assertion.ok);
    const reason = test.error || failedAssertions.map(assertion => assertion.message).join('; ');
    return `| ${test.id} | ${test.name} | ${status} | ${test.durationMs}ms | ${reason || 'OK'} |`;
  });

  const markdown = [
    '# 🧪 API Integration Test Report',
    '',
    `- **Base URL**: ${result.baseUrl}`,
    `- **Started**: ${result.startedAt}`,
    `- **Status**: ${result.ok ? '✅ PASSED' : '❌ FAILED'}`,
    `- **Total**: ${result.totalTests}`,
    `- **Passed**: ${result.passedTests}`,
    `- **Failed**: ${result.failedTests}`,
    '',
    '| ID | Test case | Status | Duration | Detail |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');

  fs.writeFileSync(markdownPath, markdown);
  return { jsonPath, markdownPath };
}
