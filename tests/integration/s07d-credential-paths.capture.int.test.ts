// tests/integration/s07d-credential-paths.capture.int.test.ts
//
// S-07d (migration 937), the rest of s07d-credential-paths.int.test.ts: auditor
// sessions, capture inboxes (email and WhatsApp) and bank feed connections are
// written on the migration_admin pool now. Each legitimate path works end to
// end through its real route on the production logins, and the auditor's
// download, which stays on the service pool, follows the session's state.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import sessionsRoute from '../../pages/api/accounting/audit-exports/[id]/sessions';
import sessionRoute from '../../pages/api/accounting/audit-exports/[id]/sessions/[sessionId]';
import downloadRoute from '../../pages/api/audit-portal/download';
import inboxAddressRoute from '../../pages/api/accounting/capture/inbox-address';
import whatsAppInboxRoute from '../../pages/api/accounting/capture/whatsapp-inbox';
import bankFeedsRoute from '../../pages/api/accounting/bank-feeds/index';
import bankFeedRoute from '../../pages/api/accounting/bank-feeds/[id]';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { verifyWhatsAppDestination } from '@/modules/accounting/services/capture/whatsAppVerificationService';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';
import { callPublic } from './s07c-credential-paths.helpers';

const ids = newIds();
// me is an admin of company; owner its owner.
const { me, owner, company, other } = ids;
const exportId = crypto.randomUUID();
const otherExport = crypto.randomUUID();
let bankAccount = '';

beforeAll(async () => {
  await setup(ids);
  vi.stubEnv('APP_URL', 'https://app.s07d.test');
  vi.stubEnv('TWILIO_AUTH_TOKEN', 's07d-twilio');
  // A ready PDF-only pack, as older exports are: 891's guard lets a pack become
  // ready only by being built, so the seed lifts its guard inside its own
  // transaction, as audit-snapshots-pack.int.test.ts does.
  const c = await fixture.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE audit_trail_exports DISABLE TRIGGER audit_trail_export_pack_guard');
    for (const [id, co] of [[exportId, company], [otherExport, other]]) {
      await c.query(`INSERT INTO audit_trail_exports (id, company_id, period_start, period_end, status, pdf_storage_path, pdf_sha256)
        VALUES ($1, $2, '2026-01-01', '2026-01-31', 'ready', 's07d/pack.pdf', 'x')`, [id, co]);
    }
    await c.query('ALTER TABLE audit_trail_exports ENABLE ALWAYS TRIGGER audit_trail_export_pack_guard');
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  bankAccount = (await fixture.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
    normal_balance, level) VALUES ($1, 'S07D-BANK', 'S07d bank', 'asset', 'bank', 'debit', 3) RETURNING id`, [company])).rows[0].id;
}, 60000);
afterAll(async () => {
  // A ready export goes with its company (891), in teardown.
  for (const t of ['audit_portal_sessions', 'capture_whatsapp_claims', 'capture_inboxes', 'bank_feed_connections',
    'gl_accounts']) {
    await fixture.query(`DELETE FROM ${t} WHERE company_id = ANY($1)`, [[company, other]]);
  }
  await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool()]);
});

describe('S-07d: auditor sessions, on migration_admin', () => {
  it('an owner invites an auditor; the auditor downloads; a revoke ends it', async () => {
    const created = await callRoute(sessionsRoute, { sub: owner, method: 'POST', companyId: company, query: { id: exportId },
      body: { auditorEmail: 'auditor@s07d.test' } });
    expect(created.status).toBe(201);
    const { session, accessToken } = (created.body as { data: { session: { id: string }; accessToken: string } }).data;
    const head = () => callPublic(downloadRoute, { method: 'HEAD', query: { sessionId: session.id, token: accessToken } });
    expect((await head()).status).toBe(200);
    const used = await fixture.query('SELECT use_count FROM audit_portal_sessions WHERE id = $1', [session.id]);
    expect(used.rows[0]?.use_count).toBe(1);
    expect((await callRoute(sessionRoute, { sub: owner, method: 'DELETE', companyId: company,
      query: { id: exportId, sessionId: session.id } })).status).toBe(200);
    expect((await head()).status).toBe(401);
  });

  it('the issue itself refuses another company\'s export, past the route\'s check (the statement reads it)', async () => {
    const { createPortalSession, AuditExportNotIssuableError } = await import('@/modules/accounting/services/capture/auditTrailExportService');
    await expect(createPortalSession(otherExport, company, 'auditor@s07d.test')).rejects.toBeInstanceOf(AuditExportNotIssuableError);
    await expect(createPortalSession(crypto.randomUUID(), company, 'auditor@s07d.test')).rejects.toBeInstanceOf(AuditExportNotIssuableError);
    expect((await fixture.query('SELECT 1 FROM audit_portal_sessions WHERE export_id = $1', [otherExport])).rowCount).toBe(0);
  });

  it('a session for another company\'s export is not issued', async () => {
    const r = await callRoute(sessionsRoute, { sub: owner, method: 'POST', companyId: company, query: { id: otherExport },
      body: { auditorEmail: 'auditor@s07d.test' } });
    expect(r.status).toBe(404);
    expect((await fixture.query('SELECT 1 FROM audit_portal_sessions WHERE export_id = $1', [otherExport])).rowCount).toBe(0);
  });
});

describe('S-07d: capture inboxes, on migration_admin', () => {
  it('the email inbox is minted once, then rotated to a new address', async () => {
    const first = await callRoute(inboxAddressRoute, { sub: me, method: 'GET', companyId: company });
    expect(first.status).toBe(200);
    const a = (first.body as { data: { inbox: { address: string } } }).data.inbox.address;
    const again = await callRoute(inboxAddressRoute, { sub: me, method: 'GET', companyId: company });
    expect((again.body as { data: { inbox: { address: string } } }).data.inbox.address).toBe(a);
    const rotated = await callRoute(inboxAddressRoute, { sub: me, method: 'POST', companyId: company });
    expect(rotated.status).toBe(200);
    const b = (rotated.body as { data: { inbox: { address: string } } }).data.inbox.address;
    expect(b).not.toBe(a);
    const live = await fixture.query(`SELECT address FROM capture_inboxes WHERE company_id = $1 AND channel = 'email' AND is_active`,
      [company]);
    expect(live.rows.map((r) => r.address)).toEqual([b]);
  });

  it('a WhatsApp claim is made, and the provider\'s callback activates the inbox', async () => {
    const address = '+27820000035';
    const claimed = await callRoute(whatsAppInboxRoute, { sub: me, method: 'POST', companyId: company, body: { address } });
    expect(claimed.status).toBe(200);
    const url = (claimed.body as { data: { verificationUrl: string } }).data.verificationUrl;
    const token = new URL(url).searchParams.get('token')!;
    const bound = await verifyWhatsAppDestination(token, address);
    expect(bound?.companyId).toBe(company);
    const inbox = await fixture.query(`SELECT is_active, provider_verified_at IS NOT NULL AS verified FROM capture_inboxes
      WHERE company_id = $1 AND channel = 'whatsapp'`, [company]);
    expect(inbox.rows).toEqual([{ is_active: true, verified: true }]);
    expect((await fixture.query('SELECT 1 FROM capture_whatsapp_claims WHERE company_id = $1', [company])).rowCount).toBe(0);
    // The same callback again finds the active binding, on the service pool:
    // every inbound message makes this call, so it takes no migration_admin connection.
    const checkout = vi.spyOn(migrationAdminPool(), 'connect');
    try {
      expect((await verifyWhatsAppDestination(token, address))?.inboxId).toBe(bound?.inboxId);
      expect(checkout).not.toHaveBeenCalled();
    } finally {
      checkout.mockRestore();
    }
  });
});

describe('S-07d: bank feed connections, on migration_admin', () => {
  it('an extension connection is created, then disconnected', async () => {
    const created = await callRoute(bankFeedsRoute, { sub: me, method: 'POST', companyId: company,
      body: { provider: 'extension', accountId: bankAccount, config: { bankId: 'absa' } } });
    expect(created.status).toBe(201);
    const id = (created.body as { data: { id: string } }).data.id;
    expect((await callRoute(bankFeedRoute, { sub: me, method: 'DELETE', companyId: company, query: { id } })).status).toBeLessThan(300);
    const row = await fixture.query('SELECT is_active, status, created_by FROM bank_feed_connections WHERE id = $1', [id]);
    expect(row.rows).toEqual([{ is_active: false, status: 'disconnected', created_by: me }]);
  });
});
