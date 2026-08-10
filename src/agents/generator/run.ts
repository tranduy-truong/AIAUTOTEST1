import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { OpenAIAdapter } from "../../adapters/openai.js";
import type { ActionPlan, ResolvedAction } from "../../core/action-plan.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MAX_DOM_REPORT_CHARS = 8000;

export function limitDomReport(report: string, maxChars = MAX_DOM_REPORT_CHARS): string {
  if (report.length <= maxChars) return report;
  return `${report.slice(0, maxChars)}\n\n[DOM catalog truncated to stay within the AI token limit.]`;
}

export function getGeneratedTestDirectory(
  level: "unit" | "integration" | "e2e",
  cwd = process.cwd(),
): string {
  return path.join(cwd, "tests", level);
}

export function clearGeneratedE2ESpecs(outDir: string): void {
  const legacyGeneratedDir = path.join(outDir, "generated");
  fs.rmSync(legacyGeneratedDir, { recursive: true, force: true });

  if (!fs.existsSync(outDir)) return;
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (entry.isFile() && /\.spec\.[jt]s$/i.test(entry.name)) {
      fs.rmSync(path.join(outDir, entry.name), { force: true });
    }
  }
}

function loadVerifiedActionPlan(level: "unit" | "integration" | "e2e"): ActionPlan | undefined {
  if (level !== "e2e" || !fs.existsSync("artifacts/action-plan.json")) return undefined;

  try {
    return JSON.parse(fs.readFileSync("artifacts/action-plan.json", "utf-8")) as ActionPlan;
  } catch (error) {
    console.warn(`   Không đọc được Action Plan đã xác minh: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return undefined;
  }
}

function compactActionPlan(plan: ActionPlan): string {
  return JSON.stringify({
    testCases: plan.testCases.map(testCase => ({
      id: testCase.id,
      actions: testCase.actions.map(action => ({
        stepIndex: action.stepIndex,
        type: action.type,
        description: action.description,
        playwrightCode: action.playwrightCode,
        confidence: action.confidence,
        matchedBy: action.matchedBy,
        assertions: action.assertions,
      })),
    })),
  }, null, 2);
}

export async function runGenerator(
  level: "unit" | "integration" | "e2e",
  targetFileName: string,
) {
  console.log(
    `\n👨‍💻 [Generator Agent] Đang sinh code kiểm thử cho tầng: ${level.toUpperCase()}`,
  );

  // 1. Kiểm tra kế hoạch từ file JSON
  const preferredPlanPath = level === 'e2e'
    ? 'artifacts/test-plan-e2e.md'
    : `artifacts/test-plan-${level}.json`;
  const legacyPlanPath = `artifacts/test-plan-${level}.json`;
  const planPath = fs.existsSync(preferredPlanPath) ? preferredPlanPath : legacyPlanPath;
  if (!fs.existsSync(planPath)) {
    console.error(`❌ Không tìm thấy ${planPath}. Hãy chạy Planner trước!`);
    return false;
  }

  const testPlan = fs.readFileSync(planPath, "utf-8");
  const structuredPlannerPlan = level === 'e2e' && fs.existsSync('artifacts/test-plan-e2e.json')
    ? fs.readFileSync('artifacts/test-plan-e2e.json', 'utf-8')
    : '';

  let sourceScript = '';
  if (level === 'e2e' && fs.existsSync('artifacts/source-script-e2e.md')) {
    sourceScript = fs.readFileSync('artifacts/source-script-e2e.md', 'utf-8');
  }
  const verifiedActionPlan = loadVerifiedActionPlan(level);

  // 2. Cấu hình Framework đích (Playwright hay Vitest)
  let framework = "";
  let fileExtension = "";
  if (level === "unit" || level === "integration") {
    framework = "Vitest (import { describe, it, expect } from 'vitest')";
    fileExtension = ".test.ts";
  } else {
    framework = "Playwright (import { test, expect } from '@playwright/test')";
    fileExtension = ".spec.ts";
  }

  // 3. Đọc kịch bản file .md của Generator
  const promptFileName = `prompt-${level}.md`;
  const promptFilePath = path.join(__dirname, promptFileName);

  let systemPrompt = "";
  if (fs.existsSync(promptFilePath)) {
    systemPrompt = fs.readFileSync(promptFilePath, "utf-8");
  } else {
    console.error(
      `❌ Không tìm thấy file kịch bản của Generator: ${promptFilePath}`,
    );
    return false;
  }

  // Đọc DOM data nếu có từ crawler
  let crawledDomData = "";
  if (!verifiedActionPlan && fs.existsSync("artifacts/crawled-dom.md")) {
    const domReport = limitDomReport(fs.readFileSync("artifacts/crawled-dom.md", "utf-8"));
    crawledDomData =
      `\n\n[BÁO CÁO CRAWLED DOM THỰC TẾ - BẮT BUỘC DÙNG CHÍNH XÁC CÁC LOCATOR NÀY]:\n` +
      domReport;
  }

  const prompt = `
${systemPrompt}

Bạn là chuyên gia tự động hóa kiểm thử. Dựa vào bản Test Plan dưới đây, hãy viết code test hoàn chỉnh bằng ${framework}.

[TEST PLAN]:
${testPlan}
${crawledDomData}

${structuredPlannerPlan ? `[TEST PLAN CÓ CẤU TRÚC DO PLANNER XUẤT RA - MỖI ASSERTION LÀ MỘT KIỂM TRA RIÊNG]:\n${structuredPlannerPlan}` : ''}

${verifiedActionPlan ? `[ACTION PLAN ĐÃ ĐƯỢC CRAWLER XÁC MINH - PLAYWRIGHT CODE TRONG TỪNG ACTION LÀ BẮT BUỘC]:\n${compactActionPlan(verifiedActionPlan)}` : ''}

${sourceScript ? `[KỊCH BẢN GỐC - NGUỒN SỰ THẬT CHO THỨ TỰ BƯỚC, TEST DATA VÀ ASSERTION]:\n${sourceScript}` : ''}

[QUY TẮC QUAN TRỌNG - PHẢI TUÂN THỦ TUYỆT ĐỐI]:
1. Kịch bản gốc quyết định chính xác thứ tự bước, dữ liệu nhập và assertion; Test Plan chỉ bổ sung ý nghĩa nghiệp vụ.
2. Nếu có ACTION PLAN ĐÃ ĐƯỢC CRAWLER XÁC MINH, PHẢI chép đúng playwrightCode cho từng action; CẤM thay bằng locator khác.
3. TUYỆT ĐỐI KHÔNG tự đoán class theo thư viện UI như .lucide-eye, .fa-edit hoặc [class*=eye] nếu DOM không cung cấp class đó.
4. Nếu không có locator duy nhất được xác minh, đánh dấu test bằng test.fixme(true, 'Không có locator được xác minh cho ...') thay vì sinh locator đoán mò.
5. Nhóm các test case theo MODULE thành các file riêng biệt.
6. Mỗi file bắt đầu bằng dòng đánh dấu: // FILE: <tên-file>${fileExtension}
7. Mỗi file chỉ được có DUY NHẤT MỘT dòng import ở đầu file.
8. TUYỆT ĐỐI KHÔNG lặp lại dòng import ở giữa hoặc cuối file.
9. Toàn bộ nội dung nằm trong một khối \`\`\`typescript ... \`\`\`.

[VÍ DỤ ĐỊNH DẠNG ĐẦU RA - TUÂN THEO CHÍNH XÁC]:
\`\`\`typescript
// FILE: login${fileExtension}
import { test, expect } from '@playwright/test';

test.describe('Login', () => {
  test('TC_LOGIN_01 - ...', async ({ page }) => {
    // test steps
  });
});

// FILE: product${fileExtension}
import { test, expect } from '@playwright/test';

test.describe('Product', () => {
  test('TC_PRODUCT_01 - ...', async ({ page }) => {
    // test steps
  });
});
\`\`\`
  `;

  console.log(`   Kích thước prompt Generator: ${prompt.length.toLocaleString('vi-VN')} ký tự`);

  // 4. Gọi AI
  const runId = `run_${Date.now()}`;
  const workDir = path.join(process.cwd(), ".testkit", "runs", runId);
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, "task.md"), prompt.trim());

  const adapter = new OpenAIAdapter("llama-3.3-70b-versatile");

  const result = await adapter.run({
    promptDir: workDir,
    workDir,
    timeoutMs: 120000,
  });

  // 5. Trích xuất code và ghi ra thư mục đích
  if (result.ok) {
    const codeMatch = result.rawOutput.match(
      /```(?:typescript|ts|javascript|js)?\n?([\s\S]*?)```/,
    );
    const codeContent = codeMatch
      ? codeMatch[1].trim()
      : result.rawOutput.trim();

    const outDir = getGeneratedTestDirectory(level);
    // E2E là output tạm theo từng kịch bản. Dọn suite cũ để lần chạy kế tiếp
    // không vô tình chạy lại test của website trước đó.
    if (level === "e2e") {
      clearGeneratedE2ESpecs(outDir);
    }
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const displayOutDir = path.relative(process.cwd(), outDir).replace(/\\/g, "/");

    // 6. Tách nhiều file nếu AI dùng marker "// FILE: ..."
    const fileMarkerRegex = /\/\/ FILE:\s*(\S+)/g;
    const markers: { name: string; index: number }[] = [];
    let match;

    while ((match = fileMarkerRegex.exec(codeContent)) !== null) {
      markers.push({ name: match[1], index: match.index });
    }

    if (markers.length > 1) {
      // Trường hợp AI sinh nhiều file → tách ra từng file riêng
      console.log(`\n📂 Phát hiện ${markers.length} file spec, đang tách...`);
      const savedFiles: string[] = [];

      for (let i = 0; i < markers.length; i++) {
        const start = markers[i].index;
        const end = i + 1 < markers.length ? markers[i + 1].index : undefined;
        let fileContent = codeContent.slice(start, end).trim();

        // Lấy tên file từ marker, làm sạch ký tự không hợp lệ cho tên file Windows (< > : " / \ | ? * `)
        let fileName = markers[i].name.replace(/[<>:"/\\|?*`']/g, "").trim();

        // Nếu tên file chứa placeholder mẫu (<name>, tên-file, filename) hoặc timestamp ngẫu nhiên, đổi thành tên tường minh
        if (
          !fileName ||
          /name|tên-file|filename|test_e2e_\d+|run_\d+/i.test(fileName)
        ) {
          fileName = `${targetFileName}_${i + 1}`;
        }

        // Đảm bảo không bị lặp đuôi extension (vd .spec.ts.spec.ts)
        fileName = fileName.replace(/(\.(spec|test))?(\.(ts|js))+$/i, "");
        fileName = `${fileName}${fileExtension}`;
        // Xóa dòng // FILE: ... khỏi nội dung file
        fileContent = fileContent.replace(/^\/\/ FILE:.*\n?/, "").trim();

        // ★ POST-PROCESSING: Sửa lỗi phổ biến trước khi ghi file
        fileContent = fixCommonPlaywrightIssues(fileContent, verifiedActionPlan);

        const filePath = path.join(outDir, fileName);
        fs.writeFileSync(filePath, fileContent + "\n");
        savedFiles.push(filePath);
        console.log(`  ✅ Đã tạo: ${filePath}`);
      }

      console.log(
        `\n✅ Sinh code thành công! ${savedFiles.length} file lưu tại: ${displayOutDir}/`,
      );
    } else {
      // Trường hợp AI chỉ sinh 1 file (hoặc không dùng marker)
      // Xóa dòng "// FILE: ..." nếu có, rồi lưu vào 1 file
      let cleanedContent = codeContent.replace(/^\/\/ FILE:.*\n?/gm, "").trim();

      // ★ POST-PROCESSING: Sửa lỗi phổ biến trước khi ghi file
      cleanedContent = fixCommonPlaywrightIssues(cleanedContent, verifiedActionPlan);

      let cleanTargetName = targetFileName
        .replace(/[<>:"/\\|?*`']/g, "")
        .trim();
      cleanTargetName = cleanTargetName.replace(
        /(\.(spec|test))?(\.(ts|js))+$/i,
        "",
      );

      const filePath = path.join(outDir, `${cleanTargetName}${fileExtension}`);
      fs.writeFileSync(filePath, cleanedContent + "\n");
      console.log(`✅ Đã sinh code thành công! File lưu tại: ${filePath}`);
    }

    return true;
  } else {
    console.error(`❌ Lỗi khi Generator chạy:`, result.rawOutput);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// ★ POST-PROCESSING ENGINE: Tự động sửa các lỗi phổ biến của AI
//   trước khi ghi file — KHÔNG phụ thuộc vào LLM "nghe lời"
// ═══════════════════════════════════════════════════════════════════
function normalizedTestId(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function numericTestSuffix(value: string): string | undefined {
  return value.match(/(\d+)$/)?.[1]?.replace(/^0+(?=\d)/, '');
}

function findPlannedTestCase(id: string, actionPlan: ActionPlan) {
  const exact = actionPlan.testCases.find(testCase =>
    normalizedTestId(testCase.id) === normalizedTestId(id),
  );
  if (exact) return exact;

  const suffix = numericTestSuffix(id);
  if (!suffix) return undefined;
  const candidates = actionPlan.testCases.filter(testCase => numericTestSuffix(testCase.id) === suffix);
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Generator remains an Agent, but its free-form output may not override the
 * Planner/Crawler contract. For complete E2E plans, rebuild each generated
 * test body from verified actions while preserving the LLM-created suite/file
 * structure and readable test title.
 */
export function enforceVerifiedActionPlan(
  code: string,
  actionPlan?: ActionPlan,
): { code: string; changed: boolean } {
  if (!actionPlan) return { code, changed: false };

  const lines = code.split('\n');
  let changed = false;

  for (let start = 0; start < lines.length; start++) {
    if (!/^\s*test\s*\(/.test(lines[start])) continue;
    const generatedId = lines[start].match(/\bTC(?:_[A-Z0-9]+)+\b/i)?.[0];
    if (!generatedId) continue;
    const testCase = findPlannedTestCase(generatedId, actionPlan);
    if (!testCase || testCase.actions.length === 0) continue;

    // A complete script-mode Action Plan starts with navigation. Partial plans
    // used by targeted post-processors must not erase unrelated generated code.
    if (testCase.actions[0].type !== 'goto') continue;

    const startIndent = lines[start].match(/^\s*/)?.[0] || '';
    let end = start + 1;
    for (; end < lines.length; end++) {
      const indent = lines[end].match(/^\s*/)?.[0] || '';
      if (indent === startIndent && /^\s*}\);\s*$/.test(lines[end])) break;
    }
    if (end >= lines.length) continue;

    const bodyIndent = `${startIndent}  `;
    const unresolved = testCase.actions.find(action => action.confidence === 'low');
    const replacement: string[] = [];
    if (unresolved) {
      const reason = `Bước ${unresolved.stepIndex} chưa được Planner/Crawler xác minh`;
      replacement.push(`${bodyIndent}test.fixme(true, '${reason}');`);
    } else {
      for (const action of testCase.actions) {
        if (action.description) {
          const description = action.description.replace(/^[-*•·▪◦–—]\s*/u, '').replace(/[\r\n]+/g, ' ');
          replacement.push(`${bodyIndent}// ${description}`);
        }
        for (const actionLine of action.playwrightCode.split('\n')) {
          if (actionLine.trim()) replacement.push(`${bodyIndent}${actionLine.trim()}`);
        }
      }
    }

    lines.splice(start + 1, end - start - 1, ...replacement);
    changed = true;
    start += replacement.length;
  }

  return { code: lines.join('\n'), changed };
}

function fixPasswordToggleAssertions(code: string): { code: string; changed: boolean } {
  const lines = code.split('\n');
  const testStarts = lines
    .map((line, index) => (/^\s*test\s*\(/.test(line) ? index : -1))
    .filter(index => index >= 0);
  let changed = false;

  for (let testPosition = 0; testPosition < testStarts.length; testPosition++) {
    const start = testStarts[testPosition];
    const end = testStarts[testPosition + 1] ?? lines.length;
    const titleLine = lines[start]
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    if (!/(an\s*\/\s*hien\s+mat\s+khau|icon\s+con\s+mat|password.*visibility|show.*hide.*password)/i.test(titleLine)) {
      continue;
    }

    const fillIndex = lines.findIndex((line, index) =>
      index >= start &&
      index < end &&
      /(?:mat khau|mật khẩu|password)/i.test(line) &&
      /\.fill\(/.test(line),
    );
    if (fillIndex < 0) continue;

    const clickIndices: number[] = [];
    for (let index = fillIndex + 1; index < end; index++) {
      if (/\.click\(/.test(lines[index])) clickIndices.push(index);
    }

    clickIndices.forEach((clickIndex, clickPosition) => {
      const assertionEnd = clickIndices[clickPosition + 1] ?? end;
      const assertionLines = lines.slice(clickIndex + 1, assertionEnd);
      if (assertionLines.some(line => /toHaveAttribute\(\s*['"]type['"]/.test(line))) return;

      const wrongOffset = assertionLines.findIndex(line =>
        /(?:mat khau|mật khẩu|password)/i.test(line) &&
        /\.(?:not\.)?toHaveValue\(/.test(line),
      );
      if (wrongOffset < 0) return;

      const wrongIndex = clickIndex + 1 + wrongOffset;
      const match = lines[wrongIndex].match(/^(\s*)await\s+expect\((.+)\)\.(?:not\.)?toHaveValue\([^;]*\);?\s*$/);
      if (!match) return;

      const expectedType = clickPosition % 2 === 0 ? 'text' : 'password';
      lines[wrongIndex] = `${match[1]}await expect(${match[2]}).toHaveAttribute('type', '${expectedType}');`;
      changed = true;
    });
  }

  return { code: lines.join('\n'), changed };
}

function normalizeForMatching(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd');
}

function isPasswordToggleAction(action: ResolvedAction): boolean {
  if (action.type !== 'click' || action.confidence === 'low') return false;
  const description = normalizeForMatching(action.description);
  return description.includes('con mat') || description.includes('eye') || description.includes('an/hien mat khau');
}

function fixPasswordToggleLocators(
  code: string,
  actionPlan?: ActionPlan,
): { code: string; changed: boolean } {
  if (!actionPlan) return { code, changed: false };

  const lines = code.split('\n');
  const testStarts = lines
    .map((line, index) => (/^\s*test\s*\(/.test(line) ? index : -1))
    .filter(index => index >= 0);
  let changed = false;

  for (let position = 0; position < testStarts.length; position++) {
    const start = testStarts[position];
    const end = testStarts[position + 1] ?? lines.length;
    const id = lines[start].match(/\bTC_\d+\b/i)?.[0].toUpperCase();
    if (!id) continue;

    const testCase = actionPlan.testCases.find(candidate => candidate.id.toUpperCase() === id);
    if (!testCase) continue;
    const verifiedToggleClicks = testCase.actions.filter(isPasswordToggleAction);
    if (verifiedToggleClicks.length === 0) continue;

    const guessedToggleLines: number[] = [];
    const allClickLines: number[] = [];
    for (let index = start + 1; index < end; index++) {
      if (!/\.click\(/.test(lines[index])) continue;
      allClickLines.push(index);
      const normalizedLine = normalizeForMatching(lines[index]);
      if (
        (normalizedLine.includes('con mat') || normalizedLine.includes('eye')) &&
        /(getByRole|getByText|getByLabel)/.test(lines[index])
      ) {
        guessedToggleLines.push(index);
      }
    }

    guessedToggleLines.forEach((lineIndex, clickIndex) => {
      const verifiedAction = verifiedToggleClicks[clickIndex];
      if (!verifiedAction) return;
      const indent = lines[lineIndex].match(/^\s*/)?.[0] || '';
      lines[lineIndex] = `${indent}${verifiedAction.playwrightCode.trim()}`;
      changed = true;
    });

    const plannedClickCount = testCase.actions.filter(action => action.type === 'click').length;
    let extraClickCount = Math.max(0, allClickLines.length - plannedClickCount);
    for (const lineIndex of allClickLines) {
      if (extraClickCount === 0) break;
      const normalizedLine = normalizeForMatching(lines[lineIndex]);
      if (/(passwordinput|mat khau|password).*\.click\(/.test(normalizedLine)) {
        lines[lineIndex] = '';
        extraClickCount--;
        changed = true;
      }
    }
  }

  return { code: lines.join('\n'), changed };
}

export function fixCommonPlaywrightIssues(code: string, actionPlan?: ActionPlan): string {
  let fixed = code;
  const fixes: string[] = [];

  // ── FIX 0: Dọn dẹp lời thoại chat rác (Preamble & Markdown Cleanup) ──
  if (
    /^(Let me|Here is|Below is|Sure, here|I will write|This is)/im.test(
      fixed,
    ) ||
    fixed.includes("```")
  ) {
    fixed = fixed
      .replace(/^(Let me|Here is|Below is|Sure,|I will|This is).*$/gm, "")
      .replace(/```(?:typescript|ts|javascript|js)?/g, "")
      .replace(/```/g, "")
      .trim();
    fixes.push("FIX-0: Dọn dẹp lời thoại rác & markdown code fences từ model");
  }

  const verifiedPlanResult = enforceVerifiedActionPlan(fixed, actionPlan);
  if (verifiedPlanResult.changed) {
    fixed = verifiedPlanResult.code;
    fixes.push('FIX-14: Dựng lại test body từ Planner/Crawler Action Plan đã xác minh');
  }

  const passwordLocatorResult = fixPasswordToggleLocators(fixed, actionPlan);
  if (passwordLocatorResult.changed) {
    fixed = passwordLocatorResult.code;
    fixes.push('FIX-13: Icon ẩn/hiện mật khẩu → locator đã được Crawler xác minh');
  }

  const passwordToggleResult = fixPasswordToggleAssertions(fixed);
  if (passwordToggleResult.changed) {
    fixed = passwordToggleResult.code;
    fixes.push("FIX-12: Ẩn/hiện mật khẩu → kiểm tra type='text'/'password', không kiểm tra value");
  }
  // ── FIX 8: Fix selectOption() on custom dropdowns ──────────────────────
  const selectOptionPattern = /await\s+page\.getByRole\(['"]option['"],\s*\{\s*name:\s*['"](.*?)['"]\s*\}\)\.selectOption\(['"].*?['"]\);?/g;
  if (selectOptionPattern.test(fixed)) {
    fixed = fixed.replace(selectOptionPattern, "await page.getByText('$1').click();");
    fixes.push("FIX-8: getByRole('option').selectOption → getByText().click()");
  }

  // ── FIX 9: Fix strict button name 'Thêm' for '+ Thêm' ─────────────────
  const strictAddButtonPattern = /await\s+page\.getByRole\(['"]button['"],\s*\{\s*name:\s*['"]Thêm['"]\s*\}\)\.click\(\);?/g;
  if (strictAddButtonPattern.test(fixed)) {
    fixed = fixed.replace(strictAddButtonPattern, "await page.getByRole('button', { name: /Thêm/i }).click();");
    fixes.push("FIX-9: getByRole('button', { name: 'Thêm' }) → RegExp /Thêm/i (hỗ trợ nút + Thêm)");
  }

  // ── FIX 10: Strict mode violation fix cho combobox dropdown triggers ──
  const UnscopedFilterPattern = /await\s+page\.locator\(['"]div,\s*span,\s*button['"]\)\.filter\(\{\s*hasText:\s*\/(.*?)\/i?\s*\}\)\.click\(\);?/g;
  if (UnscopedFilterPattern.test(fixed)) {
    fixed = fixed.replace(UnscopedFilterPattern, "await page.getByRole('dialog').getByText('$1').first().click();");
    fixes.push("FIX-10: Scope dropdown trigger vào dialog để tránh 7 elements strict mode violation");
  }

  // ── FIX 11: toContainText trên <input> → toHaveValue (input không có textContent) ──
  // AI hay viết: expect(page.getByPlaceholder('...')).toContainText('...')
  // Đúng:        expect(page.getByPlaceholder('...')).toHaveValue('...')
  const inputContainTextPattern = /await\s+expect\((page\.getByPlaceholder\([^)]+\))\)\.toContainText\((['"][^'"]+['"])\);?/g;
  if (inputContainTextPattern.test(fixed)) {
    fixed = fixed.replace(inputContainTextPattern, "await expect($1).toHaveValue($2);");
    fixes.push("FIX-11: toContainText() trên input → toHaveValue() (input không có textContent)");
  }

  // AI hay viết: expect(page.locator('...').textContent()).toContain('...')
  // Đúng:        await expect(page.locator('...')).toContainText('...')
  const textContentPattern =
    /expect\((.*?)\.textContent\(\)\)\.toContain\(('.*?')\)/g;
  if (textContentPattern.test(fixed)) {
    fixed = fixed.replace(
      textContentPattern,
      "await expect($1).toContainText($2)",
    );
    fixes.push("FIX-1: .textContent().toContain() → .toContainText()");
  }

  // Variant: expect(await locator.textContent()).toContain(...)
  const awaitTextContentPattern =
    /expect\(await\s+(.*?)\.textContent\(\)\)\.toContain\(('.*?')\)/g;
  if (awaitTextContentPattern.test(fixed)) {
    fixed = fixed.replace(
      awaitTextContentPattern,
      "await expect($1).toContainText($2)",
    );
    fixes.push("FIX-1b: expect(await .textContent()) → .toContainText()");
  }

  // ── FIX 2: Strict mode — thêm .first() cho selector khớp nhiều element ──
  const multiElementSelectors = [
    ".oxd-input-group__message",
    ".oxd-input-field-error-message",
    ".invalid-feedback",
    ".error-message",
    ".help-block",
    ".alert-danger",
  ];

  // ── FIX 6: [role="alert"] → dùng getByText() thay vì locator (tránh conflict với __next-route-announcer__) ──
  const roleAlertPattern =
    /await\s+expect\(page\.locator\(\s*['"`]\[role=["']?alert["']?\]['"`]\s*\)\)\.toContainText\(\s*(['"`])(.*?)\1\s*\)/g;
  if (roleAlertPattern.test(fixed)) {
    fixed = fixed.replace(
      roleAlertPattern,
      "await expect(page.getByText($1$2$1)).toBeVisible()",
    );
    fixes.push(
      "FIX-6: locator('[role=alert]').toContainText → getByText().toBeVisible() (tránh strict mode với __next-route-announcer__)",
    );
  }

  for (const sel of multiElementSelectors) {
    // Pattern: page.locator('sel') KHÔNG theo sau bởi .first()/.nth()/.last()
    const escapedSel = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const strictPattern = new RegExp(
      `(page\\.locator\\(['"\`]${escapedSel}['"\`]\\))(?!\\s*\\.(first|nth|last|filter|and)\\()`,
      "g",
    );
    if (strictPattern.test(fixed)) {
      fixed = fixed.replace(strictPattern, "$1.first()");
      fixes.push(`FIX-2: '${sel}' → thêm .first() tránh strict mode violation`);
    }
  }

  // ── FIX 3: Logout ẩn trong dropdown ─────────────────────────────
  // AI hay viết: page.getByText('Logout').click() hoặc getByRole('link', { name: 'Logout' }).click()
  // Đúng: click dropdown trước → rồi mới click Logout
  const logoutPatterns = [
    /await\s+page\.getByText\(['"`]Logout['"`]\)\.click\(\)/g,
    /await\s+page\.getByRole\(['"`]link['"`],\s*\{\s*name:\s*['"`]Logout['"`]\s*\}\)\.click\(\)/g,
    /await\s+page\.locator\(['"`][^'"]*[Ll]ogout[^'"]*['"`]\)\.click\(\)/g,
  ];

  for (const pattern of logoutPatterns) {
    if (pattern.test(fixed)) {
      fixed = fixed.replace(
        pattern,
        `await page.locator('.oxd-userdropdown-tab').click();\n    await page.getByRole('menuitem', { name: 'Logout' }).click()`,
      );
      fixes.push(
        "FIX-3: Logout ẩn trong dropdown → thêm bước click dropdown trước",
      );
    }
  }

  // ── FIX 4: toHaveURL đoán mò dashboard → not.toHaveURL(login/dang-nhap) ──
  // AI hay đoán: toHaveURL(/.*dashboard.*/i) hoặc toHaveURL('.../dashboard')
  // Đúng cho mọi trang: expect(page).not.toHaveURL(/.*(dang-nhap|login).*/i)
  const dashboardUrlPattern =
    /\.toHaveURL\(\s*(\/.*dashboard.*\/i|['"`].*dashboard.*['"`])\s*\)/g;
  if (dashboardUrlPattern.test(fixed)) {
    fixed = fixed.replace(
      dashboardUrlPattern,
      ".not.toHaveURL(/.*(dang-nhap|login).*/i)",
    );
    fixes.push(
      "FIX-4: toHaveURL(/.*dashboard.*/) → .not.toHaveURL(/.*(dang-nhap|login).*/i) (Tự động phát hiện rời trang login)",
    );
  }

  // ── FIX 5: Thiếu await trước expect() ──────────────────────────
  // AI hay viết: expect(page.locator('...')).toContainText('...');
  // Đúng: await expect(page.locator('...')).toContainText('...');
  const missingAwaitPattern =
    /(?<!\bawait\s)expect\((page\.[^)]+)\)\.(toContainText|toHaveText|toHaveURL|toBeVisible|toBeHidden|toBeEnabled|toBeDisabled|toHaveValue|toHaveAttribute)\(/g;
  if (missingAwaitPattern.test(fixed)) {
    fixed = fixed.replace(missingAwaitPattern, "await expect($1).$2(");
    fixes.push("FIX-5: Thiếu await trước expect() → đã thêm");
  }

  // Log các fix đã áp dụng
  if (fixes.length > 0) {
    console.log(
      `\n🔧 [Post-Processing] Đã tự động sửa ${fixes.length} lỗi phổ biến:`,
    );
    fixes.forEach((f) => console.log(`   → ${f}`));
  }

  return fixed;
}
