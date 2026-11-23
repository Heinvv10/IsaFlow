/**
 * Sage supplier -> IsaFlow supplier id, through the MCP read tools: by the Sage reference on the supplier (find_by_external_ref,
 * kind supplier), else by exact name, case-insensitive (list_suppliers). No match, or two suppliers of that name, is a
 * refusal of the purchase orders naming it (`supplier_unresolved`, `supplier_ambiguous`): a PO is never booked to a guess.
 * A supplier that already carries ANOTHER Sage reference is a different Sage supplier that happens to share the name: it is
 * never matched by name (`supplier_ref_conflict` when that leaves nothing).
 */
import type { SagePurchaseOrder } from './sageExportTypes';
import type { ToolSession } from './sageToolSession';
import { SAGE_SYSTEM } from './sageItemMapping';

export type SupplierResolution = { id: string } | { code: 'supplier_unresolved' | 'supplier_ambiguous' | 'supplier_ref_conflict' | 'supplier_collapsed'; reason: string };

const PAGE = 200;
const MAX_PAGES = 5;
export const SEARCH_CAP = PAGE * MAX_PAGES;

/** supplier uuid -> the Sage reference it carries (suppliers with none are absent). */
export type SupplierSageRefs = ReadonlyMap<string, string>;

interface NameSearch { ids: string[]; otherRef: Array<{ id: string; ref: string }> }

/** The suppliers named `name` (split by whether they carry another Sage reference); a string when the read failed; 'capped' past SEARCH_CAP rows. */
async function byName(session: ToolSession, name: string, sageId: string, refs: SupplierSageRefs): Promise<NameSearch | string | 'capped'> {
  const wanted = name.trim().toLowerCase();
  const out: NameSearch = { ids: [], otherRef: [] };
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await session.call('list_suppliers', { search: name, limit: PAGE, offset });
    if (r.isError || !r.body) return `list_suppliers failed: ${r.text.slice(0, 200)}`;
    for (const s of (r.body.suppliers ?? []) as Array<{ id: string; name: string }>) {
      if (String(s.name).trim().toLowerCase() !== wanted) continue;
      const ref = refs.get(String(s.id));
      if (ref !== undefined && ref !== sageId) out.otherRef.push({ id: String(s.id), ref });
      else out.ids.push(String(s.id));
    }
    if (typeof r.body.next_offset !== 'number') return out;
    offset = r.body.next_offset;
  }
  return 'capped';
}

/** What one Sage supplier id is called across the POs naming it (distinct, case-insensitive, in file order): one id can carry several names. */
function distinctNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.map((n) => n.trim()).filter((n) => n !== '' && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
}

async function resolveOne(session: ToolSession, id: string, names: readonly string[], refs: SupplierSageRefs): Promise<SupplierResolution> {
  const ref = await session.call('find_by_external_ref', { source: SAGE_SYSTEM, kind: 'supplier', id });
  if (ref.isError || !ref.body) return { code: 'supplier_unresolved', reason: `find_by_external_ref failed for Sage supplier ${id}: ${ref.text.slice(0, 200)}` };
  const record = ref.body.record as { id?: string } | null;
  // The tool answers the first live match and lists the others: two live suppliers on one Sage reference is a guess, never booked.
  const others = Array.isArray(ref.body.other_live) ? (ref.body.other_live as Array<{ id?: string }>) : [];
  if (ref.body.found === true && record?.id && others.length > 0) {
    const ids = [record.id, ...others.map((o) => String(o.id))].join(', ');
    return { code: 'supplier_ambiguous', reason: `${others.length + 1} live IsaFlow suppliers carry Sage reference ${id} (${ids}): none is picked; remove the reference from all but one` };
  }
  if (ref.body.found === true && record?.id) return { id: String(record.id) };
  const named = distinctNames(names);
  if (named.length === 0) return { code: 'supplier_unresolved', reason: `Sage supplier ${id} has no IsaFlow supplier carrying that reference and the export gives no name` };
  // EVERY name the export gives this Sage id is searched, and what they find is pooled: whichever PO comes first in the file decides nothing.
  const pooled: NameSearch = { ids: [], otherRef: [] };
  for (const name of named) {
    const found = await byName(session, name, id, refs);
    if (found === 'capped') return { code: 'supplier_ambiguous', reason: `more than ${SEARCH_CAP} suppliers match "${name}": a second supplier of that name may be beyond the ones read, so none is picked` };
    if (typeof found === 'string') return { code: 'supplier_unresolved', reason: found };
    for (const x of found.ids) if (!pooled.ids.includes(x)) pooled.ids.push(x);
    for (const x of found.otherRef) if (!pooled.otherRef.some((y) => y.id === x.id)) pooled.otherRef.push(x);
  }
  const label = named.map((n) => `"${n}"`).join(' / ');
  if (pooled.ids.length === 1) return { id: pooled.ids[0]! };
  if (pooled.ids.length === 0 && pooled.otherRef.length > 0) {
    const who = pooled.otherRef.map((x) => `${x.id} (Sage supplier ${x.ref})`).join(', ');
    return { code: 'supplier_ref_conflict', reason: `the supplier(s) named ${label} already carry another Sage reference: ${who}; Sage supplier ${id} is a different one, so none is matched by name` };
  }
  if (pooled.ids.length === 0) return { code: 'supplier_unresolved', reason: `no IsaFlow supplier carries Sage reference ${id} or is named ${label}` };
  return { code: 'supplier_ambiguous', reason: `${pooled.ids.length} IsaFlow suppliers match Sage supplier ${id} (${label}) and none carries its reference: ${pooled.ids.join(', ')}` };
}

/** One resolution per distinct Sage supplier id of `pos`. */
export async function resolveSuppliers(
  session: ToolSession, pos: readonly SagePurchaseOrder[], refs: SupplierSageRefs,
): Promise<Map<string, SupplierResolution>> {
  const names = new Map<string, string[]>();
  for (const po of pos) names.set(po.supplierId, [...(names.get(po.supplierId) ?? []), ...(po.supplierName ? [po.supplierName] : [])]);
  const out = new Map<string, SupplierResolution>();
  for (const [id, list] of names) out.set(id, await resolveOne(session, id, list, refs));
  // Two different Sage suppliers that land on one IsaFlow supplier (found by the same name) would be merged silently: both are refused.
  const bySupplier = new Map<string, string[]>();
  for (const [id, r] of out) if ('id' in r) bySupplier.set(r.id, [...(bySupplier.get(r.id) ?? []), id]);
  for (const [uuid, sageIds] of bySupplier) {
    if (sageIds.length < 2) continue;
    const list = sageIds.length === 2 ? sageIds.join(' and ') : `${sageIds.slice(0, -1).join(', ')} and ${sageIds[sageIds.length - 1]}`;
    const named = [...new Set(sageIds.flatMap((i) => distinctNames(names.get(i) ?? [])))].map((n) => `"${n}"`).join(' / ');
    for (const id of sageIds) {
      out.set(id, { code: 'supplier_collapsed', reason: `Sage suppliers ${list} (named ${named}) all resolve to one IsaFlow supplier ${uuid}; they are different Sage suppliers, so none is matched` });
    }
  }
  return out;
}
