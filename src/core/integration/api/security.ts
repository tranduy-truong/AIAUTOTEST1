const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const PRODUCTION_LIKE_HOST_PATTERNS = [
  /(^|[.-])production([.-]|$)/i,
  /(^|[.-])prod([.-]|$)/i,
  /(^|[.-])live([.-]|$)/i,
];

export interface ApiSecurityConfig {
  allowedHostnames?: string[];
  allowExternalHosts?: boolean;
  blockProductionLikeHosts?: boolean;
}

export function validateApiBaseUrl(
  baseUrl: string,
  security: ApiSecurityConfig = {},
): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`[API Security] baseUrl không hợp lệ: ${baseUrl}`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`[API Security] Chỉ cho phép HTTP/HTTPS: ${baseUrl}`);
  }

  const hostname = url.hostname.toLowerCase();
  const blockProductionLikeHosts = security.blockProductionLikeHosts ?? true;
  if (
    blockProductionLikeHosts &&
    PRODUCTION_LIKE_HOST_PATTERNS.some(pattern => pattern.test(hostname))
  ) {
    throw new Error(
      `[API Security] Từ chối host có dấu hiệu Production: ${hostname}. ` +
      'Hãy dùng môi trường test/staging được allowlist rõ ràng.',
    );
  }

  const allowedHostnames = security.allowedHostnames || [];
  if (allowedHostnames.length > 0) {
    const allowed = allowedHostnames.some(
      allowed => hostname === allowed.toLowerCase(),
    );
    if (!allowed) {
      throw new Error(
        `[API Security] Host "${hostname}" không nằm trong allowedHostnames.`,
      );
    }
    return;
  }

  if (!LOCAL_HOSTS.has(hostname) && !(security.allowExternalHosts ?? false)) {
    throw new Error(
      `[API Security] Host "${hostname}" là external host nhưng chưa được cho phép. ` +
      'Khai báo allowedHostnames hoặc allowExternalHosts=true cho môi trường test được kiểm soát.',
    );
  }
}
