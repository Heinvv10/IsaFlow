/**
 * Which CC1 / CC2 / BU a bank allocation stamps, and on which line.
 *
 * Brief §5.3: a settlement (supplier payment, customer receipt, transfer) and a
 * VAT payment carry NO dimensions, and dimensions never land on a control line
 * (bank, AP, AR, VAT). They belong on the cost or revenue line only — the
 * contra line of a GL-account allocation. Explicit dimensions where none may
 * go are REFUSED (before any write); the bank account's defaults are simply
 * not applied there.
 *
 * Paycard spend (brief §5.4): the card's defaults (gl_accounts.default_cc1_id /
 * default_cc2_id / default_bu_id on the bank-subtype account) apply when the
 * caller names none — transaction beats default, default beats blank (§5.5).
 * A CC2 named on the transaction is never paired with the card's default CC1:
 * the FNO is derived from that project instead.
 */
import { isControlSubtype } from '../gl/dimensions/dimensionPolicy';
import { BankAllocationRefusal } from './bankAllocationRefusal';
import { hasDimensions, type DimensionIds } from '../gl/dimensions/dimensionTypes';
import type { JournalLineInput } from '../../types/gl.types';

export { isControlSubtype };

const nonEmpty = (v: string | null | undefined): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;

export interface AllocationDimensionPlanInput {
  /** The allocation settles a document or moves cash between banks. */
  settlement: boolean;
  /** The contra account is a control account (VAT payment, AP/AR by account, bank). */
  contraIsControl: boolean;
  explicit: DimensionIds;
  bankDefaults: DimensionIds;
}

/** Pure: the dimensions for the contra line, or a refusal. */
export function planAllocationDimensions(input: AllocationDimensionPlanInput): DimensionIds {
  const explicit: DimensionIds = {
    cc1Id: nonEmpty(input.explicit.cc1Id), cc2Id: nonEmpty(input.explicit.cc2Id), buId: nonEmpty(input.explicit.buId),
  };
  if (input.settlement || input.contraIsControl) {
    if (hasDimensions(explicit)) {
      throw new BankAllocationRefusal(
        input.settlement
          ? 'A supplier payment, customer receipt or transfer carries no CC1/CC2/BU — the bill or invoice it '
            + 'settles carries them. Remove the dimensions, or allocate to the cost account instead.'
          : 'This allocation posts to a control account (bank, AP, AR, VAT or payroll clearing), which carries '
            + 'no CC1/CC2/BU. Remove the dimensions.',
      );
    }
    return {};
  }
  const defaults = input.bankDefaults;
  const cc2Id = explicit.cc2Id ?? nonEmpty(defaults.cc2Id);
  const cc1Id = explicit.cc1Id ?? (explicit.cc2Id ? undefined : nonEmpty(defaults.cc1Id));
  const buId = explicit.buId ?? nonEmpty(defaults.buId);
  return {
    ...(cc1Id ? { cc1Id } : {}), ...(cc2Id ? { cc2Id } : {}), ...(buId ? { buId } : {}),
  };
}

/**
 * Stamp the planned dimensions on the contra line(s) only. The legacy
 * cost_center_id mirror of CC1 is kept, as the single allocation always set it.
 */
export function stampContraDimensions(
  lines: JournalLineInput[],
  contraAccountId: string | null,
  dims: DimensionIds,
): JournalLineInput[] {
  if (!contraAccountId || !hasDimensions(dims)) return lines;
  return lines.map((l) => (l.glAccountId === contraAccountId
    ? { ...l, cc1Id: dims.cc1Id, cc2Id: dims.cc2Id, buId: dims.buId, costCenterId: dims.cc1Id ?? l.costCenterId }
    : l));
}
