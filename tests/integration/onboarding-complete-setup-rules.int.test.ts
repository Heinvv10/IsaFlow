/**
 * POST /api/onboarding/complete-setup against a real database, through the real withAuth:
 * the server-side rule per entity type (one required proof each, entityOnboardingRules),
 * what a successful completion writes, and the double-submit guard (request key, mig 895).
 *
 * Disposable schema fixture only (assertDisposable).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  callSetup, doc, dropSetupUsers, newSetupUser, person, rowsFor, setupBody, type SetupUser,
} from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const users: SetupUser[] = [];
const user = async () => { const u = await newSetupUser(pool); users.push(u); return u; };

afterAll(async () => {
  try { await dropSetupUsers(pool, users); } finally { await pool.end(); }
}, 60000);

const companiesNamed = async (name: string) =>
  (await pool.query('SELECT COUNT(*)::int AS n FROM companies WHERE name = $1', [name])).rows[0].n as number;

/** Refused with 400 and the message; nothing at all is written. */
async function expectRefused(entityType: string, over: Record<string, unknown>, message: string) {
  const u = await user();
  const body = setupBody(entityType, over);
  const out = await callSetup(u, body);
  expect(out.status, JSON.stringify(out.body)).toBe(400);
  expect(out.body.error?.message).toContain(message);
  expect(await companiesNamed(body.company.name)).toBe(0);
  expect((await pool.query('SELECT COUNT(*)::int AS n FROM company_users WHERE user_id = $1', [u.userId])).rows[0].n).toBe(1);
  expect((await pool.query('SELECT onboarding_completed FROM users WHERE id = $1', [u.userId])).rows[0].onboarding_completed).toBe(false);
  expect(out.cookies).toEqual([]);
}

/** Accepted: returns the new company, which carries the entity type. */
async function expectAccepted(entityType: string, over: Record<string, unknown>) {
  const u = await user();
  const out = await callSetup(u, setupBody(entityType, over));
  expect(out.status, JSON.stringify(out.body)).toBe(200);
  const companyId = out.body.data!.companyId!;
  const row = (await pool.query('SELECT entity_type, registration_number FROM companies WHERE id = $1', [companyId])).rows[0];
  expect(row.entity_type).toBe(entityType);
  return { u, companyId, out, row };
}

describe('complete-setup: the required proof per entity type', () => {
  it('pty_ltd is refused without a CIPC certificate', () =>
    expectRefused('pty_ltd', { documents: [doc('tax_clearance')] }, 'Upload the CIPC registration certificate'));

  it('pty_ltd with its CIPC certificate: company, owner, directors, document, chart, flag and cookies', async () => {
    const { u, companyId, out, row } = await expectAccepted('pty_ltd', {
      company: { name: `WIZ pty ${crypto.randomUUID()}`, registrationNumber: '2020/123456/07', vatPeriod: 'none' },
      people: [person('Director A', false), person('Director B')], documents: [doc('cipc_certificate'), doc('bbbee_certificate')],
      coaTemplate: 'xero_compatible',
    });
    expect(row.registration_number).toBe('2020/123456/07');
    const rows = await rowsFor(pool, companyId);
    expect(rows).toMatchObject({ companies: 1, company_users: 1, company_directors: 2, company_documents: 2 });
    const roles = (await pool.query('SELECT DISTINCT role FROM company_directors WHERE company_id = $1', [companyId])).rows;
    expect(roles).toEqual([{ role: 'Director' }]);
    // The chosen template's own accounts are there (xero's 3-digit codes are not in the taxonomy create_company_with_owner seeds).
    const tmpl = (await pool.query(`SELECT COUNT(*)::int AS n FROM gl_accounts WHERE company_id = $1 AND account_code = '001'`, [companyId])).rows[0].n;
    expect(tmpl).toBe(1);
    expect((await pool.query('SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [companyId, u.userId])).rows)
      .toEqual([{ role: 'owner' }]);
    expect((await pool.query('SELECT onboarding_completed FROM users WHERE id = $1', [u.userId])).rows[0].onboarding_completed).toBe(true);
    expect(out.cookies.some(c => c.startsWith(`active_company_id=${companyId};`))).toBe(true);
    expect(out.cookies.some(c => c.startsWith('ff_onboarding_done=1;'))).toBe(true);
  });

  it('ltd and npc need the CIPC certificate too', async () => {
    await expectRefused('ltd', {}, 'Upload the CIPC registration certificate');
    await expectAccepted('ltd', { documents: [doc('cipc_certificate')] });
    await expectRefused('npc', {}, 'Upload the CIPC registration certificate');
    await expectAccepted('npc', { documents: [doc('cipc_certificate')] });
  });

  it('a sole proprietor finishes with the owner and their ID, no CIPC; a registration number is not stored', async () => {
    const { companyId, row } = await expectAccepted('sole_proprietor', {
      company: { name: `WIZ sole ${crypto.randomUUID()}`, registrationNumber: '2020/123456/07' }, people: [person('Owner A')],
    });
    expect(row.registration_number).toBeNull();
    expect((await pool.query('SELECT role, id_document_name FROM company_directors WHERE company_id = $1', [companyId])).rows)
      .toEqual([{ role: 'Owner', id_document_name: 'Owner A-id.png' }]);
    expect((await rowsFor(pool, companyId)).company_documents).toBe(0);
  });

  it('a sole proprietor is refused without the owner ID, with two owners, or with a CIPC certificate', async () => {
    await expectRefused('sole_proprietor', {}, "Add the owner and upload the owner's ID document");
    await expectRefused('sole_proprietor', { people: [person('Owner A', false)] }, 'Upload the ID document of Owner A');
    await expectRefused('sole_proprietor', { people: [person('Owner A'), person('Owner B')] }, 'A sole proprietor has 1 owner');
    await expectRefused('sole_proprietor', { people: [person('Owner A')], documents: [doc('cipc_certificate')] },
      'CIPC Registration Certificate is not a document for a Sole proprietor');
  });

  it('a partnership needs at least two partners, each with an ID document', async () => {
    await expectRefused('partnership', { people: [person('Partner A')] }, 'Add at least 2 partners');
    await expectRefused('partnership', { people: [person('Partner A'), person('Partner B', false)] }, 'Upload the ID document of Partner B');
    const { companyId } = await expectAccepted('partnership', { people: [person('Partner A'), person('Partner B')] });
    expect((await pool.query('SELECT DISTINCT role FROM company_directors WHERE company_id = $1', [companyId])).rows)
      .toEqual([{ role: 'Partner' }]);
  });

  it('a CC needs its CK1/CK2 (a CIPC certificate does not do), stored as ck_certificate', async () => {
    await expectRefused('cc', { documents: [doc('cipc_certificate')] }, 'Upload the CK1 or CK2');
    const { companyId } = await expectAccepted('cc', { documents: [doc('ck_certificate')], people: [person('Member A', false)] });
    expect((await pool.query('SELECT document_type FROM company_documents WHERE company_id = $1', [companyId])).rows)
      .toEqual([{ document_type: 'ck_certificate' }]);
    expect((await pool.query('SELECT role FROM company_directors WHERE company_id = $1', [companyId])).rows).toEqual([{ role: 'Member' }]);
  });

  it("a trust needs the Master's Letters of Authority", async () => {
    await expectRefused('trust', {}, "Upload the Master's Letters of Authority");
    const { companyId } = await expectAccepted('trust', {
      company: { name: `WIZ trust ${crypto.randomUUID()}`, registrationNumber: 'IT1234/2020' },
      documents: [doc('letters_of_authority')], people: [person('Trustee A', false)],
    });
    expect((await pool.query('SELECT registration_number FROM companies WHERE id = $1', [companyId])).rows[0].registration_number)
      .toBe('IT1234/2020');
    expect((await pool.query('SELECT role FROM company_directors WHERE company_id = $1', [companyId])).rows).toEqual([{ role: 'Trustee' }]);
  });

  it('"other" needs nothing; the blank chart template seeds no template accounts', async () => {
    const { companyId } = await expectAccepted('other', { coaTemplate: 'blank' });
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM gl_accounts WHERE company_id = $1 AND account_code = '001'`, [companyId])).rows[0].n)
      .toBe(0);
  });

  it('an unknown entity type, a spoofed file and a bad VAT period are refused before anything is written', async () => {
    await expectRefused('company', {}, 'Choose the type of business');
    const spoofed = { ...doc('cipc_certificate'), data: `data:application/pdf;base64,${Buffer.from('<html>x</html>').toString('base64')}` };
    await expectRefused('pty_ltd', { documents: [spoofed] }, 'contents do not match application/pdf');
    await expectRefused('other', { company: { name: 'WIZ vat', vatPeriod: 'quarterly' } }, 'vatPeriod must be');
  });
});

describe('complete-setup: one company per request key', () => {
  it('a retry with the same key after a commit returns the same company (replayed), not a second one', async () => {
    const u = await user();
    const body = setupBody('other');
    const first = await callSetup(u, body);
    const second = await callSetup(u, body);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.body.data).toEqual({ companyId: first.body.data!.companyId, replayed: true });
    expect(await companiesNamed(body.company.name)).toBe(1);
    expect(second.cookies.some(c => c.startsWith(`active_company_id=${first.body.data!.companyId};`))).toBe(true);
  });

  it('two concurrent requests with the same key create one company', async () => {
    const u = await user();
    const body = setupBody('other');
    const [a, b] = await Promise.all([callSetup(u, body), callSetup(u, body)]);
    expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([200, 200]);
    expect(a.body.data!.companyId).toBe(b.body.data!.companyId);
    expect([a.body.data!.replayed, b.body.data!.replayed].sort()).toEqual([false, true]);
    expect(await companiesNamed(body.company.name)).toBe(1);
  });

  it("the same key from another user is a different key: they get their own fresh company, the first is untouched", async () => {
    const owner = await user();
    const body = setupBody('other');
    const first = await callSetup(owner, body);
    expect(first.status).toBe(200);
    const other = await user();
    const name = `WIZ other user ${crypto.randomUUID()}`;
    const out = await callSetup(other, { ...body, company: { name } });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body.data!.replayed).toBe(false);
    expect(out.body.data!.companyId).not.toBe(first.body.data!.companyId);
    expect(await companiesNamed(name)).toBe(1);
    expect(await rowsFor(pool, first.body.data!.companyId!)).toMatchObject({ companies: 1, company_users: 1 });
    // Stored keys are md5(user:key), so the two rows never share one.
    const keys = (await pool.query('SELECT onboarding_request_key::text AS k FROM companies WHERE id = ANY($1::uuid[])',
      [[first.body.data!.companyId, out.body.data!.companyId]])).rows.map((r: { k: string }) => r.k);
    expect(new Set(keys).size).toBe(2);
    expect(keys).not.toContain(body.requestKey);
  });
});
