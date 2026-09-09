import type { DbRow } from '@/lib/neon';
import { runPeriodControl, type PeriodControlOptions } from '../controls/periodControl';
import { recordCommittedChange } from '../controls/changeEventService';
import { readControlEntityVersion } from '../controls/operationVersions';
import type { FiscalPeriod } from '../../types/gl.types';
import { mapFiscalPeriod } from './fiscalPeriodMapping';

export function closePeriod(companyId: string, id: string, userId: string, options?: PeriodControlOptions): Promise<FiscalPeriod> {
  return runPeriodControl(companyId, { entityType: 'fiscal_period', entityId: id, operation: 'fiscal_period.close' }, options, async ctx => {
    const [period] = await ctx.sql`SELECT * FROM fiscal_periods WHERE company_id=${companyId}::uuid AND id=${id}::uuid FOR UPDATE` as DbRow[];
    if (!period) throw new Error('Fiscal period not found');
    if (period.status !== 'open') throw new Error('Only an open period can be closed');
    const prior = await ctx.sql`SELECT id FROM fiscal_periods WHERE company_id=${companyId}::uuid
      AND fiscal_year=${period.fiscal_year} AND period_number<${period.period_number} AND status='open'`;
    if (prior.length) throw new Error('Cannot close period while prior periods are still open');
    const rows = await ctx.sql`UPDATE fiscal_periods SET status='closed',closed_by=${ctx.principal.personId}::uuid,closed_at=clock_timestamp()
      WHERE company_id=${companyId}::uuid AND id=${id}::uuid AND status='open' RETURNING *` as DbRow[];
    if (rows.length !== 1) throw new Error('Fiscal period state changed');
    return mapFiscalPeriod(rows[0]!);
  }, userId);
}
export function lockPeriod(companyId: string, id: string, options?: PeriodControlOptions): Promise<FiscalPeriod> {
  return changeClosedPeriod(companyId, id, 'locked', options);
}
export function reopenPeriod(companyId: string, id: string, options?: PeriodControlOptions): Promise<FiscalPeriod> {
  return changeClosedPeriod(companyId, id, 'open', options);
}
function changeClosedPeriod(companyId: string, id: string, target: 'open' | 'locked', options?: PeriodControlOptions): Promise<FiscalPeriod> {
  return runPeriodControl(companyId, { entityType: 'fiscal_period', entityId: id,
    operation: target === 'open' ? 'fiscal_period.reopen' : 'fiscal_period.lock' }, options, async ctx => {
    const [before] = await ctx.sql`SELECT * FROM fiscal_periods WHERE company_id=${companyId}::uuid AND id=${id}::uuid FOR UPDATE` as DbRow[];
    if (!before || before.status !== 'closed') throw new Error('Period must be closed before locking or reopening');
    const rows = target === 'open'
      ? await ctx.sql`UPDATE fiscal_periods SET status='open',closed_by=NULL,closed_at=NULL
          WHERE company_id=${companyId}::uuid AND id=${id}::uuid AND status='closed' RETURNING *`
      : await ctx.sql`UPDATE fiscal_periods SET status='locked'
          WHERE company_id=${companyId}::uuid AND id=${id}::uuid AND status='closed' RETURNING *`;
    if (rows.length !== 1) throw new Error('Fiscal period state changed');
    return mapFiscalPeriod(rows[0]!);
  });
}
export function closeYear(companyId: string, fiscalYear: number, userId: string, options?: PeriodControlOptions): Promise<FiscalPeriod[]> {
  return runPeriodControl(companyId, { entityType: 'fiscal_year', entityId: String(fiscalYear), operation: 'year.close' }, options, async (ctx, permit) => {
    const before = await ctx.sql`SELECT * FROM fiscal_periods WHERE company_id=${companyId}::uuid AND fiscal_year=${fiscalYear} ORDER BY id FOR UPDATE` as DbRow[];
    if (!before.length) throw new Error('No fiscal periods found');
    if (before.every(row => row.status === 'closed' || row.status === 'locked')) throw new Error('Fiscal year is already closed');
    const rows = await ctx.sql`UPDATE fiscal_periods SET status='closed',closed_by=${ctx.principal.personId}::uuid,closed_at=clock_timestamp()
      WHERE company_id=${companyId}::uuid AND fiscal_year=${fiscalYear} AND status NOT IN ('closed','locked') RETURNING *` as DbRow[];
    for (const after of [...rows].sort((a,b) => String(a.id) < String(b.id) ? -1 : 1)) {
      const ref = { entityType: 'fiscal_period', entityId: String(after.id) };
      const version = await readControlEntityVersion(ctx, ref);
      if (!version) throw new Error('Fiscal period baseline unavailable');
      await recordCommittedChange(ctx, { ...ref, previousVersion: version.version, newVersion: version.version + 1,
        action: 'year_closed_period', accountingDate: permit.accountingDate, before: before.find(row => row.id === after.id)!, after,
        bindingHash: null, protectedEvidenceRef: null, operationId: permit.operationId });
    }
    return rows.map(mapFiscalPeriod);
  }, userId);
}
