// tests/integration/s08-portal-magic-link-per-company.int.test.ts
//
// Audit 2026-10-18 S-08: POST /api/accounting/portal/auth looked the email up
// with LIMIT 1 and sent a link for whichever company came back. The rule
// (Hein, 2026-10-21): one email listing every LIVE company the contact is
// active on, each with its own magic link, labelled with the company name.
// The response stays 200 { sent: true } whether or not the email exists.
//
// Real route, real magicLinkService, real verify route, real DB. Only the
// mail transport and the rate limiter are replaced: the email is captured so
// its links can be followed, and the limiter is not what this test is about.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import type { NextApiRequest, NextApiResponse } from 'next';
import { assertDisposableDb, isDisposableDb } from '../helpers/assertDisposableDb';

const sendEmailMock = vi.hoisted(() => vi.fn());
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail: sendEmailMock }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true), getClientIp: () => '127.0.0.1' }));
vi.hoisted(() => { process.env.PORTAL_JWT_SECRET ??= 's08-portal-jwt-secret-for-tests-0123456789abcdef'; });

import { verifyPortalToken } from '@/lib/auth/portalJwt';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so the @/ alias won't resolve
import authHandler from '../../pages/api/accounting/portal/auth';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so the @/ alias won't resolve
import verifyHandler from '../../pages/api/accounting/portal/auth/verify';

const DATABASE_URL = process.env.DATABASE_URL;
assertDisposableDb('s08 seeds companies and portal contacts.');

const ALPHA = '00000000-0000-4000-8000-0000000a0801';
const BETA = '00000000-0000-4000-8000-0000000a0802';
const SUSPENDED = '00000000-0000-4000-8000-0000000a0803';
const DELETED = '00000000-0000-4000-8000-0000000a0804';
const COMPANIES = [ALPHA, BETA, SUSPENDED, DELETED];
const EMAIL = 's08-director@fixture.test';
const XSS_EMAIL = 's08-xss@fixture.test';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

function mockRes() {
  const out = { status: 0, body: undefined as unknown, headers: {} as Record<string, unknown>, location: '' };
  const res = {
    status(code: number) { out.status = code; return res; },
    json(b: unknown) { out.body = b; if (!out.status) out.status = 200; return res; },
    setHeader(k: string, v: unknown) { out.headers[k.toLowerCase()] = v; return res; },
    redirect(code: number, url: string) { out.status = code; out.location = url; return res; },
  };
  return { res: res as unknown as NextApiResponse, out };
}

async function requestLink(email: string) {
  const { res, out } = mockRes();
  await (authHandler as Handler)({ method: 'POST', body: { email }, headers: {}, query: {} } as unknown as NextApiRequest, res);
  return out;
}

function sentEmails(): Array<{ to: string; html: string }> {
  return sendEmailMock.mock.calls.map((c) => c[0] as { to: string; html: string });
}

function tokensIn(html: string): string[] {
  return [...new Set([...html.matchAll(/verify\?token=([0-9a-f]{64})/g)].map((m) => m[1]!))];
}

async function landingCompanyOf(token: string): Promise<string | null> {
  const { res, out } = mockRes();
  await (verifyHandler as Handler)({ method: 'GET', query: { token }, headers: {} } as unknown as NextApiRequest, res);
  if (out.location !== '/accounting/afs/portal/dashboard') return null;
  const cookie = String((out.headers['set-cookie'] as string[])[0]);
  const jwt = cookie.split(';')[0]!.split('=')[1]!;
  return (await verifyPortalToken(jwt))?.companyId ?? null;
}

describe.skipIf(!isDisposableDb(DATABASE_URL))('S-08 — one sign-in email, one link per live company', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await admin.query(
      `INSERT INTO companies (id, name, is_active, status, suspended_at) VALUES
         ($1,'S08 Alpha (Pty) Ltd',true,'active',NULL),
         ($2,'S08 Beta <script>alert(1)</script>',true,'active',NULL),
         ($3,'S08 Suspended Ltd',true,'suspended',now()),
         ($4,'S08 Deleted Ltd',true,'deleted',NULL)
       ON CONFLICT (id) DO NOTHING`, COMPANIES);
    for (const c of COMPANIES) {
      await admin.query(
        `INSERT INTO portal_contacts (company_id, name, email, role) VALUES ($1,'Jo Director',$2,'director')
         ON CONFLICT (company_id, email) DO NOTHING`, [c, EMAIL]);
    }
    await admin.query(
      `INSERT INTO portal_contacts (company_id, name, email, role) VALUES ($1,'Xss Only',$2,'director')
       ON CONFLICT (company_id, email) DO NOTHING`, [BETA, XSS_EMAIL]);
  });

  beforeEach(() => sendEmailMock.mockReset());

  afterAll(async () => {
    await admin.query('DELETE FROM portal_magic_links WHERE company_id = ANY($1::UUID[])', [COMPANIES]);
    await admin.query('DELETE FROM portal_contacts WHERE company_id = ANY($1::UUID[])', [COMPANIES]);
    await admin.query('DELETE FROM companies WHERE id = ANY($1::UUID[])', [COMPANIES]);
    await admin.end();
  });

  it('sends one email with a link per live company, and each link lands in its own company', async () => {
    const out = await requestLink(EMAIL);
    expect(out.status).toBe(200);
    expect(JSON.stringify(out.body)).toContain('"sent":true');

    const emails = sentEmails();
    expect(emails).toHaveLength(1);
    expect(emails[0]!.to).toBe(EMAIL);
    expect(emails[0]!.html).toContain('S08 Alpha (Pty) Ltd');
    expect(emails[0]!.html).not.toContain('S08 Suspended Ltd');
    expect(emails[0]!.html).not.toContain('S08 Deleted Ltd');

    const tokens = tokensIn(emails[0]!.html);
    expect(tokens).toHaveLength(2);
    const landed = await Promise.all(tokens.map(landingCompanyOf));
    expect(landed.sort()).toEqual([ALPHA, BETA].sort());
  });

  it('gives no link for a suspended or deleted company', async () => {
    await requestLink(EMAIL);
    const rows = await admin.query(
      `SELECT company_id FROM portal_magic_links
       WHERE company_id = ANY($1::UUID[]) AND used_at IS NULL AND expires_at > now()`, [[SUSPENDED, DELETED]]);
    expect(rows.rowCount).toBe(0);
  });

  it('escapes the company name in the email', async () => {
    await requestLink(XSS_EMAIL);
    const html = sentEmails()[0]!.html;
    expect(html).toContain('S08 Beta &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('answers 200 { sent: true } and sends nothing for an unknown email', async () => {
    const out = await requestLink('s08-nobody@fixture.test');
    expect(out.status).toBe(200);
    expect(JSON.stringify(out.body)).toContain('"sent":true');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('matches the email whatever its case and surrounding spaces', async () => {
    await requestLink(`  ${EMAIL.toUpperCase()} `);
    expect(sentEmails()).toHaveLength(1);
    expect(tokensIn(sentEmails()[0]!.html)).toHaveLength(2);
  });
});
