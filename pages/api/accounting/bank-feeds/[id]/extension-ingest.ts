/**
 * POST /api/accounting/bank-feeds/[id]/extension-ingest
 *
 * Bank-feed extension ingest endpoint. The browser extension scrapes the
 * user's authenticated bank session, normalises the rows, and POSTs them
 * here. The route is a thin transport: it validates the wire shape, then
 * submits the batch through `ingestBankBatch` — the canonical feed
 * ingestion service (bank sync v1, Release 1) that every live feed source
 * shares. Extension rows use content-hash identity (date | amount |
 * description); the service inserts and applies suggestion rules only —
 * it never auto-posts, auto-links transfers, or runs auto-create rules.
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
import { ingestBankBatch } from '@/modules/accounting/services/bank/feed/bankIngestionService';
import { isBankIngestionRefusal } from '@/modules/accounting/services/bank/feed/bankIngestionTypes';
import { contentHashIdentity } from '@/modules/accounting/services/bank/feed/bankIngestionValidation';
import type { NormalizedBankTransaction } from '@/modules/accounting/services/bank/feed/bankIngestionTypes';

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
  const { companyId, userId, connectionId, bankId } = req.extension;

  // Rate limit — 60 batches/hr/company.
  const rlAllowed = await checkRateLimit(`extension-ingest:${companyId}`, { max: 60, windowSecs: 3600 });
  if (!rlAllowed) {
    return apiResponse.tooManyRequests(res, 'Rate limit exceeded for extension ingest');
  }

  // Anti-abuse: per-connection daily transaction cap.
  const capRows = (await sql`
    SELECT daily_tx_cap FROM bank_feed_connections
     WHERE id = ${connectionId}::UUID AND company_id = ${companyId}::UUID
  `) as Array<{ daily_tx_cap: number | null }>;
  const cap = capRows[0]?.daily_tx_cap ?? DEFAULT_DAILY_TX_CAP;
  const usedRows = (await sql`
    SELECT COALESCE(SUM(transactions_imported), 0)::INT AS used
      FROM bank_feed_sync_logs
     WHERE connection_id = ${connectionId}::UUID
       AND company_id = ${companyId}::UUID
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

  const transactions: NormalizedBankTransaction[] = body.transactions.map((t) => ({
    identity: contentHashIdentity({ transactionDate: t.transactionDate, amount: t.amount, description: t.description }),
    state: 'posted',
    transactionDate: t.transactionDate,
    ...(t.valueDate ? { valueDate: t.valueDate } : {}),
    amount: t.amount,
    currency: 'ZAR',
    description: t.description,
    ...(t.reference ? { reference: t.reference } : {}),
    ...(t.balance !== undefined ? { balance: t.balance } : {}),
  }));

  try {
    const result = await ingestBankBatch(
      companyId,
      { source: { kind: 'feed', connectionId }, fetchedAt: new Date().toISOString(), transactions },
      { userId, sourceLabel: `extension/${body.scraperId}@${body.scraperVersion}`, bankFormat: bankId },
    );
    await sql`
      UPDATE bank_feed_connections
         SET last_scraper_version = ${body.scraperVersion}, scraper_version = ${body.scraperVersion}, updated_at = NOW()
       WHERE id = ${connectionId}::UUID AND company_id = ${companyId}::UUID`;
    const c = result.counts;
    return apiResponse.success(res, {
      found: c.found, imported: c.inserted, duplicate: c.duplicate, updated: c.updated,
      pending: c.pending, removed: c.removed, conflicts: c.conflicts,
      appliedRules: result.appliedSuggestions, warnings: result.warnings,
    });
  } catch (err) {
    // Refusals are decided before any bank_transactions write and the service
    // has already recorded a failed sync log; a 4xx COMMITs it.
    if (isBankIngestionRefusal(err)) {
      return err.code === 'SYNC_IN_PROGRESS'
        ? apiResponse.conflict(res, err.message)
        : apiResponse.badRequest(res, err.message);
    }
    throw err;
  }
}

export default withExtensionToken(withErrorHandler(handler));
