import { describe, expect, it } from 'vitest';
import { parseAssertions, parseScript } from '../../src/core/step-parser.js';

describe('parseScript', () => {
  it('keeps quoted values, annotations and unicode bullets', () => {
    const script = [
      'URL: https://example.com/login',
      'TC_01: Đăng nhập',
      '• Mở URL',
      "• Nhập ' admin ' (có khoảng trắng ở đầu và cuối) vào ô 'Tên đăng nhập'",
      "• Nhập '123123' vào ô 'Mật khẩu' (mặc định đang ẩn)",
      "• Bấm nút 'Đăng nhập'",
    ].join('\n');
    const cases = parseScript(script);

    expect(cases).toHaveLength(1);
    expect(cases[0].steps.map(step => step.type)).toEqual(['goto', 'fill', 'fill', 'click']);
    expect(cases[0].steps[1]).toMatchObject({ value: ' admin ', target: 'Tên đăng nhập' });
    expect(cases[0].steps[2]).toMatchObject({ value: '123123', target: 'Mật khẩu' });
    expect(cases[0].unparsedSteps).toEqual([]);
  });

  it('normalizes common imperfect human input without dropping the step', () => {
    const script = [
      'URL: https://example.com/login',
      'TC_01: Dữ liệu không hợp lệ',
      '- Mở URL',
      "- Nhập 'admin'1 vào ô 'Tên đăng nhập'",
      "- Nhập ' OR '1'='1 vào ô 'Mật khẩu'",
    ].join('\n');
    const cases = parseScript(script);

    const fillSteps = cases[0].steps.filter(step => step.type === 'fill');
    expect(fillSteps.map(step => step.value)).toEqual(['admin1', "OR '1'='1"]);
    expect(cases[0].unparsedSteps).toEqual([]);
  });

  it('reports step-like lines that cannot be parsed', () => {
    const cases = parseScript([
      'TC_01: Chưa hỗ trợ',
      '- Kéo thả tệp vào vùng upload',
    ].join('\n'));

    expect(cases[0].steps).toEqual([]);
    expect(cases[0].unparsedSteps).toEqual(['- Kéo thả tệp vào vùng upload']);
  });

  it('splits compound Vietnamese messages into atomic assertions', () => {
    const assertions = parseAssertions(
      'Có cả 2 thông báo: " Vui lòng nhập tên đăng nhập" và " Vui lòng nhập mật khẩu" cùng lúc',
    );

    expect(assertions).toEqual([
      { kind: 'text_visible', value: 'Vui lòng nhập tên đăng nhập' },
      { kind: 'text_visible', value: 'Vui lòng nhập mật khẩu' },
    ]);
  });

  it('accepts descriptive test case identifiers', () => {
    const cases = parseScript([
      'TC_LOGIN_07: Bỏ trống hai trường',
      '- Kiểm tra: Có cả hai thông báo "Tên đăng nhập bắt buộc" và "Mật khẩu bắt buộc"',
    ].join('\n'));

    expect(cases[0].id).toBe('TC_LOGIN_07');
    expect(cases[0].steps[0].assertions).toHaveLength(2);
  });
});
