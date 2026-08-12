import inquirer from "inquirer";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { TestPolicyHarness } from "./harness/policy.js";

import { loadStructuredE2EPlan, runPlanner } from "./agents/planner/run.js";
import { runGenerator } from "./agents/generator/run.js";
import { runUnitGenerator } from "./agents/generator/unit-generator.js";
import { runHealer } from "./agents/healer/run.js";
import { plannerPlanToTestCases } from "./agents/planner/schema.js";
import { buildActionPlan } from "./core/action-plan.js";
import { buildCompactDomReport, runLive } from "./agents/crawler/live-runner.js";
import { analyzeUnitInput, createUnitSession } from "./core/unit/artifacts.js";
import { runLastGeneratedUnitTests, summarizeUnitRunOutput } from "./core/unit/runner.js";
import { runUnitCoverageGuidedLoop } from "./agents/planner/unit-coverage-loop.js";
import {
  applyUnitOracleConfirmations,
  formatExpectedForTester,
  formatInputsForTester,
  humanizeUnitTarget,
  loadPendingUnitOracleRequests,
  parseTesterDataValue,
} from "./core/unit/oracle/oracle-confirmation.js";
import {
  artifact,
  detail,
  error as uiError,
  header,
  menuChoice,
  paint,
  profile,
  section,
  success,
  summary,
  warning,
} from "./core/cli-ui.js";

const harness = new TestPolicyHarness();

// 1. MENU CHÍNH CỦA ỨNG DỤNG
async function mainMenu() {
  console.clear();
  header();

  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: "Chọn chức năng",
      choices: [
        {
          name: menuChoice("01", "Lên kế hoạch & sinh test", "Planner → Generator"),
          value: "plan_and_generate",
        },
        {
          name: menuChoice("02", "Chạy E2E", "Playwright • giao diện"),
          value: "run_e2e",
        },
        {
          name: menuChoice("03", "Chạy Integration", "API • database"),
          value: "run_integration",
        },
        {
          name: menuChoice("04", "Chạy Unit Test", "Vitest • logic nội bộ"),
          value: "run_unit",
        },
        {
          name: menuChoice("05", "Xác nhận kết quả Unit", "Tiếp tục phiên đang chờ"),
          value: "review_unit_oracles",
        },
        {
          name: menuChoice("06", "Xem báo cáo", "Kết quả gần nhất"),
          value: "view_report",
        },
        { name: menuChoice("07", "Thoát", "Đóng ứng dụng"), value: "exit" },
      ],
    },
  ]);

  switch (action) {
    case "plan_and_generate":
      await handlePlanAndGenerate();
      break;
    case "run_e2e":
      await runTests("e2e");
      break;
    case "run_integration":
      await runTests("integration");
      break;
    case "run_unit":
      await runTests("unit");
      break;
    case "review_unit_oracles":
      await reviewPendingUnitOracles({ askToStart: false });
      await returnToMenu();
      return;
    case "view_report":
      showReport();
      break;
    case "exit":
      process.exit(0);
  }
}

// 2. TÍNH NĂNG: GỌI PLANNER LÊN KẾ HOẠCH & GENERATOR SINH CODE
async function handlePlanAndGenerate() {
  // Chọn tầng kiểm thử
  const { level } = await inquirer.prompt([
    {
      type: "list",
      name: "level",
      message: "Bạn muốn sinh test case cho tầng nào?",
      choices: [
        { name: "E2E (Kiểm thử luồng giao diện - Blackbox)", value: "e2e" },
        {
          name: "Integration (Kiểm thử API/Tích hợp - Greybox)",
          value: "integration",
        },
        {
          name: "Unit (Kiểm thử hàm/component nội bộ - Whitebox)",
          value: "unit",
        },
      ],
    },
  ]);

  // Cấp Context (Dữ liệu đầu vào) tùy theo tầng
  let contextData = "";
  let plannerCompleted = false;
  if (level === "e2e") {
    console.log(`
-----------------------------------------------------------------
NHAP KICH BAN TEST

Viet tung test case bang tieng Viet, AI se dich sang code.
Co the viet cau tu nhien gom nhieu thao tac; Planner se tach theo dung thu tu.
Neu cau mo ho, he thong se yeu cau lam ro thay vi doan.

Vi du:
  URL: https://staging.example.com/login
  TC_01: Dang nhap thanh cong
  - Mo URL
  - Nhap 'demo_user' vao o 'Nhap ten dang nhap'
  - Nhap 'demo_password' vao o 'Nhap mat khau'
  - Bam nut 'Dang nhap'
  - Kiem tra: URL khong con chua 'dang-nhap'
-----------------------------------------------------------------
    `);

    const { scriptContent } = await inquirer.prompt([
      {
        type: "editor",
        name: "scriptContent",
        message:
          "Nhap kich ban test chi tiet (mo editor, luu va dong khi xong):",
      },
    ]);

    if (!fs.existsSync("artifacts")) fs.mkdirSync("artifacts");
    fs.writeFileSync("artifacts/source-script-e2e.md", scriptContent.trim() + "\n");

    // Planner là tầng hiểu tiếng Việt duy nhất. JSON đã qua validator mới được
    // chuyển cho Crawler; không còn parse lại bằng regex ở CLI.
    const plannerSuccess = await runPlanner("e2e", scriptContent);
    if (!plannerSuccess) {
      console.error("   Da dung truoc Crawler/Generator vi Planner chua tao duoc Action Intent an toan.");
      await returnToMenu();
      return;
    }
    plannerCompleted = true;

    // === CRAWLER: Live Multi-State Crawler (xác minh DOM theo Action Intent) ===
    console.log("\n[Crawler Agent] Dang khoi chay Live Crawler de xac minh Action Intent tren DOM that...");
    try {
      const parsedCases = plannerPlanToTestCases(loadStructuredE2EPlan());
      const snapshotsMap = await runLive(parsedCases);

      const totalSnapshots = [...snapshotsMap.values()]
        .reduce((total, snapshots) => total + snapshots.length, 0);
      const domReport = buildCompactDomReport(snapshotsMap);

      fs.writeFileSync("artifacts/crawled-dom.md", domReport);
      const actionPlan = buildActionPlan(parsedCases, snapshotsMap);
      const crawlerFailuresPath = "artifacts/crawler-failures.json";
      const crawlerFailures = fs.existsSync(crawlerFailuresPath)
        ? JSON.parse(fs.readFileSync(crawlerFailuresPath, "utf-8"))
        : [];
      const unresolvedActions = actionPlan.testCases.flatMap(testCase =>
        testCase.actions
          .filter(action => action.confidence === "low")
          .map(action => {
            const crawlerFailure = crawlerFailures.find(failure =>
              failure.testCaseId === testCase.id && failure.stepNumber === action.stepIndex,
            ) || crawlerFailures.find(failure =>
              failure.testCaseId === testCase.id &&
              String(failure.reason).startsWith("AUTHENTICATION_FAILED:"),
            );
            return {
              testCaseId: testCase.id,
              stepIndex: action.stepIndex,
              description: action.description,
              matchedBy: action.matchedBy,
              currentUrl: crawlerFailure?.currentUrl,
              crawlerReason: crawlerFailure?.reason,
            };
          }),
      );
      if (unresolvedActions.length > 0) {
        fs.writeFileSync(
          "artifacts/unresolved-actions.json",
          JSON.stringify(unresolvedActions, null, 2) + "\n",
        );
        throw new Error(
          `Crawler chua xac minh duoc ${unresolvedActions.length} action. ` +
          `Lan chay nay da ket thuc, khong tu dong cho hay thu lai. ` +
          `Chi tiet: artifacts/unresolved-actions.json va artifacts/crawler-failures.json. ` +
          `Generator duoc chan de khong doan locator.`,
        );
      }
      console.log(`   Da van dap va thu thap ${totalSnapshots} DOM snapshot(s) theo tung trang thai.`);
    } catch (err) {
      console.error(`   Loi hop dong E2E: ${err.message}`);
      console.error("   Planner Plan van duoc giu lai; Generator dung de tranh sinh locator doan mo.");
      await returnToMenu();
      return;
    }

    contextData = scriptContent;

  } else if (level === "integration") {
    const { apiDesc } = await inquirer.prompt([
      {
        type: "input",
        name: "apiDesc",
        message: "Nhập Endpoint API hoặc dán cấu trúc JSON/Swagger vào đây:",
      },
    ]);
    contextData = apiDesc;
  } else if (level === "unit") {
    section("UNIT", "Kiểm thử Whitebox", "Đọc source thật • phân tích AST • sinh Vitest có kiểm chứng");
    const { inputMode } = await inquirer.prompt([
      {
        type: "list",
        name: "inputMode",
        message: "Bạn muốn cung cấp mã nguồn theo cách nào?",
        choices: [
          { name: "Chọn thư mục dự án", value: "folder" },
          { name: "Chọn một file nguồn", value: "file" },
          { name: "Dán đoạn code export để thử nhanh", value: "paste" },
        ],
      },
    ]);
    let unitInputPath = "";
    if (inputMode === "paste") {
      const { pastedCode } = await inquirer.prompt([
        {
          type: "editor",
          name: "pastedCode",
          message: "Dán code JavaScript/TypeScript (target phải có export):",
        },
      ]);
      const snippetDir = path.join(process.cwd(), ".testkit", "unit-inputs", `snippet_${Date.now()}`);
      fs.mkdirSync(snippetDir, { recursive: true });
      unitInputPath = path.join(snippetDir, "snippet.ts");
      fs.writeFileSync(unitInputPath, `${pastedCode.trim()}\n`);
    } else {
      const { sourcePath } = await inquirer.prompt([
        {
          type: "input",
          name: "sourcePath",
          message: inputMode === "folder"
            ? "Nhập đường dẫn thư mục gốc dự án cần test:"
            : "Nhập đường dẫn file nguồn cần test:",
          validate: value => value.trim() ? true : "Đường dẫn không được để trống.",
        },
      ]);
      unitInputPath = path.resolve(sourcePath.trim());
    }

    let analysis;
    try {
      analysis = analyzeUnitInput(unitInputPath);
    } catch (error) {
      uiError(`Code Reader không thể phân tích: ${error.message}`);
      await returnToMenu();
      return;
    }
    const eligibleTargets = analysis.index.targets.filter(target => target.executionMode !== "UNSUPPORTED");
    if (eligibleTargets.length === 0) {
      uiError("Không tìm thấy hàm/class được export để sinh Unit Test.");
      detail("Yêu cầu", "Target phải được export để file test import source thật.");
      await returnToMenu();
      return;
    }
    summary("Kết quả quét mã nguồn", [
      ["Dự án", analysis.manifest.projectName],
      ["File nguồn", String(analysis.manifest.sourceFiles.length)],
      ["Target", `${eligibleTargets.length}/${analysis.index.targets.length} có thể test`],
      ["Framework", analysis.manifest.testFramework],
    ]);
    if (analysis.manifest.testFramework === "unknown") {
      uiError("Dự án chưa cấu hình Vitest hoặc Jest.");
      detail("Hành động", "Cấu hình test runner trong dự án đích rồi quét lại.");
      await returnToMenu();
      return;
    }

    let selectedTargetIds = eligibleTargets.map(target => target.id);
    if (eligibleTargets.length > 1) {
      const { selectionMode } = await inquirer.prompt([
        {
          type: "list",
          name: "selectionMode",
          message: "Chọn phạm vi Planner Unit:",
          choices: [
            { name: "Chọn hàm/class cụ thể (khuyến nghị)", value: "choose" },
            { name: `Phân tích tất cả ${eligibleTargets.length} target`, value: "all" },
          ],
        },
      ]);
      if (selectionMode === "choose") {
        const { selected } = await inquirer.prompt([
          {
            type: "checkbox",
            name: "selected",
            message: "Chọn target cần sinh test:",
            pageSize: 20,
            choices: eligibleTargets.map(target => ({
              name: `${target.sourceFile}  ›  ${target.symbol} ${profile(target.profile)}`,
              value: target.id,
            })),
            validate: value => value.length > 0 ? true : "Phải chọn ít nhất một target.",
          },
        ]);
        selectedTargetIds = selected;
      }
    }
    const { requirements } = await inquirer.prompt([
      {
        type: "editor",
        name: "requirements",
        message: "Nhập yêu cầu nghiệp vụ/expected nhiều dòng (lưu và đóng editor khi xong):",
      },
    ]);
    const normalizedRequirements = String(requirements || "").trim();
    if (normalizedRequirements) {
      const requirementLineCount = normalizedRequirements.split(/\r?\n/).length;
      success(`Đã nhận đầy đủ ${requirementLineCount} dòng yêu cầu nghiệp vụ.`);
    } else {
      detail("Yêu cầu nghiệp vụ", "Để trống; hệ thống chỉ kiểm tra hành vi suy ra từ source.");
    }
    try {
      const prepared = createUnitSession(analysis, selectedTargetIds, normalizedRequirements);
      contextData = JSON.stringify(prepared.context);
      success("Đã chuẩn bị dữ liệu cho Planner.");
      artifact("Phiên chạy", path.basename(prepared.session.runDirectory));
    } catch (error) {
      uiError(`Không tạo được Unit Context: ${error.message}`);
      await returnToMenu();
      return;
    }
  }

  // Bước 1: Gọi Planner
  const isPlanSuccess = plannerCompleted || await runPlanner(level, contextData);

  if (isPlanSuccess) {
    const { confirmGen } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmGen",
        message: "Kế hoạch đã sẵn sàng. Sinh file test ngay?",
        default: true,
      },
    ]);

    // Bước 2: Gọi Generator
    if (confirmGen) {
      let targetName = "";

      // Tự động tìm URL trong contextData (cả ở Auto Mode lẫn Script Mode)
      const urlMatch = contextData.match(/https?:\/\/[^\s\'"\)>]+/i);
      if (urlMatch) {
        try {
          const urlObj = new URL(urlMatch[0]);
          let host = urlObj.hostname.replace(/^www\./, "").split(".")[0];
          if (host === "opensource-demo") host = "orangehrm";
          const pathParts = urlObj.pathname.split("/").filter(Boolean);
          const lastPath = pathParts.pop() || "main";
          targetName = `${host}_${lastPath}`
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, "_");
        } catch {}
      }

      // Nếu không có URL, tìm tên Module / TC đầu tiên
      if (!targetName) {
        const tcMatch = contextData.match(/TC_([A-Z0-9_]+)/i);
        if (tcMatch) {
          const moduleName = tcMatch[1].split("_")[0].toLowerCase();
          targetName = `${level}_${moduleName}`;
        }
      }

      if (!targetName) {
        targetName = `${level}_test_suite`;
      }

      await runGenerator(level, targetName);
      if (level === "unit") {
        await reviewPendingUnitOracles({ askToStart: true });
      }
    }
  }

  await returnToMenu();
}

function editableOracleValue(value) {
  if (value && typeof value === "object" && value.$type === "undefined") return "undefined";
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value);
}

async function askTesterExpected(proposed) {
  if (!proposed) throw new Error("Chưa có dạng kết quả đề xuất để tester chỉnh sửa an toàn.");
  const kind = proposed.kind;
  if (kind === "return" || kind === "resolve") {
    const { rawValue } = await inquirer.prompt([
      {
        type: "input",
        name: "rawValue",
        message: "Nhập giá trị đúng (ví dụ: true, 10, văn bản hoặc JSON):",
        default: editableOracleValue(proposed?.value),
        validate: value => {
          try {
            parseTesterDataValue(value);
            return true;
          } catch (error) {
            return error.message;
          }
        },
      },
    ]);
    return { kind, value: parseTesterDataValue(rawValue) };
  }
  const proposedMessage = proposed?.error?.message?.value
    || proposed?.message
    || (typeof proposed?.value === "string" ? proposed.value : "");
  const { errorMessage, match } = await inquirer.prompt([
    {
      type: "input",
      name: "errorMessage",
      message: "Thông báo lỗi đúng là gì?",
      default: proposedMessage,
      validate: value => value.trim() ? true : "Thông báo lỗi không được để trống.",
    },
    {
      type: "list",
      name: "match",
      message: "So sánh thông báo lỗi theo cách nào?",
      choices: [
        { name: "Chỉ cần có chứa nội dung này (khuyến nghị)", value: "contains" },
        { name: "Phải giống hoàn toàn", value: "equals" },
      ],
    },
  ]);
  return {
    kind,
    error: { message: { match, value: errorMessage.trim() } },
  };
}

function showOracleRequest(request, index, total) {
  section("03", `Xác nhận kết quả ${index + 1}/${total}`, "Không cần đọc source code hay mở file JSON");
  summary("Tester cần quyết định", [
    ["Chức năng", humanizeUnitTarget(request.target)],
    ["Trường hợp", request.name || request.testCaseId],
    ["Đề xuất", formatExpectedForTester(request.proposedExpected)],
  ], "warning");
  console.log(`\n   ${paint.bold("Dữ liệu đầu vào")}`);
  for (const line of formatInputsForTester(request.inputs)) detail("", line);
  console.log(`\n   ${paint.muted("Hệ thống chưa thể tự chứng minh kết quả này từ mã nguồn.")}`);
  console.log(`   ${paint.muted("Tester chỉ xác nhận khi đây đúng là hành vi mong muốn của nghiệp vụ.")}`);
}

async function reviewPendingUnitOracles({ askToStart = true } = {}) {
  let requests;
  try {
    requests = loadPendingUnitOracleRequests();
  } catch (error) {
    uiError(`Không đọc được phiên Unit hiện tại: ${error.message}`);
    return false;
  }
  if (requests.length === 0) {
    success("Không có test case Unit nào đang chờ xác nhận.");
    return false;
  }
  if (askToStart) {
    const { startReview } = await inquirer.prompt([
      {
        type: "confirm",
        name: "startReview",
        message: `Có ${requests.length} kết quả cần tester xác nhận. Xác nhận ngay trên CLI?`,
        default: true,
      },
    ]);
    if (!startReview) {
      detail("Làm sau", "Chọn mục 05 - Xác nhận kết quả Unit ở menu chính.");
      return false;
    }
  }

  const confirmations = [];
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    let decided = false;
    while (!decided) {
      showOracleRequest(request, index, requests.length);
      const choices = [];
      if (request.proposedExpected) {
        choices.push({
          name: "Đúng, dùng kết quả hệ thống đang đề xuất",
          value: "confirm",
        });
        if (request.proposedExpected.kind !== "side-effect") {
          choices.push({ name: "Kết quả chưa đúng, tôi muốn nhập lại", value: "edit" });
        }
      }
      choices.push(
        { name: "Tạm bỏ qua test case này", value: "skip" },
        { name: "Cần BA/Developer xác nhận thêm", value: "review" },
        { name: "Xem lý do kỹ thuật", value: "details" },
        { name: "Dừng tại đây và lưu các lựa chọn đã làm", value: "stop" },
      );
      const { action } = await inquirer.prompt([
        {
          type: "list",
          name: "action",
          message: "Kết quả mong đợi đúng là gì?",
          choices,
        },
      ]);
      if (action === "details") {
        warning("Giải thích kỹ thuật (chỉ để tham khảo):");
        for (const reason of request.reasons || []) detail("", reason);
        continue;
      }
      if (action === "stop") {
        index = requests.length;
        break;
      }
      const confirmedAt = new Date().toISOString();
      if (action === "confirm") {
        confirmations.push({
          target: request.target,
          testCaseId: request.testCaseId,
          status: "CONFIRMED",
          expected: request.proposedExpected,
          confirmedAt,
        });
      } else if (action === "edit") {
        const expected = await askTesterExpected(request.proposedExpected);
        confirmations.push({
          target: request.target,
          testCaseId: request.testCaseId,
          status: "CONFIRMED",
          expected,
          confirmedAt,
        });
      } else {
        confirmations.push({
          target: request.target,
          testCaseId: request.testCaseId,
          status: action === "review" ? "NEEDS_REVIEW" : "SKIPPED",
          confirmedAt,
        });
      }
      decided = true;
    }
  }

  if (confirmations.length === 0) return false;
  let result;
  try {
    result = applyUnitOracleConfirmations(confirmations);
  } catch (error) {
    uiError(`Không lưu được xác nhận: ${error.message}`);
    return false;
  }
  summary("Đã lưu lựa chọn của tester", [
    ["Đã xác nhận", String(result.confirmedCount)],
    ["Tạm bỏ qua", String(result.skippedCount)],
    ["Cần xem lại", String(result.needsReviewCount)],
  ], result.confirmedCount > 0 ? "success" : "warning");

  if (result.confirmedTargetIds.length > 0) {
    section("04", "Tạo lại Unit Test", "Dùng xác nhận vừa nhập • không gọi Planner • không gọi AI");
    await runUnitGenerator({
      preserveExistingFiles: true,
      onlyTargetIds: result.confirmedTargetIds,
    });
  }
  return result.confirmedCount > 0;
}

// 3. TÍNH NĂNG: CHẠY TEST VÀ KÍCH HOẠT CHÍNH SÁCH BẮT LỖI
async function runTests(level) {
  section("RUN", `Chạy ${level.toUpperCase()}`, "Thực thi test và tổng hợp kết quả");

  if (level === "unit") {
    let unitResult;
    try {
      unitResult = runLastGeneratedUnitTests();
    } catch (error) {
      uiError(`Không thể chạy Unit Test gần nhất: ${error.message}`);
      await returnToMenu();
      return;
    }
    detail("Dự án", path.basename(unitResult.cwd));
    const runSummary = summarizeUnitRunOutput(unitResult.stdout, unitResult.stderr);
    summary("Kết quả thực thi", [
      ["File test", `${runSummary.passedFiles}/${runSummary.totalFiles} pass`],
      ["Test case", `${runSummary.passedTests}/${runSummary.totalTests} pass`],
      ["Thất bại", String(runSummary.failedTests)],
      ["Coverage", unitResult.coverageEnabled ? "Đã bật" : "Chưa bật"],
    ], unitResult.ok ? "success" : "error");
    if (unitResult.ok) {
      success("Tất cả Unit Test đã pass.");
      unitResult.coverageEnabled
        ? success("Coverage đã được ghi nhận.")
        : warning("Test đã pass nhưng dự án chưa có coverage provider.");
      const coverageLoop = await runUnitCoverageGuidedLoop(unitResult);
      unitResult = coverageLoop.finalRun;
      if (coverageLoop.status === "TARGET_REACHED") {
        success("Coverage đã đạt ngưỡng 80% cho các target được đo.");
      } else if (coverageLoop.rounds.length > 0) {
        warning(`Coverage kết thúc ở trạng thái ${coverageLoop.status} sau ${coverageLoop.rounds.length} vòng.`);
      }
    } else {
      const errorMessage = `${unitResult.stdout}\n${unitResult.stderr}`.trim();
      uiError("Unit Test chưa pass.");
      for (const failedName of runSummary.failedNames.slice(0, 3)) {
        detail("Test lỗi", failedName);
      }
      if (runSummary.failedNames.length > 3) {
        detail("Còn lại", `${runSummary.failedNames.length - 3} test case`);
      }
      if (runSummary.primaryError) detail("Nguyên nhân", runSummary.primaryError);
      artifact("Log đầy đủ", "test-results.json");
      await runHealer("unit", errorMessage);
      const result = await harness.handleTestFailure("unit", "Generated Unit Suite", errorMessage);
      fs.mkdirSync("artifacts", { recursive: true });
      fs.writeFileSync("artifacts/report.md", result.report);
      success("Đã lưu báo cáo chẩn đoán.");
      artifact("Báo cáo", "artifacts/report.md");
    }
    await returnToMenu();
    return;
  }

  // Xác định lệnh chạy theo tầng
  let command = "";
  if (level === "e2e") command = "npx playwright test tests/e2e";
  else if (level === "integration")
    command = "npx vitest run tests/integration";

  try {
    const output = execSync(command, { encoding: "utf-8" });
    console.log(output);
    success(`Tất cả test ${level.toUpperCase()} đã pass.`);
  } catch (error) {
    uiError(`Test ${level.toUpperCase()} chưa pass.`);
    detail("Tiếp theo", "Đang chạy chẩn đoán và tạo báo cáo.");

    const errorMessage = error.stdout || error.message;
    await runHealer(level, String(errorMessage));
    const result = await harness.handleTestFailure(
      level,
      `Suite [${level}]`,
      errorMessage,
    );

    if (!fs.existsSync("artifacts")) fs.mkdirSync("artifacts");

    const reportContent = `
# BÁO CÁO PHÂN TÍCH LỖI TỰ ĐỘNG - ${new Date().toLocaleString()}

- **Cấp độ test**: ${level.toUpperCase()}
- **Chế độ áp dụng**: ${result.mode}
- **Hành động hệ thống**: ${result.actionTaken}

---

## Log lỗi gốc từ Playwright:

\`\`\`
${result.rawErrorLog || errorMessage}
\`\`\`

---

## Phân tích & Đề xuất sửa lỗi từ AI:

${result.report}
    `;

    fs.writeFileSync("artifacts/report.md", reportContent);
    success("Đã tạo báo cáo chẩn đoán.");
    artifact("Báo cáo", "artifacts/report.md");
  }

  await returnToMenu();
}

// 4. TÍNH NĂNG: XEM BÁO CÁO CẬP NHẬT
function showReport() {
  if (fs.existsSync("artifacts/report.md")) {
    const content = fs.readFileSync("artifacts/report.md", "utf-8");
    console.log("\n------------------ BÁO CÁO GẦN NHẤT ------------------");
    console.log(content);
    console.log("------------------------------------------------------\n");
  } else {
    warning("Chưa có báo cáo kiểm thử nào.");
  }
  returnToMenu();
}

// HÀM PHỤ TỰ QUAY LẠI MENU
async function returnToMenu() {
  if (process.argv.includes("--non-interactive")) {
    return;
  }
  await inquirer.prompt([
    {
      type: "input",
      name: "continue",
      message: paint.muted("Nhấn Enter để quay lại menu chính"),
    },
  ]);
  await mainMenu();
}

// XỬ LÝ KHỞI CHẠY CLI: INTERACTIVE NẾU KHÔNG CÓ CỜ, NON-INTERACTIVE NẾU CÓ CỜ
async function runCliEntrypoint() {
  const args = process.argv.slice(2);
  const isNonInteractive = args.includes("--non-interactive");

  let level = null;
  const levelIdx = args.indexOf("--level");
  if (levelIdx !== -1 && args[levelIdx + 1]) {
    level = args[levelIdx + 1];
  }

  if (isNonInteractive || level) {
    header();
    const targetLevel = level || "unit";
    section("CLI", `CHẠY NON-INTERACTIVE PIPELINE [${targetLevel.toUpperCase()}]`, "Thực thi CI/CD tự động");

    try {
      if (targetLevel === "unit") {
        const unitResult = runLastGeneratedUnitTests();
        const runSummary = summarizeUnitRunOutput(unitResult.stdout, unitResult.stderr);

        if (!unitResult.ok || runSummary.failedTests > 0) {
          uiError(`Pipeline CI thất bại: Có ${runSummary.failedTests} test case bị lỗi.`);
          process.exit(1);
        } else {
          success("Tất cả Unit Test đã pass thành công trong CI.");
          process.exit(0);
        }
      } else if (targetLevel === "integration") {
        execSync("npx vitest run tests/integration", { stdio: "inherit" });
        success("Integration Test pass.");
        process.exit(0);
      } else if (targetLevel === "e2e") {
        execSync("npx playwright test tests/e2e", { stdio: "inherit" });
        success("E2E Test pass.");
        process.exit(0);
      } else {
        uiError(`Tầng kiểm thử không hợp lệ: ${targetLevel}`);
        process.exit(2);
      }
    } catch (err) {
      uiError(`Pipeline thất bại với lỗi: ${err.message}`);
      process.exit(1);
    }
  } else {
    mainMenu();
  }
}

// KHỞI CHẠY CLI
runCliEntrypoint();
