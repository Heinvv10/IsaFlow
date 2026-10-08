/**
 * What a replacement line keeps of the CC1 / CC2 / BU a draft's stored lines
 * carry, when a draft edit replaces its lines wholesale (the customer invoice
 * PUT, update_supplier_invoice). Without it, a save that did not re-send the
 * dimensions stripped them from every line.
 *
 * A key the caller SENDS wins: a value sets it, null clears it. A key LEFT OUT
 * keeps the stored value — but a replacement line cannot be matched to "its"
 * stored line (lines carry no position, and their content is what is being
 * edited), so it keeps only a value EVERY stored line shares. When the stored
 * lines differ on that dimension, the line is refused rather than guessed.
 * CC1 follows its CC2: a line that sends a CC2 — or clears one with null —
 * leaves CC1 to derivation (dimensionDerivation: the project's FNO, else the
 * customer's) instead of keeping the FNO the old project gave it.
 *
 * Pure. Runs before derivation and validation, which then treat the result
 * exactly as they treat a new document's lines.
 */
import { DimensionRefusal, type DimensionIds } from './dimensionTypes';

/** A line's dimensions as sent: absent keeps, null clears, a value sets. */
export interface SentDimensions {
  cc1Id?: string | null;
  cc2Id?: string | null;
  buId?: string | null;
}

/** A stored line's dimension columns, as the row comes back. */
export interface StoredDimensionRow {
  cc1_id?: unknown;
  cc2_id?: unknown;
  bu_id?: unknown;
}

const SLOTS = [
  { key: 'cc2Id', column: 'cc2_id', name: 'CC2 (project)' },
  { key: 'buId', column: 'bu_id', name: 'BU' },
  { key: 'cc1Id', column: 'cc1_id', name: 'CC1 (FNO)' },
] as const;

export function keepStoredDimensions<T extends SentDimensions>(
  lines: readonly T[],
  stored: readonly StoredDimensionRow[],
  label: (index: number) => string = (i) => `Line ${i + 1}`,
): (Omit<T, keyof SentDimensions> & DimensionIds)[] {
  // Per slot: the one value every stored line carries (null = none), or undefined when they differ.
  const shared = new Map(SLOTS.map(({ column }) => {
    const values = new Set(stored.map((r) => (r[column] ? String(r[column]).toLowerCase() : null)));
    return [column, values.size <= 1 ? ([...values][0] ?? null) : undefined] as const;
  }));
  return lines.map((line, i) => {
    const { cc1Id, cc2Id, buId, ...rest } = line;
    const sent: SentDimensions = { cc1Id, cc2Id, buId };
    const out: DimensionIds = {};
    for (const { key, column, name } of SLOTS) {
      const value = sent[key];
      if (value !== undefined) {
        if (value !== null) out[key] = value;
        continue;
      }
      // A CC2 sent (a project, or null clearing one) re-derives CC1 — from the
      // project, or the customer's FNO — unless no stored line had a project,
      // when the stored CC1 was typed rather than derived and is kept.
      if (key === 'cc1Id' && (cc2Id || (cc2Id === null && shared.get('cc2_id') !== null))) continue;
      const kept = shared.get(column);
      if (kept === undefined) {
        throw new DimensionRefusal(
          `${label(i)}: the stored lines carry different ${name} values, so which one this line keeps is `
          + `ambiguous. Send ${key} on every line (null to clear it).`,
        );
      }
      if (kept !== null) out[key] = kept;
    }
    return { ...rest, ...out } as Omit<T, keyof SentDimensions> & DimensionIds;
  });
}
