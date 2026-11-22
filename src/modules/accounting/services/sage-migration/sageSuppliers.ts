/**
 * Sage supplier -> IsaFlow supplier id, through the MCP read tools: by the Sage reference on the supplier (find_by_external_ref,
 * kind supplier), else by exact name, case-insensitive (list_suppliers). No match, or two suppliers of that name, is a
 * refusal of the purchase orders naming it (`supplier_unresolved`, `supplier_ambiguous`): a PO is never booked to a guess.
 */
import type { SagePurchaseOrder } from './sageExportTypes';
import type { ToolSession } from './sageToolSession';
import { SAGE_SYSTEM } from './sageItemMapping';

export type SupplierResolution = { id: string } | { code: 'supplier_unresolved' | 'supplier_ambiguous'; reason: string };

const PAGE = 200;
const MAX_PAGES = 5;
export const SEARCH_CAP = PAGE * MAX_PAGES;

/** The ids of the suppliers named `name`; a string when the read failed; 'capped' when the search ran past SEARCH_CAP rows (the rest was never read). */
async function byName(session: ToolSession, name: string): Promise<string[] | string | 'capped'> {
  const wanted = name.trim().toLowerCase();
  const ids: string[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await session.call('list_suppliers', { search: name, limit: PAGE, offset });
    if (r.isError || !r.body) return `list_suppliers failed: ${r.text.slice(0, 200)}`;
    for (const s of (r.body.suppliers ?? []) as Array<{ id: string; name: string }>) {
      if (String(s.name).trim().toLowerCase() === wanted) ids.push(String(s.id));
    }
    if (typeof r.body.next_offset !== 'number') return ids;
    offset = r.body.next_offset;
  }
  return 'capped';
}

async function resolveOne(session: ToolSession, id: string, name: string | null): Promise<SupplierResolution> {
  const ref = await session.call('find_by_external_ref', { source: SAGE_SYSTEM, kind: 'supplier', id });
  if (ref.isError || !ref.body) return { code: 'supplier_unresolved', reason: `find_by_external_ref failed for Sage supplier ${id}: ${ref.text.slice(0, 200)}` };
  const record = ref.body.record as { id?: string } | null;
  if (ref.body.found === true && record?.id) return { id: String(record.id) };
  if (!name) return { code: 'supplier_unresolved', reason: `Sage supplier ${id} has no IsaFlow supplier carrying that reference and the export gives no name` };
  const ids = await byName(session, name);
  if (ids === 'capped') return { code: 'supplier_ambiguous', reason: `more than ${SEARCH_CAP} suppliers match "${name}": a second supplier of that name may be beyond the ones read, so none is picked` };
  if (typeof ids === 'string') return { code: 'supplier_unresolved', reason: ids };
  if (ids.length === 1) return { id: ids[0]! };
  if (ids.length === 0) return { code: 'supplier_unresolved', reason: `no IsaFlow supplier carries Sage reference ${id} or is named "${name}"` };
  return { code: 'supplier_ambiguous', reason: `${ids.length} IsaFlow suppliers are named "${name}" and none carries Sage reference ${id}` };
}

/** One resolution per distinct Sage supplier id of `pos`. */
export async function resolveSuppliers(session: ToolSession, pos: readonly SagePurchaseOrder[]): Promise<Map<string, SupplierResolution>> {
  const names = new Map<string, string | null>();
  for (const po of pos) if (!names.get(po.supplierId)) names.set(po.supplierId, po.supplierName);
  const out = new Map<string, SupplierResolution>();
  for (const [id, name] of names) out.set(id, await resolveOne(session, id, name));
  return out;
}
