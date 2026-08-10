import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findLearnedLocator,
  loadLocatorRegistry,
  rememberLearnedLocator,
  registryPageKey,
  saveLocatorRegistry,
} from '../../src/core/locator-registry.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('locator registry', () => {
  it('scopes learned locators by page, action, target, and dropdown context', () => {
    const registry = { version: 1 as const, entries: [] };
    rememberLearnedLocator(registry, {
      pageUrl: 'https://example.com/to-chuc?tab=active',
      stepType: 'option',
      target: 'Công giáo',
      context: 'Tôn giáo',
      selector: '[data-value="catholic"]',
    });

    expect(registryPageKey('https://example.com/to-chuc?tab=archived')).toBe(
      'https://example.com/to-chuc',
    );
    expect(findLearnedLocator(
      registry,
      'https://example.com/to-chuc',
      'option',
      'Cong giao',
      'Ton giao',
    )?.selector).toBe('[data-value="catholic"]');
    expect(findLearnedLocator(
      registry,
      'https://example.com/to-chuc',
      'option',
      'Cong giao',
      'Loai hinh to chuc',
    )).toBeUndefined();
  });

  it('persists and reloads verified selectors', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'locator-registry-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'registry.json');
    const registry = loadLocatorRegistry(filePath);
    rememberLearnedLocator(registry, {
      pageUrl: 'https://example.com/form',
      stepType: 'fill',
      target: 'Nhập tên tổ chức',
      selector: 'input[placeholder="Nhập tên tổ chức"]',
    });
    saveLocatorRegistry(registry, filePath);

    expect(loadLocatorRegistry(filePath).entries).toHaveLength(1);
    expect(loadLocatorRegistry(filePath).entries[0].selector).toBe(
      'input[placeholder="Nhập tên tổ chức"]',
    );
  });
});
