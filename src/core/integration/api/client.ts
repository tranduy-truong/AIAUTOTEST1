import type {
  ApiHttpMethod,
  ApiRequestDefinition,
  ApiResponseSnapshot,
} from './schema.js';

const DEFAULT_TIMEOUT_MS = 15000;

function joinUrl(baseUrl: string, requestPath: string): string {
  if (/^https?:\/\//i.test(requestPath)) return requestPath;
  return new URL(requestPath.replace(/^\/+/, ''), `${baseUrl.replace(/\/+$/, '')}/`).toString();
}

function withQuery(url: string, query?: ApiRequestDefinition['query']): string {
  if (!query) return url;
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
}

async function readBody(response: Response): Promise<{ body: unknown; rawBody: string }> {
  const rawBody = await response.text();
  if (!rawBody) return { body: undefined, rawBody: '' };

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json') || /^[\[{]/.test(rawBody.trim())) {
    try {
      return { body: JSON.parse(rawBody), rawBody };
    } catch {
      // Keep malformed JSON as text so the assertion layer can report the real payload.
    }
  }
  return { body: rawBody, rawBody };
}

export async function sendApiRequest(
  baseUrl: string,
  request: ApiRequestDefinition,
  defaultHeaders: Record<string, string> = {},
): Promise<ApiResponseSnapshot & { url: string }> {
  const url = withQuery(joinUrl(baseUrl, request.path), request.query);
  const controller = new AbortController();
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(defaultHeaders);

  for (const [name, value] of Object.entries(request.headers || {})) headers.set(name, value);

  let body: BodyInit | undefined;
  const bodyType = request.bodyType ?? 'json';
  if (request.body !== undefined && bodyType !== 'empty') {
    if (bodyType === 'json') {
      body = JSON.stringify(request.body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    } else {
      body = String(request.body);
    }
  }

  const method = request.method as ApiHttpMethod;
  const start = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      signal: controller.signal,
    });
    const parsed = await readBody(response);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });

    return {
      url,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: parsed.body,
      rawBody: parsed.rawBody,
      durationMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timeout);
  }
}
