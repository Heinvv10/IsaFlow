/**
 * Derivation (brief §5.4) and conflict blocking (brief §5.5) for CC1.
 *
 * FNO is an attribute of the project, never typed on a cost line: a CC2 sets
 * its CC1 by walking parent_id until it reaches a cc_type 'cc1' row (through a
 * programme CC2 if there is one). An explicit CC1 that disagrees with the
 * derived one is a data error and is BLOCKED, not resolved either way.
 *
 * On revenue the FNO comes from the customer (customers.default_cc1_id). A CC2
 * whose FNO differs from the customer's is blocked for the same reason.
 *
 * Queries run only when a line actually names a CC2 (or, for the customer
 * check, any dimension), so a journal without dimensions costs nothing extra.
 */
import { sql } from '@/lib/neon';
import { isValidUUID } from '@/lib/validation';
import { DimensionRefusal, type DimensionIds } from './dimensionTypes';

export interface CostCentreNode { id: string; code: string; parentId: string | null; ccType: string | null }

const MAX_DEPTH = 16;

/** Pure: the CC1 a CC2 rolls up to, or null when its chain reaches none. */
export function deriveFnoId(cc2Id: string, nodes: ReadonlyMap<string, CostCentreNode>): string | null {
  const seen = new Set<string>([cc2Id]);
  let cursor = nodes.get(cc2Id)?.parentId ?? null;
  for (let depth = 0; cursor && depth < MAX_DEPTH; depth++) {
    if (seen.has(cursor)) return null; // a cycle is not an FNO
    seen.add(cursor);
    const node = nodes.get(cursor);
    if (!node) return null;
    if (node.ccType === 'cc1') return node.id;
    cursor = node.parentId;
  }
  return null;
}

/**
 * Every cost centre on the parent chains of `ids`, company-scoped. An id that
 * is not a UUID names no cost centre and is left out of the query (it would
 * fail the cast): its line keeps it as typed, and the slot validator
 * (journalCostCentreValidation) refuses it as it refuses an unknown id.
 */
export async function loadCostCentreChains(
  companyId: string,
  ids: readonly string[],
): Promise<Map<string, CostCentreNode>> {
  // A malformed id names no cost centre, so it has no chain to walk. Leave it
  // out of the ::UUID[] cast — which would throw a raw Postgres error — and let
  // the line validator refuse it with the slot's own message.
  const unique = [...new Set(ids.filter(isValidUUID).map((id) => id.toLowerCase()))];
  if (unique.length === 0) return new Map();
  const rows = (await sql`
    WITH RECURSIVE chain AS (
      SELECT id, code, parent_id, cc_type, 0 AS depth FROM cost_centres
      WHERE company_id = ${companyId}::UUID AND id = ANY(${unique}::UUID[])
      UNION ALL
      SELECT p.id, p.code, p.parent_id, p.cc_type, c.depth + 1
      FROM chain c JOIN cost_centres p ON p.id = c.parent_id AND p.company_id = ${companyId}::UUID
      WHERE c.depth < ${MAX_DEPTH}
    )
    SELECT DISTINCT id::TEXT AS id, code, parent_id::TEXT AS parent_id, cc_type FROM chain
  `) as { id: string; code: string; parent_id: string | null; cc_type: string | null }[];
  return new Map(rows.map((r) => [r.id.toLowerCase(), {
    id: r.id.toLowerCase(), code: String(r.code), parentId: r.parent_id ? r.parent_id.toLowerCase() : null, ccType: r.cc_type,
  }]));
}

const codeOf = (nodes: ReadonlyMap<string, CostCentreNode>, id: string): string =>
  nodes.get(id.toLowerCase())?.code ?? id;

/**
 * Pure: fill CC1 from each line's CC2 and refuse a conflicting explicit CC1.
 * `label(i)` names the line in the refusal.
 */
export function applyFnoDerivation<T extends DimensionIds>(
  lines: readonly T[],
  nodes: ReadonlyMap<string, CostCentreNode>,
  label: (index: number) => string = (i) => `Line ${i + 1}`,
): T[] {
  return lines.map((line, i) => {
    if (!line.cc2Id) return line;
    const fno = deriveFnoId(line.cc2Id.toLowerCase(), nodes);
    if (!fno) return line;
    if (line.cc1Id && line.cc1Id.toLowerCase() !== fno) {
      throw new DimensionRefusal(
        `${label(i)}: project ${codeOf(nodes, line.cc2Id)} belongs to FNO ${codeOf(nodes, fno)}, `
        + `but CC1 ${codeOf(nodes, line.cc1Id)} was given. The FNO is derived from the project and cannot be overridden — `
        + 'fix the project\'s parent, or name the right project.',
      );
    }
    return line.cc1Id ? line : { ...line, cc1Id: fno };
  });
}

/** Derive CC1 from CC2 on every line (no query when no line names a CC2). */
export async function deriveLineDimensions<T extends DimensionIds>(
  companyId: string,
  lines: readonly T[],
  label?: (index: number) => string,
): Promise<T[]> {
  const cc2Ids = lines.map((l) => l.cc2Id).filter((id): id is string => Boolean(id));
  if (cc2Ids.length === 0) return [...lines];
  const explicitCc1 = lines.map((l) => l.cc1Id).filter((id): id is string => Boolean(id));
  const nodes = await loadCostCentreChains(companyId, [...cc2Ids, ...explicitCc1]);
  return applyFnoDerivation(lines, nodes, label);
}

/**
 * Pure: the customer-side rule for a revenue line. The line's CC1 defaults to
 * the customer's FNO; a CC1 (explicit or derived from its CC2) that differs
 * from the customer's FNO is refused.
 */
export function applyCustomerFno<T extends DimensionIds>(
  lines: readonly T[],
  customerFnoId: string | null,
  label: (index: number) => string = (i) => `Line ${i + 1}`,
  describe: (id: string) => string = (id) => id,
): T[] {
  if (!customerFnoId) return [...lines];
  const fno = customerFnoId.toLowerCase();
  return lines.map((line, i) => {
    if (!line.cc1Id) return { ...line, cc1Id: fno };
    if (line.cc1Id.toLowerCase() !== fno) {
      throw new DimensionRefusal(
        `${label(i)}: FNO ${describe(line.cc1Id)} differs from the customer's FNO ${describe(fno)}. `
        + 'On revenue the FNO comes from the customer; a project under another FNO cannot be billed to it.',
      );
    }
    return line;
  });
}

/** The customer's FNO (customers.default_cc1_id), or null. */
export async function customerFnoId(companyId: string, customerId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT default_cc1_id::TEXT AS fno FROM customers
    WHERE id = ${customerId}::UUID AND company_id = ${companyId}::UUID
  `) as { fno: string | null }[];
  return rows[0]?.fno ?? null;
}

/**
 * Derive from CC2, then apply the customer rule: the EFFECTIVE dimensions a
 * revenue line stores, which is what it posts (posting adds nothing:
 * dimensionStoredPosting). The customer's FNO is applied to every line without
 * a CC1, whether or not any line names a dimension, so it is on the document —
 * and in its approval digest — from the first save. One query (the customer)
 * when no line names a dimension.
 */
export async function deriveRevenueDimensions<T extends DimensionIds>(
  companyId: string,
  customerId: string,
  lines: readonly T[],
  label?: (index: number) => string,
): Promise<T[]> {
  const derived = lines.some((l) => l.cc1Id || l.cc2Id || l.buId)
    ? await deriveLineDimensions(companyId, lines, label) : [...lines];
  const fno = await customerFnoId(companyId, customerId);
  if (!fno) return derived;
  const ids = derived.flatMap((l) => (l.cc1Id ? [l.cc1Id] : []));
  const nodes = ids.length > 0 ? await loadCostCentreChains(companyId, [fno, ...ids]) : new Map<string, CostCentreNode>();
  return applyCustomerFno(derived, fno, label, (id) => codeOf(nodes, id));
}

/**
 * The dimensions a revenue line with none of its own stores: the customer's
 * FNO, or nothing. For the writers whose source carries no dimension (quote,
 * sales-order, recurring, WIP and time-entry billing, the Sage import).
 */
export async function revenueLineDefaults(companyId: string, customerId: string | null): Promise<DimensionIds> {
  if (!customerId) return {};
  const [line] = await deriveRevenueDimensions<DimensionIds>(companyId, customerId, [{}]);
  return line ?? {};
}
