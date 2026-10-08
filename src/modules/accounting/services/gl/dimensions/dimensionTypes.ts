/**
 * Shared shapes for the CC1 / CC2 / BU analysis dimensions.
 *
 * CC1 = FNO / client (cost_centres.cc_type 'cc1'), CC2 = project ('cc2', its
 * parent chain ends at a CC1, possibly through a programme CC2), BU = function
 * (business_units). The canonical columns are gl_journal_lines.cc1_id / cc2_id /
 * bu_id (migration 285); documents carry the same three (migration 870).
 */

export type DimensionKind = 'cc1' | 'cc2' | 'bu';

/** Resolved ids, as they are written to a line. */
export interface DimensionIds {
  cc1Id?: string;
  cc2Id?: string;
  buId?: string;
}

/** What a caller typed: a UUID, a code, or (for cost centres) an alias. */
export interface DimensionRefs {
  cc1?: string;
  cc2?: string;
  bu?: string;
}

/**
 * A dimension refusal: an unknown reference, a CC2 whose FNO conflicts with the
 * CC1 or customer given, dimensions on a settlement, or a COS line with no
 * project where the company requires one. Always raised before any write, and
 * its message names only what the caller sent or its own masters' codes, so
 * MCP surfaces it verbatim (REFUSAL_CODES).
 */
export class DimensionRefusal extends Error {
  readonly code = 'DIMENSION_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'DimensionRefusal';
  }
}

export function isDimensionRefusal(err: unknown): err is DimensionRefusal {
  return err instanceof Error && (err as { code?: unknown }).code === 'DIMENSION_REFUSED';
}

/** True when the line names any of the three dimensions. */
export function hasDimensions(line: DimensionIds | null | undefined): boolean {
  return Boolean(line && (line.cc1Id || line.cc2Id || line.buId));
}

/** True when the refs name any of the three dimensions. */
export function hasDimensionRefs(refs: DimensionRefs | null | undefined): boolean {
  return Boolean(refs && (refs.cc1 || refs.cc2 || refs.bu));
}
