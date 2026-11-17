/**
 * Classified Bank Transactions Import API
 * POST /api/accounting/bank-transactions-import-classified
 *   Import pre-classified bank transactions from worksheets.
 *
 * Body: { bankAccountId, transactions: ClassifiedBankTx[] }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { journalDayWindowError } from '@/modules/accounting/utils/journalDateWindow';
import { ledgerDaysOf } from '@/modules/accounting/services/gl/journalDateGuard';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { sql, transaction } from '@/lib/neon';
import { log } from '@/lib/logger';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { existingStatementHashes, statementLineHash } from '@/modules/accounting/services/bank/bankStatementDedupe';
import { dateRangeOf } from '@/modules/accounting/services/bank/bankStatementDateRange';
import { lockBankAccountIngest } from '@/modules/accounting/services/bank/bankIngestLock';
import { assertBankAccountInCompany, isBankAccountGuardRefusal } from '@/modules/accounting/services/bank/bankAccountGuard';
import { resolveWorksheetDimensions } from '@/modules/accounting/services/bank/classifiedImportDimensions';
import type { DimensionIds } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';
type Row = Record<string, unknown>;

const ClassifiedBankTxSchema = z.object({
  transactionDate: z.string().min(8).max(30),
  description: z.string().max(500),
  debit: z.number().nonnegative().optional(),
  credit: z.number().nonnegative().optional(),
  category: z.string().max(200).optional(),
  costCentreT1: z.string().max(100).optional(),
  costCentreT2: z.string().max(100).optional(),
  businessUnit: z.string().max(100).optional(),
  statementRef: z.string().max(200).optional(),
  source: z.string().max(50).optional(),
});

const BodySchema = z.object({
  bankAccountId: UUID,
  transactions: z.array(ClassifiedBankTxSchema).min(1).max(10_000),
}).strict();

type ClassifiedBankTx = z.infer<typeof ClassifiedBankTxSchema>;

/** bank_transactions.amount is numeric(15,2), as gl_journal_lines. */
const MAX_AMOUNT = 9_999_999_999_999.99;

/**
 * What Postgres would refuse mid-INSERT (a 500 that rolled the file back): a NUL byte in a text column (22021) and an
 * amount past the column's precision (22003). Named per row, as a 400, before any write.
 */
function rowRefusal(tx: ClassifiedBankTx): string | null {
  for (const [name, value] of [['description', tx.description], ['category', tx.category], ['statementRef', tx.statementRef]] as const) {
    if (value?.includes('\u0000')) return `${name} contains a NUL character, which cannot be stored`;
  }
  for (const [name, value] of [['debit', tx.debit], ['credit', tx.credit]] as const) {
    if (value !== undefined && value > MAX_AMOUNT) return `${name} exceeds the largest amount that can be stored (R${MAX_AMOUNT.toFixed(2)})`;
  }
  return null;
}

/**
 * A year-first date (YYYY-M-D, optionally followed by a time) naming a day that exists. Year-first is the one order
 * Postgres reads the same under every DateStyle; '31/12/2026' was a 500 from the cast and '01/02/2026' became 2 January.
 */
function isYearFirstCalendarDay(value: string): boolean {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(0);
  probe.setUTCFullYear(y, mo - 1, d); // not Date.UTC: it maps years 0..99 to 1900..1999
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
    }
    const { bankAccountId, transactions } = parsed.data;

    // An active bank account of this company, before anything is written (audit 2026-11-15 WP2-1: any account was taken).
    await assertBankAccountInCompany(companyId, bankAccountId);

    // Pre-load category → GL account mapping from existing rules
    const ruleRows = (await sql`
      SELECT LOWER(rule_name) AS rule_name, gl_account_id, supplier_id
      FROM bank_categorisation_rules
      WHERE is_active = true AND company_id = ${companyId}
    `) as Row[];
    const categoryMap = new Map<string, { glAccountId: string; supplierId: string | null }>();
    for (const r of ruleRows) {
      categoryMap.set(String(r.rule_name).toLowerCase(), {
        glAccountId: String(r.gl_account_id),
        supplierId: r.supplier_id ? String(r.supplier_id) : null, // a UUID: Number() made it NaN
      });
    }

    const batchId = crypto.randomUUID();
    let skippedDuplicates = 0;
    const unresolvedCategories: string[] = [];

    // Pre-normalise incoming transactions and drop zero-amount/empty rows
    interface NormTx {
      tx: ClassifiedBankTx;
      amount: number;
      txDate: string;
      desc: string;
      row: number;
    }
    const badDate = (row: number, value: string) =>
      `Row ${row + 1}: transactionDate "${value}" must be a year-first date such as 2026-09-04 (YYYY-MM-DD)`;
    const normTxs: NormTx[] = [];
    for (const [row, tx] of transactions.entries()) {
      const refusal = rowRefusal(tx);
      if (refusal) return apiResponse.badRequest(res, `Row ${row + 1}: ${refusal}`);
      const debit = Number(tx.debit || 0);
      const credit = Number(tx.credit || 0);
      const amount = credit > 0 ? credit : -debit;
      if (amount === 0) continue;
      const txDate = String(tx.transactionDate).trim();
      const desc = String(tx.description || '').trim();
      if (!txDate || !desc) continue;
      // Before any write: only a year-first calendar day. Postgres refused '31/12/2026' (a 500 from the cast) and read
      // '01/02/2026' as 2 January, so a worksheet in another order cannot be told apart from one in this.
      if (!isYearFirstCalendarDay(txDate)) return apiResponse.badRequest(res, badDate(row, txDate));
      normTxs.push({ tx, amount, txDate, desc, row });
    }
    // The day Postgres stores for each date (gl/journalDateGuard); one outside the ledger window refuses the file (422).
    const days = await ledgerDaysOf(normTxs.map((n) => n.txDate));
    for (const n of normTxs) {
      const day = days.get(n.txDate) ?? null;
      if (day === null) return apiResponse.badRequest(res, badDate(n.row, n.txDate)); // a time part Postgres cannot read
      const windowError = journalDayWindowError(day);
      if (windowError) return apiResponse.validationError(res, { transactionDate: [windowError] });
      n.txDate = day;
    }

    // Dedupe against the account, under its ingest lock taken BEFORE the read (WP2-2): a concurrent import of the same
    // worksheet waits here for this one to commit, then reads its lines. The hash is the statement imports' own
    // (bankStatementDedupe): the old text key compared the amount's JS spelling with NUMERIC::text and never matched.
    await lockBankAccountIngest(companyId, bankAccountId);
    const lines = normTxs.map((n) => ({ transactionDate: n.txDate, amount: n.amount, description: n.desc }));
    const range = dateRangeOf(lines);
    const seen = range ? await existingStatementHashes(companyId, bankAccountId, range) : new Set<string>();
    const toInsert = normTxs.filter((_, i) => {
      if (seen.has(statementLineHash(lines[i]!))) { skippedDuplicates++; return false; }
      return true;
    });

    // Resolve categories and collect unresolved ones
    interface InsertRow {
      txDate: string;
      amount: number;
      desc: string;
      statementRef: string | null;
      suggestedGlAccountId: string | null;
      suggestedSupplierId: string | null;
      category: string | null;
      dims: DimensionIds;
    }
    // The worksheet's cost centres, resolved to the line's own dimension columns (classifiedImportDimensions).
    const { dimensions, unresolved: unresolvedDimensions } = await resolveWorksheetDimensions(
      companyId, toInsert.map(({ tx }) => tx));
    const insertRows: InsertRow[] = toInsert.map(({ tx, amount, txDate, desc }, i) => {
      const category = String(tx.category || '').trim();
      const mapping = categoryMap.get(category.toLowerCase());
      if (category && !mapping && !unresolvedCategories.includes(category)) {
        unresolvedCategories.push(category);
      }
      return {
        txDate,
        amount,
        desc,
        statementRef: tx.statementRef || null,
        suggestedGlAccountId: mapping?.glAccountId || null,
        suggestedSupplierId: mapping?.supplierId || null,
        category: category || null,
        dims: dimensions[i] ?? {},
      };
    });

    // Batch INSERT all non-duplicate rows in a single transaction — the batch row first (step 2 provenance: the
    // importer, who may then not allocate these lines under enforcement; a worksheet carries no statement file).
    if (insertRows.length > 0) {
      const statementDate = insertRows.map((r) => r.txDate).sort().at(-1)!;
      await transaction((txSql) => [
        txSql`
          INSERT INTO bank_import_batches (id, company_id, bank_account_id, statement_date, transaction_count,
            imported_by, balance_source, import_channel)
          VALUES (${batchId}::UUID, ${companyId}::UUID, ${bankAccountId}::UUID, ${statementDate}::DATE,
            ${insertRows.length}, ${(req as CompanyAuthedRequest).user.id}, 'not_in_file', 'classified')
        `,
        ...insertRows.map((r) =>
          txSql`
            INSERT INTO bank_transactions (
              bank_account_id, transaction_date, amount, description,
              reference, import_batch_id, status,
              suggested_gl_account_id, suggested_supplier_id,
              suggested_category, cc1_id, cc2_id, bu_id,
              company_id
            ) VALUES (
              ${bankAccountId}::UUID, ${r.txDate}, ${r.amount}, ${r.desc},
              ${r.statementRef}, ${batchId}::UUID, 'imported',
              ${r.suggestedGlAccountId}::UUID, ${r.suggestedSupplierId}::UUID,
              ${r.category}, ${r.dims.cc1Id ?? null}::UUID, ${r.dims.cc2Id ?? null}::UUID, ${r.dims.buId ?? null}::UUID,
              ${companyId}
            )
          `
        ),
      ]);
    }

    const inserted = insertRows.length;

    log.info('Imported classified bank transactions', {
      batchId, bankAccountId, inserted, skippedDuplicates,
      unresolvedCategories: unresolvedCategories.length,
    }, 'accounting');

    return apiResponse.created(res, {
      batchId,
      inserted,
      skippedDuplicates,
      unresolvedCategories: unresolvedCategories.length > 0 ? unresolvedCategories : undefined,
      unresolvedDimensions: unresolvedDimensions.length > 0 ? unresolvedDimensions : undefined,
    });
  } catch (err) {
    // A held ingest lock (or any lock wait) aborted the transaction: 503 + Retry-After rolls it back; a 400 would COMMIT it.
    if (respondIfLockTimeout(res, err)) return;
    if (isBankAccountGuardRefusal(err)) return apiResponse.badRequest(res, err.message);
    // Audit WP2 row 9: anything else is a fault — rethrown, so withErrorHandler's 500 rolls the request back.
    log.error('Failed to import classified bank transactions', { error: err }, 'accounting-api');
    throw err;
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
