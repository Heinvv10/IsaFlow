import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(path, 'utf8');

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
    const text = source('src/modules/accounting/services/payroll/payrollRunLock.ts');
    expect(text.match(/approval_plan_hash = NULL/g)).toHaveLength(2);
    expect(text.match(/approval_revision = gen_random_uuid\(\)/g)).toHaveLength(2);
    expect(text).toContain('approval_grandfathered_at = NULL');
  });

  it('records the six distinct human/control stages plus decline', () => {
    const text = source('src/modules/accounting/services/payroll/payRunApprovalAudit.ts');
    for (const event of ['prepared', 'requested', 'authorised', 'executed', 'reopened', 'reversed']) {
      expect(text).toContain(`'${event}'`);
    }
  });
});
