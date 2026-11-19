/**
 * Migration 999v's table rules for the stored filing file and its stamps (wave 6 EFa, grill F11), below the services.
 * Every check runs as app_user (SET LOCAL ROLE, withAuth's GUCs) in a transaction that is always rolled back: a forged,
 * stale or rewritten stamp or file is refused, a stamp that is not the stored file's sha256 or names another form's
 * kind is refused, both are frozen once a return is filed, and a version finalised after the cut-off is filed only once
 * its file was stored. A version finalised before the cut-off files as before (the old colour).
 */
import { createHash } from 'crypto';
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
const CONTENT = '"section","field","amount"\r\n"Payroll tax calculations","PAYE",9000.00\r\n';
const shaOf = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const SHA = shaOf(CONTENT);
/** The five filing-file columns as the service writes them; each part can be forged. */
const STAMP = (by: string, at = 'now()', sha = SHA, kind = 'emp201_capture_csv@1', content = CONTENT) =>
  `filing_file_content = '${content}', filing_file_sha256 = '${sha}', filing_file_kind = '${kind}', filing_file_at = ${at}, `
  + `filing_file_by = '${by}'`;

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

  it('the file and its stamps are written once: rewriting each of the five, or clearing them, is refused', async () => {
    const v = await version(a, 2, 'finalised', true);
    const other = `${CONTENT}x`;
    await asAppUser(a, async (c) => {
      expect(await failOf(c, upd(v, STAMP(U())))).toBe('ok');
      for (const set of [`filing_file_sha256 = '${'b'.repeat(64)}'`, `filing_file_kind = 'emp201_capture_csv@2'`,
        `filing_file_at = clock_timestamp()`, `filing_file_by = '${U()}x'`,
        `filing_file_content = '${other}', filing_file_sha256 = '${shaOf(other)}'`, // a new file with its own hash
        'filing_file_content = NULL, filing_file_sha256 = NULL, filing_file_kind = NULL, filing_file_at = NULL, filing_file_by = NULL']) {
        expect(await failOf(c, upd(v, set)), set).toMatch(/^23514 the filing-file stamps of a return are written once/);
      }
    });
  });

  it('a malformed file or stamp is refused by the CHECK: partial, a hash that is not the file\'s, a kind of another form', async () => {
    const v = await version(a, 3, 'finalised', true);
    const ck = /^23514 .*tax_return_versions_filing_file_ck/;
    await asAppUser(a, async (c) => {
      expect(await failOf(c, upd(v, `filing_file_content = '${CONTENT}', filing_file_sha256 = '${SHA}', filing_file_at = now(), filing_file_by = '${U()}'`)))
        .toMatch(ck); // no kind
      expect(await failOf(c, upd(v, `filing_file_content = '${CONTENT}', filing_file_kind = 'emp201_capture_csv@1', filing_file_at = now(), filing_file_by = '${U()}'`)))
        .toMatch(ck); // no hash
      expect(await failOf(c, upd(v, `filing_file_sha256 = '${SHA}', filing_file_kind = 'emp201_capture_csv@1', filing_file_at = now(), filing_file_by = '${U()}'`)))
        .toMatch(ck); // no file
      expect(await failOf(c, upd(v, STAMP(U(), 'now()', SHA.toUpperCase())))).toMatch(ck);
      expect(await failOf(c, upd(v, STAMP(U(), 'now()', 'a'.repeat(64))))).toMatch(ck); // a hash that is not the file's
      expect(await failOf(c, upd(v, STAMP(U(), 'now()', shaOf('other'), 'emp201_capture_csv@1', 'other')))).toBe('ok'); // control
    });
    await asAppUser(a, async (c) => {
      for (const kind of ['emp201_pdf', 'emp201_capture_csv', 'emp201_capture_csv@0', 'emp201_capture_csv@1x',
        'vat201_capture_csv@1', 'emp501_easyfile@1']) { // the last two belong to the VAT201 and the EMP501
        expect(await failOf(c, upd(v, STAMP(U(), 'now()', SHA, kind))), kind).toMatch(ck);
      }
      const big = 'x'.repeat(1048577);
      expect(await failOf(c, upd(v, STAMP(U(), 'now()', shaOf(big), 'emp201_capture_csv@1', big)))).toMatch(ck); // over 1 MB
    });
  });

  it('the stamps are frozen once a return is filed or superseded', async () => {
    const filed = await version(a, 4, 'filed');
    const sup = await version(a, 5, 'superseded');
    await asAppUser(a, async (c) => {
      expect(await failOf(c, upd(filed, STAMP(U())))).toMatch(/^23514 the filing-file stamps are written only while a return is finalised/);
      expect(await failOf(c, upd(filed, `filing_file_content = '${CONTENT}'`))).toMatch(/^23514 the filing-file stamps are written only while/);
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
