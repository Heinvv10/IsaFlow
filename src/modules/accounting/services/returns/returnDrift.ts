/**
 * Versions of a return with their drift (wave 5 L1a). Read-only: nothing here writes, and it
 * never posts or touches vat_returns (the older submitVATReturn record, shown beside the lifecycle).
 *
 * DRIFT = re-generate the return now and compare it with what was finalised. Only the live
 * (non-superseded) version is compared; a superseded one is history.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { getVat201Report } from '@/modules/accounting/services/reports/vat201ReportService';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { listVersionRows } from './returnVersionStore';
import { getVatReturnRecord } from './vatReturnRecord';
import { empRunDrift } from './empDrift';
import { empEtiDrift } from './empEtiDrift';
import type { ReturnForm, ReturnVersion, VatReturnRecord } from './returnVersionTypes';

export interface DriftField { name: string; recorded: number; current: number }
export interface ReturnDrift {
  drifted: boolean;
  fields: DriftField[];
  /** Non-numeric parts that changed: 'sarsFields' (VAT201) or 'runs' (EMP201: run set or a plan hash). */
  changed: string[];
  /** EMP201: summed runs no longer final under R-035. */
  unfinalRuns: number;
  /** Why a figure moved without the source changing (a calculation change, wave 5 ET). Absent when none. */
  notes?: string[];
}

export interface ReturnVersionView extends ReturnVersion {
  /** Null for a superseded version. */
  drift: ReturnDrift | null;
  /** The VAT period lock behind this version has been unlocked outside the lifecycle. */
  lockRemoved: boolean;
}

const cents = (n: number): number => Math.round(n * 100) / 100;
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

function compare(recorded: Record<string, unknown>, current: Record<string, number>): DriftField[] {
  return Object.entries(current)
    .map(([name, now]) => ({ name, recorded: cents(num(recorded[name])), current: cents(now) }))
    .filter((f) => f.recorded !== f.current);
}

/** The recorded directive totals as the same numeric fields empRunDrift reports for now. */
function recordedDirective(figures: Record<string, unknown>): Record<string, unknown> {
  const t = (figures.directiveTotals ?? {}) as Record<string, unknown>;
  return { directiveCount: t.count, directiveGross: t.gross, directivePaye: t.paye };
}

export async function driftOf(companyId: string, v: ReturnVersion): Promise<ReturnDrift> {
  const { formType: form, periodStart: start, periodEnd: end, figures } = v;
  if (form === 'VAT201') {
    const r = await getVat201Report(companyId, start, end, { detail: 'summary' });
    const fields = compare(figures, { outputTax: r.totals.outputTax, inputTax: r.totals.inputTax, netVat: r.totals.netVat });
    // Both sides went through JSON, so the same producer gives the same key order.
    const changed = JSON.stringify(figures.sarsFields ?? []) !== JSON.stringify(JSON.parse(JSON.stringify(r.boxes)))
      ? ['sarsFields'] : [];
    return { drifted: fields.length + changed.length > 0, fields, changed, unfinalRuns: 0 };
  }
  const e = await generateEMP201(companyId, start, end);
  const run = await empRunDrift(companyId, figures, e);
  const eti = empEtiDrift(figures, e);
  const fields = [
    ...compare(figures, {
      totalPAYE: e.totalPAYE, totalETI: e.totalETI, payePayable: e.payePayable, totalUIF: e.totalUIF,
      totalSDL: e.totalSDL, employeeCount: e.employeeCount, totalTaxableRemuneration: e.totalTaxableRemuneration,
    }),
    ...compare(recordedDirective(figures), run.directive),
    ...eti.fields,
  ].filter((f) => !(eti.payableExplained && f.name === 'payePayable'));
  const changed = run.runsChanged ? ['runs'] : [];
  return {
    drifted: fields.length + changed.length > 0 || run.unfinalRuns > 0, fields, changed, unfinalRuns: run.unfinalRuns,
    ...(eti.notes.length > 0 ? { notes: eti.notes } : {}),
  };
}

async function removedLocks(companyId: string, versions: ReturnVersion[]): Promise<Set<string>> {
  const ids = versions.map((v) => v.vatPeriodLockId).filter((i): i is string => i !== null);
  if (ids.length === 0) return new Set();
  const rows = (await sql`
    SELECT id FROM vat_period_locks
    WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[]) AND unlocked_at IS NOT NULL
  `) as DbRow[];
  return new Set(rows.map((r) => String(r.id)));
}

export async function listVersions(
  companyId: string, form: ReturnForm, start: string, end: string,
): Promise<{ versions: ReturnVersionView[]; vatReturn: VatReturnRecord | null }> {
  const versions = await listVersionRows(companyId, form, start, end);
  const live = versions.find((v) => v.status !== 'superseded');
  const removed = await removedLocks(companyId, versions);
  const view: ReturnVersionView[] = [];
  for (const v of versions) {
    view.push({
      ...v,
      drift: v === live ? await driftOf(companyId, v) : null,
      lockRemoved: v.vatPeriodLockId !== null && removed.has(v.vatPeriodLockId),
    });
  }
  const vatReturn = form === 'VAT201'
    ? await getVatReturnRecord(companyId, start, end, live ? {
      outputTax: num(live.figures.outputTax), inputTax: num(live.figures.inputTax), netVat: num(live.figures.netVat),
    } : undefined)
    : null;
  return { versions: view, vatReturn };
}
