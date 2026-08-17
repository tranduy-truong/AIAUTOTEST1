import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { evaluateApiAssertion, getBodyPath } from '../../src/core/integration/api/assertions.js';
import { validateApiBaseUrl } from '../../src/core/integration/api/security.js';
import { runApiTestSuite } from '../../src/core/integration/api/runner.js';

let server: http.Server | undefined;

function startTestServer(): Promise<string> {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      if (req.url === '/users/42' && req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        res.setHeader('x-test', 'api');
        res.end(JSON.stringify({ id: 42, name: 'Alice', active: true, tags: ['a', 'b'] }));
        return;
      }

      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'NOT_FOUND' }));
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server!.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Không lấy được test server port.'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

afterEach(async () => {
  if (!server) return;
  await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
});

describe('API Integration Test Foundation', () => {
  it('resolves nested object and array body paths', () => {
    const body = { user: { id: 42, tags: ['a', 'b'] } };

    expect(getBodyPath(body, '$.user.id')).toEqual({ exists: true, value: 42 });
    expect(getBodyPath(body, 'user.tags[1]')).toEqual({ exists: true, value: 'b' });
    expect(getBodyPath(body, 'user.missing')).toEqual({ exists: false, value: undefined });
  });

  it('evaluates status, header, body value and body type assertions', () => {
    const response = {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json', 'x-test': 'api' },
      body: { id: 42, active: true },
      rawBody: '{"id":42,"active":true}',
      durationMs: 2,
    };

    expect(evaluateApiAssertion({ type: 'STATUS', expected: 200 }, response).ok).toBe(true);
    expect(evaluateApiAssertion({ type: 'HEADER_EQUALS', name: 'X-Test', expected: 'api' }, response).ok).toBe(true);
    expect(evaluateApiAssertion({ type: 'BODY_PATH_EQUALS', path: '$.id', expected: 42 }, response).ok).toBe(true);
    expect(evaluateApiAssertion({ type: 'BODY_PATH_TYPE', path: '$.active', expected: 'boolean' }, response).ok).toBe(true);
  });

  it('blocks production-like API hosts and requires explicit external-host permission', () => {
    expect(() => validateApiBaseUrl('https://api.production.example.com')).toThrow('[API Security]');
    expect(() => validateApiBaseUrl('https://staging.example.com')).toThrow('[API Security]');
    expect(() => validateApiBaseUrl('https://staging.example.com', {
      allowedHostnames: ['staging.example.com'],
    })).not.toThrow();
  });

  it('runs a real HTTP request and reports an incorrect expected status as a failure', async () => {
    const url = await startTestServer();

    const result = await runApiTestSuite({
      version: 1,
      baseUrl: url,
      tests: [
        {
          id: 'API-001',
          name: 'Get user',
          request: { method: 'GET', path: '/users/42' },
          assertions: [
            { type: 'STATUS', expected: 200 },
            { type: 'BODY_PATH_EQUALS', path: '$.id', expected: 42 },
            { type: 'HEADER_EXISTS', name: 'x-test' },
          ],
        },
        {
          id: 'API-002',
          name: 'Intentional failure',
          request: { method: 'GET', path: '/users/42' },
          assertions: [{ type: 'STATUS', expected: 201 }],
        },
      ],
    });

    expect(result.totalTests).toBe(2);
    expect(result.passedTests).toBe(1);
    expect(result.failedTests).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.tests[1].assertions[0].message).toContain('expected 201');
  });
});
