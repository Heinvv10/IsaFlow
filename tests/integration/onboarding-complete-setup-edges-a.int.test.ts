/**
 * Edge cases for POST /api/onboarding/complete-setup (part 1: entity types, document types,
 * people, names / registration number / VAT), ported from the edge-case tester's file.
 * Disposable schema fixture only (assertDisposable). All values synthetic.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callSetup, doc, dropSetupUsers, person, rowsFor, setupBody, type SetupUser } from './helpers/onboardingSetupFixture';
import { PROOF, ROLE, edgeHelpers } from './helpers/onboardingEdgeHelpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const users: SetupUser[] = [];
const { user, membership, refused, accepted } = edgeHelpers(pool, users);
afterAll(async () => { try { await dropSetupUsers(pool, users); } finally { await pool.end(); } }, 60000);

describe('all 8 entity types, with and without proof', () => {
  for (const [type, p] of Object.entries(PROOF)) {
    it(`${type}: accepted with its proof; roles + entity_type stored`, async () => {
      const people = p.people ?? [person('Person One', false)];
      const { companyId } = await accepted(type, { people, documents: p.docs ?? [] });
      const roles = (await pool.query('SELECT DISTINCT role FROM company_directors WHERE company_id = $1', [companyId])).rows;
      expect(roles).toEqual([{ role: ROLE[type] }]);
    });
    if (type !== 'other') {
      it(`${type}: refused with no proof at all (nothing written)`, () => refused(type, {}));
      it(`${type}: refused with optional docs only and no proof`, () =>
        refused(type, { documents: [doc('tax_clearance'), doc('bbbee_certificate'), doc('vat_registration')] }));
    }
  }
  it('optional docs alone are fine for "other" and for sole prop / partnership with IDs, and are stored', async () => {
    const o = await accepted('other', { documents: [doc('tax_clearance'), doc('bbbee_certificate'), doc('vat_registration')] });
    expect((await rowsFor(pool, o.companyId)).company_documents).toBe(3);
    const s = await accepted('sole_proprietor', { people: [person('Owner A')], documents: [doc('vat_registration')] });
    expect((await rowsFor(pool, s.companyId)).company_documents).toBe(1);
  });
  it('pty_ltd with cipc plus three optional docs stores 4 docs', async () => {
    const r = await accepted('pty_ltd', { documents: [doc('cipc_certificate'), doc('tax_clearance'), doc('bbbee_certificate'), doc('vat_registration')] });
    expect((await rowsFor(pool, r.companyId)).company_documents).toBe(4);
  });
});

describe('disallowed document types', () => {
  it('ck_certificate on pty_ltd (even with cipc present)', () =>
    refused('pty_ltd', { documents: [doc('cipc_certificate'), doc('ck_certificate')] }, 'is not a document for a'));
  it('letters_of_authority on sole_proprietor', () =>
    refused('sole_proprietor', { people: [person('A')], documents: [doc('letters_of_authority')] }, 'is not a document for a'));
  it('cipc_certificate on trust (with LoA) and on cc (with CK)', async () => {
    await refused('trust', { documents: [doc('letters_of_authority'), doc('cipc_certificate')] }, 'is not a document for a');
    await refused('cc', { documents: [doc('ck_certificate'), doc('cipc_certificate')] }, 'is not a document for a');
  });
  it('type "other" and an unknown type are refused before the DB CHECK is reached', async () => {
    await refused('other', { documents: [doc('other')] });
    await refused('other', { documents: [doc('passport')] });
  });
  it('document with empty type is 400', () => refused('other', { documents: [{ ...doc('x'), type: '' }] }, 'type is required'));
});

describe('people rules', () => {
  it('partnership with 1 partner', () => refused('partnership', { people: [person('Partner A')] }, 'Add at least 2 partners'));
  it('partnership with 2 where one lacks an ID', () =>
    refused('partnership', { people: [person('Partner A'), person('Partner B', false)] }, 'Upload the ID document of Partner B'));
  it('partnership: 2nd partner whitespace-only name counts as absent', () =>
    refused('partnership', { people: [person('Partner A'), person('   ')] }, 'Add at least 2 partners'));
  it('partnership with 3 partners, all with IDs', async () => {
    const { companyId } = await accepted('partnership', { people: [person('A'), person('B'), person('C')] });
    expect((await rowsFor(pool, companyId)).company_directors).toBe(3);
  });
  it('sole_proprietor with 2 owners', () =>
    refused('sole_proprietor', { people: [person('Owner A'), person('Owner B')] }, 'A sole proprietor has 1 owner'));
  it('sole_proprietor: one owner + one whitespace row is fine (blank row dropped)', async () => {
    const { companyId } = await accepted('sole_proprietor', { people: [person('Owner A'), person('  ')] });
    expect((await rowsFor(pool, companyId)).company_directors).toBe(1);
  });
  it('sole_proprietor owner with whitespace-only name -> refused', () =>
    refused('sole_proprietor', { people: [person('   ')] }, "Add the owner"));
  it('person name is trimmed on store', async () => {
    const { companyId } = await accepted('sole_proprietor', { people: [person('  Owner Trim  ')] });
    expect((await pool.query('SELECT name FROM company_directors WHERE company_id = $1', [companyId])).rows).toEqual([{ name: 'Owner Trim' }]);
  });
  it('more than 50 people is 400', () =>
    refused('other', { people: Array.from({ length: 51 }, (_, i) => person(`P${i}`, false)) }, 'Maximum 50'));
});

describe('names, registration number, vat', () => {
  it('whitespace company name refused', async () => {
    await refused('other', { company: { name: '   ', vatPeriod: 'none' } });
    await refused('pty_ltd', { company: { name: '\t\n ', vatPeriod: 'none' }, documents: [doc('cipc_certificate')] });
  });
  it('missing company object / name missing refused with 400', async () => {
    for (const company of [undefined, null, 'x', { vatPeriod: 'none' }]) {
      const u = await user();
      const out = await callSetup(u, { ...setupBody('other'), company });
      expect(out.status, JSON.stringify(company)).toBe(400);
      expect(await membership(u)).toBe(1);
    }
  });
  it('company name is trimmed on store', async () => {
    const n = `WIZ trim ${crypto.randomUUID()}`;
    const { row } = await accepted('other', { company: { name: `  ${n}  `, vatPeriod: 'none' } });
    expect(row.name).toBe(n);
  });
  it('registration number sent for sole_proprietor / partnership / other is stored NULL', async () => {
    for (const [t, p] of [['sole_proprietor', { people: [person('A')] }], ['partnership', { people: [person('A'), person('B')] }], ['other', {}]] as const) {
      const { row } = await accepted(t, { ...p, company: { name: `WIZ reg ${crypto.randomUUID()}`, registrationNumber: '2020/123456/07', vatPeriod: 'none' } });
      expect(row.registration_number, t).toBeNull();
    }
  });
  it('registration number whitespace-only for pty_ltd stored null; padded one is trimmed', async () => {
    const a = await accepted('pty_ltd', { documents: [doc('cipc_certificate')], company: { name: `WIZ ws ${crypto.randomUUID()}`, registrationNumber: '   ', vatPeriod: 'none' } });
    expect(a.row.registration_number).toBeNull();
    const b = await accepted('pty_ltd', { documents: [doc('cipc_certificate')], company: { name: `WIZ ws ${crypto.randomUUID()}`, registrationNumber: '  2020/123456/07 ', vatPeriod: 'none' } });
    expect(b.row.registration_number).toBe('2020/123456/07');
  });
  it('invalid vatPeriod / vatSystemType refused; valid ones accepted', async () => {
    for (const v of ['quarterly', 'weekly', 'x', 5 as unknown as string]) {
      const u = await user();
      const out = await callSetup(u, setupBody('other', { company: { name: `WIZ vat ${crypto.randomUUID()}`, vatPeriod: v } }));
      expect(out.status, `vatPeriod=${JSON.stringify(v)} -> ${JSON.stringify(out.body)}`).toBe(400);
    }
    await refused('other', { company: { name: 'WIZ vst', vatPeriod: 'none', vatSystemType: 'cash' } }, 'vatSystemType must be');
    for (const v of ['monthly', 'bi-monthly', 'none']) await accepted('other', { company: { name: `WIZ vat ok ${crypto.randomUUID()}`, vatPeriod: v } });
  });
  it('vatPeriod "MONTHLY" / " monthly " (validator is case/space-insensitive): stored value is the canonical lowercase one', async () => {
    for (const v of ['MONTHLY', ' monthly ', 'Bi-Monthly']) {
      const { row } = await accepted('other', { company: { name: `WIZ vatcase ${crypto.randomUUID()}`, vatPeriod: v } });
      expect(row.vat_period, `sent ${JSON.stringify(v)}`).toBe(v.trim().toLowerCase());
    }
  });
  it('vatPeriod omitted entirely', async () => {
    const out = await callSetup(await user(), setupBody('other', { company: { name: `WIZ novat ${crypto.randomUUID()}` } }));
    expect(out.status, JSON.stringify(out.body)).toBe(200);
  });
  it('non-string company field / bad financialYearStart refused', async () => {
    await refused('other', { company: { name: 'WIZ x', email: 5 } }, 'must be text');
    for (const m of [0, 13, 1.5, '3']) await refused('other', { company: { name: 'WIZ fy', financialYearStart: m } }, 'financialYearStart');
  });
});

