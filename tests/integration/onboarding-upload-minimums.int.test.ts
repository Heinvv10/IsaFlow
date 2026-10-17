/**
 * The 1 KB upload minimum (uploadLimits.MIN_UPLOAD_BYTES) holds on every route that stores
 * a proof document, not only onboarding's complete-setup: POST /api/accounting/company-directors
 * (ID documents) and POST /api/accounting/company-documents. A director with an ID document
 * NAME but no data is stored without one. Real withAuth; disposable schema fixture only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import directorsRoute from '../../pages/api/accounting/company-directors';
import documentsRoute from '../../pages/api/accounting/company-documents';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { PDF, callRoute, dropSetupUsers, newSetupUser, pngFor, type SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const users: SetupUser[] = [];
const user = async () => { const u = await newSetupUser(pool); users.push(u); return u; };
afterAll(async () => { try { await dropSetupUsers(pool, users); } finally { await pool.end(); } }, 60000);

const TINY_PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')}`;
const TINY_PDF = `data:application/pdf;base64,${Buffer.from('%PDF').toString('base64')}`;
const directors = (u: SetupUser, list: unknown[]) => callRoute(directorsRoute, u, { directors: list }, '/api/accounting/company-directors');
const stored = async (u: SetupUser) => (await pool.query(
  'SELECT name, id_document_name, id_document_data IS NOT NULL AS has_data FROM company_directors WHERE company_id = $1 ORDER BY name', [u.homeCompanyId])).rows;

describe('company-directors POST', () => {
  it('an ID document under 1 KB is refused and nothing is replaced', async () => {
    const u = await user();
    const out = await directors(u, [{ name: 'Director A', idDocument: { name: 'id.png', data: TINY_PNG } }]);
    expect(out.status, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toContain('too small');
    expect(await stored(u)).toEqual([]);
  });
  it('a name without data is not stored as an ID document; a real one is', async () => {
    const u = await user();
    const out = await directors(u, [
      { name: 'Director A', idDocument: { name: 'ghost.png' } },
      { name: 'Director B', idDocument: { name: 'b.png', data: pngFor('Director B') } },
    ]);
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(await stored(u)).toEqual([
      { name: 'Director A', id_document_name: null, has_data: false },
      { name: 'Director B', id_document_name: 'b.png', has_data: true },
    ]);
  });
});

describe('company-documents POST', () => {
  const upload = (u: SetupUser, fileData: string) => callRoute(documentsRoute, u, {
    companyId: u.homeCompanyId, documentType: 'ck_certificate', documentName: 'ck.pdf', fileData, mimeType: 'application/pdf', fileSize: 1,
  }, '/api/accounting/company-documents');
  it('a file under 1 KB is refused; 2 KB is stored', async () => {
    const u = await user();
    const tiny = await upload(u, TINY_PDF);
    expect(tiny.status, JSON.stringify(tiny.body)).toBe(400);
    expect(tiny.body.error?.message).toContain('too small');
    expect((await upload(u, PDF)).status).toBe(201);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM company_documents WHERE company_id = $1', [u.homeCompanyId])).rows[0].n).toBe(1);
  });
});
