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
import type { ReturnForm, ReturnVersion } from './returnVersionTypes';

export interface DriftField { name: string; recorded: number; current: number }
export interface ReturnDrift { drifted: boolean; fields: DriftField[] }

export interface ReturnVersionView extends ReturnVersion {
  /** Null for a superseded version. */
  drift: ReturnDrift | null;
  /** The VAT period lock behind this version has been unlocked outside the lifecycle. */
  lockRemoved: boolean;
}

export interface VatReturnRecord {
  status: string;
  outputTax: number;
  inputTax: number;
  netVat: number;
  sarsReference: string | null;
  submittedAt: string | null;
  /** True when its figures differ from the live version's recorded figures. */
  mismatch: boolean;
}

const cents = (n: number): number => Math.round(n * 100) / 100;
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

function compare(recorded: Record<string, unknown>, current: Record<string, number>): ReturnDrift {
  const fields = Object.entries(current)
    .map(([name, now]) => ({ name, recorded: cents(num(recorded[name])), current: cents(now) }))
    .filter((f) => f.recorded !== f.current);
  return { drifted: fields.length > 0, fields };
}

async function currentFigures(
  companyId: string, form: ReturnForm, start: string, end: string,
): Promise<Record<string, number>> {
  if (form === 'VAT201') {
    const { totals } = await getVat201Report(companyId, start, end, { detail: 'summary' });
    return { outputTax: totals.outputTax, inputTax: totals.inputTax, netVat: totals.netVat };
  }
  const e = await generateEMP201(companyId, start, end);
  return {
    totalPAYE: e.totalPAYE, totalETI: e.totalETI, payePayable: e.payePayable, totalUIF: e.totalUIF,
    totalSDL: e.totalSDL, employeeCount: e.employeeCount, totalTaxableRemuneration: e.totalTaxableRemuneration,
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

async function vatReturnRecord(
  companyId: string, start: string, end: string, live: ReturnVersion | undefined,
): Promise<VatReturnRecord | null> {
  const rows = (await sql`
    SELECT status, total_output_tax, total_input_tax, net_vat, sars_reference, submitted_at
    FROM vat_returns
    WHERE company_id = ${companyId}::UUID AND period_start = ${start}::DATE AND period_end = ${end}::DATE
  `) as DbRow[];
  const r = rows[0];
  if (!r) return null;
  const rec = { outputTax: cents(num(r.total_output_tax)), inputTax: cents(num(r.total_input_tax)), netVat: cents(num(r.net_vat)) };
  const mismatch = live !== undefined && (
    rec.outputTax !== cents(num(live.figures.outputTax)) || rec.inputTax !== cents(num(live.figures.inputTax))
    || rec.netVat !== cents(num(live.figures.netVat)));
  return {
    status: String(r.status), ...rec, sarsReference: r.sars_reference == null ? null : String(r.sars_reference),
    submittedAt: r.submitted_at == null ? null : new Date(r.submitted_at as string | Date).toISOString(), mismatch,
  };
}

export async function listVersions(
  companyId: string, form: ReturnForm, start: string, end: string,
): Promise<{ versions: ReturnVersionView[]; vatReturn: VatReturnRecord | null }> {
  const versions = await listVersionRows(companyId, form, start, end);
  const live = versions.find((v) => v.status !== 'superseded');
  const removed = await removedLocks(companyId, versions);
  const now = live ? await currentFigures(companyId, form, start, end) : null;
  const view = versions.map((v): ReturnVersionView => ({
    ...v,
    drift: v === live && now ? compare(v.figures, now) : null,
    lockRemoved: v.vatPeriodLockId !== null && removed.has(v.vatPeriodLockId),
  }));
  return { versions: view, vatReturn: form === 'VAT201' ? await vatReturnRecord(companyId, start, end, live) : null };
}
