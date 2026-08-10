import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type FailureCategory =
  | 'PRODUCT_BUG'
  | 'TEST_SCRIPT_BUG'
  | 'LOCATOR_CHANGED'
  | 'TIMING_OR_ASYNC'
  | 'TEST_DATA_ERROR'
  | 'ENVIRONMENT_ERROR'
  | 'NETWORK_ERROR'
  | 'ASSERTION_ERROR'
  | 'AUTHENTICATION_ERROR'
  | 'UNKNOWN';

export interface HealerDiagnosis {
  category: FailureCategory;
  reasonCode: string;
  confidence: 'high' | 'medium' | 'low';
  canSelfHeal: boolean;
  preservesExpectedResult: boolean;
}

export function classifyFailure(errorLog: string): HealerDiagnosis {
  const normalized = errorLog
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd');

  if (
    normalized.includes("locator('body')") &&
    /(ca\s*(2|hai).*thong bao|dong thoi|ca .* lan .* va)/i.test(normalized)
  ) {
    return {
      category: 'TEST_SCRIPT_BUG',
      reasonCode: 'SEMANTIC_ASSERTION_NOT_SPLIT',
      confidence: 'high',
      canSelfHeal: true,
      preservesExpectedResult: true,
    };
  }
  if (/strict mode violation|waiting for .*locator|locator\.(click|fill): test timeout/.test(normalized)) {
    return {
      category: 'LOCATOR_CHANGED',
      reasonCode: 'LOCATOR_NOT_UNIQUE_OR_NOT_FOUND',
      confidence: 'high',
      canSelfHeal: true,
      preservesExpectedResult: true,
    };
  }
  if (/econnrefused|enotfound|dns|net::err_|request failed|response status 5\d\d/.test(normalized)) {
    return {
      category: 'NETWORK_ERROR',
      reasonCode: 'NETWORK_OR_BACKEND_UNAVAILABLE',
      confidence: 'medium',
      canSelfHeal: false,
      preservesExpectedResult: true,
    };
  }
  if (/expect\(.*\).*failed|expected:|received:|assertionerror/.test(normalized)) {
    return {
      category: 'ASSERTION_ERROR',
      reasonCode: 'ACTUAL_DIFFERS_FROM_PLANNED_EXPECTATION',
      confidence: 'medium',
      canSelfHeal: false,
      preservesExpectedResult: true,
    };
  }

  return {
    category: 'UNKNOWN',
    reasonCode: 'NEED_MORE_EVIDENCE',
    confidence: 'low',
    canSelfHeal: false,
    preservesExpectedResult: true,
  };
}

export async function runHealer(
  level: "unit" | "integration" | "e2e",
  errorLog: string,
) {
  console.log(
    `\n🩺 [Healer Agent] Đang chẩn đoán lỗi cho tầng: ${level.toUpperCase()}`,
  );

  const promptFileName = `prompt-${level}.md`;
  const promptFilePath = path.join(__dirname, promptFileName);

  let systemPrompt = "";
  if (fs.existsSync(promptFilePath)) {
    systemPrompt = fs.readFileSync(promptFilePath, "utf-8");
  } else {
    console.error(
      `❌ Không tìm thấy file kịch bản của Healer: ${promptFilePath}`,
    );
    return false;
  }

  const diagnosis = classifyFailure(errorLog);
  if (!fs.existsSync('artifacts')) fs.mkdirSync('artifacts');
  fs.writeFileSync(
    'artifacts/healer-diagnosis.json',
    JSON.stringify({
      level,
      diagnosedAt: new Date().toISOString(),
      ...diagnosis,
    }, null, 2) + '\n',
  );
  console.log(`   Phân loại: ${diagnosis.category} (${diagnosis.reasonCode})`);
  console.log(
    diagnosis.canSelfHeal
      ? '   Healer có thể sửa test nhưng phải giữ nguyên Expected Result từ Planner.'
      : '   Healer không tự đổi Expected Result; cần thêm bằng chứng hoặc xác nhận product bug.',
  );
  return true;
}
