import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { OpenAIAdapter } from "../../adapters/openai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  let sourceScript = '';
  if (level === 'e2e' && fs.existsSync('artifacts/source-script-e2e.md')) {
    sourceScript = fs.readFileSync('artifacts/source-script-e2e.md', 'utf-8');
  }

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
  if (fs.existsSync("artifacts/crawled-dom.md")) {
    crawledDomData =
      `\n\n[BÁO CÁO CRAWLED DOM THỰC TẾ - BẮT BUỘC DÙNG CHÍNH XÁC CÁC LOCATOR NÀY]:\n` +
      fs.readFileSync("artifacts/crawled-dom.md", "utf-8");
  }

  const prompt = `
${systemPrompt}

Bạn là chuyên gia tự động hóa kiểm thử. Dựa vào bản Test Plan dưới đây, hãy viết code test hoàn chỉnh bằng ${framework}.

[TEST PLAN]:
${testPlan}
${crawledDomData}

${sourceScript ? `[KỊCH BẢN GỐC - NGUỒN SỰ THẬT CHO THỨ TỰ BƯỚC, TEST DATA VÀ ASSERTION]:\n${sourceScript}` : ''}

[QUY TẮC QUAN TRỌNG - PHẢI TUÂN THỦ TUYỆT ĐỐI]:
1. Kịch bản gốc quyết định chính xác thứ tự bước, dữ liệu nhập và assertion; Test Plan chỉ bổ sung ý nghĩa nghiệp vụ.
2. Locator chỉ được lấy từ role/name/placeholder/label hoặc cột Verified selector có trong báo cáo DOM.
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

    const outDir = path.join(process.cwd(), "tests", level);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

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
        fileContent = fixCommonPlaywrightIssues(fileContent);

        const filePath = path.join(outDir, fileName);
        fs.writeFileSync(filePath, fileContent + "\n");
        savedFiles.push(filePath);
        console.log(`  ✅ Đã tạo: ${filePath}`);
      }

      console.log(
        `\n✅ Sinh code thành công! ${savedFiles.length} file lưu tại: tests/${level}/`,
      );
    } else {
      // Trường hợp AI chỉ sinh 1 file (hoặc không dùng marker)
      // Xóa dòng "// FILE: ..." nếu có, rồi lưu vào 1 file
      let cleanedContent = codeContent.replace(/^\/\/ FILE:.*\n?/gm, "").trim();

      // ★ POST-PROCESSING: Sửa lỗi phổ biến trước khi ghi file
      cleanedContent = fixCommonPlaywrightIssues(cleanedContent);

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
function fixCommonPlaywrightIssues(code: string): string {
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
