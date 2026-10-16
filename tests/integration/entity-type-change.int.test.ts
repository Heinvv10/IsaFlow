/**
 * Changing a company's entity type after onboarding (entityTypeChange.ts, via
 * PUT /api/accounting/companies), round-3 edges against a real database and the real withAuth:
 *  - the duplicate-people rule applies only when the NEW type's proof is people's IDs;
 *  - the new type's people maximum holds (3 directors cannot become a sole proprietor);
 *  - stored sizes ignore base64 whitespace and padding (a 1 000-byte file wrapped in
 *    newlines is not 1 KB);
 *  - ID fingerprints treat equivalent base64 encodings (url-safe, wrapped) as the same file.
 * And POST /api/accounting/companies no longer creates a company (onboarding does).
 * Disposable schema fixture only (assertDisposable). Synthetic values.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import companiesRoute from '../../pages/api/accounting/companies';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { PDF, callRoute, dropSetupUsers, newSetupUser, pngFor, type SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const users: SetupUser[] = [];
const user = async () => { const u = await newSetupUser(pool); users.push(u); return u; };
afterAll(async () => { try { await dropSetupUsers(pool, users); } finally { await pool.end(); } }, 60000);

const put = (u: SetupUser, entityType: string) =>
  callRoute(companiesRoute, u, { id: u.homeCompanyId, entityType }, '/api/accounting/companies', 'PUT');
const addDoc = (u: SetupUser, type: string, data = PDF) => pool.query(`INSERT INTO company_documents
  (company_id, document_type, document_name, file_data, mime_type, file_size, uploaded_by) VALUES ($1, $2, 'f.pdf', $3, 'application/pdf', 1, $4)`,
  [u.homeCompanyId, type, data, u.userId]);
const addPerson = (u: SetupUser, name: string, data: string | null, idNumber: string | null = null) => pool.query(
  'INSERT INTO company_directors (company_id, name, role, id_number, id_document_name, id_document_data) VALUES ($1, $2, $3, $4, $5, $6)',
  [u.homeCompanyId, name, 'Director', idNumber, data ? 'id.png' : null, data]);
const wrap = (b64: string, every: number) => b64.replace(new RegExp(`(.{${every}})`, 'g'), '$1\n');

describe('entity type change', () => {
  it('a legacy duplicate director does not block pty_ltd -> cc when the CK1/CK2 is on file', async () => {
    const u = await user();
    await addPerson(u, 'Director A', null);
    await addPerson(u, 'Director A', null);
    await addDoc(u, 'ck_certificate');
    const out = await put(u, 'cc');
    expect(out.status, JSON.stringify(out.body)).toBe(200);
  });
  it('the duplicate rule still holds for a people-proof type (partnership)', async () => {
    const u = await user();
    await addPerson(u, 'Partner A', pngFor('same'));
    await addPerson(u, 'Partner B', pngFor('same'));
    expect((await put(u, 'partnership')).body.error?.message).toContain('Two people have the same ID document');
  });
  it('three identified directors cannot become a sole proprietor (1 owner)', async () => {
    const u = await user();
    for (const n of ['Director A', 'Director B', 'Director C']) await addPerson(u, n, pngFor(n), `SYNTH-${n}`);
    const out = await put(u, 'sole_proprietor');
    expect(out.status, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toContain('A sole proprietor has 1 owner');
  });
  it('a 1 000-byte document padded out with base64 line breaks is not 1 KB', async () => {
    const u = await user();
    const bytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(991, 0x20)]);
    await addDoc(u, 'ck_certificate', `data:application/pdf;base64,${wrap(bytes.toString('base64'), 16)}`);
    expect((await put(u, 'cc')).status).toBe(400);
  });
  it('the same ID scan in url-safe, unpadded, line-wrapped base64 is the same document', async () => {
    const u = await user();
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1200, 0xfb), Buffer.from([0xff, 0xef])]);
    const std = bytes.toString('base64');
    const urlSafe = wrap(std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), 60);
    await addPerson(u, 'Partner A', `data:image/png;base64,${std}`);
    await addPerson(u, 'Partner B', `data:image/png;base64,${urlSafe}`);
    expect((await put(u, 'partnership')).body.error?.message).toContain('Two people have the same ID document');
  });
});

describe('POST /api/accounting/companies', () => {
  it('no longer creates a company: 405 pointing to onboarding, no row', async () => {
    const u = await user();
    const name = `WIZ direct create ${crypto.randomUUID()}`;
    const out = await callRoute(companiesRoute, u, { name }, '/api/accounting/companies');
    expect(out.status, JSON.stringify(out.body)).toBe(405);
    expect(out.body.error?.message).toBe('Create a company through onboarding (/onboarding)');
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM companies WHERE name = $1', [name])).rows[0].n).toBe(0);
  });
  it('set-default still works', async () => {
    const u = await user();
    const out = await callRoute(companiesRoute, u, { action: 'set-default', companyId: u.homeCompanyId }, '/api/accounting/companies');
    expect(out.status, JSON.stringify(out.body)).toBe(200);
  });
});
