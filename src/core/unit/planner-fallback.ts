import { buildDeterministicUnitPlan } from './deterministic-plan-builder.js';
import {
  anchorStructuredUnitPlan,
  parseStructuredUnitPlan,
  salvageStructuredUnitPlan,
  validateStructuredUnitPlan,
  type UnitPlanValidationIssue,
} from './plan-validator.js';
import type { StructuredUnitPlan, UnitContextBundle } from './schema.js';

export interface UnitPlannerResolution {
  plan: StructuredUnitPlan | null;
  issues: UnitPlanValidationIssue[];
  skippedIssues: UnitPlanValidationIssue[];
  diagnostics: UnitPlanValidationIssue[];
  mode: 'ai' | 'salvaged-ai' | 'deterministic' | 'deterministic-fallback';
}

export function resolveDeterministicUnitPlan(context: UnitContextBundle): UnitPlannerResolution {
  const plan = buildDeterministicUnitPlan(context);
  const validationIssues = validateStructuredUnitPlan(plan, context);
  const blocking = validationIssues.filter(issue => issue.code !== 'UNCOVERED_BRANCH');
  return blocking.length === 0
    ? {
      plan,
      issues: [],
      skippedIssues: [],
      diagnostics: validationIssues,
      mode: 'deterministic',
    }
    : {
      plan: null,
      issues: blocking,
      skippedIssues: [],
      diagnostics: validationIssues,
      mode: 'deterministic',
    };
}

/**
 * Resolves an optional AI proposal into a safe Unit Plan. The AI output is
 * never a pipeline prerequisite: malformed or contract-invalid proposals are
 * replaced from the AST-owned Unit Context. Only a failure in that local,
 * deterministic reconstruction remains blocking.
 */
export function resolveUnitPlannerProposal(
  rawOutput: string,
  context: UnitContextBundle,
  apiError = false,
): UnitPlannerResolution {
  let plan = apiError ? null : parseStructuredUnitPlan(rawOutput);
  if (plan) plan = anchorStructuredUnitPlan(plan, context);
  let issues: UnitPlanValidationIssue[] = plan
    ? validateStructuredUnitPlan(plan, context)
    : [{
      code: apiError ? 'AI_API_ERROR' : 'INVALID_JSON',
      message: apiError ? rawOutput : 'AI Planner không trả về Unit Plan JSON hợp lệ.',
    }];
  const diagnostics = [...issues];

  if (plan && issues.length === 0) {
    return { plan, issues: [], skippedIssues: [], diagnostics: [], mode: 'ai' };
  }
  if (plan) {
    const salvaged = salvageStructuredUnitPlan(plan, context);
    if (salvaged.plan) {
      return {
        plan: salvaged.plan,
        issues: [],
        skippedIssues: salvaged.skippedIssues,
        diagnostics: [...diagnostics, ...salvaged.skippedIssues],
        mode: 'salvaged-ai',
      };
    }
    issues = salvaged.blockingIssues;
  }

  const fallback = resolveDeterministicUnitPlan(context);
  if (fallback.plan) {
    return {
      plan: fallback.plan,
      issues: [],
      skippedIssues: [],
      diagnostics: [...diagnostics, ...fallback.diagnostics],
      mode: 'deterministic-fallback',
    };
  }
  return {
    plan: null,
    issues: fallback.issues,
    skippedIssues: [],
    diagnostics: [...diagnostics, ...issues, ...fallback.diagnostics],
    mode: 'deterministic-fallback',
  };
}
