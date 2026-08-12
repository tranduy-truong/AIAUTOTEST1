import type {
  StructuredUnitPlan,
  UnitContextBundle,
  UnitPlanTarget,
  UnitTarget,
} from './schema.js';
import { validateExpectedIntent, validateOracleEvidence } from './test-intent.schema.js';

export interface UnitPlanValidationIssue {
  code: string;
  message: string;
  target?: string;
  testCaseId?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function removeJsonTrailingCommas(value: string): string {
  let output = '';
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      output += char;
      continue;
    }
    if (char === ',') {
      let cursor = index + 1;
      while (/\s/.test(value[cursor] || '')) cursor++;
      if (value[cursor] === '}' || value[cursor] === ']') continue;
    }
    output += char;
  }
  return output;
}

const SPECIAL_VALUE_TYPES = new Set([
  'undefined', 'nan', 'infinity', 'negative-infinity', 'bigint', 'date', 'regexp', 'map', 'set',
]);

function validateDataValue(value: unknown, label: string): string[] {
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => validateDataValue(item, `${label}[${index}]`));
  if (!isObject(value)) return [`${label} không phải giá trị JSON hợp lệ.`];
  if ('$type' in value) {
    if (typeof value.$type !== 'string' || !SPECIAL_VALUE_TYPES.has(value.$type)) {
      return [`${label} có $type không được hỗ trợ.`];
    }
    if (['bigint', 'date', 'regexp'].includes(value.$type) && typeof value.value !== 'string') {
      return [`${label} cần trường value dạng string cho $type=${value.$type}.`];
    }
    if (value.$type === 'map') {
      if (!Array.isArray(value.entries)) return [`${label} cần entries dạng mảng cho $type=map.`];
      return value.entries.flatMap((entry, index) => {
        if (!Array.isArray(entry) || entry.length !== 2) {
          return [`${label}.entries[${index}] phải là cặp [key, value].`];
        }
        return [
          ...validateDataValue(entry[0], `${label}.entries[${index}][0]`),
          ...validateDataValue(entry[1], `${label}.entries[${index}][1]`),
        ];
      });
    }
    if (value.$type === 'set') {
      if (!Array.isArray(value.values)) return [`${label} cần values dạng mảng cho $type=set.`];
      return value.values.flatMap((item, index) => validateDataValue(item, `${label}.values[${index}]`));
    }
    return [];
  }
  return Object.entries(value).flatMap(([key, item]) => validateDataValue(item, `${label}.${key}`));
}

function validateMockOutcome(value: unknown, label: string, allowSequence = false): string[] {
  if (!isObject(value)) return [`${label} phải là object có cấu trúc.`];
  if (!['return', 'resolve', 'reject', 'throw'].includes(String(value.kind))) {
    return [`${label}.kind phải là return | resolve | reject | throw.`];
  }
  const errors: string[] = [];
  if (['reject', 'throw'].includes(String(value.kind)) && !('value' in value) && !('message' in value)) {
    errors.push(`${label} cần value hoặc message có bằng chứng cho kind=${String(value.kind)}.`);
  }
  if ('value' in value) errors.push(...validateDataValue(value.value, `${label}.value`));
  if ('message' in value && typeof value.message !== 'string') errors.push(`${label}.message phải là string.`);
  if ('properties' in value) {
    if (!isObject(value.properties)) errors.push(`${label}.properties phải là object.`);
    else for (const [key, item] of Object.entries(value.properties)) {
      errors.push(...validateDataValue(item, `${label}.properties.${key}`));
    }
  }
  if ('methods' in value) {
    if (!isObject(value.methods)) errors.push(`${label}.methods phải là object.`);
    else for (const [key, item] of Object.entries(value.methods)) {
      errors.push(...validateMockOutcome(item, `${label}.methods.${key}`));
    }
  }
  if (allowSequence && 'sequence' in value) {
    if (!Array.isArray(value.sequence)) errors.push(`${label}.sequence phải là mảng.`);
    else value.sequence.forEach((item, index) => errors.push(...validateMockOutcome(item, `${label}.sequence[${index}]`)));
  }
  return errors;
}

export function parseStructuredUnitPlan(raw: string): StructuredUnitPlan | null {
  const input = raw.replace(/^\uFEFF/, '').trim();
  const candidates = new Set<string>([
    input,
    input.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim(),
  ]);

  // Some providers wrap valid JSON in a sentence or a Markdown fence. Extract
  // the first balanced object without trying to invent any missing content.
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth++;
    } else if (char === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        candidates.add(input.slice(start, index + 1));
        break;
      }
    }
  }

  for (const candidate of candidates) {
    // A trailing comma is a common serialization blemish and can be removed
    // deterministically. Truncated JSON is deliberately not repaired.
    const variants = [candidate, removeJsonTrailingCommas(candidate)];
    for (const variant of variants) {
      try {
        const parsed = JSON.parse(variant) as StructuredUnitPlan;
        if (!isObject(parsed) || parsed.version !== 1
          || !['ai-planner', 'deterministic-planner', 'hybrid-planner'].includes(String(parsed.source))
          || !Array.isArray(parsed.targets)) continue;
        return parsed;
      } catch {
        // Try the next lossless/tolerant representation.
      }
    }
  }
  return null;
}

/**
 * Re-anchor fields owned by Code Reader instead of asking the LLM to copy
 * hashes, project identity and execution policy perfectly. Test intent,
 * inputs, branches, mocks and expected results remain untouched and are still
 * validated strictly.
 */
export function anchorStructuredUnitPlan(
  plan: StructuredUnitPlan,
  context: UnitContextBundle,
): StructuredUnitPlan {
  const anchoredTargets = plan.targets.map((planTarget, index) => {
    const exact = context.targets.find(target =>
      target.sourceFile === planTarget.sourceFile && target.symbol === planTarget.symbol,
    );
    const target = exact || (context.targets.length === 1 && plan.targets.length === 1
      ? context.targets[0]
      : undefined);
    if (!target) return planTarget;
    return {
      ...planTarget,
      sourceFile: target.sourceFile,
      symbol: target.symbol,
      sourceHash: target.sourceHash,
      executionMode: target.executionMode,
      profile: target.profile,
      testCases: Array.isArray(planTarget.testCases) ? planTarget.testCases : [],
    };
  });
  return {
    ...plan,
    version: 1,
    source: plan.source || 'ai-planner',
    project: {
      name: context.project.projectName,
      root: context.project.projectRoot,
      testFramework: context.project.testFramework,
    },
    targets: anchoredTargets,
    clarifications: Array.isArray(plan.clarifications) ? plan.clarifications : [],
  };
}

function validateTarget(planTarget: UnitPlanTarget, target: UnitTarget): UnitPlanValidationIssue[] {
  const issues: UnitPlanValidationIssue[] = [];
  const targetLabel = `${target.sourceFile}#${target.symbol}`;
  if (planTarget.sourceHash !== target.sourceHash) {
    issues.push({ code: 'STALE_OR_INVENTED_SOURCE_HASH', target: targetLabel, message: 'sourceHash không khớp Code Reader.' });
  }
  if (planTarget.executionMode !== target.executionMode) {
    issues.push({ code: 'INVENTED_EXECUTION_MODE', target: targetLabel, message: 'Planner đã thay đổi executionMode do Target Classifier xác định.' });
  }
  if (planTarget.profile !== target.profile) {
    issues.push({ code: 'INVENTED_TESTABILITY_PROFILE', target: targetLabel, message: 'Planner đã thay đổi profile do Testability Classifier xác định.' });
  }
  if (target.supportingContext.truncated) {
    issues.push({
      code: 'SUPPORTING_CONTEXT_TRUNCATED', target: targetLabel,
      message: 'Call/type graph vượt ngân sách an toàn; hãy chọn target nhỏ hơn hoặc tách module trước khi sinh test.',
    });
  }
  if (!Array.isArray(planTarget.testCases) || planTarget.testCases.length === 0) {
    issues.push({ code: 'MISSING_TEST_CASES', target: targetLabel, message: 'Target không có test case.' });
    return issues;
  }

  const validBranches = new Set(target.branches.map(branch => branch.id));
  const validDependencies = new Set(target.dependencies.map(dependency => dependency.module));
  const mockDependencies = target.dependencies.filter(dependency => dependency.strategy === 'mock');
  const requiredMocks = new Set(mockDependencies.map(dependency => dependency.module));
  const coveredBranches = new Set<string>();
  const ids = new Set<string>();
  for (const testCase of planTarget.testCases) {
    if (!/^UT_[A-Z0-9_]+$/i.test(testCase.id || '')) {
      issues.push({ code: 'INVALID_TEST_ID', target: targetLabel, testCaseId: testCase.id, message: 'ID phải bắt đầu bằng UT_ và chỉ chứa chữ/số/dấu gạch dưới.' });
    }
    const normalizedId = String(testCase.id).toUpperCase();
    if (ids.has(normalizedId)) {
      issues.push({ code: 'DUPLICATE_TEST_ID', target: targetLabel, testCaseId: testCase.id, message: 'ID test case bị trùng.' });
    }
    ids.add(normalizedId);
    if (typeof testCase.name !== 'string' || !testCase.name.trim()) {
      issues.push({ code: 'MISSING_TEST_NAME', target: targetLabel, testCaseId: testCase.id, message: 'Test case thiếu tên.' });
    }
    if (!isObject(testCase.inputs)) {
      issues.push({ code: 'INVALID_TEST_INPUTS', target: targetLabel, testCaseId: testCase.id, message: 'inputs phải là JSON object.' });
    } else {
      for (const message of validateDataValue(testCase.inputs, 'inputs')) {
        issues.push({ code: 'INVALID_TEST_INPUTS', target: targetLabel, testCaseId: testCase.id, message });
      }
      if (target.kind === 'function' || target.kind === 'class-method') {
        const declaredParameters = new Map(target.parameters.map(parameter => [parameter.name, parameter]));
        for (const parameter of target.parameters.filter(item => !item.optional)) {
          if (!(parameter.name in testCase.inputs)) {
            issues.push({
              code: 'MISSING_REQUIRED_INPUT', target: targetLabel, testCaseId: testCase.id,
              message: `Thiếu input bắt buộc: ${parameter.name}.`,
            });
          }
        }
        for (const [inputName, inputValue] of Object.entries(testCase.inputs)) {
          const parameter = declaredParameters.get(inputName);
          if (!parameter) {
            issues.push({
              code: 'INVENTED_INPUT', target: targetLabel, testCaseId: testCase.id,
              message: `Input không có trong chữ ký target: ${inputName}.`,
            });
            continue;
          }
          const type = parameter.type.replace(/\s+/g, ' ').trim();
          const mismatch =
            (/^(?:string)(?:\s*\|\s*(?:null|undefined))*$/i.test(type) && typeof inputValue !== 'string')
            || (/^(?:number)(?:\s*\|\s*(?:null|undefined))*$/i.test(type) && typeof inputValue !== 'number')
            || (/^(?:boolean)(?:\s*\|\s*(?:null|undefined))*$/i.test(type) && typeof inputValue !== 'boolean')
            || ((/\[\]|\bArray\s*</.test(type)) && !Array.isArray(inputValue))
            || ((/^\{|\b(?:Record|Map|Set)\s*</.test(type)) && !isObject(inputValue));
          if (mismatch) {
            issues.push({
              code: 'INPUT_TYPE_MISMATCH', target: targetLabel, testCaseId: testCase.id,
              message: `Input ${inputName} không khớp type ${parameter.type}.`,
            });
          }
        }
      }
    }
    if (target.kind === 'class-method') {
      const constructorInputs = testCase.constructorInputs ?? {};
      if (!isObject(constructorInputs)) {
        issues.push({
          code: 'INVALID_CONSTRUCTOR_INPUTS', target: targetLabel, testCaseId: testCase.id,
          message: 'constructorInputs phải là JSON object.',
        });
      } else {
        for (const message of validateDataValue(constructorInputs, 'constructorInputs')) {
          issues.push({ code: 'INVALID_CONSTRUCTOR_INPUTS', target: targetLabel, testCaseId: testCase.id, message });
        }
        const constructorParameters = new Map(
          (target.classMethod?.constructorParameters || []).map(parameter => [parameter.name, parameter]),
        );
        for (const parameter of (target.classMethod?.constructorParameters || []).filter(item => !item.optional)) {
          if (!(parameter.name in constructorInputs)) {
            issues.push({
              code: 'MISSING_REQUIRED_CONSTRUCTOR_INPUT', target: targetLabel, testCaseId: testCase.id,
              message: `Thiếu constructor input bắt buộc: ${parameter.name}.`,
            });
          }
        }
        for (const inputName of Object.keys(constructorInputs)) {
          if (!constructorParameters.has(inputName)) {
            issues.push({
              code: 'INVENTED_CONSTRUCTOR_INPUT', target: targetLabel, testCaseId: testCase.id,
              message: `Constructor input không tồn tại: ${inputName}.`,
            });
          }
        }
      }
    }
    if (!isObject(testCase.expected) || !['return', 'throw', 'resolve', 'reject', 'side-effect'].includes(String(testCase.expected.kind))) {
      issues.push({ code: 'INVALID_EXPECTED_RESULT', target: targetLabel, testCaseId: testCase.id, message: 'expected.kind không hợp lệ.' });
    } else if ('value' in testCase.expected) {
      for (const message of validateDataValue(testCase.expected.value, 'expected.value')) {
        issues.push({ code: 'INVALID_EXPECTED_RESULT', target: targetLabel, testCaseId: testCase.id, message });
      }
    }
    if (isObject(testCase.expected)) {
      for (const issue of validateExpectedIntent(testCase.expected)) {
        issues.push({
          code: 'INVALID_EXPECTED_RESULT', target: targetLabel, testCaseId: testCase.id,
          message: `${issue.path}: ${issue.message}`,
        });
      }
    }
    const expectedKind = testCase.expected?.kind;
    if (target.async && ['return', 'throw'].includes(String(expectedKind))) {
      issues.push({
        code: 'ASYNC_ORACLE_KIND_MISMATCH', target: targetLabel, testCaseId: testCase.id,
        message: 'Target async phải dùng expected.kind=resolve hoặc reject.',
      });
    }
    if (!target.async && ['resolve', 'reject'].includes(String(expectedKind))) {
      issues.push({
        code: 'SYNC_ORACLE_KIND_MISMATCH', target: targetLabel, testCaseId: testCase.id,
        message: 'Target đồng bộ không được dùng expected.kind=resolve/reject.',
      });
    }
    if (isObject(testCase.expected) && 'value' in testCase.expected) {
      const expectedValue = testCase.expected.value;
      if (/\bMap\s*</.test(target.returnType) && (!isObject(expectedValue) || expectedValue.$type !== 'map')) {
        issues.push({
          code: 'RETURN_TYPE_ORACLE_MISMATCH', target: targetLabel, testCaseId: testCase.id,
          message: 'Target trả về Map; expected.value phải dùng { "$type": "map", "entries": [...] }.',
        });
      }
      if (/\bSet\s*</.test(target.returnType) && (!isObject(expectedValue) || expectedValue.$type !== 'set')) {
        issues.push({
          code: 'RETURN_TYPE_ORACLE_MISMATCH', target: targetLabel, testCaseId: testCase.id,
          message: 'Target trả về Set; expected.value phải dùng { "$type": "set", "values": [...] }.',
        });
      }
    }
    const branchIds = Array.isArray(testCase.branchIds) ? testCase.branchIds : [];
    if (!Array.isArray(testCase.branchIds)) {
      issues.push({
        code: 'INVALID_BRANCH_REFERENCES',
        target: targetLabel,
        testCaseId: testCase.id,
        message: 'branchIds phải là mảng. Test bổ trợ không gắn với decision branch phải dùng mảng rỗng.',
      });
    }
    for (const branchId of branchIds) {
      if (!validBranches.has(branchId)) {
        issues.push({ code: 'INVENTED_BRANCH', target: targetLabel, testCaseId: testCase.id, message: `Branch không tồn tại: ${branchId}` });
      } else coveredBranches.add(branchId);
    }
    if (!['requirement', 'type-contract', 'existing-test', 'implementation', 'tester-confirmation'].includes(testCase.oracleSource)) {
      issues.push({ code: 'INVALID_ORACLE_SOURCE', target: targetLabel, testCaseId: testCase.id, message: 'oracleSource không hợp lệ.' });
    }
    if (testCase.oracleEvidence !== undefined) {
      for (const issue of validateOracleEvidence(testCase.oracleEvidence)) {
        issues.push({
          code: 'INVALID_ORACLE_EVIDENCE', target: targetLabel, testCaseId: testCase.id,
          message: `${issue.path}: ${issue.message}`,
        });
      }
    }
    if (!Array.isArray(testCase.mocks)) {
      issues.push({ code: 'INVALID_MOCK_PLAN', target: targetLabel, testCaseId: testCase.id, message: 'mocks phải là mảng.' });
    }
    for (const mock of testCase.mocks || []) {
      if (!validDependencies.has(mock.module)) {
        issues.push({ code: 'INVENTED_MOCK', target: targetLabel, testCaseId: testCase.id, message: `Dependency mock không có trong source: ${mock.module}` });
      }
      if (validDependencies.has(mock.module) && !requiredMocks.has(mock.module)) {
        issues.push({
          code: 'MOCK_OF_REAL_DEPENDENCY', target: targetLabel, testCaseId: testCase.id,
          message: `Dependency ${mock.module} không có strategy=mock.`,
        });
      }
      const dependency = mockDependencies.find(item => item.module === mock.module);
      const operations = dependency?.usedMembers || (dependency?.mockKind === 'global'
        ? [dependency.globalName || dependency.module]
        : dependency?.importedNames || []);
      if (operations.length > 1 && (!mock.symbol || !operations.includes(mock.symbol))) {
        issues.push({
          code: 'INVALID_MOCK_SYMBOL', target: targetLabel, testCaseId: testCase.id,
          message: `Mock ${mock.module} phải chỉ rõ symbol: ${operations.join(', ')}.`,
        });
      } else if (mock.symbol && operations.length > 0 && !operations.includes(mock.symbol)) {
        issues.push({
          code: 'INVENTED_MOCK_SYMBOL', target: targetLabel, testCaseId: testCase.id,
          message: `Mock symbol không được Code Reader xác minh: ${mock.module}#${mock.symbol}.`,
        });
      }
      for (const message of validateMockOutcome(mock.behavior, `mocks.${mock.module}.behavior`, true)) {
        issues.push({ code: 'INVALID_MOCK_PLAN', target: targetLabel, testCaseId: testCase.id, message });
      }
    }
    const plannedMocks = new Set((testCase.mocks || []).map(mock => mock.module));
    for (const dependency of requiredMocks) {
      if (!plannedMocks.has(dependency)) {
        issues.push({
          code: 'MISSING_REQUIRED_MOCK', target: targetLabel, testCaseId: testCase.id,
          message: `Test chưa cô lập dependency strategy=mock: ${dependency}.`,
        });
      }
    }
    for (const dependency of mockDependencies) {
      const operations = dependency.usedMembers || [];
      if (operations.length <= 1) continue;
      const plannedOperations = new Set((testCase.mocks || [])
        .filter(mock => mock.module === dependency.module)
        .map(mock => mock.symbol));
      for (const operation of operations) {
        if (!plannedOperations.has(operation)) {
          issues.push({
            code: 'MISSING_REQUIRED_MOCK_OPERATION', target: targetLabel, testCaseId: testCase.id,
            message: `Test chưa cấu hình ${dependency.module}#${operation}.`,
          });
        }
      }
    }
  }
  for (const branchId of validBranches) {
    if (!coveredBranches.has(branchId)) {
      issues.push({ code: 'UNCOVERED_BRANCH', target: targetLabel, message: `Planner chưa lập test cho branch ${branchId}.` });
    }
  }
  return issues;
}

export function validateStructuredUnitPlan(
  plan: StructuredUnitPlan,
  context: UnitContextBundle,
): UnitPlanValidationIssue[] {
  const issues: UnitPlanValidationIssue[] = [];
  if (plan.project?.root !== context.project.projectRoot || plan.project?.name !== context.project.projectName) {
    issues.push({ code: 'PROJECT_MISMATCH', message: 'Planner đã thay đổi project identity.' });
  }
  if (plan.project?.testFramework !== context.project.testFramework) {
    issues.push({ code: 'FRAMEWORK_MISMATCH', message: 'Planner đã thay đổi test framework được Scanner phát hiện.' });
  }
  const planTargets = new Map((plan.targets || []).map(target => [`${target.sourceFile}#${target.symbol}`, target]));
  for (const target of context.targets) {
    const key = `${target.sourceFile}#${target.symbol}`;
    const planTarget = planTargets.get(key);
    if (!planTarget) {
      issues.push({ code: 'MISSING_TARGET', target: key, message: 'Planner bỏ sót target được chọn.' });
      continue;
    }
    issues.push(...validateTarget(planTarget, target));
  }
  for (const key of planTargets.keys()) {
    if (!context.targets.some(target => `${target.sourceFile}#${target.symbol}` === key)) {
      issues.push({ code: 'INVENTED_TARGET', target: key, message: 'Planner tạo target không có trong Code Reader.' });
    }
  }
  return issues;
}

export function unitPlanForSingleTarget(
  plan: StructuredUnitPlan,
  target: UnitTarget,
): StructuredUnitPlan {
  return {
    ...plan,
    targets: plan.targets.filter(item => item.sourceFile === target.sourceFile && item.symbol === target.symbol),
  };
}

export function salvageStructuredUnitPlan(
  plan: StructuredUnitPlan,
  context: UnitContextBundle,
): {
  plan: StructuredUnitPlan | null;
  skippedIssues: UnitPlanValidationIssue[];
  blockingIssues: UnitPlanValidationIssue[];
} {
  const initial = validateStructuredUnitPlan(plan, context);
  if (initial.length === 0) return { plan, skippedIssues: [], blockingIssues: [] };
  const invalidCaseIds = new Set(initial.flatMap(issue => issue.testCaseId ? [issue.testCaseId] : []));
  const targets = plan.targets.map(target => ({
    ...target,
    testCases: target.testCases.filter(testCase => !invalidCaseIds.has(testCase.id)),
  }));
  if (targets.some(target => target.testCases.length === 0)) {
    return { plan: null, skippedIssues: initial, blockingIssues: initial };
  }
  const candidate = { ...plan, targets };
  const after = validateStructuredUnitPlan(candidate, context);
  const toleratedCodes = new Set(['UNCOVERED_BRANCH']);
  const blockingIssues = after.filter(issue => !toleratedCodes.has(issue.code));
  if (blockingIssues.length > 0) return { plan: null, skippedIssues: initial, blockingIssues };
  return {
    plan: candidate,
    skippedIssues: [
      ...initial.filter(issue => issue.testCaseId && invalidCaseIds.has(issue.testCaseId)),
      ...after.filter(issue => toleratedCodes.has(issue.code)),
    ],
    blockingIssues: [],
  };
}
