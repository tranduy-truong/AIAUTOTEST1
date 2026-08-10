import { describe, expect, it } from 'vitest';
import {
  extractHttpUrl,
  parseAssertions,
  parseScript,
  validateParsedScript,
} from '../../src/core/step-parser.js';

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

  it('accepts a visible message with missing or unbalanced quotes', () => {
    expect(parseAssertions(
      "Có thông báo Trường này không thể để trống.' xuất hiện",
    )).toEqual([
      { kind: 'text_visible', value: 'Trường này không thể để trống.' },
    ]);

    expect(parseAssertions(
      'Có thông báo Trường này không thể để trống. xuất hiện',
    )).toEqual([
      { kind: 'text_visible', value: 'Trường này không thể để trống.' },
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

  it('parses a stateful organization flow written in natural Vietnamese', () => {
    const loginUrl = 'https://example.com/app/dang-nhap';
    const organizationUrl = 'https://example.com/app/quan-tri/to-chuc';
    const cases = parseScript([
      'TC_01: Thêm tổ chức thành công',
      `- Mở URL: [${loginUrl}](${loginUrl})`,
      "- Nhập 'test' vào ô 'Nhập tên đăng nhập'",
      "- Nhập 'Abc@12345' vào ô 'Nhập mật khẩu'",
      "- Bấm nút 'Đăng nhập'",
      `- Mở URL: [${organizationUrl}](${organizationUrl})`,
      '- Bấm nút có chữ "Thêm"',
      "- Nhập 'Tổ chức Test' vào ô 'Nhập tên tổ chức'",
      '- Tên quốc tế, tên viết tắt bỏ trống',
      "- Dropdown chọn loại hình tổ chức, chọn 'Tổ chức tôn giáo'",
      "- Dropdown chọn tôn giáo, chọn 'Công giáo'",
      "- Nhấn nút 'Lưu'",
      "- Kiểm tra: Có thông báo 'Thành công' xuất hiện",
    ].join('\n'));

    expect(cases[0].steps.map(step => step.type)).toEqual([
      'goto', 'fill', 'fill', 'click', 'goto', 'click', 'fill', 'select', 'select', 'click', 'check',
    ]);
    expect(cases[0].steps[0].url).toBe(loginUrl);
    expect(cases[0].steps[4].url).toBe(organizationUrl);
    expect(cases[0].steps[7]).toMatchObject({
      target: 'loại hình tổ chức',
      value: 'Tổ chức tôn giáo',
    });
    expect(cases[0].steps[8]).toMatchObject({ target: 'tôn giáo', value: 'Công giáo' });
    expect(cases[0].steps[9]).toMatchObject({ type: 'click', target: 'Lưu' });
    expect(validateParsedScript(cases)).toEqual([]);
  });

  it('parses an organization validation flow without turning blank fields into actions', () => {
    const cases = parseScript([
      'TC_02: Thêm tổ chức thất bại',
      '- Mở URL: https://example.com/dang-nhap',
      "- Nhập 'test' vào ô 'Nhập tên đăng nhập'",
      "- Nhập 'Abc@12345' vào ô 'Nhập mật khẩu'",
      "- Bấm nút 'Đăng nhập'",
      '- Kiểm tra: URL không còn chứa \'dang-nhap\'',
      '- Mở URL: https://example.com/quan-tri/to-chuc',
      '- Bấm nút có chữ "Thêm"',
      "- Nhập 'Tổ chức Test 2' vào ô 'Nhập tên tổ chức'",
      "- Nhập 'International name' vào ô 'Nhập tên quốc tế'",
      "- Nhập 'ITN' vào ô 'Nhập tên viết tắt'",
      "- Dropdown chọn loại hình tổ chức, chọn 'Tổ chức tôn giáo trực thuộc'",
      '- Dropdown chọn tôn giáo bỏ trống',
      "- Dropdown 'Chọn trụ sở chính' chọn 'Chùa Vĩnh Nghiêm'",
      "- Nhấn nút 'Lưu'",
      "- Kiểm tra: Có thông báo Trường này không thể để trống.' xuất hiện",
    ].join('\n'));

    expect(validateParsedScript(cases)).toEqual([]);
    expect(cases[0].steps.filter(step => step.type === 'select')).toHaveLength(2);
    expect(cases[0].steps.at(-1)).toMatchObject({
      type: 'check',
      assertions: [{ kind: 'text_visible', value: 'Trường này không thể để trống.' }],
    });
  });

  it('extracts a plain URL from Markdown without retaining link syntax', () => {
    expect(extractHttpUrl('[https://example.com/a](https://example.com/a)')).toBe(
      'https://example.com/a',
    );
  });
});
