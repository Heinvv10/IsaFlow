/**
 * A supplier's default CC1 / CC2 / BU (migration 890, brief §6 supplier master):
 * the dimensions its bill lines take when the line names none.
 *
 * Precedence, per line (brief §5.5, the card-default rule in
 * bank/bankAllocationDimensions.ts): the line's own dimensions win. The default
 * CC2 and CC1 apply only to a line that names NEITHER — a line that names a
 * CC2 derives its FNO from it, and a line that names only an FNO is not handed
 * a project that may sit under another FNO. The BU defaults independently. A
 * line (or bill) still carrying the legacy single cost-centre pick gets no
 * CC default, so placeCostCentres never meets a default it would contradict.
 *
 * A default whose master has since been deactivated is not applied, so a
 * deactivation never makes that supplier's bills unsaveable.
 */
import { sql } from '@/lib/neon';
import { assertSupplierInCompany } from '../../core/contactDirectoryService';
import { resolveDimensionRefs } from './dimensionRefResolver';
import { deriveLineDimensions } from './dimensionDerivation';
import { assertDocumentDimensions } from './dimensionPolicy';
import type { DimensionIds, DimensionRefs } from './dimensionTypes';

const nonEmpty = (v: string | null | undefined): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;

/** The supplier's ACTIVE default dimensions ({} when it has no rule or none set). */
export async function loadSupplierDefaultDimensions(companyId: string, supplierId: string): Promise<DimensionIds> {
  const rows = (await sql`
    SELECT c1.id::TEXT AS cc1, c2.id::TEXT AS cc2, bu.id::TEXT AS bu
    FROM supplier_coding_rules r
    LEFT JOIN cost_centres c1 ON c1.id = r.default_cc1_id AND c1.company_id = r.company_id AND c1.is_active = true
    LEFT JOIN cost_centres c2 ON c2.id = r.default_cc2_id AND c2.company_id = r.company_id AND c2.is_active = true
    LEFT JOIN business_units bu ON bu.id = r.default_bu_id AND bu.company_id = r.company_id AND bu.is_active = true
    WHERE r.company_id = ${companyId}::UUID AND r.supplier_id = ${supplierId}::UUID
    LIMIT 1
  `) as { cc1: string | null; cc2: string | null; bu: string | null }[];
  const r = rows[0];
  if (!r) return {};
  return {
    ...(r.cc1 ? { cc1Id: r.cc1 } : {}), ...(r.cc2 ? { cc2Id: r.cc2 } : {}), ...(r.bu ? { buId: r.bu } : {}),
  };
}

type BillLine = DimensionIds & { costCenterId?: string };

/** Pure: each line with the supplier's defaults filled in where the line leaves them open. */
export function applySupplierDefaultDimensions<T extends BillLine>(
  lines: readonly T[], defaults: DimensionIds, billCostCenterId?: string,
): T[] {
  const d = { cc1Id: nonEmpty(defaults.cc1Id), cc2Id: nonEmpty(defaults.cc2Id), buId: nonEmpty(defaults.buId) };
  if (!d.cc1Id && !d.cc2Id && !d.buId) return [...lines];
  return lines.map((line) => {
    const legacyPick = Boolean(nonEmpty(line.costCenterId) ?? nonEmpty(billCostCenterId));
    const namesCc = Boolean(nonEmpty(line.cc1Id) ?? nonEmpty(line.cc2Id));
    const takeCc = !legacyPick && !namesCc;
    const cc1Id = nonEmpty(line.cc1Id) ?? (takeCc ? d.cc1Id : undefined);
    const cc2Id = nonEmpty(line.cc2Id) ?? (takeCc ? d.cc2Id : undefined);
    const buId = nonEmpty(line.buId) ?? d.buId;
    return {
      ...line,
      ...(cc1Id ? { cc1Id } : {}), ...(cc2Id ? { cc2Id } : {}), ...(buId ? { buId } : {}),
    };
  });
}

/**
 * The dimension half of creating a bill, reads only: the supplier's defaults, CC1 derived from CC2 (a
 * conflicting CC1 refused), then tenant / slot / active. createSupplierInvoice runs it before its first write;
 * the REST route runs it too, ahead of the bill-number reservation (a 400 there commits the consumed number).
 */
export async function resolveBillLineDimensions<T extends BillLine>(
  companyId: string, supplierId: string, lines: readonly T[], billCostCenterId?: string,
): Promise<T[]> {
  const defaulted = applySupplierDefaultDimensions(
    lines, await loadSupplierDefaultDimensions(companyId, supplierId), billCostCenterId,
  );
  const derived = await deriveLineDimensions(companyId, defaulted);
  await assertDocumentDimensions(companyId, derived); // no query when none named
  return derived;
}

/** `refs[kind] === null` clears that default; undefined leaves it unchanged. */
export type SupplierDefaultRefs = { [K in keyof DimensionRefs]?: string | null };

export interface SupplierDefaultsPlan { supplierId: string; next: DimensionIds; previous: DimensionIds }

/** The supplier-rules routes' body fields → refs; null when the body names none of them. */
export function supplierDefaultRefsFromBody(
  body: { defaultCc1Id?: string | null; defaultCc2Id?: string | null; defaultBuId?: string | null },
): SupplierDefaultRefs | null {
  const refs: SupplierDefaultRefs = {};
  if (body.defaultCc1Id !== undefined) refs.cc1 = body.defaultCc1Id || null;
  if (body.defaultCc2Id !== undefined) refs.cc2 = body.defaultCc2Id || null;
  if (body.defaultBuId !== undefined) refs.bu = body.defaultBuId || null;
  return Object.keys(refs).length > 0 ? refs : null;
}

/** Reads only: resolve the refs, merge with what is held, refuse a default CC1 that contradicts the default CC2's FNO. */
export async function planSupplierDefaults(
  companyId: string, supplierId: string, refs: SupplierDefaultRefs,
): Promise<SupplierDefaultsPlan> {
  await assertSupplierInCompany(companyId, supplierId);
  const [current] = (await sql`
    SELECT default_cc1_id::TEXT AS cc1, default_cc2_id::TEXT AS cc2, default_bu_id::TEXT AS bu
    FROM supplier_coding_rules WHERE company_id = ${companyId}::UUID AND supplier_id = ${supplierId}::UUID
  `) as { cc1: string | null; cc2: string | null; bu: string | null }[];
  const previous: DimensionIds = {
    ...(current?.cc1 ? { cc1Id: current.cc1 } : {}), ...(current?.cc2 ? { cc2Id: current.cc2 } : {}),
    ...(current?.bu ? { buId: current.bu } : {}),
  };
  const toResolve: DimensionRefs = {
    ...(refs.cc1 ? { cc1: refs.cc1 } : {}), ...(refs.cc2 ? { cc2: refs.cc2 } : {}), ...(refs.bu ? { bu: refs.bu } : {}),
  };
  const [resolved] = await resolveDimensionRefs(companyId, [toResolve], () => 'defaults');
  const pick = (kind: 'cc1' | 'cc2' | 'bu', key: keyof DimensionIds): string | undefined =>
    refs[kind] === null ? undefined : refs[kind] === undefined ? previous[key] : resolved?.[key];
  const next: DimensionIds = { cc1Id: pick('cc1', 'cc1Id'), cc2Id: pick('cc2', 'cc2Id'), buId: pick('bu', 'buId') };
  // What a bill would take: the defaults a bill would APPLY after this call. A held default whose own master is
  // inactive is dropped (the load skips it), so it is not judged. A held default whose master is active stays in
  // the set and IS judged even when this call sets another field: a held project whose derived FNO is inactive
  // refuses a BU-only edit, because every bill would be refused (send that default too, or null, to repair it).
  // A default CC1 contradicting the project's FNO is refused the same way.
  const held = await loadSupplierDefaultDimensions(companyId, supplierId);
  const effective: DimensionIds = {
    cc1Id: refs.cc1 === undefined ? held.cc1Id : next.cc1Id,
    cc2Id: refs.cc2 === undefined ? held.cc2Id : next.cc2Id,
    buId: refs.bu === undefined ? held.buId : next.buId,
  };
  const derived = await deriveLineDimensions(companyId, [effective], () => 'defaults');
  await assertDocumentDimensions(companyId, derived);
  return { supplierId, next, previous };
}

/** Writes only: create the supplier's rule if it has none, and set the three defaults. */
export async function applySupplierDefaultsPlan(
  companyId: string, plan: SupplierDefaultsPlan, userId: string | null,
): Promise<void> {
  await sql`
    INSERT INTO supplier_coding_rules (company_id, supplier_id, default_cc1_id, default_cc2_id, default_bu_id, updated_by)
    VALUES (${companyId}::UUID, ${plan.supplierId}::UUID, ${plan.next.cc1Id ?? null}::UUID,
            ${plan.next.cc2Id ?? null}::UUID, ${plan.next.buId ?? null}::UUID, ${userId}::UUID)
    ON CONFLICT (company_id, supplier_id) DO UPDATE SET
      default_cc1_id = EXCLUDED.default_cc1_id,
      default_cc2_id = EXCLUDED.default_cc2_id,
      default_bu_id  = EXCLUDED.default_bu_id,
      updated_by     = COALESCE(EXCLUDED.updated_by, supplier_coding_rules.updated_by),
      updated_at     = NOW()
  `;
}
