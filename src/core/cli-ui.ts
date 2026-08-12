import path from 'path';

type Tone = 'info' | 'success' | 'warning' | 'error' | 'muted' | 'accent';

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  cyan: '\u001b[36m',
  brightCyan: '\u001b[96m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  gray: '\u001b[90m',
  white: '\u001b[97m',
};

function colorsEnabled(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
}

function decorate(value: string, ...codes: string[]): string {
  return colorsEnabled() ? `${codes.join('')}${value}${ANSI.reset}` : value;
}

function toneColor(tone: Tone): string {
  if (tone === 'success') return ANSI.green;
  if (tone === 'warning') return ANSI.yellow;
  if (tone === 'error') return ANSI.red;
  if (tone === 'muted') return ANSI.gray;
  if (tone === 'accent') return ANSI.brightCyan;
  return ANSI.cyan;
}

export const paint = {
  bold: (value: string) => decorate(value, ANSI.bold),
  accent: (value: string) => decorate(value, ANSI.brightCyan, ANSI.bold),
  success: (value: string) => decorate(value, ANSI.green),
  warning: (value: string) => decorate(value, ANSI.yellow),
  error: (value: string) => decorate(value, ANSI.red),
  muted: (value: string) => decorate(value, ANSI.gray),
  white: (value: string) => decorate(value, ANSI.white),
};

export function header(): void {
  const border = '━'.repeat(62);
  console.log(decorate(`\n${border}`, ANSI.brightCyan));
  console.log(`${paint.accent('  AI TESTKIT')}  ${paint.muted('Planner  •  Generator  •  Healer')}`);
  console.log(decorate(border, ANSI.brightCyan));
  console.log(paint.muted('  Kiểm thử E2E, Integration và Unit Test có kiểm chứng\n'));
}

export function section(step: string, title: string, subtitle?: string): void {
  console.log(decorate(`\n━━ ${step}  ${title.toUpperCase()} ${'━'.repeat(Math.max(1, 48 - title.length))}`, ANSI.cyan, ANSI.bold));
  if (subtitle) console.log(`   ${paint.muted(subtitle)}`);
}

export function success(message: string): void {
  console.log(`${paint.success('✔')} ${message}`);
}

export function info(message: string): void {
  console.log(`${paint.accent('●')} ${message}`);
}

export function warning(message: string): void {
  console.warn(`${paint.warning('▲')} ${paint.warning(message)}`);
}

export function error(message: string): void {
  console.error(`${paint.error('✖')} ${paint.error(message)}`);
}

export function progress(current: number, total: number, message: string): void {
  console.log(`${paint.accent(`[${current}/${total}]`)} ${message}`);
}

export function detail(label: string, value: string): void {
  console.log(`   ${paint.muted(`${label}:`)} ${value}`);
}

export function artifact(label: string, filePath: string): void {
  detail(label, paint.muted(filePath));
}

export function fileCreated(filePath: string): void {
  success(`Đã tạo ${paint.bold(path.basename(filePath))}`);
  artifact('Thư mục', path.dirname(filePath));
}

export function summary(
  title: string,
  rows: Array<[string, string]>,
  tone: Tone = 'info',
): void {
  const color = toneColor(tone);
  const width = 62;
  const top = `╭${'─'.repeat(width)}╮`;
  const bottom = `╰${'─'.repeat(width)}╯`;
  console.log(decorate(`\n${top}`, color));
  console.log(decorate(`│  ${title.toUpperCase().padEnd(width - 2)}│`, color, ANSI.bold));
  console.log(decorate(`├${'─'.repeat(width)}┤`, color));
  for (const [label, value] of rows) {
    const plain = `  ${label.padEnd(18)} ${value}`;
    const clipped = plain.length > width ? `${plain.slice(0, width - 1)}…` : plain;
    console.log(`${decorate('│', color)}${clipped.padEnd(width)}${decorate('│', color)}`);
  }
  console.log(decorate(bottom, color));
}

export function menuChoice(index: string, title: string, description: string): string {
  return `${paint.accent(index.padStart(2, '0'))}  ${paint.bold(title)}  ${paint.muted(description)}`;
}

export function profile(value: string): string {
  return paint.muted(`[${value}]`);
}

export function oracleSummary(counts: {
  specRequirement: number;
  specTesterConfirmed: number;
  characterization: number;
  sourceConflict: number;
  needsOracle: number;
}): void {
  summary('ORACLE VALIDATION SUMMARY', [
    ['Specification (Requirement)', paint.success(`${counts.specRequirement} test cases`)],
    ['Specification (Tester Approved)', paint.success(`${counts.specTesterConfirmed} test cases`)],
    ['Characterization (Source Derived)', paint.warning(`${counts.characterization} test cases`)],
    ['Conflict with Specification', paint.error(`${counts.sourceConflict} test cases`)],
    ['Needs Oracle / Invalid', paint.error(`${counts.needsOracle} test cases`)],
  ], counts.sourceConflict > 0 || counts.needsOracle > 0 ? 'error' : 'info');
}

export function testExecutionSummary(execution: {
  specPassed: number;
  specTotal: number;
  charPassed: number;
  charTotal: number;
  conflicts: number;
  needsOracle: number;
}): void {
  console.log(`\n${paint.bold('📊 TỔNG HỢP KẾT QUẢ THỰC THI (ORACLE TAXONOMY):')}`);
  console.log(`  ${paint.success('✔')} ${paint.bold('Specification Tests:')}      ${execution.specPassed}/${execution.specTotal} passed`);
  if (execution.charTotal > 0) {
    console.log(`  ${paint.warning('⚠')} ${paint.bold('Characterization Tests:')}   ${execution.charPassed}/${execution.charTotal} passed ${paint.muted('(⚠ Chỉ xác nhận code không bị trôi hành vi)')}`);
  }
  if (execution.conflicts > 0) {
    console.log(`  ${paint.error('✖')} ${paint.bold('Source Conflicts:')}          ${execution.conflicts} ${paint.error('(Cần sửa bug trong source code)')}`);
  }
  if (execution.needsOracle > 0) {
    console.log(`  ${paint.error('?')} ${paint.bold('Needs Oracle:')}              ${execution.needsOracle} ${paint.error('(Thiếu expected result)')}`);
  }
}

