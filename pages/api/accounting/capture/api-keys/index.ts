/**
 * GET  /api/accounting/capture/api-keys — list keys for this company
 * POST /api/accounting/capture/api-keys — generate a new key
 *
 * The raw key is returned ONCE on creation and never stored — only its hash.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';
import { sql } from '@/lib/neon';
import { generateCaptureApiKey } from '@/lib/auth/captureApiKeyAuth';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';

type Row = Record<string, unknown>;

interface ApiKeyRow {
  id: string;
  label: string;
  key_prefix: string;
  is_active: boolean;
  last_used_at: Date | string | null;
  created_at: Date | string;
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;

  // ── GET — list keys (never return hash) ───────────────────────────────────
  if (req.method === 'GET') {
    const rows = await sql`
      SELECT id, label, key_prefix, is_active, last_used_at, created_at
      FROM capture_api_keys
      WHERE company_id = ${companyId}
      ORDER BY created_at DESC
    ` as ApiKeyRow[];

    return apiResponse.success(res, rows);
  }

  // ── POST — generate a new key ─────────────────────────────────────────────
  if (req.method === 'POST') {
    // R-032: a Login-as session mints no credential as the target.
    await assertNotImpersonating();
    const body = req.body as Record<string, unknown>;
    const label = typeof body?.label === 'string' ? body.label.trim() : '';

    if (!label) {
      return apiResponse.badRequest(res, 'label is required');
    }
    if (label.length > 100) {
      return apiResponse.badRequest(res, 'label must be 100 characters or fewer');
    }

    const { raw, hash, prefix } = generateCaptureApiKey();
    const createdBy = req.user?.id ?? null;

    // On the migration_admin pool, keyed on the verified company and caller
    // (S-07c): a row here is a live upload credential acting with its
    // creator's role, so no app role may write the table (migration 930).
    const insertRows = await migrationAdminTx('create capture api key', async (client) => (await client.query(
      `INSERT INTO capture_api_keys (company_id, key_hash, key_prefix, label, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, label, key_prefix, created_at`,
      [companyId, hash, prefix, label, createdBy],
    )).rows as Row[]);

    const inserted = insertRows[0]!;

    log.info(
      'capture api key created',
      { companyId, keyId: inserted.id as string, label },
      'capture-api-key',
    );

    // Raw key returned here — NEVER stored, NEVER logged.
    return apiResponse.created(res, {
      key: raw,
      id: inserted.id,
      label: inserted.label,
      prefix: inserted.key_prefix,
    });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
