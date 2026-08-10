import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { OpenAIAdapter } from "../../adapters/openai.js";
//import { OllamaAdapter } from "../../adapters/ollama.js";

// Lấy đường dẫn thư mục hiện tại của file run.ts
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseJsonArray(rawOutput: string): unknown[] | null {
  const withoutFence = rawOutput
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(withoutFence);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function runPlanner(
  level: "unit" | "integration" | "e2e",
  contextData: string,
) {
  console.log(
    `\n🧠 [Planner Agent] Đang lập kế hoạch kiểm thử cho tầng: ${level.toUpperCase()}`,
  );

  // 1. ĐỌC PROMPT TỪ FILE .md CỦA BẠN THAY VÌ HARDCODE
  const promptFileName = `prompt-${level}.md`;
  const promptFilePath = path.join(__dirname, promptFileName);

  let systemPrompt = "";
  if (fs.existsSync(promptFilePath)) {
    systemPrompt = fs.readFileSync(promptFilePath, "utf-8");
  } else {
    console.error(`❌ Không tìm thấy file kịch bản: ${promptFilePath}`);
    console.log(`👉 Bạn cần tạo file này chứa luật cho AI trước khi chạy!`);
    return false;
  }

  // 2. Ghép kịch bản (systemPrompt) với dữ liệu thực tế (contextData)
  const outputRequirement = level === 'e2e'
    ? '- Giữ đúng định dạng bảng Test Plan được quy định trong prompt Planner E2E.'
    : '- Chỉ xuất ra mảng JSON hợp lệ đúng schema được quy định trong prompt.';

  const taskContent = `
${systemPrompt}

---
⚠️ LƯU Ý QUAN TRỌNG: Phần "Ví dụ" ở trên chỉ là THAM KHẢO ĐỊNH DẠNG. 
TUYỆT ĐỐI KHÔNG dùng URL, dữ liệu, hay tên trang web trong ví dụ đó.
Bạn PHẢI sử dụng ĐÚNG thông tin thực tế từ mục [THÔNG TIN THỰC TẾ CỦA NGƯỜI DÙNG] bên dưới.
---

[THÔNG TIN THỰC TẾ CỦA NGƯỜI DÙNG - ĐÂY LÀ MỤC TIÊU THẬT SỰ]
${contextData}

[YÊU CẦU ĐẦU RA]
- Sinh test case dựa 100% trên thông tin thực tế ở trên.
- KHÔNG sử dụng bất kỳ thông tin nào từ ví dụ minh họa (saucedemo, standard_user, secret_sauce, v.v.).
${outputRequirement}
- KHÔNG GIẢI THÍCH GÌ THÊM ngoài định dạng đầu ra được yêu cầu.
  `;

  // ... (Phần code bên dưới giữ nguyên như cũ: tạo workDir, gọi adapter, xuất file JSON)
  const runId = `run_${Date.now()}`;
  const workDir = path.join(process.cwd(), ".testkit", "runs", runId);
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, "task.md"), taskContent.trim());

  const adapter = new OpenAIAdapter("llama-3.3-70b-versatile");

  const result = await adapter.run({
    promptDir: workDir,
    workDir,
    timeoutMs: 120000,
  });
  //const adapter = new OllamaAdapter("qwen2.5-coder");
  //const result = await adapter.run({
  //  promptDir: workDir,
  // workDir,
  // timeoutMs: 120000,
  //});

  if (result.ok) {
    if (!fs.existsSync("artifacts")) fs.mkdirSync("artifacts");

    let planPath = '';
    if (level === 'e2e') {
      planPath = 'artifacts/test-plan-e2e.md';
      fs.writeFileSync(planPath, result.rawOutput.trim() + '\n');
    } else {
      const parsedPlan = parseJsonArray(result.rawOutput);
      if (!parsedPlan) {
        const invalidPath = `artifacts/test-plan-${level}.invalid.txt`;
        fs.writeFileSync(invalidPath, result.rawOutput.trim() + '\n');
        console.error(`❌ Planner không trả về JSON hợp lệ. Đã lưu output để kiểm tra tại ${invalidPath}`);
        return false;
      }
      planPath = `artifacts/test-plan-${level}.json`;
      fs.writeFileSync(planPath, JSON.stringify(parsedPlan, null, 2) + '\n');
    }

    console.log(
      `✅ Đã lập xong kế hoạch! Lưu tại: ${planPath}`,
    );
    return true;
  } else {
    console.error(`❌ Lỗi khi Planner chạy:`, result.rawOutput);
    return false;
  }
}
