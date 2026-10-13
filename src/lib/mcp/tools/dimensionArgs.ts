/**
 * The optional per-line `cc1` / `cc2` / `bu` arguments every capture tool
 * accepts, and their pre-write resolution.
 *
 * A value is a UUID, a code, or (for cost centres) an alias — resolved
 * company-scoped by gl/dimensions/dimensionRefResolver, with CC1 then derived
 * from CC2 and a conflicting CC1 refused (dimensionDerivation). Everything here
 * runs BEFORE the first write, so a refusal is a toolError with the line index.
 * With no dimension named anywhere, nothing here queries.
 */
import { resolveDimensionRefs } from '@/modules/accounting/services/gl/dimensions/dimensionRefResolver';
import { deriveLineDimensions } from '@/modules/accounting/services/gl/dimensions/dimensionDerivation';
import { cosProjectWarnings } from '@/modules/accounting/services/gl/dimensions/dimensionPolicy';
import {
  applySupplierDefaultDimensions, loadSupplierDefaultDimensions,
} from '@/modules/accounting/services/gl/dimensions/supplierDimensionDefaults';
import {
  hasDimensionRefs, isDimensionRefusal, type DimensionIds, type DimensionRefs,
} from '@/modules/accounting/services/gl/dimensions/dimensionTypes';

const REF_DESCRIPTION = 'code, UUID';

/** Schema fragment: spread into a line's `properties`. */
export const DIMENSION_LINE_PROPERTIES = {
  cc1: {
    type: 'string',
    description: `Optional CC1 = FNO / client (${REF_DESCRIPTION} or alias). Usually omit it: a CC2 derives its FNO, `
      + 'and naming a CC1 that disagrees is refused.',
  },
  cc2: {
    type: 'string',
    description: `Optional CC2 = project (${REF_DESCRIPTION} or alias, e.g. "Ben Farms"). Sets the FNO through its parent. `
      + 'A cost-of-sales line without one is reported in dimension_warnings.',
  },
  bu: { type: 'string', description: `Optional business unit = function (${REF_DESCRIPTION}), e.g. "MAINT".` },
} as const;

/**
 * Parse `cc1` / `cc2` / `bu` off one line object. Returns undefined when none is
 * named, the refusal text when one is not a non-empty string.
 */
export function parseDimensionRefs(o: Record<string, unknown>, label: string): DimensionRefs | undefined | string {
  const out: DimensionRefs = {};
  for (const kind of ['cc1', 'cc2', 'bu'] as const) {
    const v = o[kind];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || !v.trim() || v.length > 255) return `${label}.${kind} must be a non-empty code, UUID or alias`;
    out[kind] = v.trim();
  }
  return hasDimensionRefs(out) ? out : undefined;
}

/**
 * Resolve every line's refs to ids, derive CC1 from CC2, refuse conflicts.
 * Returns one entry per line (undefined where none was named), or the refusal
 * TEXT. Rethrows anything that is not a dimension refusal.
 */
export async function resolveLineDimensionRefs(
  companyId: string,
  refs: readonly (DimensionRefs | undefined)[],
  label: (index: number) => string,
): Promise<(DimensionIds | undefined)[] | string> {
  if (!refs.some(hasDimensionRefs)) return refs.map(() => undefined);
  try {
    const ids = await resolveDimensionRefs(companyId, refs, label);
    const derived = await deriveLineDimensions(companyId, ids.map((d) => d ?? {}), label);
    return derived.map((d, i) => (ids[i] ? d : undefined));
  } catch (err) {
    if (isDimensionRefusal(err)) return err.message;
    throw err;
  }
}

/** COS-without-project warnings, or the refusal TEXT when the company blocks them. */
export async function dimensionWarningsOrRefusal(
  companyId: string,
  lines: readonly { glAccountId?: string | null; cc2Id?: string | null }[],
  label: (index: number) => string,
): Promise<{ warnings: string[] } | string> {
  try {
    return { warnings: await cosProjectWarnings(companyId, lines, label) };
  } catch (err) {
    if (isDimensionRefusal(err)) return err.message;
    throw err;
  }
}

/**
 * `dimensionWarningsOrRefusal` for a supplier's bill lines, over the lines as the supplier's default CC2 (migration
 * 890) will leave them, so a line the default fills is not reported or refused as project-less. Reads only: the
 * defaulted copy is for the check, and createSupplierInvoice applies the defaults to the lines it is given.
 */
export async function supplierBillWarningsOrRefusal(
  companyId: string,
  supplierId: string,
  lines: readonly (DimensionIds & { glAccountId?: string | null; costCenterId?: string })[],
  label: (index: number) => string,
): Promise<{ warnings: string[] } | string> {
  const defaulted = applySupplierDefaultDimensions(lines, await loadSupplierDefaultDimensions(companyId, supplierId));
  return dimensionWarningsOrRefusal(companyId, defaulted, label);
}

/**
 * For lines that carry `dims` (as typed): resolve them in one pass and set
 * `dimIds` on each. Returns the refusal TEXT, or null.
 */
export async function attachLineDimensionIds(
  companyId: string,
  lines: { dims?: DimensionRefs; dimIds?: DimensionIds }[],
  label: (index: number) => string,
): Promise<string | null> {
  const resolved = await resolveLineDimensionRefs(companyId, lines.map((l) => l.dims), label);
  if (typeof resolved === 'string') return resolved;
  resolved.forEach((ids, i) => { if (ids) lines[i]!.dimIds = ids; });
  return null;
}

/**
 * Merge resolved dimensions into document items (one per item, in order), or
 * return the refusal TEXT. Items are returned unchanged when none is named.
 */
export async function itemsWithDimensions<T extends object>(
  companyId: string,
  items: readonly T[],
  refs: readonly (DimensionRefs | undefined)[],
  label: (index: number) => string,
): Promise<(T & DimensionIds)[] | string> {
  const resolved = await resolveLineDimensionRefs(companyId, refs, label);
  if (typeof resolved === 'string') return resolved;
  return items.map((item, i) => ({ ...item, ...(resolved[i] ?? {}) }));
}
