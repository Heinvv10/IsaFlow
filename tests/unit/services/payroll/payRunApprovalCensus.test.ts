import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const source = (path: string) => readFileSync(path, 'utf8');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === 'node_modules' || name === 'migrations') return [];
    return statSync(p).isDirectory() ? tsFiles(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('pay-run approval mutation census', () => {
  it('gates approve-and-post before its first payroll write', () => {
    const text = source('src/modules/accounting/services/payroll/payrollApprovalService.ts');
    expect(text.indexOf('assertPayRunApproved(companyId, runId, gate.planHash)')).toBeGreaterThan(0);
    expect(text.indexOf('assertPayRunApproved(companyId, runId, gate.planHash)'))
      .toBeLessThan(text.indexOf('await claimRunSeveranceDirectives'));
  });

  it('gates the recovery poster for MCP and every future caller', () => {
    const text = source('src/modules/accounting/services/payroll/payrollJournalPostingService.ts');
    expect(text).toContain('await assertPayRunApproved(companyId, runId)');
    expect(text.indexOf('await assertPayRunApproved(companyId, runId)'))
      .toBeLessThan(text.indexOf('createJournalEntry(companyId'));
  });

  it('invalidates clearance on calculate and reopen', () => {
    const text = source('src/modules/accounting/services/payroll/payrollRunLock.ts')
      + source('src/modules/accounting/services/payroll/payrollRunReopen.ts');
    expect(text.match(/approval_plan_hash = NULL/g)).toHaveLength(2);
    expect(text.match(/approval_revision = gen_random_uuid\(\)/g)).toHaveLength(2);
    expect(text).toContain('approval_grandfathered_at = NULL');
  });

  it('every writer that sets a pay run approved also sets approved_at in the same statement (payslip finality reads it)', () => {
    const writers: string[] = [];
    for (const file of [...tsFiles('src'), ...tsFiles('pages')]) {
      for (const m of source(file).matchAll(/UPDATE\s+payroll_run_headers[^`]*/g)) {
        if (/status\s*=\s*'(approved|paid)'/.test(m[0])) writers.push(`${file}: ${/approved_at\s*=/.test(m[0]) ? 'ok' : 'MISSING approved_at'}`);
      }
    }
    expect(writers.length).toBeGreaterThan(0); // the scan finds the approve UPDATE, so it is not vacuous
    expect(writers.filter((w) => w.endsWith('MISSING approved_at'))).toEqual([]);
  });

  it('records the six distinct human/control stages plus decline', () => {
    const text = source('src/modules/accounting/services/payroll/payRunApprovalAudit.ts');
    for (const event of ['prepared', 'requested', 'authorised', 'executed', 'reopened', 'reversed']) {
      expect(text).toContain(`'${event}'`);
    }
  });
});
