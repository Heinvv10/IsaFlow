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

export type SupplierResolution = { id: string } | { code: 'supplier_unresolved' | 'supplier_ambiguous' | 'supplier_ref_conflict'; reason: string };

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

async function resolveOne(session: ToolSession, id: string, name: string | null, refs: SupplierSageRefs): Promise<SupplierResolution> {
  const ref = await session.call('find_by_external_ref', { source: SAGE_SYSTEM, kind: 'supplier', id });
  if (ref.isError || !ref.body) return { code: 'supplier_unresolved', reason: `find_by_external_ref failed for Sage supplier ${id}: ${ref.text.slice(0, 200)}` };
  const record = ref.body.record as { id?: string } | null;
  if (ref.body.found === true && record?.id) return { id: String(record.id) };
  if (!name) return { code: 'supplier_unresolved', reason: `Sage supplier ${id} has no IsaFlow supplier carrying that reference and the export gives no name` };
  const found = await byName(session, name, id, refs);
  if (found === 'capped') return { code: 'supplier_ambiguous', reason: `more than ${SEARCH_CAP} suppliers match "${name}": a second supplier of that name may be beyond the ones read, so none is picked` };
  if (typeof found === 'string') return { code: 'supplier_unresolved', reason: found };
  if (found.ids.length === 1) return { id: found.ids[0]! };
  if (found.ids.length === 0 && found.otherRef.length > 0) {
    const who = found.otherRef.map((x) => `${x.id} (Sage supplier ${x.ref})`).join(', ');
    return { code: 'supplier_ref_conflict', reason: `the supplier(s) named "${name}" already carry another Sage reference: ${who}; Sage supplier ${id} is a different one, so none is matched by name` };
  }
  if (found.ids.length === 0) return { code: 'supplier_unresolved', reason: `no IsaFlow supplier carries Sage reference ${id} or is named "${name}"` };
  return { code: 'supplier_ambiguous', reason: `${found.ids.length} IsaFlow suppliers are named "${name}" and none carries Sage reference ${id}` };
}

/** One resolution per distinct Sage supplier id of `pos`. */
export async function resolveSuppliers(
  session: ToolSession, pos: readonly SagePurchaseOrder[], refs: SupplierSageRefs,
): Promise<Map<string, SupplierResolution>> {
  const names = new Map<string, string | null>();
  for (const po of pos) if (!names.get(po.supplierId)) names.set(po.supplierId, po.supplierName);
  const out = new Map<string, SupplierResolution>();
  for (const [id, name] of names) out.set(id, await resolveOne(session, id, name, refs));
  return out;
}
