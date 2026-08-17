import fs from 'fs';
import path from 'path';
import { validateApiBaseUrl } from './security.js';
import type { ApiTestSuite } from './schema.js';

export function loadApiTestSuite(
  projectRoot = process.cwd(),
  customPath = 'testkit.api.json',
): ApiTestSuite | null {
  const configPath = path.resolve(projectRoot, customPath);
  if (!fs.existsSync(configPath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (error: any) {
    throw new Error(`[API Config] Không thể parse "${configPath}": ${error.message}`);
  }

  validateApiSuite(parsed, configPath);
  return parsed as ApiTestSuite;
}

export function validateApiSuite(
  value: unknown,
  source = 'testkit.api.json',
): asserts value is ApiTestSuite {
  if (!value || typeof value !== 'object') {
    throw new Error(`[API Config] ${source} phải là một object.`);
  }

  const suite = value as Partial<ApiTestSuite>;
  if (suite.version !== 1) {
    throw new Error(`[API Config] ${source} phải có version = 1.`);
  }
  if (!suite.baseUrl || typeof suite.baseUrl !== 'string') {
    throw new Error(`[API Config] ${source} thiếu baseUrl.`);
  }

  validateApiBaseUrl(suite.baseUrl, suite.security);

  if (!Array.isArray(suite.tests) || suite.tests.length === 0) {
    throw new Error('[API Config] tests phải là mảng và có ít nhất một test case.');
  }

  for (const [index, testCase] of suite.tests.entries()) {
    if (!testCase || typeof testCase !== 'object') {
      throw new Error(`[API Config] tests[${index}] không hợp lệ.`);
    }
    if (!testCase.id || !testCase.name) {
      throw new Error(`[API Config] tests[${index}] phải có id và name.`);
    }
    if (!testCase.request || typeof testCase.request !== 'object') {
      throw new Error(`[API Config] tests[${index}] thiếu request.`);
    }
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(testCase.request.method)) {
      throw new Error(`[API Config] tests[${index}].request.method không hợp lệ.`);
    }
    if (!testCase.request.path || typeof testCase.request.path !== 'string') {
      throw new Error(`[API Config] tests[${index}].request.path phải là string.`);
    }
    if (!Array.isArray(testCase.assertions) || testCase.assertions.length === 0) {
      throw new Error(`[API Config] tests[${index}] phải có ít nhất một assertion.`);
    }
  }
}
