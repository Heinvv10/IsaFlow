/**
 * What the two re-apply MCP tools (`reapply_payment_terms` for supplier bills, `reapply_customer_payment_terms` for
 * customer invoices) share: the confirmed items' wire shape and the dry run's per-item check.
 */
import type { ReapplyItem } from '@/modules/accounting/services/shared/reapplyTermsShared';

/** The tool's snake_case items as the service's { id, dueDate, fromDueDate, fromSource } (validated by parseReapplyItems). */
export function toPairs(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((it) => {
    const o = (it ?? {}) as Record<string, unknown>;
    return { id: o.invoice_id, dueDate: o.due_date, fromDueDate: o.current_due_date, fromSource: o.current_source };
  });
}

interface ListedRow { id: string; currentDueDate: string | null; currentSource: string; newDueDate: string }

/**
 * What each confirmed pair would do against this preview: `update`, `date_changed` (its date or source moved since the
 * preview the pair came from), `terms_changed`, or `not_listed` (not in this preview).
 */
export function itemsCheckOf(pairs: ReapplyItem[], rows: ListedRow[]): { invoice_id: string; would: string }[] {
  const listed = new Map(rows.map((r) => [r.id, r]));
  return pairs.map(({ id, dueDate, fromDueDate, fromSource }) => {
    const r = listed.get(id);
    const would = !r ? 'not_listed'
      : r.currentDueDate !== fromDueDate || r.currentSource !== fromSource ? 'date_changed'
        : r.newDueDate === dueDate ? 'update' : 'terms_changed';
    return { invoice_id: id, would };
  });
}

/** The `items` property of both tools' input schema; `filter` names the preview's contact filter argument. */
export const reapplyItemsSchema = (max: number, noun: 'Bill' | 'Invoice', filter: string) => ({
  type: 'array',
  maxItems: max,
  description: 'Required when dry_run is false: the confirmed rows, taken from the preview. With dry_run true they are checked as the live call checks them and items_check says what each would do: update, date_changed, terms_changed, or not_listed '
    + `(not in this preview: already on that date, closed, outside ${filter}, or past a truncated list).`,
  items: {
    type: 'object',
    properties: {
      invoice_id: { type: 'string', description: `${noun} UUID from the preview row.` },
      due_date: { type: 'string', format: 'date', description: 'The preview row\'s new_due_date, YYYY-MM-DD.' },
      current_due_date: { type: ['string', 'null'], description: 'The preview row\'s current_due_date (null when it had none).' },
      current_source: { type: 'string', enum: ['terms', 'manual', 'document', 'legacy'], description: 'The preview row\'s current_source.' },
    },
    required: ['invoice_id', 'due_date', 'current_due_date', 'current_source'],
    additionalProperties: false,
  },
});
