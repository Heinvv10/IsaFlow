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
import pisScoreRoute from '../../pages/api/accounting/afs/pis-score';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  NO_ROWS, PDF, callRoute, callSetup, doc, dropSetupUsers, newSetupUser, person, pngFor, rowsFor, setupBody, type SetupUser,
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

describe('entity type change: every writer checks the new type\'s proof (companies PUT, pis-score PUT)', () => {
  const put = (u: SetupUser, body: Record<string, unknown>, id = u.homeCompanyId) => callRoute(companiesRoute, u, { id, ...body }, '/api/accounting/companies', 'PUT');
  const pis = (u: SetupUser, body: Record<string, unknown>) => callRoute(pisScoreRoute, u, body, '/api/accounting/afs/pis-score', 'PUT');
  const typeOf = async (id: string) => (await pool.query('SELECT entity_type FROM companies WHERE id = $1', [id])).rows[0].entity_type;
  const addDoc = (companyId: string, u: SetupUser, type: string, data = PDF) => pool.query(`INSERT INTO company_documents
    (company_id, document_type, document_name, file_data, mime_type, file_size, uploaded_by) VALUES ($1, $2, 'f.pdf', $3, 'application/pdf', 1, $4)`,
    [companyId, type, data, u.userId]);
  const addPerson = (u: SetupUser, name: string, idDoc: { name: string; data: string } | null, idNumber: string | null = null) => pool.query(
    'INSERT INTO company_directors (company_id, name, role, id_number, id_document_name, id_document_data) VALUES ($1, $2, $3, $4, $5, $6)',
    [u.homeCompanyId, name, 'Partner', idNumber, idDoc?.name ?? null, idDoc?.data ?? null]);

  it('companies PUT to cc without a CK1/CK2 on file: 400 with the issue, the type is unchanged', async () => {
    const u = await user();
    const out = await put(u, { entityType: 'cc' });
    expect(out.status, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toContain('Upload the CK1 or CK2');
    expect(await typeOf(u.homeCompanyId)).toBe('pty_ltd');
  });
  it('pis-score PUT to cc without a CK1/CK2: 400, unchanged; with one on file: saved', async () => {
    const u = await user();
    const out = await pis(u, { entityType: 'cc' });
    expect(out.status, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toContain('Upload the CK1 or CK2');
    expect(await typeOf(u.homeCompanyId)).toBe('pty_ltd');
    await addDoc(u.homeCompanyId, u, 'ck_certificate');
    expect((await pis(u, { entityType: 'cc' })).status).toBe(200);
    expect(await typeOf(u.homeCompanyId)).toBe('cc');
    expect((await pis(u, { employeeCountEnd: 3 })).status).toBe(200); // no type in the body: no check
  });
  it('a stored document under 1 KB, or inactive, is not proof', async () => {
    const u = await user();
    await addDoc(u.homeCompanyId, u, 'ck_certificate', `data:application/pdf;base64,${Buffer.from('%PDF').toString('base64')}`);
    expect((await put(u, { entityType: 'cc' })).status).toBe(400);
    await addDoc(u.homeCompanyId, u, 'ck_certificate');
    await pool.query("UPDATE company_documents SET is_active = false WHERE company_id = $1 AND file_data = $2", [u.homeCompanyId, PDF]);
    expect((await put(u, { entityType: 'cc' })).status).toBe(400);
  });
  it('to partnership: an id_document_name with no data (or under 1 KB) is not an ID; two real IDs are', async () => {
    const u = await user();
    await addPerson(u, 'Partner A', { name: 'a.png', data: pngFor('Partner A') });
    await addPerson(u, 'Partner B', { name: 'b.png', data: '' });
    expect((await put(u, { entityType: 'partnership' })).body.error?.message).toContain('Upload the ID document of Partner B');
    await pool.query("UPDATE company_directors SET id_document_data = $2 WHERE company_id = $1 AND name = 'Partner B'",
      [u.homeCompanyId, `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`]);
    expect((await put(u, { entityType: 'partnership' })).body.error?.message).toContain('Upload the ID document of Partner B');
    await pool.query("UPDATE company_directors SET id_document_data = $2 WHERE company_id = $1 AND name = 'Partner B'", [u.homeCompanyId, pngFor('Partner B')]);
    expect((await put(u, { entityType: 'partnership' })).status).toBe(200);
  });
  it('to partnership: the same person twice (same ID document) is refused', async () => {
    const u = await user();
    await addPerson(u, 'Partner A', { name: 'a.png', data: pngFor('same') });
    await addPerson(u, 'Partner B', { name: 'b.png', data: pngFor('same') });
    expect((await put(u, { entityType: 'partnership' })).body.error?.message).toContain('Two people have the same ID document');
  });
  it("another company the user owns (not the active one): RLS lets the check see its rows, so it judges them", async () => {
    const u = await user();
    const other = crypto.randomUUID();
    await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [other, `WIZ second ${other}`]);
    await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'owner', false)`, [other, u.userId]);
    expect((await put(u, { entityType: 'cc' }, other)).status).toBe(400);
    await addDoc(other, u, 'ck_certificate');
    expect((await put(u, { entityType: 'cc' }, other)).status).toBe(200);
    expect(await typeOf(other)).toBe('cc');
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
    // Same name, no ID numbers, different scans: the same person twice. With different ID numbers: two people.
    const noNumber = (seed: string) => ({ name: 'Partner A', idDocument: { name: `${seed}.png`, data: pngFor(seed) } });
    const twice = await callSetup(u, setupBody('partnership', { people: [noNumber('one'), noNumber('two')] }));
    expect(twice.body.error?.message).toContain('Partner A is listed more than once');
    const namesakes = await callSetup(await user(), setupBody('partnership', { people: [
      { ...noNumber('one'), idNumber: 'SYNTH-1' }, { ...noNumber('two'), idNumber: 'SYNTH-2' }] }));
    expect(namesakes.status, JSON.stringify(namesakes.body)).toBe(200);
  });
});
