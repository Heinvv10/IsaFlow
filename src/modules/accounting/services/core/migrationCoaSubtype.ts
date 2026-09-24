/**
 * The subtype a COA import row resolves to (its mapped role, else what the row
 * said, else the income-statement default) — split out of migrationCoaService
 * to keep that file inside the 300-line cap. The VAT-lock check does not
 * re-derive it: it reads the attributes the import actually wrote
 * (migrationCoaVatLock).
 */
import { defaultIncomeStatementSubtype } from '../gl/accountSubtypeRules';
import type { AccountImportRow, SystemAccountMap } from './migrationCoaService';

export interface ImportRowSubtype {
  isSystem: boolean;
  /** What the row itself said (or its mapped role). NULL when it said nothing. */
  explicitSubtype: string | null;
  /** explicitSubtype, or the income-statement default for a row that said nothing. */
  accountSubtype: string | null;
  /** True when accountSubtype is that default. */
  defaulted: boolean;
}

export function importRowSubtype(acct: AccountImportRow, systemAccountMap: SystemAccountMap): ImportRowSubtype {
  const subtypeEntry = Object.entries(systemAccountMap).find(([, code]) => code === acct.accountCode);
  const isSystem = subtypeEntry != null;
  // What the row itself said. Stays NULL when it said nothing, so that a
  // re-import never overwrites a classification someone made by hand.
  const explicitSubtype = subtypeEntry ? subtypeEntry[0] : (acct.accountSubtype || null);
  // A revenue/expense row with no subtype is imported under the type's
  // default and SAID SO, rather than skipped: the alternative strands
  // every income-statement code the opening balances reference.
  if (!isSystem && !explicitSubtype) {
    const fallback = defaultIncomeStatementSubtype(acct.accountType);
    if (fallback) return { isSystem, explicitSubtype, accountSubtype: fallback, defaulted: true };
  }
  return { isSystem, explicitSubtype, accountSubtype: explicitSubtype, defaulted: false };
}
