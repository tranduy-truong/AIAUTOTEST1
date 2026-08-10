import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildCompactDomReport, runLive } from "../crawler/live-runner.js";
import { runGenerator } from "../generator/run.js";
import { buildActionPlan } from "../../core/action-plan.js";
import { parseScript, validateParsedScript } from "../../core/step-parser.js";

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
  recoveryAction: 'RECRAWL_FAILED_STATE' | 'REPLAY_AUTH_FLOW' | 'WAIT_FOR_OBSERVED_STATE' | 'REPORT_ONLY';
  failedLine?: number;
}

function failedLineFromLog(errorLog: string): number | undefined {
  const matches = [...errorLog.matchAll(/\.spec\.[jt]s:(\d+)(?::\d+)?/gi)];
  const last = matches.at(-1)?.[1];
  return last ? Number(last) : undefined;
}

function targetNameFromLog(errorLog: string): string {
  const match = errorLog.match(/tests[\\/]e2e[\\/](?:generated[\\/])?([^\s:]+?)\.spec\.[jt]s/i);
  return match?.[1] || 'healed_e2e';
}

async function recoverVerifiedE2E(errorLog: string): Promise<{
  ok: boolean;
  reason: string;
}> {
  const sourcePath = 'artifacts/source-script-e2e.md';
  if (!fs.existsSync(sourcePath)) {
    return { ok: false, reason: 'MISSING_SOURCE_SCRIPT' };
  }

  const parsedCases = parseScript(fs.readFileSync(sourcePath, 'utf-8'));
  const parserIssues = validateParsedScript(parsedCases);
  if (parsedCases.length === 0 || parserIssues.length > 0) {
    return { ok: false, reason: 'SOURCE_SCRIPT_NOT_FULLY_PARSED' };
  }

  const snapshotsMap = await runLive(parsedCases);
  fs.writeFileSync('artifacts/crawled-dom.md', buildCompactDomReport(snapshotsMap));
  const actionPlan = buildActionPlan(parsedCases, snapshotsMap);
  const unresolved = actionPlan.testCases.flatMap(testCase =>
    testCase.actions
      .filter(action => action.confidence === 'low')
      .map(action => ({
        testCaseId: testCase.id,
        stepIndex: action.stepIndex,
        description: action.description,
      })),
  );
  if (unresolved.length > 0) {
    fs.writeFileSync(
      'artifacts/healer-unresolved-actions.json',
      JSON.stringify(unresolved, null, 2) + '\n',
    );
    return { ok: false, reason: 'RECRAWL_STILL_HAS_UNRESOLVED_ACTIONS' };
  }

  const generated = await runGenerator('e2e', targetNameFromLog(errorLog));
  return {
    ok: generated,
    reason: generated ? 'VERIFIED_ACTION_PLAN_REGENERATED' : 'GENERATOR_FAILED',
  };
}

export function classifyFailure(errorLog: string): HealerDiagnosis {
  const normalized = errorLog
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd');
  const failedLine = failedLineFromLog(errorLog);

  if (
    /((current|page)\s*url.*(dang-nhap|\/login)|redirect.*(dang-nhap|login)|authentication|unauthorized|status\s*401)/.test(normalized) &&
    /(waiting for|locator\.|timeout|expected)/.test(normalized)
  ) {
    return {
      category: 'AUTHENTICATION_ERROR',
      reasonCode: 'AUTH_STATE_NOT_READY_OR_EXPIRED',
      confidence: 'high',
      canSelfHeal: true,
      preservesExpectedResult: true,
      recoveryAction: 'REPLAY_AUTH_FLOW',
      failedLine,
    };
  }
  if (/waitforurl|waitforloadstate|networkidle|page load|navigation timeout/.test(normalized)) {
    return {
      category: 'TIMING_OR_ASYNC',
      reasonCode: 'OBSERVED_STATE_NOT_READY',
      confidence: 'high',
      canSelfHeal: true,
      preservesExpectedResult: true,
      recoveryAction: 'WAIT_FOR_OBSERVED_STATE',
      failedLine,
    };
  }

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
      recoveryAction: 'RECRAWL_FAILED_STATE',
      failedLine,
    };
  }
  if (/strict mode violation|waiting for .*locator|locator\.(click|fill): test timeout/.test(normalized)) {
    return {
      category: 'LOCATOR_CHANGED',
      reasonCode: 'LOCATOR_NOT_UNIQUE_OR_NOT_FOUND',
      confidence: 'high',
      canSelfHeal: true,
      preservesExpectedResult: true,
      recoveryAction: 'RECRAWL_FAILED_STATE',
      failedLine,
    };
  }
  if (/econnrefused|enotfound|dns|net::err_|request failed|response status 5\d\d/.test(normalized)) {
    return {
      category: 'NETWORK_ERROR',
      reasonCode: 'NETWORK_OR_BACKEND_UNAVAILABLE',
      confidence: 'medium',
      canSelfHeal: false,
      preservesExpectedResult: true,
      recoveryAction: 'REPORT_ONLY',
      failedLine,
    };
  }
  if (/expect\(.*\).*failed|expected:|received:|assertionerror/.test(normalized)) {
    return {
      category: 'ASSERTION_ERROR',
      reasonCode: 'ACTUAL_DIFFERS_FROM_PLANNED_EXPECTATION',
      confidence: 'medium',
      canSelfHeal: false,
      preservesExpectedResult: true,
      recoveryAction: 'REPORT_ONLY',
      failedLine,
    };
  }

  return {
    category: 'UNKNOWN',
    reasonCode: 'NEED_MORE_EVIDENCE',
    confidence: 'low',
    canSelfHeal: false,
    preservesExpectedResult: true,
    recoveryAction: 'REPORT_ONLY',
    failedLine,
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

  let recovery: { ok: boolean; reason: string } | undefined;
  if (level === 'e2e' && diagnosis.canSelfHeal) {
    console.log('   Healer đang replay kịch bản và crawl lại đúng trạng thái lỗi...');
    try {
      recovery = await recoverVerifiedE2E(errorLog);
    } catch (error) {
      recovery = {
        ok: false,
        reason: `RECOVERY_ERROR: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
    fs.writeFileSync(
      'artifacts/healer-recovery.json',
      JSON.stringify({
        attemptedAt: new Date().toISOString(),
        action: diagnosis.recoveryAction,
        ...recovery,
      }, null, 2) + '\n',
    );
    console.log(
      recovery.ok
        ? '   Healer đã tái tạo test từ Action Plan được xác minh.'
        : `   Healer dừng an toàn: ${recovery.reason}`,
    );
  }
  return true;
}
