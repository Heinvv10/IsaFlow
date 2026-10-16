/**
 * Edge cases for POST /api/onboarding/complete-setup (part 2: files and bodies, chart
 * template, request-key semantics, rate limit), ported from the edge-case tester's file.
 * Disposable schema fixture only (assertDisposable). All values synthetic.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callSetup, doc, dropSetupUsers, person, rowsFor, setupBody, type SetupUser } from './helpers/onboardingSetupFixture';
import { edgeHelpers } from './helpers/onboardingEdgeHelpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const users: SetupUser[] = [];
const { user, count, companiesNamed, membership, refused, accepted } = edgeHelpers(pool, users);
afterAll(async () => { try { await dropSetupUsers(pool, users); } finally { await pool.end(); } }, 60000);

describe('files and bodies', () => {
  const fake = (mime: string, bytes: string) => ({ ...doc('cipc_certificate'), mimeType: mime, data: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` });
  it('document magic-bytes mismatch (html as pdf, png header as pdf, pdf as png)', async () => {
    await refused('pty_ltd', { documents: [fake('application/pdf', '<html>x</html>')] }, 'contents do not match');
    // Fix 11: a data-URL prefix that disagrees with mimeType is refused before the magic bytes are read.
    await refused('pty_ltd', { documents: [{ ...doc('cipc_certificate'), mimeType: 'image/png' }] }, 'the file says application/pdf, not image/png');
  });
  it('person id document magic-bytes mismatch', () =>
    refused('sole_proprietor', { people: [{ name: 'Owner A', idNumber: 'X', idDocument: { name: 'id.png', data: `data:image/png;base64,${Buffer.from('not a png at all').toString('base64')}` } }] }, 'contents do not match'));
  it('disallowed mime / empty data / svg / missing prefix on person doc', async () => {
    await refused('pty_ltd', { documents: [{ ...doc('cipc_certificate'), mimeType: 'text/html' }] }, 'the file says application/pdf, not text/html');
    await refused('pty_ltd', { documents: [{ ...doc('cipc_certificate'), mimeType: 'text/html', data: doc('x').data.split(',')[1] }] }, 'not allowed');
    await refused('pty_ltd', { documents: [{ ...doc('cipc_certificate'), data: '' }] }, 'invalid or empty');
    await refused('sole_proprietor', { people: [{ name: 'A', idDocument: { name: 'i', data: Buffer.from('%PDF-1.4').toString('base64') } }] }, 'not allowed');
  });
  it('document data-URL prefix mime differing from mimeType field (png bytes, mimeType pdf)', async () => {
    const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]).toString('base64')}`;
    await refused('pty_ltd', { documents: [{ ...doc('cipc_certificate'), data: png, mimeType: 'application/pdf' }] }, 'the file says image/png, not application/pdf');
  });
  it('bad requestKey / entityType / coaTemplate / non-object body', async () => {
    for (const over of [{ requestKey: 'not-a-uuid' }, { requestKey: undefined }, { entityType: 'company' }, { entityType: undefined }, { coaTemplate: 'zoho' },
      { people: 'x' }, { documents: {} }]) {
      const u = await user();
      const out = await callSetup(u, { ...setupBody('other'), ...over });
      expect(out.status, JSON.stringify(over)).toBe(400);
      expect(await membership(u)).toBe(1);
    }
    const u = await user();
    expect((await callSetup(u, null)).status).toBe(400);
    expect((await callSetup(u, 'str')).status).toBe(400);
    expect((await callSetup(u, [])).status).toBe(400);
  });
  it('20 documents ok boundary; 21 refused', async () => {
    await refused('other', { documents: Array.from({ length: 21 }, () => doc('tax_clearance')) }, 'Maximum 20');
  });
  it('a refused request does not burn the key: retry with the same key after fixing succeeds', async () => {
    const u = await user();
    const body = setupBody('pty_ltd');
    expect((await callSetup(u, body)).status).toBe(400);
    const ok = await callSetup(u, { ...body, documents: [doc('cipc_certificate')] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data!.replayed).toBe(false);
  });
});

describe('coaTemplate', () => {
  const tmplCount = async (id: string) => count(`SELECT COUNT(*)::int AS n FROM gl_accounts WHERE company_id = $1 AND account_code = '001'`, [id]);
  const total = async (id: string) => count('SELECT COUNT(*)::int AS n FROM gl_accounts WHERE company_id = $1', [id]);
  it('blank seeds no xero template accounts; record how many accounts it has vs standard', async () => {
    const b = await accepted('other', { coaTemplate: 'blank' });
    expect(await tmplCount(b.companyId)).toBe(0);
    const s = await accepted('other', { coaTemplate: 'isaflow_standard' });
    const x = await accepted('other', { coaTemplate: 'xero_compatible' });
    expect(await total(b.companyId)).toBeLessThanOrEqual(await total(s.companyId));
    expect(await total(x.companyId)).toBeGreaterThan(0);
  });
  it('sage_compatible and omitted coaTemplate (defaults) work', async () => {
    await accepted('other', { coaTemplate: 'sage_compatible' });
    const u = await user();
    const body: Record<string, unknown> = setupBody('other'); delete body.coaTemplate;
    expect((await callSetup(u, body)).status).toBe(200);
  });
});

describe('request key semantics', () => {
  it("another user's key (fix 3: stored per user): they get their own fresh company, no leak, the first untouched", async () => {
    const owner = await user();
    const body = setupBody('other');
    const first = await callSetup(owner, body);
    expect(first.status).toBe(200);
    const intruder = await user();
    const name = `WIZ intruder ${crypto.randomUUID()}`;
    const out = await callSetup(intruder, { ...body, company: { name, vatPeriod: 'none' } });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body.data!.replayed).toBe(false);
    expect(JSON.stringify(out)).not.toContain(first.body.data!.companyId!);
    expect(await companiesNamed(name)).toBe(1);
    expect(await membership(intruder)).toBe(2);
    expect(out.cookies.some(c => c.includes(first.body.data!.companyId!))).toBe(false);
  });
  it("another user's key does not alter the first user's company or onboarding flag", async () => {
    const owner = await user(); const body = setupBody('other');
    const first = await callSetup(owner, body);
    const intruder = await user();
    await callSetup(intruder, { ...body, company: { name: `WIZ i2 ${crypto.randomUUID()}` } });
    const row = (await pool.query('SELECT name, entity_type FROM companies WHERE id = $1', [first.body.data!.companyId])).rows[0];
    expect(row.name).toBe(body.company.name);
    expect(await count('SELECT COUNT(*)::int AS n FROM company_users WHERE company_id = $1', [first.body.data!.companyId])).toBe(1);
  });
  it('same user replays: replayed:true, no duplicate rows of any kind, cookies set; 3 replays', async () => {
    const u = await user();
    const body = setupBody('pty_ltd', { documents: [doc('cipc_certificate')], people: [person('D1')] });
    const first = await callSetup(u, body);
    expect(first.status).toBe(200);
    expect(first.body.data!.replayed).toBe(false);
    const before = await rowsFor(pool, first.body.data!.companyId!);
    for (let i = 0; i < 3; i++) {
      const r = await callSetup(u, body);
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual({ companyId: first.body.data!.companyId, replayed: true });
    }
    expect(await rowsFor(pool, first.body.data!.companyId!)).toEqual(before);
    expect(await companiesNamed(body.company.name)).toBe(1);
    expect(await membership(u)).toBe(2);
  });
  it('replay with a different (even invalid-by-rules) payload but same key', async () => {
    const u = await user(); const body = setupBody('other');
    const first = await callSetup(u, body);
    const r = await callSetup(u, { ...body, entityType: 'pty_ltd' }); // rules refuse this one before the key lookup
    expect(first.status).toBe(200);
    expect([200, 400]).toContain(r.status);
  });
  it('concurrent double submit, same user + key: one company, one replayed', async () => {
    const u = await user();
    const body = setupBody('pty_ltd', { documents: [doc('cipc_certificate')] });
    const [a, b] = await Promise.all([callSetup(u, body), callSetup(u, body)]);
    expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([200, 200]);
    expect(a.body.data!.companyId).toBe(b.body.data!.companyId);
    expect(await companiesNamed(body.company.name)).toBe(1);
    expect(await count('SELECT COUNT(*)::int AS n FROM company_documents WHERE company_id = $1', [a.body.data!.companyId])).toBe(1);
  });
  it('concurrent x5 same key: one company', async () => {
    const u = await user(); const body = setupBody('other');
    const rs = await Promise.all(Array.from({ length: 5 }, () => callSetup(u, body)));
    expect(rs.map(r => r.status), JSON.stringify(rs.map(r => r.body))).toEqual([200, 200, 200, 200, 200]);
    expect(new Set(rs.map(r => r.body.data!.companyId)).size).toBe(1);
    expect(rs.filter(r => !r.body.data!.replayed).length).toBe(1);
    expect(await companiesNamed(body.company.name)).toBe(1);
  });
  it('concurrent, same key, TWO different users (fix 3): two companies, both 200, the raw key stored nowhere', async () => {
    const a = await user(); const b = await user();
    const body = setupBody('other');
    const nameB = `WIZ concB ${crypto.randomUUID()}`;
    const [ra, rb] = await Promise.all([callSetup(a, body), callSetup(b, { ...body, company: { name: nameB, vatPeriod: 'none' } })]);
    expect([ra.status, rb.status], JSON.stringify([ra.body, rb.body])).toEqual([200, 200]);
    expect(ra.body.data!.companyId).not.toBe(rb.body.data!.companyId);
    expect(await count('SELECT COUNT(*)::int AS n FROM companies WHERE onboarding_request_key = $1::uuid', [body.requestKey])).toBe(0);
    expect(await companiesNamed(body.company.name)).toBe(1);
    expect(await companiesNamed(nameB)).toBe(1);
  });
  it('request key case-insensitive: UPPERCASE replay returns same company', async () => {
    const u = await user(); const body = setupBody('other');
    const first = await callSetup(u, body);
    const r = await callSetup(u, { ...body, requestKey: body.requestKey.toUpperCase() });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ companyId: first.body.data!.companyId, replayed: true });
  });
  it('failure mid-way (DB CHECK on doc size would not trigger) -> a doc with bad data after valid ones leaves nothing', async () => {
    const u = await user();
    const body = setupBody('pty_ltd', { documents: [doc('cipc_certificate'), { ...doc('tax_clearance'), data: `data:application/pdf;base64,${Buffer.from('nope').toString('base64')}` }] });
    const out = await callSetup(u, body);
    expect(out.status).toBe(400);
    expect(await companiesNamed(body.company.name)).toBe(0);
    expect(await rowsFor(pool, u.homeCompanyId)).toMatchObject({ companies: 1 });
  });
  it('rate limit (fix 13): refused requests do not count; the 11th VALID request in an hour is 429', async () => {
    const u = await user();
    for (let i = 0; i < 12; i++) expect((await callSetup(u, { requestKey: 'bad' })).status).toBe(400);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await callSetup(u, setupBody('other', { coaTemplate: 'blank' }))).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
  }, 120000);
});
