import { afterEach, describe, expect, it, vi } from 'vitest';
import { detail, error, header, info, progress, success, summary, warning } from '../../src/core/cli-ui.js';

afterEach(() => vi.restoreAllMocks());

describe('CLI UI', () => {
  it('renders concise semantic status messages without forcing ANSI in captured output', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fail = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    header();
    info('Đang phân tích');
    progress(1, 2, 'Target A');
    success('Đã tạo test');
    warning('Cần expected');
    error('Không thể tiếp tục');
    detail('Chi tiết', 'artifact.json');

    expect(log.mock.calls.flat().join('\n')).toContain('AI TESTKIT');
    expect(log.mock.calls.flat().join('\n')).toContain('[1/2] Target A');
    expect(warn).toHaveBeenCalledWith('▲ Cần expected');
    expect(fail).toHaveBeenCalledWith('✖ Không thể tiếp tục');
  });

  it('renders a readable result summary', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    summary('Kết quả', [['Đã tạo', '1/2 file'], ['Cần xử lý', '2 test case']], 'warning');
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('KẾT QUẢ');
    expect(output).toContain('1/2 file');
    expect(output).toContain('2 test case');
  });
});
