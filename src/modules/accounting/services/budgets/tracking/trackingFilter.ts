/**
 * A request's dimension filter, looked up under its company (budgets P3 spec
 * §2.4, §4): a cost centre or business unit id that is not the company's is a
 * 404, never an empty report, so another tenant's id reveals nothing.
 *
 * `cc1_id` must name a CC1 centre and `cc2_id` a CC2 (400 otherwise): an
 * explicit level given a centre of the other kind can only match legacy
 * cross-tags, which is not what the caller asked for. `cost_centre_id` is
 * either level and takes any centre.
 *
 * Returns the members the response names, the actuals filter
 * (`trackingActualRead`, explicit levels), the CC2 ids whose chains the
 * budget filter needs, and `budgetFilter(nodes)`, built once the request has
 * loaded every chain it needs in one query (the service does).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { isValidUUID } from '@/lib/validation';
import { deriveFnoId, type CostCentreNode } from '@/modules/accounting/services/gl/dimensions/dimensionDerivation';
import type { BudgetFilter } from './trackingDimRollup';
import { TrackingError, type BudgetTrackingReport, type TrackingFilter, type TrackingMemberRef, type TrackingParams } from './trackingTypes';

export interface ResolvedTrackingFilter {
  members: BudgetTrackingReport['filter'];
  actual: TrackingFilter;
  /** The CC2 the filter names, whose FNO the budget filter needs. */
  chainIds: string[];
  budgetFilter: (nodes: ReadonlyMap<string, CostCentreNode>) => BudgetFilter;
}

export interface Centre extends TrackingMemberRef { ccType: string | null }

function assertId(name: string, id: string): string {
  if (!isValidUUID(id)) throw new TrackingError(400, `${name} must be a UUID`);
  return id.toLowerCase();
}

/** Pure: an explicit-level filter must name a centre of that level. */
export function assertCentreLevel(name: 'cc1_id' | 'cc2_id', c: Centre): Centre {
  const level = name === 'cc1_id' ? 'cc1' : 'cc2';
  if (c.ccType !== level) {
    throw new TrackingError(400, `${name} must name a ${level.toUpperCase()} cost centre; ${c.code} is ${c.ccType ?? 'untyped'}`);
  }
  return c;
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

const ref = (c: Centre): TrackingMemberRef => ({ id: c.id, code: c.code, name: c.name });

/** Sequential lookups (one pg client under withAuth). */
export async function resolveTrackingFilter(companyId: string, p: TrackingParams): Promise<ResolvedTrackingFilter> {
  const members: BudgetTrackingReport['filter'] = {};
  const actual: TrackingFilter = {};
  let cc1: string | undefined;
  let cc2: string | undefined;
  let bu: string | undefined;
  let either: string | undefined;
  if (p.cc1Id !== undefined) {
    const c = assertCentreLevel('cc1_id', await centre(companyId, 'cc1_id', p.cc1Id));
    members.cc1 = ref(c);
    actual.cc1 = cc1 = c.id;
  }
  if (p.cc2Id !== undefined) {
    const c = assertCentreLevel('cc2_id', await centre(companyId, 'cc2_id', p.cc2Id));
    members.cc2 = ref(c);
    actual.cc2 = cc2 = c.id;
  }
  if (p.buId !== undefined) {
    const u = await unit(companyId, p.buId);
    members.bu = u;
    actual.bu = bu = u.id;
  }
  if (p.costCentreId !== undefined) {
    const c = await centre(companyId, 'cost_centre_id', p.costCentreId);
    members.costCentre = ref(c);
    actual.costCentre = either = c.id;
  }
  return {
    members,
    actual,
    chainIds: cc2 ? [cc2] : [],
    budgetFilter: (nodes) => {
      const f: BudgetFilter = {};
      if (cc1) f.cc1 = cc1;
      if (cc2) f.cc2 = { id: cc2, fno: deriveFnoId(cc2, nodes) };
      if (bu) f.bu = bu;
      if (either) f.costCentre = { id: either };
      return f;
    },
  };
}
