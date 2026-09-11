/**
 * sageProbeShape.ts
 *
 * The redaction half of the Sage allocation probe: the structure of a decoded
 * Sage response with every value removed. Keys are deny-by-default — a key is
 * printed only when EVERY word in it is a Sage/accounting field word below, so
 * a key that is itself client data (a surname, a customer code, an account
 * number, an email) is only counted. Residual risk, accepted: a client datum
 * made entirely of vocabulary words ("TotalPayment" as a customer name used as
 * a key) would print.
 */

const MAX_DEPTH = 8;
const DICTIONARY_KEYS = 100;
const SAMPLE_ITEMS = 5;

// Field words seen in the Sage list DTOs the migration already reads, plus the
// words an allocation/line structure is likely to use. Case-insensitive.
const FIELD_WORDS = new Set(`
 id key type name code number status date created modified updated deleted
 total totals amount amounts exclusive inclusive tax vat discount due paid balance outstanding
 unallocated allocated allocation allocations allocate applied settlement settled
 document documents doc from to source target parent child linked link links
 invoice invoices receipt receipts payment payments return returns credit note notes journal entry entries
 line lines item items quantity price unit units selection category account accounts
 customer customers supplier suppliers bank branch contact email telephone mobile fax web address
 reference description comments comment period printed reconciled locked editable obfuscated on hold
 has attachments anticipated is results returned count message error errors method value values
`.split(/\s+/).filter(Boolean));

/** PascalCase / camelCase / snake_case words; any digit disqualifies the whole key. */
export function isFieldName(key: string): boolean {
  if (!/^[A-Za-z][A-Za-z_]{0,63}$/.test(key)) return false;
  const words = key.split('_').flatMap(part => part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? []);
  return words.length > 0 && words.join('').length === key.replaceAll('_', '').length
    && words.every(word => FIELD_WORDS.has(word.toLowerCase()));
}

export type Shape = string | { object: Record<string, Shape>; redactedKeys?: number }
  | { array: number; items?: Shape } | { dictionary: number; values?: Shape };

function kind(shape: Shape): string[] {
  if (typeof shape === 'string') return shape.split('|');
  return ['object' in shape ? 'object' : 'array' in shape ? 'array' : 'dictionary'];
}

function mergeShapes(a: Shape | undefined, b: Shape): Shape {
  if (a === undefined) return b;
  if (typeof a !== 'string' && typeof b !== 'string') {
    if ('object' in a && 'object' in b) {
      const object: Record<string, Shape> = { ...a.object };
      for (const [key, value] of Object.entries(b.object)) object[key] = mergeShapes(object[key], value);
      const redactedKeys = Math.max(a.redactedKeys ?? 0, b.redactedKeys ?? 0);
      return redactedKeys ? { object, redactedKeys } : { object };
    }
    if ('array' in a && 'array' in b) {
      const items = b.items === undefined ? a.items : mergeShapes(a.items, b.items);
      return items === undefined ? { array: Math.max(a.array, b.array) } : { array: Math.max(a.array, b.array), items };
    }
  }
  return [...new Set([...kind(a), ...kind(b)])].sort().join('|');
}

function sampleShape(values: unknown[], depth: number): Shape | undefined {
  let merged: Shape | undefined;
  for (const value of values.slice(0, SAMPLE_ITEMS)) merged = mergeShapes(merged, describeShape(value, depth + 1));
  return merged;
}

/** Structure of a decoded JSON value with every value and every non-field key removed. */
export function describeShape(value: unknown, depth = 0): Shape {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return { array: value.length };
    const items = sampleShape(value, depth);
    return items === undefined ? { array: value.length } : { array: value.length, items };
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (depth >= MAX_DEPTH) return 'object';
    if (entries.length > DICTIONARY_KEYS) {
      const values = sampleShape(entries.map(([, v]) => v), depth);
      return values === undefined ? { dictionary: entries.length } : { dictionary: entries.length, values };
    }
    const object: Record<string, Shape> = {};
    let redactedKeys = 0;
    for (const [key, child] of entries) {
      if (isFieldName(key)) object[key] = describeShape(child, depth + 1);
      else redactedKeys += 1;
    }
    return redactedKeys ? { object, redactedKeys } : { object };
  }
  return typeof value;
}
