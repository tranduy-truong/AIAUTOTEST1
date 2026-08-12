import type { StructuredUnitPlan } from './schema.js';

export function renderUnitPlanMarkdown(plan: StructuredUnitPlan): string {
  const lines = [
    '# UNIT TEST PLAN',
    '',
    `- Dự án: ${plan.project.name}`,
    `- Framework: ${plan.project.testFramework}`,
    `- Số target: ${plan.targets.length}`,
    '',
  ];
  for (const target of plan.targets) {
    lines.push(`## ${target.sourceFile} — ${target.symbol}`, '');
    lines.push(`- Chế độ chạy: ${target.executionMode}`);
    lines.push(`- Testability profile: ${target.profile}`);
    lines.push(`- Source hash: \`${target.sourceHash}\``, '');
    lines.push('| ID | Trường hợp | Branch | Oracle |', '|---|---|---|---|');
    for (const testCase of target.testCases) {
      lines.push(`| ${testCase.id} | ${testCase.name.replace(/\|/g, '\\|')} | ${testCase.branchIds.join(', ')} | ${testCase.oracleSource} |`);
    }
    lines.push('');
  }
  if (plan.clarifications.length > 0) {
    lines.push('## Điểm cần xác nhận nghiệp vụ', '', ...plan.clarifications.map(item => `- ${item}`), '');
  }
  return `${lines.join('\n').trim()}\n`;
}
