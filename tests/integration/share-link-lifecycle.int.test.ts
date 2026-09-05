// tests/integration/share-link-lifecycle.int.test.ts
/**
 * The share link, end to end, against a real database: a minted token resolves
 * to its own company and nothing else; an expired one, a revoked one and a
 * wrong one all fail; and the view audit records every attempt.
 *
 * Deliberately fails (not skips) without a real DATABASE_URL: a test that can
 * pass by not running is not a test (`feedback_db_gated_tests_pass_when_skipped`).
 * vitest.integration.config.ts substitutes a `dummy.neon.tech` placeholder when
 * the env var is unset, so an absent DATABASE_URL is detected by looking for
 * that placeholder too — same convention as statement-grid-foots.int.test.ts.
 *
 * `resolveShareLink` itself only ever writes an `expired` or `revoked` audit
 * row (see shareResolver.ts) — an `ok` view is recorded by `commitShareView`,
 * which the real page (pages/share/[token].tsx) calls only after it has built
 * the pack. This file calls commitShareView the same way the page does,
 * wherever it asserts on view_count or an 'ok' audit row.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createShareLink, revokeShareLink, listShareLinks } from '@/modules/accounting/services/share/shareLinkService';
import { resolveShareLink, commitShareView } from '@/modules/accounting/services/share/shareResolver';
import { mintShareToken, hashShareToken } from '@/modules/accounting/services/share/shareToken';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL || DATABASE_URL.includes('dummy.neon.tech')) {
  throw new Error('share-link-lifecycle requires DATABASE_URL; it does not skip');
}

const CA = '00000000-0000-0000-0000-0000000053aa';
const CB = '00000000-0000-0000-0000-0000000053bb';
const UA = 'ws3-share-user-A';
const CTX = { ip: '203.0.113.9', userAgent: 'vitest' };
const PARAMS = { type: 'board', from: '2026-03-01', to: '2026-08-31' } as const;

let admin: Pool;

beforeAll(async () => {
  admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
  await admin.query(
    `INSERT INTO companies (id, name, is_active) VALUES ($1,'WS3-A',true), ($2,'WS3-B',true) ON CONFLICT (id) DO NOTHING`, [CA, CB]);
  await admin.query(`INSERT INTO users (id, email, is_active) VALUES ($1,'ws3a@test.local',true) ON CONFLICT (id) DO NOTHING`, [UA]);
  await admin.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1,$2,'admin') ON CONFLICT DO NOTHING`, [CA, UA]);
});

afterAll(async () => {
  await admin.query(`DELETE FROM share_link_views WHERE company_id IN ($1,$2)`, [CA, CB]);
  await admin.query(`DELETE FROM share_links WHERE company_id IN ($1,$2)`, [CA, CB]);
  await admin.query(`DELETE FROM company_users WHERE user_id = $1`, [UA]);
  await admin.query(`DELETE FROM users WHERE id = $1`, [UA]);
  await admin.query(`DELETE FROM companies WHERE id IN ($1,$2)`, [CA, CB]);
  await admin.end();
});

describe('share link lifecycle', () => {
  it('a fresh token resolves to the company that created it', async () => {
    const { link, token } = await createShareLink({ companyId: CA, userId: UA, params: PARAMS });
    const r = await resolveShareLink(token, CTX);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.link.companyId).toBe(CA);
      expect(r.link.id).toBe(link.id);
      expect(r.link.params).toEqual(PARAMS);
    }
  });

  it('the raw token is never persisted anywhere in the row', async () => {
    const { link, token } = await createShareLink({ companyId: CA, userId: UA, params: PARAMS });
    const { rows } = await admin.query(`SELECT * FROM share_links WHERE id = $1`, [link.id]);
    expect(JSON.stringify(rows[0])).not.toContain(token);
    expect(rows[0].token_hash).toBe(hashShareToken(token));
  });

  it('listShareLinks never returns a token or a hash to the caller', async () => {
    await createShareLink({ companyId: CA, userId: UA, params: PARAMS });
    const links = await listShareLinks(CA);
    expect(JSON.stringify(links)).not.toContain('token');
  });

  it('an unminted token is not_found, and records no view', async () => {
    const before = (await admin.query(
      `SELECT COUNT(*)::int c FROM share_link_views WHERE company_id IN ($1,$2)`, [CA, CB])).rows[0].c;
    expect((await resolveShareLink(mintShareToken(), CTX)).status).toBe('not_found');
    const after = (await admin.query(
      `SELECT COUNT(*)::int c FROM share_link_views WHERE company_id IN ($1,$2)`, [CA, CB])).rows[0].c;
    expect(after).toBe(before);
  });

  it('a revoked token stops resolving immediately and the attempt is audited', async () => {
    const { link, token } = await createShareLink({ companyId: CA, userId: UA, params: PARAMS });
    const first = await resolveShareLink(token, CTX);
    expect(first.status).toBe('ok');
    // Mirrors pages/share/[token].tsx: an 'ok' view is only ever recorded once
    // the caller commits it, after it has built the pack.
    if (first.status === 'ok') {
      await commitShareView({ id: first.link.id, companyId: first.link.companyId }, CTX);
    }
    expect(await revokeShareLink(CA, link.id, UA)).toBe(true);
    expect((await resolveShareLink(token, CTX)).status).toBe('revoked');
    const { rows } = await admin.query(
      `SELECT outcome FROM share_link_views WHERE share_link_id = $1 ORDER BY viewed_at`, [link.id]);
    expect(rows.map((r: { outcome: string }) => r.outcome)).toEqual(['ok', 'revoked']);
  });

  it('an expired token does not resolve', async () => {
    const { link, token } = await createShareLink({ companyId: CA, userId: UA, params: PARAMS });
    await admin.query(`UPDATE share_links SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [link.id]);
    expect((await resolveShareLink(token, CTX)).status).toBe('expired');
  });

  it('company B cannot revoke company A\'s link', async () => {
    const { link, token } = await createShareLink({ companyId: CA, userId: UA, params: PARAMS });
    expect(await revokeShareLink(CB, link.id, 'attacker')).toBe(false);
    expect((await resolveShareLink(token, CTX)).status).toBe('ok');
  });

  it('view_count and last_viewed_at advance only when the caller commits a successful view', async () => {
    const { link, token } = await createShareLink({ companyId: CA, userId: UA, params: PARAMS });
    for (let i = 0; i < 2; i++) {
      const r = await resolveShareLink(token, CTX);
      expect(r.status).toBe('ok');
      if (r.status === 'ok') {
        await commitShareView({ id: r.link.id, companyId: r.link.companyId }, CTX);
      }
    }
    const { rows } = await admin.query(`SELECT view_count, last_viewed_at FROM share_links WHERE id = $1`, [link.id]);
    expect(rows[0].view_count).toBe(2);
    expect(rows[0].last_viewed_at).not.toBeNull();
  });
});
