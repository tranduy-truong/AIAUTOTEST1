import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildCompactDomReport, runLive } from "../crawler/live-runner.js";
import { runGenerator } from "../generator/run.js";
import { loadStructuredE2EPlan } from "../planner/run.js";
import { plannerPlanToTestCases } from "../planner/schema.js";
import { buildActionPlan } from "../../core/action-plan.js";
import { loadUnitSession } from '../../core/unit/artifacts.js';
import { artifact, detail, section, warning } from '../../core/cli-ui.js';

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
  const matches = [...errorLog.matchAll(/\.(?:spec|test)\.[jt]sx?:(\d+)(?::\d+)?/gi)];
  const last = matches.at(-1)?.[1];
  return last ? Number(last) : undefined;
}

export function classifyUnitFailure(errorLog: string): HealerDiagnosis {
  const normalized = errorLog
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd');
  const failedLine = failedLineFromLog(errorLog);

  if (/spawnsync .* einval|spawn .* einval|spawn .* enoent|is not recognized as an internal or external command/.test(normalized)) {
    return {
      category: 'ENVIRONMENT_ERROR',
      reasonCode: 'UNIT_TEST_RUNNER_LAUNCH_FAILED',
      confidence: 'high', canSelfHeal: false, preservesExpectedResult: true,
      recoveryAction: 'REPORT_ONLY', failedLine,
    };
  }

  if (/cannot find module|failed to resolve import|module not found|err_module_not_found|cannot find package/.test(normalized)) {
    return {
      category: 'TEST_SCRIPT_BUG',
      reasonCode: 'IMPORT_OR_ALIAS_NOT_RESOLVED',
      confidence: 'high', canSelfHeal: false, preservesExpectedResult: true,
      recoveryAction: 'REPORT_ONLY', failedLine,
    };
  }
  if (/cannot access .* before initialization|mock factory|vi\.mock|jest\.mock|hoist/.test(normalized)) {
    return {
      category: 'TEST_SCRIPT_BUG',
      reasonCode: 'MOCK_SETUP_OR_HOISTING_ERROR',
      confidence: 'high', canSelfHeal: false, preservesExpectedResult: true,
      recoveryAction: 'REPORT_ONLY', failedLine,
    };
  }
  if (/no test files found|no tests found|test suite must contain at least one test/.test(normalized)) {
    return {
      category: 'TEST_SCRIPT_BUG',
      reasonCode: 'TEST_DISCOVERY_CONFIGURATION_ERROR',
      confidence: 'high', canSelfHeal: false, preservesExpectedResult: true,
      recoveryAction: 'REPORT_ONLY', failedLine,
    };
  }
  if (/err_invalid_arg_type|argument must be of type .* received undefined|path.*received undefined/.test(normalized)) {
    return {
      category: 'TEST_SCRIPT_BUG',
      reasonCode: 'GENERATED_INPUT_FIXTURE_INVALID',
      confidence: 'high', canSelfHeal: false, preservesExpectedResult: true,
      recoveryAction: 'REPORT_ONLY', failedLine,
    };
  }
  if (/timed out|timeout|exceeded timeout/.test(normalized)) {
    return {
      category: 'TIMING_OR_ASYNC',
      reasonCode: 'UNIT_ASYNC_DID_NOT_SETTLE',
      confidence: 'medium', canSelfHeal: false, preservesExpectedResult: true,
      recoveryAction: 'REPORT_ONLY', failedLine,
    };
  }
  if (/expected:|received:|assertionerror|expected .* to (?:be|equal|throw|match)/.test(normalized)) {
    return {
      category: 'ASSERTION_ERROR',
      reasonCode: 'IMPLEMENTATION_DIFFERS_FROM_PLANNED_ORACLE',
      confidence: 'high', canSelfHeal: false, preservesExpectedResult: true,
      recoveryAction: 'REPORT_ONLY', failedLine,
    };
  }
  if (/econnrefused|enotfound|network|database|connection refused/.test(normalized)) {
    return {
      category: 'TEST_DATA_ERROR',
      reasonCode: 'UNMOCKED_EXTERNAL_DEPENDENCY',
      confidence: 'medium', canSelfHeal: false, preservesExpectedResult: true,
      recoveryAction: 'REPORT_ONLY', failedLine,
    };
  }
  return {
    category: 'UNKNOWN', reasonCode: 'UNIT_NEEDS_MORE_EVIDENCE', confidence: 'low',
    canSelfHeal: false, preservesExpectedResult: true, recoveryAction: 'REPORT_ONLY', failedLine,
  };
}

function targetNameFromLog(errorLog: string): string {
  const match = errorLog.match(/tests[\\/]e2e[\\/](?:generated[\\/])?([^\s:]+?)\.spec\.[jt]s/i);
  return match?.[1] || 'healed_e2e';
}

async function recoverVerifiedE2E(errorLog: string): Promise<{
  ok: boolean;
  reason: string;
}> {
  const planPath = 'artifacts/test-plan-e2e.json';
  if (!fs.existsSync(planPath)) {
    return { ok: false, reason: 'MISSING_STRUCTURED_PLAN' };
  }

  let parsedCases: ReturnType<typeof plannerPlanToTestCases>;
  try {
    parsedCases = plannerPlanToTestCases(loadStructuredE2EPlan(planPath));
  } catch {
    return { ok: false, reason: 'STRUCTURED_PLAN_INVALID' };
  }
  if (parsedCases.length === 0) {
    return { ok: false, reason: 'STRUCTURED_PLAN_HAS_NO_TEST_CASES' };
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
  section('03', 'Healer', 'Phân loại nguyên nhân; không tự đổi expected result');

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

  const diagnosis = level === 'unit' ? classifyUnitFailure(errorLog) : classifyFailure(errorLog);
  if (!fs.existsSync('artifacts')) fs.mkdirSync('artifacts');
  fs.writeFileSync(
    'artifacts/healer-diagnosis.json',
    JSON.stringify({
      level,
      diagnosedAt: new Date().toISOString(),
      ...diagnosis,
    }, null, 2) + '\n',
  );
  if (level === 'unit') {
    try {
      const session = loadUnitSession();
      fs.writeFileSync(
        path.join(session.runDirectory, 'healer-diagnosis.json'),
        JSON.stringify({ level, diagnosedAt: new Date().toISOString(), policy: 'diagnose-only', ...diagnosis }, null, 2) + '\n',
      );
    } catch {
      // Global artifact above remains available when there is no Unit session.
    }
  }
  const diagnosisLabels: Record<string, string> = {
    GENERATED_INPUT_FIXTURE_INVALID: 'Dữ liệu đầu vào do Generator tạo chưa đúng kiểu',
    IMPLEMENTATION_DIFFERS_FROM_PLANNED_ORACLE: 'Kết quả thực tế khác expected đã lập',
    IMPORT_OR_ALIAS_NOT_RESOLVED: 'Import hoặc alias của dự án chưa được resolve',
    UNIT_TEST_RUNNER_LAUNCH_FAILED: 'Không khởi chạy được test runner',
    UNIT_ASYNC_DID_NOT_SETTLE: 'Tác vụ bất đồng bộ không hoàn tất đúng hạn',
    UNIT_NEEDS_MORE_EVIDENCE: 'Chưa đủ dữ liệu để kết luận nguyên nhân',
  };
  warning(diagnosisLabels[diagnosis.reasonCode] || diagnosis.category);
  detail('Mã chẩn đoán', diagnosis.reasonCode);
  detail('Chính sách', diagnosis.canSelfHeal ? 'Có thể sửa test nhưng giữ nguyên expected.' : 'Chỉ chẩn đoán, không tự đổi expected.');
  artifact('Chi tiết kỹ thuật', 'healer-diagnosis.json');

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
