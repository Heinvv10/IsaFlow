/**
 * The guards around onboarding completion, against a real database through the real withAuth:
 *  - POST /api/onboarding/complete cannot finish onboarding for a user whose flag is false
 *    (that was a way round the wizard and its required documents);
 *  - PUT /api/accounting/companies refuses an entity-type change the stored documents and
 *    people do not prove;
 *  - complete-setup: a real DB error mid-chain leaves nothing; a request key held by a
 *    deactivated company is a 409, never a 500 or a constraint name; document-type and
 *    registration-number refusals.
 * Disposable schema fixture only (assertDisposable). Synthetic values.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import completeRoute from '../../pages/api/onboarding/complete';
import companiesRoute from '../../pages/api/accounting/companies';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  NO_ROWS, callRoute, callSetup, doc, dropSetupUsers, newSetupUser, person, rowsFor, setupBody, type SetupUser,
} from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const users: SetupUser[] = [];
const user = async () => { const u = await newSetupUser(pool); users.push(u); return u; };
afterAll(async () => { try { await dropSetupUsers(pool, users); } finally { await pool.end(); } }, 60000);

const flagOf = async (u: SetupUser) => (await pool.query('SELECT onboarding_completed FROM users WHERE id = $1', [u.userId])).rows[0].onboarding_completed;
const companiesNamed = async (name: string) => (await pool.query('SELECT COUNT(*)::int AS n FROM companies WHERE name = $1', [name])).rows[0].n;

describe('POST /api/onboarding/complete', () => {
  const complete = (u: SetupUser) => callRoute(completeRoute, u, {}, '/api/onboarding/complete');
  it('flag false: 409 with a sentence, the flag stays false, no cookie', async () => {
    const u = await user();
    const out = await complete(u);
    expect(out.status, JSON.stringify(out.body)).toBe(409);
    expect(out.body.error?.message).toBe('Onboarding is not finished yet. Complete the setup wizard to continue.');
    expect(await flagOf(u)).toBe(false);
    expect(out.cookies).toEqual([]);
  });
  it('flag NULL (legacy member): set to true and the cookie issued', async () => {
    const u = await user();
    await pool.query('UPDATE users SET onboarding_completed = NULL WHERE id = $1', [u.userId]);
    const out = await complete(u);
    expect(out.status).toBe(200);
    expect(await flagOf(u)).toBe(true);
    expect(out.cookies.some(c => c.startsWith('ff_onboarding_done=1;'))).toBe(true);
  });
  it('flag true: the cookie is re-issued', async () => {
    const u = await user();
    await pool.query('UPDATE users SET onboarding_completed = true WHERE id = $1', [u.userId]);
    const out = await complete(u);
    expect(out.status).toBe(200);
    expect(out.cookies.some(c => c.startsWith('ff_onboarding_done=1;'))).toBe(true);
  });
});

describe('PUT /api/accounting/companies: entity type change', () => {
  const put = (u: SetupUser, body: Record<string, unknown>) => callRoute(companiesRoute, u, { id: u.homeCompanyId, ...body }, '/api/accounting/companies', 'PUT');
  const typeOf = async (u: SetupUser) => (await pool.query('SELECT entity_type FROM companies WHERE id = $1', [u.homeCompanyId])).rows[0].entity_type;
  it('to cc without a CK1/CK2 on file: 400 with the issue, the type is unchanged', async () => {
    const u = await user();
    const out = await put(u, { entityType: 'cc' });
    expect(out.status, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toContain('Upload the CK1 or CK2');
    expect(await typeOf(u)).toBe('pty_ltd');
  });
  it('to cc with an active ck_certificate on file: saved', async () => {
    const u = await user();
    await pool.query(`INSERT INTO company_documents (company_id, document_type, document_name, file_data, mime_type, file_size, uploaded_by)
      VALUES ($1, 'ck_certificate', 'ck.pdf', 'x', 'application/pdf', 1, $2)`, [u.homeCompanyId, u.userId]);
    expect((await put(u, { entityType: 'cc' })).status).toBe(200);
    expect(await typeOf(u)).toBe('cc');
  });
  it('to partnership: needs two people with ID documents on file', async () => {
    const u = await user();
    const add = (name: string, idDoc: string | null) => pool.query(
      'INSERT INTO company_directors (company_id, name, role, id_document_name) VALUES ($1, $2, $3, $4)', [u.homeCompanyId, name, 'Partner', idDoc]);
    await add('Partner A', 'a.png');
    await add('Partner B', null);
    expect((await put(u, { entityType: 'partnership' })).body.error?.message).toContain('Upload the ID document of Partner B');
    await pool.query("UPDATE company_directors SET id_document_name = 'b.png' WHERE company_id = $1 AND name = 'Partner B'", [u.homeCompanyId]);
    expect((await put(u, { entityType: 'partnership' })).status).toBe(200);
  });
  it('an unchanged type, and saves without a type, still work for a company with no documents', async () => {
    const u = await user();
    expect((await put(u, { entityType: 'pty_ltd', city: 'Synthetic City' })).status).toBe(200);
    expect((await put(u, { city: 'Other City' })).status).toBe(200);
    expect((await put(u, { entityType: 'other' })).status).toBe(200);
  });
});

describe('complete-setup guards', () => {
  it('a real DB error mid-chain (a NUL byte the people INSERT cannot store): 500 and no rows', async () => {
    const u = await user();
    const body = setupBody('pty_ltd', { documents: [doc('cipc_certificate')], people: [{ name: 'Director\u0000A' }] });
    const out = await callSetup(u, body);
    expect(out.status, JSON.stringify(out.body)).toBe(500);
    expect(await companiesNamed(body.company.name)).toBe(0);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM company_users WHERE user_id = $1', [u.userId])).rows[0].n).toBe(1);
    expect(await flagOf(u)).toBe(false);
    expect(await rowsFor(pool, u.homeCompanyId)).toMatchObject({ ...NO_ROWS, companies: 1, company_users: 1 });
  });
  it('a key whose company was deactivated: 409 with a generic sentence, nothing new written', async () => {
    const u = await user();
    const body = setupBody('other');
    const first = await callSetup(u, body);
    expect(first.status).toBe(200);
    await pool.query('UPDATE companies SET is_active = false WHERE id = $1', [first.body.data!.companyId]);
    const name = `WIZ again ${crypto.randomUUID()}`;
    const out = await callSetup(u, { ...body, company: { name } });
    expect(out.status, JSON.stringify(out.body)).toBe(409);
    expect(JSON.stringify(out.body)).not.toMatch(/duplicate|unique|constraint|onboarding_request_key/i);
    expect(await companiesNamed(name)).toBe(0);
  });
  it('document types the entity does not use, and optional documents it may add', async () => {
    const u = await user();
    expect((await callSetup(u, setupBody('trust', { documents: [doc('letters_of_authority'), doc('ck_certificate')] }))).status).toBe(400);
    expect((await callSetup(u, setupBody('other', { documents: [doc('passport')] }))).body.error?.message).toContain('passport is not a document');
    for (const [t, people] of [['sole_proprietor', [person('Owner A')]], ['partnership', [person('P A'), person('P B')]], ['other', []]] as const) {
      const out = await callSetup(await user(), setupBody(t, { people, documents: [doc('tax_clearance'), doc('vat_registration')] }));
      expect(out.status, `${t}: ${JSON.stringify(out.body)}`).toBe(200);
      expect((await rowsFor(pool, out.body.data!.companyId!)).company_documents).toBe(2);
    }
  });
  it('a registration number of another entity type, a junk 4-byte proof and the same partner twice are refused', async () => {
    const u = await user();
    const ck = await callSetup(u, setupBody('pty_ltd', { documents: [doc('cipc_certificate')],
      company: { name: 'WIZ ck', registrationNumber: 'CK1998/012345/23' } }));
    expect(ck.status).toBe(400);
    expect(ck.body.error?.message).toContain('belongs to a Close corporation (CC)');
    const tiny = { ...doc('cipc_certificate'), data: `data:application/pdf;base64,${Buffer.from('%PDF').toString('base64')}` };
    expect((await callSetup(u, setupBody('pty_ltd', { documents: [tiny] }))).body.error?.message).toContain('too small');
    const twice = await callSetup(u, setupBody('partnership', { people: [person('Partner A'), { ...person('Partner A'), idNumber: 'SYNTH-X' }] }));
    expect(twice.body.error?.message).toContain('Partner A is listed more than once');
  });
});
