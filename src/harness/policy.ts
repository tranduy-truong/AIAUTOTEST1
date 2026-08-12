import fs from "fs";
import path from "path";
import { OpenAIAdapter } from "../adapters/openai.js";

export class TestPolicyHarness {
  ai: OpenAIAdapter;

  constructor() {
    this.ai = new OpenAIAdapter("llama-3.3-70b-versatile");
  }

  async handleTestFailure(
    level: string,
    suiteName: string,
    errorMessage: string,
  ) {
    const isDiagnoseOnly = level === "unit" || level === "integration";
    const mode = isDiagnoseOnly ? "Diagnose-Only" : "Auto-Fix";
    const actionTaken = isDiagnoseOnly
      ? "Chẩn đoán nguyên nhân gốc rễ (Không tự sửa code để tránh che giấu bug thật)"
      : "Phân tích log và đề xuất bản vá code";

    const prompt = `Bạn là chuyên gia Automation Testing.

Phân tích lỗi sau từ bộ test [${level.toUpperCase()}] - Suite: ${suiteName}
Chế độ xử lý: ${mode} (${isDiagnoseOnly ? "CHỈ CHẨN ĐOÁN LỖI NGHIỆP VỤ - KHÔNG SỬA CODE TEST KHI CHƯA XÁC NHẬN" : "TỰ ĐỘNG ĐỀ XUẤT VÁ CODE"})

=== LOG LỖI ===
${errorMessage}
===============

Hãy trả lời theo đúng cấu trúc sau:

## 1. Nguyên nhân gốc rễ
[Giải thích rõ ràng lỗi xảy ra do đâu - là Bug logic thật hay do Test code lỗi thời?]

## 2. Phân tích chi tiết
[Phân tích từng dòng lỗi quan trọng]

## 3. Khuyến nghị cho Developer
[Hướng dẫn từng bước kiểm tra và sửa lỗi logic]

${isDiagnoseOnly ? "## 4. Cảnh báo Regression\n[Cảnh báo nếu đây là lỗi logic nghiệp vụ nghiêm trọng]" : "## 4. Code đề xuất (nếu có)\nLƯU Ý KHI SỬA CODE: BẮT BUỘC dùng Web-First Assertions: `await expect(locator).toContainText('...')`. TUYỆT ĐỐI CẤM dùng `expect(locator.textContent()).toContain('...')` vì gọi textContent() bất đồng bộ chưa await trong expect() sẽ gây lỗi TypeError: received is not iterable.\n```typescript\n[Đoạn code đã được vá/sửa]\n```"}

## 5. Khuyến nghị phòng ngừa
[Các best practice để tránh lỗi tương tự]`;

    // Cô lập tiến trình (Harness Engineering)
    const runId = `heal_${Date.now()}`;
    const workDir = path.join(process.cwd(), ".testkit", "runs", runId);
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, "task.md"), prompt);

    // Gọi AI Adapter bằng hàm .run()
    const result = await this.ai.run({
      promptDir: workDir,
      workDir,
      timeoutMs: 120000,
    });

    return {
      mode,
      actionTaken,
      rawErrorLog: errorMessage,
      report: result.ok
        ? result.rawOutput
        : `Lỗi khi gọi AI chẩn đoán: ${result.rawOutput}`,
      patch: "",
    };
  }
}
