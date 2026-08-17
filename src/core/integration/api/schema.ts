import type { ApiSecurityConfig } from './security.js';

export type ApiHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export type ApiBodyType = 'json' | 'text' | 'empty';

export interface ApiRequestDefinition {
  method: ApiHttpMethod;
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
  bodyType?: ApiBodyType;
  timeoutMs?: number;
}

export type ApiBodyValueType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null';

export type ApiAssertion =
  | { type: 'STATUS'; expected: number }
  | { type: 'STATUS_IN'; expected: number[] }
  | { type: 'HEADER_EXISTS'; name: string }
  | { type: 'HEADER_EQUALS'; name: string; expected: string }
  | { type: 'BODY_PATH_EXISTS'; path: string }
  | { type: 'BODY_PATH_EQUALS'; path: string; expected: unknown }
  | { type: 'BODY_PATH_TYPE'; path: string; expected: ApiBodyValueType }
  | { type: 'BODY_CONTAINS'; expected: string };

export interface ApiTestCase {
  id: string;
  name: string;
  request: ApiRequestDefinition;
  assertions: ApiAssertion[];
}

export interface ApiTestSuite {
  version: 1;
  baseUrl: string;
  security?: ApiSecurityConfig;
  defaultHeaders?: Record<string, string>;
  tests: ApiTestCase[];
}

export interface ApiResponseSnapshot {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  rawBody: string;
  durationMs: number;
}

export interface ApiAssertionResult {
  type: ApiAssertion['type'];
  ok: boolean;
  message: string;
}

export interface ApiTestResult {
  id: string;
  name: string;
  ok: boolean;
  durationMs: number;
  request: {
    method: ApiHttpMethod;
    url: string;
  };
  response?: ApiResponseSnapshot;
  assertions: ApiAssertionResult[];
  error?: string;
}

export interface ApiTestRunResult {
  ok: boolean;
  baseUrl: string;
  startedAt: string;
  durationMs: number;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  tests: ApiTestResult[];
}
