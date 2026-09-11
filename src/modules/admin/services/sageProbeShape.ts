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
 id guid key type name code number status date created modified updated deleted by at of on is has
 total amount exclusive inclusive tax vat discount due paid balance outstanding remaining open
 unallocated allocated allocation allocate applied settlement settled matched match split write off reversal
 document doc from to source target parent child linked link related transaction detail event business
 invoice receipt payment return credit note journal entry ledger line item quantity price unit selection category account
 customer supplier payee bank branch contact email telephone mobile fax web address
 reference description comment period printed reconciled locked editable obfuscated hold accepted
 attachment anticipated result returned count message error method value artefact
`.split(/\s+/).filter(Boolean));

/** A word or its regular plural ("Settlements", "Entries", "Details"). */
function isFieldWord(word: string): boolean {
  const lower = word.toLowerCase();
  return FIELD_WORDS.has(lower) || (lower.endsWith('ies') && FIELD_WORDS.has(`${lower.slice(0, -3)}y`))
    || (lower.endsWith('es') && FIELD_WORDS.has(lower.slice(0, -2))) || (lower.endsWith('s') && FIELD_WORDS.has(lower.slice(0, -1)));
}

/** PascalCase / camelCase / snake_case words; any digit disqualifies the whole key. */
export function isFieldName(key: string): boolean {
  if (!/^[A-Za-z][A-Za-z_]{0,63}$/.test(key)) return false;
  const words = key.split('_').flatMap(part => part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? []);
  return words.length > 0 && words.join('').length === key.replaceAll('_', '').length
    && words.every(isFieldWord);
}

/**
 * `redacted` lists the distinct shapes found under keys that were not printed, so
 * an allocation array under an unexpected key name is still visible as structure.
 */
export type Shape = string | { object: Record<string, Shape>; redactedKeys?: number; redacted?: Shape[] }
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
      return withRedacted(object, Math.max(a.redactedKeys ?? 0, b.redactedKeys ?? 0), [...(a.redacted ?? []), ...(b.redacted ?? [])]);
    }
    if ('array' in a && 'array' in b) {
      const items = b.items === undefined ? a.items : mergeShapes(a.items, b.items);
      return items === undefined ? { array: Math.max(a.array, b.array) } : { array: Math.max(a.array, b.array), items };
    }
  }
  return [...new Set([...kind(a), ...kind(b)])].sort().join('|');
}

const MAX_REDACTED_SHAPES = 20;
function withRedacted(object: Record<string, Shape>, redactedKeys: number, shapes: Shape[]): Shape {
  if (!redactedKeys) return { object };
  const distinct = [...new Map(shapes.map(shape => [JSON.stringify(shape), shape])).values()].slice(0, MAX_REDACTED_SHAPES);
  return { object, redactedKeys, redacted: distinct };
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
    const redacted: Shape[] = [];
    for (const [key, child] of entries) {
      if (isFieldName(key)) object[key] = describeShape(child, depth + 1);
      else redacted.push(describeShape(child, depth + 1));
    }
    return withRedacted(object, redacted.length, redacted);
  }
  return typeof value;
}
