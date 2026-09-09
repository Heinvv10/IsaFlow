/**
 * POST /api/accounting/bank-feeds/[id]/extension-ingest
 *
 * Bank-feed extension ingest endpoint. The browser extension scrapes the
 * user's authenticated bank session, normalises the rows to canonical
 * `ParsedBankTransaction` shape, and POSTs them here. The server runs the
 * batch through the SAME pipeline as file-upload imports — dedup by
 * content-hash, insert via importParsedTransactions, then optionally apply
 * bank rules. This wire-format invariant means every downstream feature
 * (reconciliation, GL posting, rules engine) sees one canonical tx shape
 * regardless of source (CSV / OFX / PDF / extension).
 *
 * Auth: Bearer JWT minted by /extension-pair (HS256, 90d). The middleware
 * resolves company_id, connection_id, and bank_account_id from the token
 * and the bank_feed_connections row; CSRF is not used (cross-origin call
 * from the extension's service worker).
 *
 * Anti-abuse: rate-limited 60 batches/hr/company; daily cap of 500 tx
 * per connection (configurable via bank_feed_connections.daily_tx_cap).
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withExtensionToken, type ExtensionAuthedRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { checkRateLimit } from '@/lib/rateLimit';
import { importParsedTransactions } from '@/modules/accounting/services/bank/bankImportService';
import { applyRules as applyBankRulesService } from '@/modules/accounting/services/bank/bankRulesService';
import {
  bankTransactionHash,
  type HashableTransaction,
} from '@/modules/accounting/utils/bankTransactionHash';
import type {
  BankCsvParseResult,
  ParsedBankTransaction,
} from '@/modules/accounting/types/bank.types';

const TransactionSchema = z.object({
  transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  valueDate: z.string().optional(),
  amount: z.number().finite(),
  description: z.string().min(1).max(500),
  reference: z.string().max(200).optional(),
  balance: z.number().finite().optional(),
}).strict();

const IngestSchema = z.object({
  scraperId: z.string().min(1).max(40),
  scraperVersion: z.string().min(1).max(20),
  bankAccountExternalId: z.string().min(4).max(40),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  transactions: z.array(TransactionSchema).max(2000),
  applyBankRules: z.boolean().optional(),
}).strict().refine(d => d.fromDate <= d.toDate, {
  message: 'fromDate must be ≤ toDate',
  path: ['fromDate'],
});

const DEFAULT_DAILY_TX_CAP = 500;

async function handler(req: ExtensionAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const parsed = IngestSchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }
  const body = parsed.data;
  const { companyId, userId, connectionId, bankAccountId, bankId } = req.extension;

  // Rate limit — 60 batches/hr/company.
  const rlAllowed = await checkRateLimit(`extension-ingest:${companyId}`, { max: 60, windowSecs: 3600 });
  if (!rlAllowed) {
    return apiResponse.tooManyRequests(res, 'Rate limit exceeded for extension ingest');
  }

  // Anti-abuse: per-connection daily transaction cap.
  const capRows = (await sql`
    SELECT daily_tx_cap FROM bank_feed_connections WHERE id = ${connectionId}::UUID
  `) as Array<{ daily_tx_cap: number | null }>;
  const cap = capRows[0]?.daily_tx_cap ?? DEFAULT_DAILY_TX_CAP;
  const usedRows = (await sql`
    SELECT COALESCE(SUM(transactions_imported), 0)::INT AS used
      FROM bank_feed_sync_logs
     WHERE connection_id = ${connectionId}::UUID
       AND started_at > NOW() - INTERVAL '24 hours'
  `) as Array<{ used: number }>;
  const used = Number(usedRows[0]?.used ?? 0);
  if (used + body.transactions.length > cap) {
    log.warn(
      'Extension ingest blocked: daily tx cap exceeded',
      { connectionId, companyId, cap, used, batchSize: body.transactions.length },
      'extension-ingest',
    );
    return apiResponse.tooManyRequests(res, `Daily transaction cap of ${cap} would be exceeded.`);
  }

  // Open a sync log row.
  const logRows = (await sql`
    INSERT INTO bank_feed_sync_logs (connection_id, company_id, status)
    VALUES (${connectionId}::UUID, ${companyId}::UUID, 'running')
    RETURNING id
  `) as Array<{ id: string }>;
  const logId = String(logRows[0]?.id ?? '');

  try {
    // 1. Map to canonical shape — IngestSchema is already aligned to
    //    ParsedBankTransaction, but the type system needs the cast.
    const rawTxs: ParsedBankTransaction[] = body.transactions.map(t => ({
      transactionDate: t.transactionDate,
      ...(t.valueDate ? { valueDate: t.valueDate } : {}),
      amount: t.amount,
      description: t.description,
      ...(t.reference ? { reference: t.reference } : {}),
      ...(t.balance !== undefined ? { balance: t.balance } : {}),
    }));

    // 2. Dedup against the DB for the [fromDate, toDate] window.
    //
    // Hash strategy: use (date, amount, description) only — no balance, no
    // bank_reference. Rationale:
    //   - bank_transactions has no balance column, so we can't compare it.
    //   - ABSA doesn't expose a stable per-transaction external ID on its
    //     internal RPC. descriptionLine2 is a narrative field, not a UUID.
    //   - Using (date, amount, description) is the same collision model the
    //     CSV/OFX file-import pipeline has used in production since day one.
    //
    // If ABSA ever adds a stable transactionId field, add it to
    // absaLineToParsed as `bankReference` and use it for primary dedup here.
    let dedupedTxs = rawTxs;
    let duplicateCount = 0;
    if (rawTxs.length > 0) {
      const existing = (await sql`
        SELECT transaction_date::text AS transaction_date,
               amount,
               description
          FROM bank_transactions
         WHERE bank_account_id = ${bankAccountId}::UUID
           AND transaction_date BETWEEN ${body.fromDate} AND ${body.toDate}
      `) as Array<{
        transaction_date: string;
        amount: string | number;
        description: string | null;
      }>;

      const existingHashes = new Set<string>();
      for (const row of existing) {
        const hashable: HashableTransaction = {
          transactionDate: row.transaction_date,
          amount: Number(row.amount),
          description: row.description ?? '',
        };
        existingHashes.add(bankTransactionHash(hashable));
      }
      dedupedTxs = rawTxs.filter(tx => {
        const h = bankTransactionHash({
          transactionDate: tx.transactionDate,
          amount: tx.amount,
          description: tx.description,
        });
        if (existingHashes.has(h)) {
          duplicateCount++;
          return false;
        }
        return true;
      });
    }

    // 3. Insert through the existing pipeline.
    let importedCount = 0;
    let importWarnings: string[] = [];
    if (dedupedTxs.length > 0) {
      const parseResult: BankCsvParseResult = {
        transactions: dedupedTxs,
        errors: [],
        bankFormat: bankId,
      };
      const result = await importParsedTransactions(
        companyId,
        parseResult,
        bankAccountId,
        body.toDate,
        {
          sourceFilename: `extension/${body.scraperId}@${body.scraperVersion}`,
          importedBy: userId,
        },
      );
      importedCount = result.transactionCount;
      importWarnings = result.errors.map((e) => e.error);
    }

    // 4. Apply rules if asked.
    let appliedRuleCount = 0;
    if (body.applyBankRules !== false && importedCount > 0) {
      try {
        const ruleResult = await applyBankRulesService(companyId, bankAccountId, userId);
        appliedRuleCount = ruleResult.applied;
      } catch (err) {
        log.warn(
          'Extension ingest: applyRules failed',
          { error: err instanceof Error ? err.message : String(err), connectionId },
          'extension-ingest',
        );
      }
    }

    // 5. Update connection scraper_version + sync log.
    await sql`
      UPDATE bank_feed_connections
         SET last_scraper_version = ${body.scraperVersion},
             scraper_version = ${body.scraperVersion},
             updated_at = NOW()
       WHERE id = ${connectionId}::UUID
    `;
    await sql`
      UPDATE bank_feed_sync_logs
         SET status = 'success',
             completed_at = NOW(),
             transactions_found = ${rawTxs.length},
             transactions_imported = ${importedCount},
             transactions_duplicate = ${duplicateCount}
       WHERE id = ${logId}::UUID
    `;
    await sql`
      UPDATE bank_feed_connections
         SET last_sync_at = NOW(),
             last_sync_status = 'success',
             last_sync_error = NULL,
             updated_at = NOW()
       WHERE id = ${connectionId}::UUID
    `;

    log.info(
      'Extension ingest complete',
      { connectionId, companyId, found: rawTxs.length, imported: importedCount, duplicate: duplicateCount, appliedRules: appliedRuleCount },
      'extension-ingest',
    );

    return apiResponse.success(res, {
      found: rawTxs.length,
      imported: importedCount,
      duplicate: duplicateCount,
      appliedRules: appliedRuleCount,
      // See bank-transactions-bulk-commit: non-fatal problems the import
      // swallowed, so a caller is not told the ingest was clean when it was not.
      warnings: importWarnings,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await sql`
      UPDATE bank_feed_sync_logs
         SET status = 'failed', completed_at = NOW(), error_message = ${errMsg}
       WHERE id = ${logId}::UUID
    `;
    await sql`
      UPDATE bank_feed_connections
         SET last_sync_at = NOW(), last_sync_status = 'failed',
             last_sync_error = ${errMsg}, updated_at = NOW()
       WHERE id = ${connectionId}::UUID
    `;
    throw err;
  }
}

export default withExtensionToken(withErrorHandler(handler));
