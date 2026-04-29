/**
 * POST /api/accounting/bank-feeds/extension-pair
 *
 * Pairs a browser-extension scraper to an IsaFlow bank account. Creates a
 * bank_feed_connections row with provider='extension' (or reuses an existing
 * one for the same bank_account_id) and mints a 90-day HS256 JWT bound to
 * the connection. The extension stores the JWT in chrome.storage.local and
 * sends it as Authorization: Bearer on subsequent ingest calls.
 *
 * Revocation = UPDATE bank_feed_connections SET is_active=false (the
 * withExtensionToken middleware checks this on every request).
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, signExtensionToken } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createBankFeedConnection } from '@/modules/accounting/services/bank/openBankingConnectionService';
import type { DbRow } from '@/types/db';

const SUPPORTED_BANKS = ['absa'] as const;

const PairSchema = z.object({
  bankId: z.enum(SUPPORTED_BANKS),
  bankAccountId: z.string().uuid(),
  externalAccountId: z.string().min(4).max(40),
  scraperVersion: z.string().max(20).optional(),
}).strict();

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const parsed = PairSchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }
  const { bankId, bankAccountId, externalAccountId, scraperVersion } = parsed.data;
  const { companyId } = req;
  const userId = req.user.id;

  // IDOR guard — the IsaFlow UI's "bank account" picker returns a
  // gl_accounts row id (account_subtype='bank'); bank_transactions.bank_account_id
  // also FKs to gl_accounts(id). So we verify against gl_accounts here, not
  // the bank_accounts metadata table.
  const acct = (await sql`
    SELECT id FROM gl_accounts
     WHERE id = ${bankAccountId}::UUID
       AND company_id = ${companyId}::UUID
       AND account_subtype = 'bank'
     LIMIT 1
  `) as DbRow[];
  if (acct.length === 0) {
    return apiResponse.notFound(res, 'Bank account');
  }

  // Reuse an existing extension connection for the same (company, bankAccount, bankId)
  // so re-pairing the extension doesn't create duplicate rows.
  const existing = (await sql`
    SELECT id FROM bank_feed_connections
     WHERE company_id = ${companyId}::UUID
       AND bank_account_id = ${bankAccountId}::UUID
       AND provider = 'extension'
       AND COALESCE(config->>'bankId', '') = ${bankId}
       AND is_active = true
     ORDER BY created_at DESC
     LIMIT 1
  `) as DbRow[];

  let connectionId: string;
  if (existing.length > 0 && existing[0]) {
    connectionId = String(existing[0].id);
    await sql`
      UPDATE bank_feed_connections
         SET scraper_version = ${scraperVersion ?? null},
             updated_at = NOW()
       WHERE id = ${connectionId}::UUID
    `;
  } else {
    const conn = await createBankFeedConnection(
      companyId,
      {
        provider: 'extension',
        accountId: bankAccountId,
        externalAccountId,
        config: { bankId },
      },
      userId,
    );
    connectionId = conn.id;
    if (scraperVersion) {
      await sql`
        UPDATE bank_feed_connections
           SET scraper_version = ${scraperVersion}
         WHERE id = ${connectionId}::UUID
      `;
    }
  }

  const jwt = await signExtensionToken({
    userId,
    companyId,
    connectionId,
    bankId,
    scope: 'bank-feed-ingest',
  });

  log.info(
    'Extension paired',
    { companyId, connectionId, bankId, reused: existing.length > 0 },
    'extension-pair',
  );

  return apiResponse.success(res, {
    connectionId,
    bankId,
    jwt,
    ingestUrl: `/api/accounting/bank-feeds/${connectionId}/extension-ingest`,
  }, 'Extension paired', 201);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
