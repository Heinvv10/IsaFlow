/**
 * What a draft edit's lines are coded to (account and job, migration 874). The PUT replaces
 * every line, and a caller that sends no coding keys at all — an older client,
 * an integration — must not silently strip the coding off the invoice:
 *
 *  - a key ABSENT from a line KEEPS the stored value, when that is unambiguous:
 *    every stored line carries the same value for it (or there are none). A
 *    line has no stable identity across the replace (its lines share one
 *    created_at, so "the same position" would be a random id), so where the
 *    stored lines differ the edit is REFUSED and asks for the value explicitly
 *    rather than guess which line it belonged to;
 *  - `null` clears it; a uuid sets it ('' never reaches here: PutItemSchema
 *    refuses it, as before).
 */
import type { InvoiceLineCoding } from './invoiceLineCoding';

type CodingKey = keyof InvoiceLineCoding;
const KEYS: readonly CodingKey[] = ['glAccountId', 'projectId'];

export type EditLineCoding = { [K in CodingKey]?: string | null };

export function resolveEditCodings(
  items: readonly EditLineCoding[],
  stored: readonly InvoiceLineCoding[],
): InvoiceLineCoding[] | string {
  const kept = new Map<CodingKey, string | null | undefined>();
  for (const key of KEYS) {
    const values = new Set(stored.map((s) => s[key]));
    kept.set(key, values.size === 0 ? null : values.size === 1 ? [...values][0]! : undefined);
  }
  const out: InvoiceLineCoding[] = [];
  for (const [i, item] of items.entries()) {
    const coding = { glAccountId: null, projectId: null } as InvoiceLineCoding;
    for (const key of KEYS) {
      const sent = item[key];
      if (sent !== undefined) {
        coding[key] = sent === null ? null : sent.toLowerCase();
        continue;
      }
      const keep = kept.get(key);
      if (keep === undefined) {
        return `items[${i}].${key} was left out, and this invoice's lines carry different values for it — `
          + 'send it for every line (null clears it).';
      }
      coding[key] = keep;
    }
    out.push(coding);
  }
  return out;
}
