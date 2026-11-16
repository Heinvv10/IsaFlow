/**
 * Wave 6 FQa (grill F28): the run-kind guard lives in the SERVICES, so every caller (routes, MCP tools, bureau)
 * is covered by one call. This census pins (1) that each guarded service function calls assertRunKindSupported with
 * its own action, and (2) the set of source files that call those services, so a new caller is looked at.
 * The behaviour (refusal before any write) is proven in tests/integration/w6-freq-schema.int.test.ts; this file only
 * stops a call site being dropped or a new path appearing unnoticed.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

const P = 'src/modules/accounting/services/payroll';
const GUARDED: Array<{ file: string; fn: string; action: string }> = [
  { file: `${P}/payrollRunService.ts`, fn: 'calculatePayrollRun', action: 'calculate' },
  { file: `${P}/payrollApprovalService.ts`, fn: 'approvePayrollRun', action: 'approve' },
  { file: `${P}/payrollApprovalService.ts`, fn: 'previewPayrollApproval', action: 'approve' },
  { file: `${P}/payrollJournalPostingService.ts`, fn: 'postPayrollRunJournal', action: 'post' },
  { file: `${P}/payrollRunReopen.ts`, fn: 'reopenPayrollRun', action: 'reopen' },
  { file: `${P}/payslipModel.ts`, fn: 'getPayslips', action: 'payslip' },
  // The R-035 request writer (approval-requests.ts): no request is raised for a run this release cannot approve.
  { file: `${P}/payRunApprovalControl.ts`, fn: 'preparePayRunApprovalRequest', action: 'approve' },
];

/** The body of `export async function fn(` up to the next top-level `}` line. */
function bodyOf(source: string, fn: string): string {
  const start = source.indexOf(`export async function ${fn}(`);
  if (start < 0) return '';
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end < 0 ? undefined : end);
}

const CALLERS = [
  'pages/api/accounting/approval-requests.ts',
  'pages/api/payroll/runs/[id]/approve.ts',
  'pages/api/payroll/runs/[id]/calculate.ts',
  'pages/api/payroll/runs/[id]/journal-plan.ts',
  'pages/api/payroll/runs/[id]/payslips.ts',
  'pages/api/payroll/runs/[id]/reopen.ts',
  'src/lib/mcp/tools/writePayroll.ts',
  'src/lib/mcp/tools/writePayrollRun.ts',
  'src/lib/mcp/tools/writePayrollRunCalculate.ts',
  `${P}/payrollApprovalService.ts`,
  `${P}/payrollJournalPostingService.ts`,
  `${P}/payrollRunLock.ts`,
  `${P}/payrollRunReopen.ts`,
  `${P}/payrollRunRowWrite.ts`,
  `${P}/payrollRunService.ts`,
  `${P}/payslipModel.ts`,
  `${P}/payRunApprovalControl.ts`,
];

describe('run-kind guard census (wave 6 FQa, grill F28)', () => {
  it.each(GUARDED)('$fn calls assertRunKindSupported for $action', ({ file, fn, action }) => {
    const body = bodyOf(readFileSync(file, 'utf8'), fn);
    expect(body, `${fn} not found in ${file}`).not.toBe('');
    expect(body).toMatch(new RegExp(`assertRunKindSupported\\([^)]*'${action}'`));
  });

  it('every source file calling a guarded service is listed (look at a new one, then add it)', () => {
    const names = GUARDED.map((g) => g.fn).join('|');
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'pages'], { encoding: 'utf8' })
      .split('\n').filter((f) => /\.tsx?$/.test(f))
      .filter((f) => new RegExp(`\\b(${names})\\(`).test(readFileSync(f, 'utf8')))
      .sort();
    expect(files).toEqual([...CALLERS].sort());
  });
});
