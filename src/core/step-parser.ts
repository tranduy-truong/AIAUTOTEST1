export interface ParsedStep {
  type: 'goto' | 'fill' | 'click' | 'select' | 'check' | 'wait';
  target?: string;       // Element description, e.g. "Nhập tên đăng nhập"
  value?: string;        // Value to fill/select, e.g. "admin"
  url?: string;          // URL for goto steps
  assertion?: string;    // Assertion description for check steps
  assertions?: ParsedAssertion[]; // Assertions split into atomic, machine-readable checks
  raw: string;           // Original line from script
}

export type ParsedAssertion =
  | { kind: 'text_visible'; value: string }
  | { kind: 'url_contains'; value: string }
  | { kind: 'url_not_contains'; value: string }
  | { kind: 'attribute'; target: 'password'; name: 'type'; value: 'password' | 'text' }
  | { kind: 'unknown'; value: string };

export interface ParsedTestCase {
  id: string;            // e.g. "TC_01"
  name: string;          // e.g. "Đăng nhập thành công"
  url?: string;          // URL extracted from TC header or first goto step
  steps: ParsedStep[];
  unparsedSteps: string[]; // Step-like lines that need user/Planner review
}

const STEP_BULLET = /^[-*•·▪◦–—]\s*/u;

function normalizeVietnamese(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractQuotedLiterals(value: string): string[] {
  const literals: string[] = [];
  const pattern = /(["'])(.*?)\1/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    const literal = match[2].trim();
    if (literal) literals.push(literal);
  }

  return literals;
}

/**
 * Converts a natural-language expected result into atomic assertions.
 * The LLM Planner still explains the plan, while this contract prevents the
 * Generator from treating a compound sentence as one literal UI message.
 */
export function parseAssertions(value: string): ParsedAssertion[] {
  const normalized = normalizeVietnamese(value);
  const literals = extractQuotedLiterals(value);

  if (normalized.includes('url khong con chua') || normalized.includes('url khong chua')) {
    return [{ kind: 'url_not_contains', value: literals[0] || 'dang-nhap' }];
  }
  if (normalized.includes('url chua')) {
    return [{ kind: 'url_contains', value: literals[0] || 'dang-nhap' }];
  }
  if (
    normalized.includes('mat khau dang an') ||
    normalized.includes('mat khau bi an') ||
    normalized.includes('mat khau quay lai dang an')
  ) {
    return [{ kind: 'attribute', target: 'password', name: 'type', value: 'password' }];
  }
  if (
    normalized.includes('mat khau dang van ban') ||
    normalized.includes('mat khau chuyen sang dang van ban') ||
    (normalized.includes('mat khau') && normalized.includes('doc duoc'))
  ) {
    return [{ kind: 'attribute', target: 'password', name: 'type', value: 'text' }];
  }

  const isVisibleTextAssertion = [
    'thong bao',
    'hien thi text',
    'xuat hien',
    'co chu',
  ].some(keyword => normalized.includes(keyword));
  if (isVisibleTextAssertion && literals.length > 0) {
    return literals.map(literal => ({ kind: 'text_visible' as const, value: literal }));
  }

  return [{ kind: 'unknown', value: value.trim() }];
}

function stripOuterQuotes(value: string): string {
  let cleaned = value.trim().replace(/\s*\([^)]*\)\s*$/u, '').trim();
  const first = cleaned[0];
  const last = cleaned[cleaned.length - 1];

  if ((first === "'" || first === '"') && last === first) {
    // Preserve intentional whitespace inside quotes (for trim/whitespace tests).
    return cleaned.slice(1, -1);
  }

  // Handle imperfect human input such as: 'admin'1 or ' OR '1'='1.
  if (first === "'" || first === '"') cleaned = cleaned.slice(1).trim();
  if (/^OR\s+'?1'?\s*=\s*'?1'?$/iu.test(cleaned)) {
    return "OR '1'='1";
  }
  const singleQuoteCount = (cleaned.match(/'/g) || []).length;
  const doubleQuoteCount = (cleaned.match(/"/g) || []).length;
  if (singleQuoteCount % 2 !== 0) cleaned = cleaned.replace(/'/g, '');
  if (doubleQuoteCount % 2 !== 0) cleaned = cleaned.replace(/"/g, '');
  return cleaned.trim();
}

function parseFillStep(rawLine: string, originalLine: string): ParsedStep | null {
  if (!/^Nhập\s+/iu.test(rawLine)) return null;

  const targetMatch = rawLine.match(/\s+vào\s+(ô|trường|label)\s+(['"])(.*?)\2(?:\s*\([^)]*\))?\s*$/iu);
  if (targetMatch?.index !== undefined) {
    const valuePart = rawLine.slice(rawLine.search(/^Nhập\s+/iu) + 'Nhập'.length, targetMatch.index);
    const value = stripOuterQuotes(valuePart);
    if (value) {
      return { type: 'fill', value, target: targetMatch[3].trim(), raw: originalLine };
    }
  }

  const reverseMatch = rawLine.match(/^Nhập\s+vào\s+(?:ô|trường|label)\s+(['"])(.*?)\1\s+là\s+(.+)$/iu);
  if (reverseMatch) {
    const value = stripOuterQuotes(reverseMatch[3]);
    if (value) {
      return { type: 'fill', target: reverseMatch[2].trim(), value, raw: originalLine };
    }
  }

  return null;
}

/**
 * Phân tích kịch bản kiểm thử tiếng Việt thành các đối tượng JSON có cấu trúc.
 * 
 * @param scriptText Nội dung kịch bản dạng văn bản thuần túy (plain text)
 * @returns Danh sách các test case đã được phân tích
 */
export function parseScript(scriptText: string): ParsedTestCase[] {
  const lines = scriptText.split('\n').map(line => line.trim());
  const testCases: ParsedTestCase[] = [];
  
  let currentTC: ParsedTestCase | null = null;
  let globalUrl: string | undefined = undefined;

  for (const line of lines) {
    if (!line) continue;

    // 1. Nhận diện Global URL (được khai báo ở đầu kịch bản, trước các Test Case)
    const globalUrlMatch = line.match(/^URL:\s*(http.*)$/i);
    if (!currentTC && globalUrlMatch) {
      globalUrl = globalUrlMatch[1].trim();
      continue;
    }

    // 2. Nhận diện Test Case Header (VD: TC_01: Đăng nhập thành công)
    const tcMatch = line.match(/^(TC(?:_[A-Z0-9]+)+)\s*[:-]\s*(.*)$/i);
    if (tcMatch) {
      if (currentTC) {
        testCases.push(currentTC);
      }
      currentTC = {
        id: tcMatch[1].trim(),
        name: tcMatch[2].trim(),
        url: globalUrl, // Dùng URL toàn cục làm URL mặc định cho TC
        steps: [],
        unparsedSteps: []
      };
      continue;
    }

    if (!currentTC) continue;

    // Loại bỏ dấu "-" hoặc "*" ở đầu các dòng bước (step)
    const hasStepBullet = STEP_BULLET.test(line);
    const rawLine = line.replace(STEP_BULLET, '').trim();

    // 3. Bỏ qua các bước yêu cầu để trống ô nhập liệu
    if (/bỏ trống/i.test(rawLine)) {
      continue;
    }

    let step: ParsedStep | null = null;
    let match: RegExpMatchArray | null = null;

    // 4. Nhận diện bước "Mở URL"
    match = rawLine.match(/^Mở URL(?:\s*:\s*(http.*))?$/i);
    if (match) {
      const stepUrl = match[1]?.trim() || currentTC.url || globalUrl;
      if (match[1]?.trim()) {
        currentTC.url = stepUrl; // Cập nhật URL chính của TC nếu có URL mới
      }
      step = { type: 'goto', url: stepUrl, raw: line };
    }

    // 5. Nhận diện bước "Nhập" dữ liệu, kể cả giá trị chứa dấu nháy
    // hoặc có chú thích trong ngoặc giữa giá trị và tên ô.
    if (!step) {
      step = parseFillStep(rawLine, line);
    }

    // 6. Nhận diện bước "Click / Bấm"
    // Mẫu 1: Bấm nút 'Z', Click nút 'Z', Bấm vào nút 'Z', Bấm nút có chữ 'Z' (Hỗ trợ nháy kép hoặc đơn)
    if (!step) {
      match = rawLine.match(/^(?:Bấm|Click)(?:\s+vào)?\s+(?:nút|icon)(?:\s+có\s+chữ)?\s+['"]([^'"]+)['"]/i);
      if (match) {
        step = { type: 'click', target: match[1], raw: line };
      }
    }
    // Mẫu 2: Bấm vào icon ... (Không có dấu nháy)
    if (!step) {
      match = rawLine.match(/^(?:Bấm|Click)(?:\s+vào)?\s+icon\s+(.*)$/i);
      if (match) {
        step = { type: 'click', target: match[1].replace(/['"]/g, '').trim(), raw: line };
      }
    }

    // 7. Nhận diện bước "Select" (Dropdown)
    // Mẫu 1: Dropdown 'X' chọn 'Y'
    if (!step) {
      match = rawLine.match(/^Dropdown\s+['"]([^'"]+)['"]\s+chọn\s+['"]([^'"]+)['"]/i);
      if (match) {
        step = { type: 'select', target: match[1], value: match[2], raw: line };
      }
    }
    // Mẫu 2: Chọn 'Y' trong dropdown 'X'
    if (!step) {
      match = rawLine.match(/^Chọn\s+['"]([^'"]+)['"]\s+trong\s+dropdown\s+['"]([^'"]+)['"]/i);
      if (match) {
        step = { type: 'select', value: match[1], target: match[2], raw: line };
      }
    }

    // 8. Nhận diện bước "Check" (Kiểm tra)
    if (!step) {
      match = rawLine.match(/^Kiểm tra:\s*(.*)$/i);
      if (match) {
        const assertion = match[1].trim();
        step = {
          type: 'check',
          assertion,
          assertions: parseAssertions(assertion),
          raw: line,
        };
      }
    }

    // 9. Nhận diện bước "Wait"
    if (!step) {
      if (/^Chờ trang load xong$/i.test(rawLine)) {
        step = { type: 'wait', raw: line };
      }
    }

    // Thêm bước vào test case hiện tại nếu nhận diện thành công
    if (step) {
      currentTC.steps.push(step);
    } else if (hasStepBullet) {
      currentTC.unparsedSteps.push(line);
    }
  }

  // Đẩy test case cuối cùng vào danh sách
  if (currentTC) {
    testCases.push(currentTC);
  }

  return testCases;
}
