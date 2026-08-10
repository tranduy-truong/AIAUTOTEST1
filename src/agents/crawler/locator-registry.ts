import fs from 'fs';
import path from 'path';

export interface LearnedLocatorEntry {
  page: string;
  stepType: string;
  target: string;
  context?: string;
  selector: string;
  learnedAt: string;
  lastVerifiedAt: string;
}

export interface LocatorRegistry {
  version: 1;
  entries: LearnedLocatorEntry[];
}

export function normalizeRegistryText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function registryPageKey(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return value.replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}

export function defaultLocatorRegistryPath(): string {
  return path.join(process.cwd(), '.testkit', 'crawler-locators.json');
}

function legacyLocatorRegistryPath(): string {
  return path.join(process.cwd(), 'artifacts', 'locator-registry.json');
}

export function loadLocatorRegistry(
  filePath = defaultLocatorRegistryPath(),
): LocatorRegistry {
  const legacyPath = legacyLocatorRegistryPath();
  const sourcePath = fs.existsSync(filePath)
    ? filePath
    : filePath === defaultLocatorRegistryPath() && fs.existsSync(legacyPath)
      ? legacyPath
      : undefined;
  if (!sourcePath) return { version: 1, entries: [] };

  try {
    const parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf-8')) as Partial<LocatorRegistry>;
    const registry: LocatorRegistry = {
      version: 1,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
    if (sourcePath === legacyPath && filePath === defaultLocatorRegistryPath()) {
      saveLocatorRegistry(registry, filePath);
    }
    return registry;
  } catch {
    return { version: 1, entries: [] };
  }
}

export function saveLocatorRegistry(
  registry: LocatorRegistry,
  filePath = defaultLocatorRegistryPath(),
): void {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
}

function entryMatches(
  entry: LearnedLocatorEntry,
  pageUrl: string,
  stepType: string,
  target: string,
  context?: string,
): boolean {
  return entry.page === registryPageKey(pageUrl) &&
    entry.stepType === stepType &&
    entry.target === normalizeRegistryText(target) &&
    (entry.context || '') === normalizeRegistryText(context || '');
}

export function findLearnedLocator(
  registry: LocatorRegistry,
  pageUrl: string,
  stepType: string,
  target: string,
  context?: string,
): LearnedLocatorEntry | undefined {
  return registry.entries.find(entry =>
    entryMatches(entry, pageUrl, stepType, target, context),
  );
}

export function rememberLearnedLocator(
  registry: LocatorRegistry,
  input: {
    pageUrl: string;
    stepType: string;
    target: string;
    context?: string;
    selector: string;
  },
): LearnedLocatorEntry {
  const now = new Date().toISOString();
  const existing = findLearnedLocator(
    registry,
    input.pageUrl,
    input.stepType,
    input.target,
    input.context,
  );

  if (existing) {
    existing.selector = input.selector;
    existing.lastVerifiedAt = now;
    return existing;
  }

  const entry: LearnedLocatorEntry = {
    page: registryPageKey(input.pageUrl),
    stepType: input.stepType,
    target: normalizeRegistryText(input.target),
    context: input.context ? normalizeRegistryText(input.context) : undefined,
    selector: input.selector,
    learnedAt: now,
    lastVerifiedAt: now,
  };
  registry.entries.push(entry);
  return entry;
}

export function forgetLearnedLocator(
  registry: LocatorRegistry,
  entry: LearnedLocatorEntry,
): void {
  registry.entries = registry.entries.filter(candidate => candidate !== entry);
}
