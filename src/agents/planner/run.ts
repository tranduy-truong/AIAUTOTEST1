import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { OpenAIAdapter } from '../../adapters/openai.js';
import { renderStructuredPlanMarkdown } from './markdown-renderer.js';
import { normalizePlannerOutput } from './normalizer.js';
import type { StructuredE2EPlan } from './schema.js';
import {
  validateStructuredE2EPlan,
  type PlannerValidationIssue,
} from './validator.js';
import {
  loadUnitSession,
  saveUnitPlan,
} from '../../core/unit/artifacts.js';
import { renderUnitPlanMarkdown } from '../../core/unit/markdown-renderer.js';
import {
  validateStructuredUnitPlan,
  type UnitPlanValidationIssue,
} from '../../core/unit/plan-validator.js';
import type {
  StructuredUnitPlan,
  UnitContextBundle,
} from '../../core/unit/schema.js';
import {
  resolveDeterministicUnitPlan,
  resolveUnitPlannerProposal,
} from '../../core/unit/planner-fallback.js';
import {
  artifact,
  detail,
  error as uiError,
  progress,
  section,
  success,
  summary,
  warning,
} from '../../core/cli-ui.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const E2E_JSON_PATH = 'artifacts/test-plan-e2e.json';
const E2E_MARKDOWN_PATH = 'artifacts/test-plan-e2e.md';
const E2E_INVALID_PATH = 'artifacts/test-plan-e2e.invalid.txt';
const E2E_ERRORS_PATH = 'artifacts/planner-validation-errors.json';
const MAX_E2E_CHUNK_CHARS = 4500;
const MAX_E2E_CHUNK_STEPS = 14;
const STEP_BULLET = /^\s*[-*•·▪◦–—]\s*/u;

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

function ensureArtifactsDir(): void {
  fs.mkdirSync('artifacts', { recursive: true });
}

function validationIssuesForRawOutput(
  rawOutput: string,
  sourceScript: string,
): { plan: StructuredE2EPlan | null; issues: PlannerValidationIssue[] } {
  const plan = normalizePlannerOutput(rawOutput);
  if (!plan) {
    return {
      plan: null,
      issues: [{
        code: 'INVALID_JSON',
        message: 'Planner không trả về một JSON object hợp lệ.',
      }],
    };
  }
  return { plan, issues: validateStructuredE2EPlan(plan, sourceScript).issues };
}

export function loadStructuredE2EPlan(
  filePath = E2E_JSON_PATH,
): StructuredE2EPlan {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as StructuredE2EPlan;
  if (parsed.version !== 2 || parsed.source !== 'ai-planner' || !Array.isArray(parsed.testCases)) {
    throw new Error(`Structured Planner Plan không hợp lệ: ${filePath}`);
  }
  return parsed;
}

function createTask(systemPrompt: string, sourceScript: string): string {
  return `${systemPrompt}\n\n---\n\n[KỊCH BẢN THỰC TẾ CỦA NGƯỜI DÙNG]\n${sourceScript.trim()}\n\n[HẾT KỊCH BẢN]\n\nChỉ xuất JSON object đúng schema.`;
}

function createRepairTask(
  task: string,
  issues: PlannerValidationIssue[],
): string {
  const compactIssues = issues.slice(0, 30).map(issue => ({
    code: issue.code,
    testCaseId: issue.testCaseId,
    stepIndex: issue.stepIndex,
    sourceLine: issue.sourceLine,
    message: issue.message,
  }));
  // Regenerate from the source instead of attaching the entire broken JSON.
  // A truncated 3,500-token output would otherwise make the repair request
  // even larger and can exceed Groq TPM before the model gets a second chance.
  return `${task}\n\n[LỖI CẦN TRÁNH KHI TẠO LẠI OUTPUT]\n${JSON.stringify(compactIssues)}\n\nTạo lại toàn bộ JSON từ kịch bản gốc, sửa mọi lỗi trên và chỉ trả về JSON object hoàn chỉnh.`;
}

export function splitE2EScript(
  sourceScript: string,
  maxChars = MAX_E2E_CHUNK_CHARS,
  maxSteps = MAX_E2E_CHUNK_STEPS,
): string[] {
  const lines = sourceScript.replace(/\r/g, '').split('\n');
  const preamble: string[] = [];
  const blocks: string[][] = [];
  let current: string[] | undefined;

  for (const line of lines) {
    if (/^\s*TC(?:_[A-Z0-9]+)+\s*[:-]/i.test(line)) {
      current = [line];
      blocks.push(current);
    } else if (current) {
      current.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (blocks.length === 0) return [sourceScript.trim()];

  const units: { text: string; id: string; steps: number }[] = [];
  for (const block of blocks) {
    const header = block[0];
    const id = header.match(/^\s*(TC(?:_[A-Z0-9]+)+)/i)?.[1].toUpperCase() || header;
    let unitLines = [header];
    let unitSteps = 0;
    for (const line of block.slice(1)) {
      const addsStep = STEP_BULLET.test(line) ? 1 : 0;
      const candidate = [...unitLines, line].join('\n');
      const exceedsChars = `${preamble.join('\n')}\n${candidate}`.length > maxChars;
      const exceedsSteps = unitSteps + addsStep > maxSteps;
      if ((exceedsChars || exceedsSteps) && unitLines.length > 1) {
        units.push({ text: unitLines.join('\n'), id, steps: unitSteps });
        unitLines = [header];
        unitSteps = 0;
      }
      unitLines.push(line);
      unitSteps += addsStep;
    }
    units.push({ text: unitLines.join('\n'), id, steps: unitSteps });
  }

  const chunks: string[] = [];
  const preambleText = preamble.join('\n').trim();
  let chunkUnits: typeof units = [];
  let chunkSteps = 0;
  for (const unit of units) {
    const candidateUnits = [...chunkUnits, unit];
    const candidate = [preambleText, ...candidateUnits.map(item => item.text)]
      .filter(Boolean)
      .join('\n');
    const repeatsSameTestCase = chunkUnits.some(item => item.id === unit.id);
    if (
      chunkUnits.length > 0 &&
      (candidate.length > maxChars || chunkSteps + unit.steps > maxSteps || repeatsSameTestCase)
    ) {
      chunks.push([preambleText, ...chunkUnits.map(item => item.text)].filter(Boolean).join('\n').trim());
      chunkUnits = [unit];
      chunkSteps = unit.steps;
      continue;
    }
    chunkUnits = candidateUnits;
    chunkSteps += unit.steps;
  }
  if (chunkUnits.length > 0) {
    chunks.push([preambleText, ...chunkUnits.map(item => item.text)].filter(Boolean).join('\n').trim());
  }
  return chunks;
}

function mergeStructuredPlans(plans: StructuredE2EPlan[]): StructuredE2EPlan {
  const testCases = new Map<string, StructuredE2EPlan['testCases'][number]>();
  for (const plan of plans) {
    for (const testCase of plan.testCases) {
      const id = testCase.id.toUpperCase();
      const existing = testCases.get(id);
      if (!existing) {
        testCases.set(id, { ...testCase, steps: [...testCase.steps] });
      } else {
        existing.steps.push(...testCase.steps);
        existing.preconditions = [...new Set([...(existing.preconditions || []), ...(testCase.preconditions || [])])];
        existing.expectedResults = [...new Set([...(existing.expectedResults || []), ...(testCase.expectedResults || [])])];
        existing.notes = [...new Set([...(existing.notes || []), ...(testCase.notes || [])])];
      }
    }
  }
  return {
    version: 2,
    source: 'ai-planner',
    testCases: [...testCases.values()],
    clarifications: plans.flatMap(plan => plan.clarifications),
  };
}

async function callPlannerAdapter(taskContent: string, suffix = '') {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const runId = `run_${Date.now()}${suffix}_${attempt}`;
    const workDir = path.join(process.cwd(), '.testkit', 'runs', runId);
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, 'task.md'), taskContent.trim());

    const adapter = new OpenAIAdapter('llama-3.3-70b-versatile');
    const result = await adapter.run({
      promptDir: workDir,
      workDir,
      timeoutMs: 120000,
      maxTokens: 3500,
    });
    if (result.ok || !/rate.limit|tokens per minute|tpm/i.test(result.rawOutput) || attempt === 4) {
      return result;
    }

    const waitMs = attempt * 12000;
    console.warn(`   Groq dang gioi han TPM; tu dong cho ${waitMs / 1000}s roi thu lai (${attempt}/4)...`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
  return { ok: false, rawOutput: 'Planner retry loop ended unexpectedly.' };
}

async function planOneChunk(
  systemPrompt: string,
  sourceChunk: string,
  chunkIndex: number,
): Promise<{ plan: StructuredE2EPlan | null; issues: PlannerValidationIssue[]; rawOutput: string }> {
  const task = createTask(systemPrompt, sourceChunk);
  let result = await callPlannerAdapter(task, `_chunk_${chunkIndex}`);
  if (!result.ok) {
    return {
      plan: null,
      issues: [{ code: 'AI_API_ERROR', message: result.rawOutput }],
      rawOutput: result.rawOutput,
    };
  }

  let validation = validationIssuesForRawOutput(result.rawOutput, sourceChunk);
  if (!validation.plan || validation.issues.length > 0) {
    console.warn(`   Lo ${chunkIndex}: output chua dat hop dong (${validation.issues.length} loi), dang tu sua mot lan...`);
    const repair = await callPlannerAdapter(
      createRepairTask(task, validation.issues),
      `_chunk_${chunkIndex}_repair`,
    );
    if (repair.ok) {
      result = repair;
      validation = validationIssuesForRawOutput(result.rawOutput, sourceChunk);
    }
  }
  return { ...validation, rawOutput: result.rawOutput };
}

async function runStructuredE2EPlanner(
  systemPrompt: string,
  sourceScript: string,
): Promise<boolean> {
  ensureArtifactsDir();
  for (const stalePath of [
    E2E_JSON_PATH,
    E2E_MARKDOWN_PATH,
    'artifacts/action-plan.json',
    'artifacts/crawled-dom.md',
    'artifacts/unresolved-actions.json',
  ]) {
    fs.rmSync(stalePath, { force: true });
  }
  const chunks = splitE2EScript(sourceScript);
  if (chunks.length > 1) {
    console.log(`   Kịch bản được chia thành ${chunks.length} lô theo số bước/test case để tránh JSON bị cắt và vượt TPM.`);
  }

  const chunkPlans: StructuredE2EPlan[] = [];
  const allIssues: PlannerValidationIssue[] = [];
  const rawOutputs: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    if (chunks.length > 1) console.log(`   Planner đang phân tích lô ${index + 1}/${chunks.length}...`);
    const chunkResult = await planOneChunk(systemPrompt, chunk, index + 1);
    rawOutputs.push(chunkResult.rawOutput);
    if (chunkResult.plan && chunkResult.issues.length === 0) chunkPlans.push(chunkResult.plan);
    allIssues.push(...chunkResult.issues);
  }

  const mergedPlan = chunkPlans.length === chunks.length
    ? mergeStructuredPlans(chunkPlans)
    : null;
  const finalIssues = mergedPlan
    ? validateStructuredE2EPlan(mergedPlan, sourceScript).issues
    : allIssues;

  if (!mergedPlan || finalIssues.length > 0) {
    fs.writeFileSync(E2E_INVALID_PATH, rawOutputs.join('\n\n--- CHUNK ---\n\n').trim() + '\n');
    fs.writeFileSync(E2E_ERRORS_PATH, JSON.stringify(finalIssues, null, 2) + '\n');
    console.error(`❌ Planner chưa hiểu chắc chắn ${finalIssues.length} điểm; không chuyển sang Crawler.`);
    for (const issue of finalIssues.slice(0, 10)) {
      const where = [issue.testCaseId, issue.stepIndex && `bước ${issue.stepIndex}`]
        .filter(Boolean)
        .join(' - ');
      console.error(`   - ${where ? `${where}: ` : ''}${issue.message}`);
    }
    console.error(`   Chi tiết: ${E2E_ERRORS_PATH}`);
    return false;
  }

  fs.writeFileSync(E2E_JSON_PATH, JSON.stringify(mergedPlan, null, 2) + '\n');
  fs.writeFileSync(E2E_MARKDOWN_PATH, renderStructuredPlanMarkdown(mergedPlan));
  fs.rmSync(E2E_INVALID_PATH, { force: true });
  fs.rmSync(E2E_ERRORS_PATH, { force: true });
  console.log(`✅ Đã lập xong kế hoạch có cấu trúc! Lưu tại: ${E2E_JSON_PATH}`);
  console.log(`   Bản đọc cho tester: ${E2E_MARKDOWN_PATH}`);
  return true;
}

function createUnitTask(
  systemPrompt: string,
  context: UnitContextBundle,
): string {
  return `${systemPrompt}\n\n---\n\n[UNIT CONTEXT ĐÃ ĐƯỢC CODE READER XÁC MINH]\n${JSON.stringify(context)}\n\n[HẾT CONTEXT]\n\nChỉ xuất JSON object đúng schema. Không thêm markdown.`;
}

function unitContextForAI(context: UnitContextBundle): UnitContextBundle {
  return {
    ...context,
    project: {
      ...context.project,
      projectRoot: '<PROJECT_ROOT>',
    },
  };
}

async function planOneUnitTarget(
  systemPrompt: string,
  context: UnitContextBundle,
  index: number,
): Promise<{
  plan: StructuredUnitPlan | null;
  issues: UnitPlanValidationIssue[];
  skippedIssues: UnitPlanValidationIssue[];
  diagnostics: UnitPlanValidationIssue[];
  mode: 'ai' | 'salvaged-ai' | 'deterministic' | 'deterministic-fallback';
  rawOutput: string;
}> {
  const aiContext = unitContextForAI(context);
  const deterministic = resolveDeterministicUnitPlan(aiContext);
  // Explicit tester requirements are a business oracle and deserve semantic
  // AI interpretation. With no requirements, the AST contract is the more
  // reliable and cheaper source of truth.
  if (deterministic.plan && !aiContext.requirements?.trim()) {
    return { ...deterministic, rawOutput: '' };
  }

  // AI is invoked only for targets whose local AST contract cannot produce a
  // structurally safe intent. It is an augmentation path, never a prerequisite.
  const task = createUnitTask(systemPrompt, aiContext);
  const result = await callPlannerAdapter(task, `_unit_${index}`);
  const resolved = resolveUnitPlannerProposal(result.rawOutput, aiContext, !result.ok);
  if (resolved.mode === 'deterministic-fallback' && resolved.plan) {
    warning(`Target ${index}: AI không dùng được; đã chuyển sang phân tích AST.`);
  }
  return { ...resolved, rawOutput: result.rawOutput };
}

async function runStructuredUnitPlanner(
  systemPrompt: string,
  contextData: string,
): Promise<boolean> {
  ensureArtifactsDir();
  let context: UnitContextBundle;
  try {
    context = JSON.parse(contextData) as UnitContextBundle;
    if (context.version !== 1 || !context.project || !Array.isArray(context.targets) || context.targets.length === 0) {
      throw new Error('Context thiếu project hoặc target.');
    }
  } catch (error) {
    uiError(`Unit Context không hợp lệ: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return false;
  }

  const plannedTargets: StructuredUnitPlan['targets'] = [];
  const clarifications: string[] = [];
  const allIssues: UnitPlanValidationIssue[] = [];
  const rawOutputs: string[] = [];
  const skippedTestCaseIssues: UnitPlanValidationIssue[] = [];
  const plannerDiagnostics: Array<{
    target: string;
    mode: 'ai' | 'salvaged-ai' | 'deterministic' | 'deterministic-fallback';
    issues: UnitPlanValidationIssue[];
  }> = [];
  const plannerModes: Array<'ai' | 'salvaged-ai' | 'deterministic' | 'deterministic-fallback'> = [];
  for (let index = 0; index < context.targets.length; index++) {
    const singleContext: UnitContextBundle = { ...context, targets: [context.targets[index]] };
    progress(
      index + 1,
      context.targets.length,
      `${context.targets[index].sourceFile} › ${context.targets[index].symbol}`,
    );
    const result = await planOneUnitTarget(systemPrompt, singleContext, index + 1);
    rawOutputs.push(result.rawOutput);
    skippedTestCaseIssues.push(...result.skippedIssues);
    plannerModes.push(result.mode);
    if (result.diagnostics.length > 0) {
      plannerDiagnostics.push({
        target: `${context.targets[index].sourceFile}#${context.targets[index].symbol}`,
        mode: result.mode,
        issues: result.diagnostics,
      });
    }
    if (!result.plan || result.issues.length > 0) {
      allIssues.push(...result.issues);
      continue;
    }
    plannedTargets.push(...result.plan.targets);
    clarifications.push(...result.plan.clarifications);
  }

  if (skippedTestCaseIssues.length > 0) {
    fs.writeFileSync(
      path.join(loadUnitSession().runDirectory, 'planner-skipped-test-cases.json'),
      `${JSON.stringify(skippedTestCaseIssues, null, 2)}\n`,
    );
    warning(`${new Set(skippedTestCaseIssues.flatMap(issue => issue.testCaseId ? [issue.testCaseId] : [])).size} test case chưa an toàn đã được bỏ qua.`);
  }

  const session = loadUnitSession();
  if (plannerDiagnostics.length > 0) {
    fs.writeFileSync(
      path.join(session.runDirectory, 'planner-ai-diagnostics.json'),
      `${JSON.stringify(plannerDiagnostics, null, 2)}\n`,
    );
  }
  if (allIssues.length > 0 || plannedTargets.length !== context.targets.length) {
    fs.writeFileSync(
      path.join(session.runDirectory, 'planner-validation-errors.json'),
      `${JSON.stringify(allIssues, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(session.runDirectory, 'test-plan-unit.invalid.txt'),
      `${rawOutputs.join('\n\n--- TARGET OUTPUT ---\n\n')}\n`,
    );
    if (plannedTargets.length === 0) {
      uiError(`Planner chưa tạo được kế hoạch an toàn cho ${context.targets.length} target.`);
      for (const issue of allIssues.slice(0, 8)) {
        detail(issue.code, `${issue.testCaseId ? `${issue.testCaseId}: ` : ''}${issue.message}`);
      }
      artifact('Chi tiết kỹ thuật', 'planner-validation-errors.json');
      return false;
    }
    warning(`${context.targets.length - plannedTargets.length} target chưa an toàn đã được bỏ qua; các target còn lại vẫn tiếp tục.`);
    artifact('Chi tiết kỹ thuật', 'planner-validation-errors.json');
  }

  const plan: StructuredUnitPlan = {
    version: 1,
    source: plannerModes.every(mode => mode === 'ai')
      ? 'ai-planner'
      : plannerModes.every(mode => mode === 'deterministic' || mode === 'deterministic-fallback')
        ? 'deterministic-planner'
        : 'hybrid-planner',
    project: {
      name: context.project.projectName,
      root: context.project.projectRoot,
      testFramework: context.project.testFramework,
    },
    targets: plannedTargets,
    clarifications: [...new Set(clarifications)],
  };
  const validContext: UnitContextBundle = {
    ...context,
    targets: context.targets.filter(target => plannedTargets.some(
      planned => planned.sourceFile === target.sourceFile && planned.symbol === target.symbol,
    )),
  };
  const finalIssues = validateStructuredUnitPlan(plan, validContext);
  const finalBlockingIssues = finalIssues.filter(issue => issue.code !== 'UNCOVERED_BRANCH');
  if (finalBlockingIssues.length > 0) {
    fs.writeFileSync(
      path.join(session.runDirectory, 'planner-validation-errors.json'),
      `${JSON.stringify(finalBlockingIssues, null, 2)}\n`,
    );
    uiError(`Unit Plan hợp nhất không hợp lệ (${finalBlockingIssues.length} lỗi).`);
    return false;
  }

  saveUnitPlan(plan, session);
  const markdown = renderUnitPlanMarkdown(plan);
  fs.writeFileSync(path.join(session.runDirectory, 'test-plan-unit.md'), markdown);
  fs.writeFileSync('artifacts/test-plan-unit.md', markdown);
  const deterministicCount = plannerModes.filter(mode =>
    mode === 'deterministic' || mode === 'deterministic-fallback'
  ).length;
  summary('Planner hoàn tất', [
    ['Target sẵn sàng', `${plannedTargets.length}/${context.targets.length}`],
    ['Phân tích AST', `${deterministicCount}/${plannerModes.length}`],
    ['Dùng AI', `${plannerModes.length - deterministicCount}/${plannerModes.length}`],
    ['Kế hoạch', 'test-plan-unit.json'],
  ], plannedTargets.length === context.targets.length ? 'success' : 'warning');
  success('Kế hoạch Unit Test đã sẵn sàng.');
  return true;
}

export async function runPlanner(
  level: 'unit' | 'integration' | 'e2e',
  contextData: string,
): Promise<boolean> {
  if (level === 'unit') {
    section('01', 'Planner', 'Phân tích AST và lập Test Intent');
  } else {
    console.log(`\n🧠 [Planner Agent] Đang phân tích yêu cầu cho tầng: ${level.toUpperCase()}`);
  }

  const promptFilePath = path.join(__dirname, `prompt-${level}.md`);
  if (!fs.existsSync(promptFilePath)) {
    console.error(`❌ Không tìm thấy file prompt: ${promptFilePath}`);
    return false;
  }
  const systemPrompt = fs.readFileSync(promptFilePath, 'utf-8');

  if (level === 'e2e') {
    return runStructuredE2EPlanner(systemPrompt, contextData);
  }
  if (level === 'unit') {
    return runStructuredUnitPlanner(systemPrompt, contextData);
  }

  const taskContent = `${systemPrompt}\n\n[THÔNG TIN THỰC TẾ]\n${contextData}\n\nChỉ xuất mảng JSON đúng schema.`;
  const result = await callPlannerAdapter(taskContent);
  if (!result.ok) {
    console.error('❌ Lỗi khi Planner chạy:', result.rawOutput);
    return false;
  }

  ensureArtifactsDir();
  const parsedPlan = parseJsonArray(result.rawOutput);
  if (!parsedPlan) {
    const invalidPath = `artifacts/test-plan-${level}.invalid.txt`;
    fs.writeFileSync(invalidPath, result.rawOutput.trim() + '\n');
    console.error(`❌ Planner không trả về JSON hợp lệ. Đã lưu tại ${invalidPath}`);
    return false;
  }

  const planPath = `artifacts/test-plan-${level}.json`;
  fs.writeFileSync(planPath, JSON.stringify(parsedPlan, null, 2) + '\n');
  console.log(`✅ Đã lập xong kế hoạch! Lưu tại: ${planPath}`);
  return true;
}
