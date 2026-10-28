/**
 * A request's dimension filter, looked up under its company (budgets P3 spec
 * §2.4, §4): a cost centre or business unit id that is not the company's is a
 * 404, never an empty report, so another tenant's id reveals nothing.
 *
 * Returns the same filter three ways: the members the response names, the
 * actuals filter (`trackingActualRead`, explicit levels) and the budget
 * filter (`trackingDimRollup`), which also needs a project's FNO.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { isValidUUID } from '@/lib/validation';
import { deriveFnoId, loadCostCentreChains } from '@/modules/accounting/services/gl/dimensions/dimensionDerivation';
import type { BudgetFilter } from './trackingDimRollup';
import { TrackingError, type BudgetTrackingReport, type TrackingFilter, type TrackingMemberRef, type TrackingParams } from './trackingTypes';

export interface ResolvedTrackingFilter {
  members: BudgetTrackingReport['filter'];
  actual: TrackingFilter;
  budget: BudgetFilter;
}

interface Centre extends TrackingMemberRef { ccType: string | null }

function assertId(name: string, id: string): string {
  if (!isValidUUID(id)) throw new TrackingError(400, `${name} must be a UUID`);
  return id.toLowerCase();
}

async function centre(companyId: string, name: string, raw: string): Promise<Centre> {
  const id = assertId(name, raw);
  const rows = (await sql`
    SELECT id::TEXT AS id, code, name, cc_type FROM cost_centres WHERE company_id = ${companyId}::UUID AND id = ${id}::UUID
  `) as DbRow[];
  const r = rows[0];
  if (!r) throw new TrackingError(404, `Cost centre ${id} not found`);
  return { id: String(r.id).toLowerCase(), code: String(r.code), name: String(r.name), ccType: r.cc_type == null ? null : String(r.cc_type) };
}

async function unit(companyId: string, raw: string): Promise<TrackingMemberRef> {
  const id = assertId('bu_id', raw);
  const rows = (await sql`
    SELECT id::TEXT AS id, code, name FROM business_units WHERE company_id = ${companyId}::UUID AND id = ${id}::UUID
  `) as DbRow[];
  const r = rows[0];
  if (!r) throw new TrackingError(404, `Business unit ${id} not found`);
  return { id: String(r.id).toLowerCase(), code: String(r.code), name: String(r.name) };
}

async function fnoOf(companyId: string, id: string): Promise<string | null> {
  return deriveFnoId(id, await loadCostCentreChains(companyId, [id]));
}

const ref = (c: Centre): TrackingMemberRef => ({ id: c.id, code: c.code, name: c.name });

/** Sequential lookups (one pg client under withAuth). */
export async function resolveTrackingFilter(companyId: string, p: TrackingParams): Promise<ResolvedTrackingFilter> {
  const out: ResolvedTrackingFilter = { members: {}, actual: {}, budget: {} };
  if (p.cc1Id !== undefined) {
    const c = await centre(companyId, 'cc1_id', p.cc1Id);
    out.members.cc1 = ref(c);
    out.actual.cc1 = c.id;
    out.budget.cc1 = c.id;
  }
  if (p.cc2Id !== undefined) {
    const c = await centre(companyId, 'cc2_id', p.cc2Id);
    out.members.cc2 = ref(c);
    out.actual.cc2 = c.id;
    out.budget.cc2 = { id: c.id, fno: await fnoOf(companyId, c.id) };
  }
  if (p.buId !== undefined) {
    const u = await unit(companyId, p.buId);
    out.members.bu = u;
    out.actual.bu = u.id;
    out.budget.bu = u.id;
  }
  if (p.costCentreId !== undefined) {
    const c = await centre(companyId, 'cost_centre_id', p.costCentreId);
    out.members.costCentre = ref(c);
    out.actual.costCentre = c.id;
    out.budget.costCentre = c.ccType === 'cc1'
      ? { id: c.id, level: 'cc1', fno: c.id }
      : { id: c.id, level: 'cc2', fno: await fnoOf(companyId, c.id) };
  }
  return out;
}
