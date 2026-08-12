import fs from 'fs';
import path from 'path';
import type {
  UnitLanguage,
  UnitProjectManifest,
  UnitTestFramework,
} from './schema.js';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.testkit', 'node_modules', 'dist', 'build', 'coverage', 'out',
  '.next', '.nuxt', '.cache', 'vendor', 'playwright-report', 'test-results',
]);
const EXCLUDED_FILE_PATTERNS = [
  /(?:^|\/)\.env(?:\.|$)/i,
  /(?:secret|credential|private[-_.]?key)/i,
  /\.(?:pem|p12|pfx|key|crt|cer)$/i,
  /(?:^|\/)(?:tests?|__tests__|fixtures?|mocks?)(?:\/|$)/i,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/i,
  /\.d\.ts$/i,
];
const MAX_SOURCE_FILES = 5000;
const MAX_SOURCE_BYTES = 768 * 1024;

interface PackageJsonShape {
  name?: string;
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function safeReadJson(filePath: string): PackageJsonShape {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PackageJsonShape;
  } catch {
    return {};
  }
}

function findProjectRoot(inputPath: string): string {
  const absolute = path.resolve(inputPath);
  let current = fs.statSync(absolute).isDirectory() ? absolute : path.dirname(absolute);
  while (true) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return fs.statSync(absolute).isDirectory() ? absolute : path.dirname(absolute);
    current = parent;
  }
}

function detectFramework(root: string, pkg: PackageJsonShape): UnitTestFramework {
  const dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const scripts = Object.values(pkg.scripts || {}).join(' ');
  const rootFiles = fs.readdirSync(root);
  if (
    dependencies.vitest ||
    rootFiles.some(file => /^vitest\.config\.[cm]?[jt]s$/i.test(file)) ||
    /\bvitest\b/.test(scripts)
  ) return 'vitest';
  if (
    dependencies.jest || dependencies['@jest/globals'] || dependencies['ts-jest'] ||
    rootFiles.some(file => /^jest\.config\.[cm]?[jt]s$/i.test(file)) ||
    /\bjest\b/.test(scripts)
  ) return 'jest';
  return 'unknown';
}

function detectPackageManager(root: string): UnitProjectManifest['packageManager'] {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'package-lock.json'))) return 'npm';
  if (fs.existsSync(path.join(root, 'package.json'))) return 'npm';
  return 'unknown';
}

function detectLanguage(files: string[]): UnitLanguage {
  const hasTypeScript = files.some(file => /\.(?:ts|tsx|mts|cts)$/.test(file));
  const hasJavaScript = files.some(file => /\.(?:js|jsx|mjs|cjs)$/.test(file));
  if (hasTypeScript && hasJavaScript) return 'mixed';
  if (hasTypeScript) return 'typescript';
  if (hasJavaScript) return 'javascript';
  return 'unknown';
}

function shouldSkipFile(relativePath: string): boolean {
  return EXCLUDED_FILE_PATTERNS.some(pattern => pattern.test(toPosix(relativePath)));
}

function collectSourceFiles(root: string, selectedInput: string): string[] {
  const absoluteInput = path.resolve(selectedInput);
  if (fs.statSync(absoluteInput).isFile()) {
    const relative = toPosix(path.relative(root, absoluteInput));
    if (!SOURCE_EXTENSIONS.has(path.extname(absoluteInput).toLowerCase())) {
      throw new Error(`Định dạng file chưa được Unit Reader hỗ trợ: ${absoluteInput}`);
    }
    if (shouldSkipFile(relative)) throw new Error(`File bị loại khỏi phạm vi an toàn: ${relative}`);
    return [relative];
  }

  const files: string[] = [];
  const stack = [absoluteInput];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) stack.push(absolute);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const relative = toPosix(path.relative(root, absolute));
      if (shouldSkipFile(relative)) continue;
      if (fs.statSync(absolute).size > MAX_SOURCE_BYTES) continue;
      files.push(relative);
      if (files.length > MAX_SOURCE_FILES) {
        throw new Error(`Dự án có hơn ${MAX_SOURCE_FILES} file nguồn. Hãy chọn module hoặc file cụ thể.`);
      }
    }
  }
  return files.sort();
}

function configFiles(root: string): string[] {
  return fs.readdirSync(root)
    .filter(name =>
      /^(?:package\.json|(?:ts|js)config(?:\.[^.]+)?\.json|(?:vite|vitest|jest)\.config\.[cm]?[jt]s)$/i.test(name),
    )
    .sort();
}

export function scanUnitProject(inputPath: string): UnitProjectManifest {
  if (!inputPath.trim()) throw new Error('Đường dẫn dự án/file không được để trống.');
  const absoluteInput = path.resolve(inputPath.trim());
  if (!fs.existsSync(absoluteInput)) throw new Error(`Không tìm thấy đường dẫn: ${absoluteInput}`);

  const root = findProjectRoot(absoluteInput);
  const pkg = safeReadJson(path.join(root, 'package.json'));
  const sourceFiles = collectSourceFiles(root, absoluteInput);
  if (sourceFiles.length === 0) {
    throw new Error('Không tìm thấy file JavaScript/TypeScript phù hợp để phân tích.');
  }

  return {
    version: 1,
    projectName: pkg.name || path.basename(root),
    projectRoot: root,
    packageType: pkg.type === 'module' ? 'module' : pkg.type ? 'commonjs' : 'unknown',
    language: detectLanguage(sourceFiles),
    testFramework: detectFramework(root, pkg),
    packageManager: detectPackageManager(root),
    sourceFiles,
    configFiles: configFiles(root),
    scannedAt: new Date().toISOString(),
  };
}
