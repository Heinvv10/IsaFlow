/**
 * Migration 999v's table rules for the filing-file stamps (wave 6 EFa, grill F11), below the services. Every check runs
 * as app_user (SET LOCAL ROLE, withAuth's GUCs) in a transaction that is always rolled back: a forged, stale or
 * rewritten stamp is refused, stamps are frozen once a return is filed, and a version finalised after the cut-off is
 * filed only once its file was stamped. A version finalised before the cut-off files as before (the old colour).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropReturnFixture, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import * as rules from './helpers/returnFileDbRules';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
let a: ReturnFixture;
const { submission, version, asAppUser, failOf, upd, U, FILE } = rules;
const SHA = 'a'.repeat(64);
const STAMP = (by: string, at = 'now()', sha = SHA, kind = 'emp201_capture_csv') =>
  `filing_file_sha256 = '${sha}', filing_file_kind = '${kind}', filing_file_at = ${at}, filing_file_by = '${by}'`;

describeIfDb('tax_return_versions filing-file stamps (migration 999v)', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds a company, submissions and return versions.');
    a = await seedReturnFixture('EFA', DATABASE_URL!);
    rules.setOwner(a);
  }, 240000);
  afterAll(async () => {
    if (a) await dropReturnFixture(a);
  }, 120000);

  it('a stamp is the session user\'s, now: a forged user, a stale or future time and a session with no user are refused', async () => {
    const v = await version(a, 1, 'finalised', true);
    await asAppUser(a, async (c) => {
      expect(await failOf(c, upd(v, STAMP('someone else')))).toMatch(/^23514 filing_file_by is the session user/);
      expect(await failOf(c, upd(v, STAMP(U(), `now() - interval '1 hour'`)))).toMatch(/^23514 filing_file_by is the session user/);
      expect(await failOf(c, upd(v, STAMP(U(), `now() + interval '1 hour'`)))).toMatch(/^23514 filing_file_by is the session user/);
      expect(await failOf(c, upd(v, STAMP(U())))).toBe('ok'); // the control
    });
    const o = await a.fx.pool.connect(); // the owner with no session user
    try {
      await o.query('BEGIN');
      expect(await failOf(o, upd(v, STAMP(U())))).toMatch(/^23514 filing_file_by is the session user/);
    } finally {
      await o.query('ROLLBACK').catch(() => undefined);
      o.release();
    }
  });

  it('the stamps are written once: rewriting each of the four, or clearing them, is refused', async () => {
    const v = await version(a, 2, 'finalised', true);
    await asAppUser(a, async (c) => {
      expect(await failOf(c, upd(v, STAMP(U())))).toBe('ok');
      for (const set of [`filing_file_sha256 = '${'b'.repeat(64)}'`, `filing_file_kind = 'vat201_capture_csv'`,
        `filing_file_at = clock_timestamp()`, `filing_file_by = '${U()}x'`,
        'filing_file_sha256 = NULL, filing_file_kind = NULL, filing_file_at = NULL, filing_file_by = NULL']) {
        expect(await failOf(c, upd(v, set)), set).toMatch(/^23514 the filing-file stamps of a return are written once/);
      }
    });
  });

  it('a malformed stamp is refused by the CHECK: partial stamps, a hash that is not 64 hex digits, an unknown kind', async () => {
    const v = await version(a, 3, 'finalised', true);
    await asAppUser(a, async (c) => {
      expect(await failOf(c, upd(v, `filing_file_sha256 = '${SHA}', filing_file_at = now(), filing_file_by = '${U()}'`)))
        .toMatch(/^23514 .*tax_return_versions_filing_file_ck/); // no kind
      expect(await failOf(c, upd(v, `filing_file_kind = 'emp201_capture_csv', filing_file_at = now(), filing_file_by = '${U()}'`)))
        .toMatch(/^23514 .*tax_return_versions_filing_file_ck/); // no hash
      expect(await failOf(c, upd(v, STAMP(U(), 'now()', 'A'.repeat(64))))).toMatch(/^23514 .*filing_file_ck/);
      expect(await failOf(c, upd(v, STAMP(U(), 'now()', 'abc')))).toMatch(/^23514 .*filing_file_ck/);
      expect(await failOf(c, upd(v, STAMP(U(), 'now()', SHA, 'emp201_pdf')))).toMatch(/^23514 .*filing_file_ck/);
    });
  });

  it('the stamps are frozen once a return is filed or superseded', async () => {
    const filed = await version(a, 4, 'filed');
    const sup = await version(a, 5, 'superseded');
    await asAppUser(a, async (c) => {
      expect(await failOf(c, upd(filed, STAMP(U())))).toMatch(/^23514 the filing-file stamps are written only while a return is finalised/);
      expect(await failOf(c, upd(sup, STAMP(U())))).toMatch(/^23514 a superseded return is frozen/);
    });
  });

  it('finalised to filed needs a stamped file for a version finalised after the cut-off, not for one before it', async () => {
    const after = await version(a, 6, 'finalised', true);
    const before = await version(a, 7, 'finalised');
    const stamped = await version(a, 8, 'finalised', true);
    const [s6, s7, s8] = [await submission(a, 6), await submission(a, 7), await submission(a, 8)];
    await asAppUser(a, async (c) => {
      expect(await failOf(c, upd(after, FILE(s6)))).toMatch(/^23514 generate the filing file of this return before marking it filed/);
      expect(await failOf(c, upd(before, FILE(s7)))).toBe('ok'); // the old colour's filing of an older version
      expect(await failOf(c, upd(stamped, STAMP(U())))).toBe('ok');
      expect(await failOf(c, upd(stamped, FILE(s8)))).toBe('ok');
      // Stamping in the very UPDATE that files is still a stamp of a finalised version: allowed, and judged.
      expect(await failOf(c, upd(after, `${FILE(s6)}, ${STAMP('forger')}`))).toMatch(/^23514 filing_file_by is the session user/);
    });
  });

  it('form_type accepts EMP501 (EFb) beside VAT201 and EMP201, and still refuses anything else', async () => {
    const ins = (form: string) => sql`INSERT INTO tax_return_versions (company_id, form_type, period_start, period_end, version_no,
      figures, posted_through, finalised_by) VALUES (${a.fx.companyId}::UUID, ${form}, '2025-03-01', '2026-02-28', 1, '{}', now(),
      ${a.admin.userId}) RETURNING id`;
    expect(((await ins('EMP501')) as Row[])[0]!.id).toBeTruthy();
    await expect(ins('IRP6')).rejects.toThrow(/tax_return_versions_form_type_check/);
  });
});
