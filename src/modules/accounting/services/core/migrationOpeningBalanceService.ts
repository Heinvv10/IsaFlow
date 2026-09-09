/**
 * Migration opening balances — post a source system's trial balance as one
 * journal entry.
 *
 * Extracted from migrationExecuteService so that file stays under the 300-line
 * cap. The caller owns error reporting: this throws a plain Error describing
 * what is wrong with the source data, and executeMigration collects it into the
 * ExecuteMigrationResult.errors channel it already reports through.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import {
  createJournalEntry,
  postJournalEntry,
} from '@/modules/accounting/services/gl/journalEntryService';
import { roundToCents } from '@/modules/accounting/utils/doubleEntry';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';
import type { ParsedAccount, MigrationSource } from './migrationParserService';
import type { DbRow } from '@/types/db';

/**
 * Resolve every account, verify the set balances, then post one entry.
 *
 * Returns the number of opening-balance lines posted (0 when there is nothing
 * to post). Throws when the journal cannot be posted as a balanced whole —
 * NOTHING is written in that case.
 *
 * The previous inline version did `if (glRows.length === 0) continue;`: an
 * account that failed to import silently vanished from the journal while every
 * other account kept its balance, and the entry was INSERTed already at
 * status='posted' (trg_gl_je_balanced fires only on UPDATE), so nothing caught
 * the resulting lopsided opening trial balance.
 *
 * Nothing is plugged to a suspense or equity account: a source file whose trial
 * balance does not sum to zero is a data problem the operator has to see, and
 * fabricating the difference as equity would bury it.
 */
export async function postOpeningBalances(
  companyId: string,
  userId: string,
  source: MigrationSource,
  accounts: ParsedAccount[],
): Promise<number> {
  const balanceAccounts = accounts.filter(a => a.openingBalance !== 0 && a.sourceCode && a.mappedType);
  if (balanceAccounts.length === 0) return 0;

  const lines: JournalLineInput[] = [];
  const unresolved: string[] = [];
  const notOwned: string[] = [];

  for (const acct of balanceAccounts) {
    // Only an account THIS source owns may receive its opening balance.
    // Resolving on the code alone posted the balance onto whatever the company
    // happened to have at that code — including an account the import's
    // conflict guard refused to touch, which the operator was told was "left
    // unchanged". The two ways a code can fail to resolve are reported apart,
    // because they need different things from the operator.
    const glRows = (await sql`
      SELECT id, imported_from FROM gl_accounts
      WHERE company_id = ${companyId}::UUID AND account_code = ${acct.sourceCode}
      LIMIT 1
    `) as DbRow[];
    if (glRows.length === 0) {
      unresolved.push(`${acct.sourceCode} ${acct.sourceName}`);
      continue;
    }
    if (glRows[0]!.imported_from !== source) {
      notOwned.push(`${acct.sourceCode} ${acct.sourceName}`);
      continue;
    }
    const isDebitNormal = acct.mappedNormalBalance === 'debit';
    lines.push({
      glAccountId: String(glRows[0]!.id),
      debit: isDebitNormal && acct.openingBalance > 0 ? acct.openingBalance : 0,
      credit: !isDebitNormal && acct.openingBalance > 0 ? acct.openingBalance : 0,
      description: `Opening balance — ${source}`,
    });
  }

  // Both classes of failure in ONE throw. Reporting only the first sends the
  // operator round the loop again: they fix the missing account, re-run, and
  // meet the second message for the first time. Dropping either and posting
  // the remainder is what produced an unbalanced opening trial balance, so
  // whichever occurred, the whole journal is refused.
  const problems: string[] = [];
  if (unresolved.length > 0) {
    problems.push(`no GL account was created for ${unresolved.join('; ')} (fix the account import, then re-run)`);
  }
  if (notOwned.length > 0) {
    // The account exists; this source does not own it. That is the company's
    // own account, another source's, or one a partial rollback released back
    // to the company — and in every case posting the source's balance to it
    // would be a write to an account the operator did not offer up. Say which
    // it is, because "no GL account was created" sent the operator looking for
    // an import failure that never happened.
    problems.push(`${notOwned.join('; ')} already exists as an account the ${source} import does not own (renumber the source row, or delete the existing account, then re-run)`);
  }
  if (problems.length > 0) {
    throw new Error(`opening balances not imported: ${problems.join('; and ')}`);
  }

  if (lines.length === 0) return 0;

  const totalDebit = roundToCents(lines.reduce((s, l) => s + l.debit, 0));
  const totalCredit = roundToCents(lines.reduce((s, l) => s + l.credit, 0));
  const difference = roundToCents(totalDebit - totalCredit);
  if (difference !== 0) {
    throw new Error(
      `source trial balance does not sum to zero — debits R${totalDebit.toFixed(2)} vs credits R${totalCredit.toFixed(2)} (difference R${Math.abs(difference).toFixed(2)}); opening balances not imported`,
    );
  }

  // createJournalEntry batches header + lines into one transaction and runs
  // validateJournalEntry; postJournalEntry re-validates and checks the fiscal
  // period is open. Deliberately NOT wrapped in withTransaction — that acquires
  // a separate pool client and would deadlock against rows already locked by
  // the request-scoped transaction.
  const entry = await createJournalEntry(companyId, {
    entryDate: fmtDate(new Date()),
    description: `Opening balances imported from ${source}`,
    source: 'auto_migration',
    reference: `OB-${source.toUpperCase()}`,
    lines,
  }, userId, { postingAgent: `system:migration:${source}` });

  await postJournalEntry(companyId, entry.id, userId);
  return lines.length;
}
