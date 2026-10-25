// src/modules/accounting/services/afs/noteGenerators/inventoryBalances.ts
// The inventory accounts with a balance at a year end: note 9 lists them, and
// note 1 states an inventories policy only when there is at least one.

import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import { rawSubtypesFor } from '@/modules/accounting/services/gl/accountSubtypes';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';

/** Inventory-classified GL accounts whose posted balance at `end` is not zero (year-end closing journals excluded). */
export async function inventoryBalancesAt(companyId: string, end: string): Promise<DbRow[]> {
  return (await sql`
    SELECT ga.account_name, ga.account_code, ga.account_subtype,
           COALESCE(SUM(CASE WHEN gje.id IS NULL THEN 0 ELSE gjl.debit - gjl.credit END), 0) AS balance
    FROM gl_accounts ga
    LEFT JOIN gl_journal_lines gjl
      ON gjl.gl_account_id = ga.id AND gjl.company_id = ${companyId}
    LEFT JOIN gl_journal_entries gje
      ON gje.id = gjl.journal_entry_id
      AND gje.entry_date <= ${end} AND gje.status = 'posted' AND gje.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
    WHERE ga.company_id = ${companyId}
      AND ga.account_subtype = ANY(${[
        ...rawSubtypesFor('inventory'),
        'raw_materials', 'work_in_progress', 'finished_goods', 'consumables',
      ]}::TEXT[])
    GROUP BY ga.account_name, ga.account_code, ga.account_subtype
    HAVING COALESCE(SUM(CASE WHEN gje.id IS NULL THEN 0 ELSE gjl.debit - gjl.credit END), 0) <> 0
    ORDER BY ga.account_subtype, ga.account_name
  `) as DbRow[];
}
