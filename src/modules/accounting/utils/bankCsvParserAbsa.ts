/**
 * Bank CSV Parser — ABSA
 *
 * ABSA exports two layouts and both turn up in migrations:
 *   legacy   Account Number,Date,Description1,Description2,Amount,Balance
 *   current  Account Number,Transaction Date,Description,Amount,Balance
 *
 * Positional parsing only ever fitted the legacy one, so a current-layout
 * export lost its amount column (or was rejected outright by detection).
 *
 * The header mapping that fixed that was never ABSA-specific — it reads any
 * date/description/amount header — so it now lives in bankCsvParserGeneric.ts
 * and is shared with the `generic` format. What stays here is the part that IS
 * ABSA: the legacy positional fallback, for an export whose header row cannot
 * be mapped at all.
 *
 * Dates arrive as either YYYY/MM/DD or DD/MM/YYYY; amounts as -1234.56 or
 * "1 234,56". Both are handled by the shared engine.
 */

import type { BankCsvParseResult } from '../types/bank.types';
import {
  type MappedColumns,
  mapCsvColumns,
  parseHeaderMappedCsv,
} from './bankCsvParserGeneric';

/** Column positions of the legacy 6-column layout, used when no header matches. */
// The legacy layout is positional and carries no reference column, so there is
// no index to name here — null, not a guess at one.
const LEGACY_COLUMNS: MappedColumns = {
  date: 1, descriptions: [2, 3], amount: 4, balance: 5, reference: null,
};

/**
 * Retained for the detection tests and any caller probing an ABSA header.
 * Delegates to the shared mapper — the two must never drift apart, because
 * detection and parsing disagreeing is what produced a silent empty import.
 */
export function mapAbsaColumns(header: string[]): MappedColumns | null {
  return mapCsvColumns(header);
}

export function parseABSAStatement(csv: string): BankCsvParseResult {
  return parseHeaderMappedCsv(csv, {
    bankFormat: 'absa',
    fallbackColumns: LEGACY_COLUMNS,
    legacyMarker: 'description1',
  });
}
