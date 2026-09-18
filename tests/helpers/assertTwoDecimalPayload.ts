/**
 * Walks any object/array and fails if a number in it:
 *   - has more than 2 decimal places, or
 *   - is negative zero, or
 *   - stringifies in exponent notation (e.g. -4.3655745685100555e-11 — the
 *     shape unrounded float drift takes once it gets small enough).
 *
 * Used to guard the five running-balance report payloads (customer_statement,
 * supplier_statement, search_gl/getAccountLedger, general_ledger, trial_balance)
 * against the L4 defect class: JS float accumulation with no rounding.
 */
export function assertTwoDecimalPayload(value: unknown, path = '$'): void {
  if (value === null || value === undefined) return;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${path}: non-finite number ${value}`);
    }
    if (Object.is(value, -0)) {
      throw new Error(`${path}: -0 must be normalised to 0`);
    }
    if (/e[+-]/i.test(String(value))) {
      throw new Error(`${path}: exponent notation (${value}) — float drift`);
    }
    const cents = Math.round(value * 100);
    // Allow float noise below 1e-9 of a cent — the check is against the
    // SERIALISED value, so this only trips on genuine >2dp precision.
    if (Math.abs(value * 100 - cents) > 1e-6) {
      throw new Error(`${path}: ${value} has more than 2 decimal places`);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((v, i) => assertTwoDecimalPayload(v, `${path}[${i}]`));
    return;
  }

  if (typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      assertTwoDecimalPayload(v, `${path}.${key}`);
    }
  }
}
