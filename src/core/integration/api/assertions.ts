import type {
  ApiAssertion,
  ApiAssertionResult,
  ApiBodyValueType,
  ApiResponseSnapshot,
} from './schema.js';

function normalizePath(path: string): string[] {
  return path
    .replace(/^\$\.?/, '')
    .split('.')
    .filter(Boolean)
    .flatMap(segment => segment.replace(/\[(\d+)\]/g, '.$1').split('.'))
    .filter(Boolean);
}

export function getBodyPath(body: unknown, path: string): { exists: boolean; value: unknown } {
  if (!path || path === '$') return { exists: body !== undefined, value: body };

  let current: unknown = body;
  for (const segment of normalizePath(path)) {
    if (current === null || current === undefined) return { exists: false, value: undefined };

    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { exists: false, value: undefined };
      }
      current = current[index];
      continue;
    }

    if (typeof current !== 'object' || !(segment in current)) {
      return { exists: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return { exists: true, value: current };
}

function valueType(value: unknown): ApiBodyValueType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return typeof value;
    default:
      return 'object';
  }
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
  return entry?.[1];
}

export function evaluateApiAssertion(
  assertion: ApiAssertion,
  response: ApiResponseSnapshot,
): ApiAssertionResult {
  switch (assertion.type) {
    case 'STATUS':
      return {
        type: assertion.type,
        ok: response.status === assertion.expected,
        message: response.status === assertion.expected
          ? `HTTP status đúng: ${response.status}`
          : `HTTP status sai: expected ${assertion.expected}, received ${response.status}`,
      };

    case 'STATUS_IN':
      return {
        type: assertion.type,
        ok: assertion.expected.includes(response.status),
        message: assertion.expected.includes(response.status)
          ? `HTTP status ${response.status} thuộc tập mong đợi [${assertion.expected.join(', ')}]`
          : `HTTP status sai: expected one of [${assertion.expected.join(', ')}], received ${response.status}`,
      };

    case 'HEADER_EXISTS': {
      const value = headerValue(response.headers, assertion.name);
      return {
        type: assertion.type,
        ok: value !== undefined,
        message: value !== undefined
          ? `Header "${assertion.name}" tồn tại`
          : `Thiếu header "${assertion.name}"`,
      };
    }

    case 'HEADER_EQUALS': {
      const value = headerValue(response.headers, assertion.name);
      return {
        type: assertion.type,
        ok: value === assertion.expected,
        message: value === assertion.expected
          ? `Header "${assertion.name}" đúng`
          : `Header "${assertion.name}" sai: expected "${assertion.expected}", received "${value ?? '<missing>'}"`,
      };
    }

    case 'BODY_PATH_EXISTS': {
      const result = getBodyPath(response.body, assertion.path);
      return {
        type: assertion.type,
        ok: result.exists,
        message: result.exists
          ? `Body path "${assertion.path}" tồn tại`
          : `Body path "${assertion.path}" không tồn tại`,
      };
    }

    case 'BODY_PATH_EQUALS': {
      const result = getBodyPath(response.body, assertion.path);
      const equal = result.exists && JSON.stringify(result.value) === JSON.stringify(assertion.expected);
      return {
        type: assertion.type,
        ok: equal,
        message: equal
          ? `Body path "${assertion.path}" đúng expected`
          : `Body path "${assertion.path}" sai: expected ${JSON.stringify(assertion.expected)}, received ${JSON.stringify(result.value)}`,
      };
    }

    case 'BODY_PATH_TYPE': {
      const result = getBodyPath(response.body, assertion.path);
      const actualType = result.exists ? valueType(result.value) : undefined;
      return {
        type: assertion.type,
        ok: actualType === assertion.expected,
        message: actualType === assertion.expected
          ? `Body path "${assertion.path}" có type ${assertion.expected}`
          : `Body path "${assertion.path}" sai type: expected ${assertion.expected}, received ${actualType ?? '<missing>'}`,
      };
    }

    case 'BODY_CONTAINS': {
      const actual = typeof response.body === 'string'
        ? response.body
        : JSON.stringify(response.body);
      const ok = actual?.includes(assertion.expected) ?? false;
      return {
        type: assertion.type,
        ok,
        message: ok
          ? `Response body chứa "${assertion.expected}"`
          : `Response body không chứa "${assertion.expected}"`,
      };
    }
  }
}
