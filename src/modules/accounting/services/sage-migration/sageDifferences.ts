/**
 * What a re-run finds already in IsaFlow that differs from Sage, read from the batches' own answers. PURE.
 *   - a PO the tool answers already_existed with payload_differs: it is NOT changed (a PO billed in Sage since the first import stays
 *     as imported until a person closes or cancels it), so the difference is listed;
 *   - an item or a category the migration owns that the tool answers `updated`: Sage's values would overwrite what IsaFlow holds (IsaFlow
 *     edits made after the import included), so the fields that change are listed. Only the fields the migration SENDS can differ: the tools
 *     never clear a field, so a value Sage has since dropped stays in IsaFlow and is not listed.
 */
import type { BatchReport, MigrationReport } from './sageMigrationTypes';

interface PoAnswer { po_number?: unknown; payload_differs?: unknown; differences?: Array<{ field: string; existing: unknown; requested: unknown }> }
interface ItemAnswer { outcome?: unknown; code?: unknown; changed?: unknown }
interface CategoryAnswer { outcome?: unknown; name?: unknown; changed?: unknown }

export function differencesFrom(batches: readonly BatchReport[]): MigrationReport['differences'] {
  const purchaseOrders: MigrationReport['differences']['purchaseOrders'] = [];
  const items: MigrationReport['differences']['items'] = [];
  const categories: MigrationReport['differences']['categories'] = [];
  for (const b of batches) {
    if (b.entity === 'purchase_order') {
      for (const p of (b.toolReported?.purchase_orders ?? []) as PoAnswer[]) {
        if (p.payload_differs === true) purchaseOrders.push({ poNumber: String(p.po_number), differences: p.differences ?? [] });
      }
    } else if (b.entity === 'category') {
      const r = (b.toolReported ?? {}) as CategoryAnswer;
      if (r.outcome === 'updated') categories.push({ name: String(r.name), changed: Array.isArray(r.changed) ? r.changed.map(String) : [] });
    } else if (b.entity === 'item') {
      for (const r of (b.toolReported?.rows ?? []) as ItemAnswer[]) {
        if (r.outcome === 'updated') items.push({ code: String(r.code), changed: Array.isArray(r.changed) ? r.changed.map(String) : [] });
      }
    }
  }
  // The same PO or item named by the dry run and the live run is listed once.
  const once = <T,>(list: T[], key: (x: T) => string): T[] => list.filter((x, i) => list.findIndex((y) => key(y) === key(x)) === i);
  return { purchaseOrders: once(purchaseOrders, (x) => x.poNumber), items: once(items, (x) => x.code), categories: once(categories, (x) => x.name) };
}
