/**
 * Wave 7 EA2 (W5 part 2; Hein's ruling 10): the e@syFile IRP5 file carries each employee's captured addresses
 * (3211-3217, 3285, 3279, 3288-3294) and, in an owner's or admin's own export, their bank account (3240-3245), read
 * through the audited reader (one audit_log `export` row per account). Pre-validation names each employee missing
 * one. Real routes (withAuth, app_user, RLS) on two tenants, from real approved runs. Claims:
 *  - an owner's file carries company a's addresses and accounts, byte for byte, and only a's (b's are 10x and absent);
 *  - each full account read is one audit row naming the employee, never the number;
 *  - a Login-as export (the same owner, impersonated) and a token export (no session id) carry no address and no
 *    account, say so, and write no audit row; an employee with no account is 3240 = 0 (ruling 25); 3246 (1062);
 *  - the EMP501 filing file (ruling 25): the owner's download carries each account, read live and audited, while the
 *    stored file and the stored figures carry none; a manager is refused; a token is refused (Login-as: downloadEmp501File);
 *  - the EMP501 figures (stored, compared) carry the address and never an account;
 *  - pre-validation names a's employee with no account and the one with no address; never b's.
 *
 * Disposable DB only (rig -> assertDisposable). Every address and number is made up.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NextApiResponse } from 'next';
import exportRoute from '../../pages/api/payroll/irp5/easyfile-export';
import { buildEmp501Figures } from '@/modules/accounting/services/returns/emp501Figures';
import { emp501Period } from '@/modules/accounting/services/payroll/emp501Period';
import { preValidateTaxYear } from '@/modules/accounting/services/payroll/preValidationService';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { agent, approvedRun, loginAs, type R } from './pe-payslip-email.helpers';
import filingFile from '../../pages/api/payroll/emp501/returns/filing-file';
import returnsRoute from '../../pages/api/payroll/emp501/returns/index';
import { UNWRITTEN_FIELDS_WARNING_NO_CONTACTS } from '@/modules/accounting/services/payroll/easyFileCertificateCodes';
import { rig } from './brkr.helpers';

let a: R;
let b: R;
const emp = { full: '', box: '', bare: '', bee: '' };
const bankIds: Record<string, string> = {};

/** The route's file body (it answers with res.end(body)) and status, as `user` in `r`'s company. */
async function exportFile(r: R, user: string): Promise<{ status: number; body: string; json: unknown; warnings: string[] }> {
  const req = request({ 'sb-access-token': r.tokens[user]!, active_company_id: r.company }, 'GET') as unknown as {
    url: string; query: Record<string, unknown>;
  };
  req.url = '/api/payroll/irp5/easyfile-export?taxYear=2026';
  req.query = { taxYear: '2026' };
  const out = response();
  let body = '';
  const state = out.state as unknown as { end: (b?: unknown) => unknown; body: unknown; statusCode: number };
  state.end = function end(this: unknown, chunk?: unknown) { if (chunk !== undefined) body = String(chunk); return this; };
  await (exportRoute as unknown as (q: unknown, s: NextApiResponse) => Promise<void>)(req, out.res);
  const raw = out.headers.get('x-isaflow-warnings');
  return { status: state.statusCode, body, json: state.body, warnings: raw ? JSON.parse(decodeURIComponent(String(raw))) as string[] : [] };
}

async function profile(r: R): Promise<void> {
  await r.pool.query(`UPDATE companies SET paye_reference_number = '7000000000', sars_contact_first_name = 'Payroll',
    sars_contact_last_name = 'Officer', sars_contact_telephone = '0110000000', physical_address_line1 = '1 Test Street',
    physical_postal_code = '0001', physical_city = 'Pretoria' WHERE id = $1`, [r.company]);
}
async function person(r: R, salary: number, idNumber: string): Promise<string> {
  const { employee } = await r.employee(salary);
  await r.pool.query('UPDATE payroll_employees SET id_number = $2 WHERE id = $1', [employee, idNumber]);
  return employee;
}
const setAddress = (r: R, id: string, sql: string, values: unknown[]) =>
  r.pool.query(`UPDATE payroll_employees SET ${sql} WHERE id = $1 AND company_id = $2`, [id, r.company, ...values]);
async function bank(r: R, id: string, o: { number: string; branch: string; type: string; holder: string | null; name: string; rel?: string }) {
  bankIds[id] = String((await r.pool.query(
    `INSERT INTO payroll_bank_details (company_id, employee_id, bank_name, account_number, account_type, branch_code, account_holder,
       account_holder_relationship, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true) RETURNING id`, [r.company, id, o.name, o.number, o.type, o.branch, o.holder, o.rel ?? null])).rows[0]!.id);
}
/** One certificate's lines, by its ID number (3060). */
const certificate = (file: string, idNumber: string): string[] => {
  const lines = file.split(/\r?\n/);
  const at = lines.indexOf(`3060,${idNumber}`);
  const start = lines.slice(0, at).map((l) => l.startsWith('3010,')).lastIndexOf(true);
  const end = lines.indexOf('9999,9999', at);
  return lines.slice(start, end + 1);
};
const contact = (lines: string[]) => lines.filter((l) => /^(32(1[1-7]|4[0-6]|79|8[5-9]|9[0-4])),/.test(l));
const audits = async (r: R) => (await r.pool.query(
  `SELECT entity_id::text AS entity_id, user_id::text AS user_id, changes::text AS changes FROM audit_log
    WHERE company_id = $1 AND entity_type = 'payroll_bank_detail' AND action = 'export' ORDER BY entity_id`, [r.company])).rows;

beforeAll(async () => {
  a = await rig('w7-ea2-a');
  b = await rig('w7-ea2-b');
  await a.setup();
  await b.setup();
  for (const r of [a, b]) await profile(r);
  // Valid ID numbers for 1980-01-01 (the rig's date of birth), one per employee.
  emp.full = await person(a, 30_000, '8001015009087');
  emp.box = await person(a, 25_000, '8001015009186');
  emp.bare = await person(a, 20_000, '8001015009285');
  emp.bee = await person(b, 300_000, '8001015009384');
  await setAddress(a, emp.full, `residential_unit_number = '4', residential_complex = 'Oak Court', residential_street_number = '12',
    residential_street = 'Main Road', residential_suburb = 'Hatfield', residential_city = 'Pretoria', residential_postal_code = '0028',
    residential_country_code = 'ZA', postal_same_as_residential = true`, []);
  await setAddress(a, emp.box, `residential_street = 'Farm Rietfontein', residential_city = 'Brits', residential_postal_code = '0250',
    residential_country_code = 'ZA', postal_same_as_residential = false, postal_address_line1 = 'PO Box 77',
    postal_address_line2 = 'Brits', postal_address_code = '0250', postal_address_country_code = 'ZA'`, []);
  await setAddress(b, emp.bee, `residential_street = 'Bee Street', residential_city = 'Durban', residential_postal_code = '4001',
    residential_country_code = 'ZA', postal_same_as_residential = true`, []);
  await bank(a, emp.full, { number: '62123456789', branch: '051001', type: 'savings', holder: 'T Molefe', name: 'Standard Bank', rel: 'joint' });
  await bank(a, emp.bare, { number: '1234567890', branch: '250655', type: 'cheque', holder: null, name: 'FNB' });
  await bank(b, emp.bee, { number: '99999999999', branch: '632005', type: 'cheque', holder: 'Bee', name: 'ABSA', rel: 'own' });
  // A row naming a's employee under company b (only a forged row could): a's pre-validation must not count it. The
  // fixture's pool bypasses RLS, so this pins the query's own company predicate, not the policy.
  await b.pool.query(`INSERT INTO payroll_bank_details (company_id, employee_id, bank_name, account_number, account_type, branch_code, is_active)
    VALUES ($1, $2, 'ABSA', '88888888888', 'cheque', '632005', true)`, [b.company, emp.box]);
  for (const r of [a, b]) { await approvedRun(r, 1); await approvedRun(r, 2); }
}, 240_000);

afterAll(async () => {
  // tax_return_versions refuses DELETE (its immutability trigger): lifted for this fixture's rows only, then ENABLE ALWAYS.
  const c = await a.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE tax_return_versions DISABLE TRIGGER trg_tax_return_versions_immutable');
    await c.query('DELETE FROM tax_return_versions WHERE company_id = ANY($1)', [[a.company, b.company]]);
    await c.query('ALTER TABLE tax_return_versions ENABLE ALWAYS TRIGGER trg_tax_return_versions_immutable');
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  await a.pool.query('DELETE FROM sars_submissions WHERE company_id = ANY($1)', [[a.company, b.company]]); // after the versions naming them
  for (const r of [a, b]) {
    await r.pool.query('DELETE FROM audit_log WHERE company_id = $1', [r.company]);
    await r.pool.query('DELETE FROM impersonation_sessions WHERE actor_user_id = $1', [r.approver]);
    await r.teardown();
  }
});

describe('e@syFile addresses and bank accounts (wave 7 EA2)', () => {
  let file = '';
  it('an owner\'s file carries each captured address and account, byte for byte', async () => {
    const out = await exportFile(a, a.approver); // the rig's owner
    expect(out.status).toBe(200);
    file = out.body;
    expect(contact(certificate(file, '8001015009087'))).toEqual([
      '3211,"4"', '3212,"Oak Court"', '3213,"12"', '3214,"Main Road"', '3215,"Hatfield"', '3216,"Pretoria"', '3217,"0028"',
      '3285,"ZA"', '3279,"N"', '3288,1', '3240,2', '3241,"62123456789"', '3242,051001', '3243,"Standard Bank"', '3245,"T Molefe"', '3246,2',
    ]);
    expect(contact(certificate(file, '8001015009186'))).toEqual([
      '3214,"Farm Rietfontein"', '3216,"Brits"', '3217,"0250"', '3285,"ZA"', '3279,"N"', '3288,4',
      '3289,"PO Box 77"', '3290,"Brits"', '3293,"0250"', '3294,"ZA"', '3240,0', // no account on record: not paid by EFT
    ]);
    // No address captured: none of its codes; the account without a holder: no 3245.
    expect(contact(certificate(file, '8001015009285'))).toEqual(['3240,1', '3241,"1234567890"', '3242,250655', '3243,"FNB"']);
  });

  it('only company a\'s employees: b\'s address and account are nowhere in a\'s file', () => {
    expect(file).not.toContain('8001015009384');
    expect(file).not.toContain('Bee Street');
    expect(file).not.toContain('99999999999');
  });

  it('each full read is one audit row naming who and whose, never the number; none for the employee with no account', async () => {
    const rows = await audits(a);
    expect(rows.map((r) => r.entity_id).sort()).toEqual([bankIds[emp.full], bankIds[emp.bare]].sort());
    expect(rows.every((r) => r.user_id === a.approver)).toBe(true);
    expect(rows.map((r) => r.changes).join(' ')).not.toMatch(/62123456789|1234567890/);
    expect(await audits(b)).toEqual([]);
  });

  it.each(['Login-as', 'token'])('%s (the owner, not in their own session): no address, no account, said so, no audit row', async (how) => {
    const before = (await audits(a)).length;
    const as = how === 'Login-as' ? await loginAs(a, a.approver) : await agent(a, a.approver);
    const out = await exportFile(a, as);
    expect(out.status).toBe(200);
    for (const id of ['8001015009087', '8001015009186', '8001015009285']) expect(contact(certificate(out.body, id))).toEqual([]);
    expect(out.body).not.toMatch(/Main Road|Rietfontein|62123456789/);
    expect(out.warnings).toContain(UNWRITTEN_FIELDS_WARNING_NO_CONTACTS);
    expect((await audits(a)).length).toBe(before);
  });

  it('the EMP501 filing file (it carries the addresses): a token is refused before anything is read; a person is not', async () => {
    const call = async (user: string) => {
      const req = request({ 'sb-access-token': a.tokens[user]!, active_company_id: a.company }, 'POST') as unknown as { url: string; body: unknown };
      req.url = '/api/payroll/emp501/returns/filing-file';
      req.body = { versionId: crypto.randomUUID(), format: 'irp5' };
      const out = response();
      await (filingFile as unknown as (q: unknown, s: NextApiResponse) => Promise<void>)(req, out.res);
      return out.state as unknown as { statusCode: number; body: { error?: { details?: { reason?: string } } } };
    };
    const token = await call(await agent(a, a.approver, 'agent-filing'));
    expect([token.statusCode, token.body.error?.details?.reason]).toEqual([403, 'AGENT_FORBIDDEN']);
    expect((await call(a.approver)).statusCode).toBe(404); // the owner's own session passes the gate; no such version
  });

  it('b\'s owner gets b\'s own (10x) certificate with its address and account', async () => {
    const out = await exportFile(b, b.approver);
    expect(contact(certificate(out.body, '8001015009384'))).toEqual([
      '3214,"Bee Street"', '3216,"Durban"', '3217,"4001"', '3285,"ZA"', '3279,"N"', '3288,1',
      '3240,1', '3241,"99999999999"', '3242,632005', '3243,"ABSA"', '3245,"Bee"', '3246,1',
    ]);
    expect(out.body).not.toContain('Main Road');
  });

  it('the EMP501 figures carry the address and never an account', async () => {
    const f = await buildEmp501Figures(a.company, emp501Period(2026, 'annual'), false);
    const full = f.employees.find((e) => e.idNumber === '8001015009087')!;
    expect(full.address?.residential.street).toBe('Main Road');
    expect(f.employees.every((e) => e.bankAccount === undefined)).toBe(true);
    expect(JSON.stringify(f)).not.toContain('62123456789');
    // An employee with no address has no key at all (a stored version compares key by key).
    expect('address' in f.employees.find((e) => e.idNumber === '8001015009285')!).toBe(false);
  });

  it('pre-validation names a\'s employee with no account and the one with no address, never b\'s', async () => {
    const pv = (await preValidateTaxYear(a.company, { taxYear: 2026 }))!;
    const gaps = Object.fromEntries(pv.employees.map((e) => [e.employeeId,
      e.issues.filter((i) => i.code === 'IRP5_ADDRESS_MISSING' || i.code === 'IRP5_BANK_MISSING').map((i) => i.code)]));
    expect(gaps[emp.full] ?? []).toEqual([]);
    expect(gaps[emp.box]).toEqual(['IRP5_BANK_MISSING']);
    expect(gaps[emp.bare]).toEqual(['IRP5_ADDRESS_MISSING']);
    expect(pv.employees.some((e) => e.employeeId === emp.bee)).toBe(false);
    const pvB = (await preValidateTaxYear(b.company, { taxYear: 2026 }))!;
    expect(pvB.employees.find((e) => e.employeeId === emp.bee)?.issues.filter((i) => i.code.startsWith('IRP5_ADDRESS') || i.code.startsWith('IRP5_BANK')) ?? []).toEqual([]);
  });

  describe('the EMP501 filing file reads the accounts live at download (ruling 25)', () => {
    let versionId = '';
    beforeAll(async () => {
      const figures = await buildEmp501Figures(a.company, emp501Period(2026, 'annual'), false);
      versionId = String((await a.pool.query(
        `INSERT INTO tax_return_versions (company_id, form_type, period_start, period_end, version_no, figures, posted_through, finalised_by, status)
         VALUES ($1, 'EMP501', '2025-03-01', '2026-02-28', 1, $2, now(), 'fixture', 'finalised') RETURNING id`,
        [a.company, JSON.stringify(figures)])).rows[0]!.id);
    });
    const download = async (user: string) => {
      const req = request({ 'sb-access-token': a.tokens[user]!, active_company_id: a.company }, 'POST') as unknown as { url: string; body: unknown };
      req.url = '/api/payroll/emp501/returns/filing-file';
      req.body = { versionId, format: 'irp5' };
      const out = response();
      await (filingFile as unknown as (q: unknown, s: NextApiResponse) => Promise<void>)(req, out.res);
      return { ...(out.state as unknown as { statusCode: number; body: unknown }), headers: out.headers };
    };

    it('the owner\'s download carries each account (3246 too, 3240 = 0 with none), audited; nothing of it is stored', async () => {
      const before = (await audits(a)).length;
      const out = await download(a.approver);
      expect(out.statusCode).toBe(200);
      const body = String(out.body);
      expect(contact(certificate(body, '8001015009087')).filter((l) => l.startsWith('324'))).toEqual([
        '3240,2', '3241,"62123456789"', '3242,051001', '3243,"Standard Bank"', '3245,"T Molefe"', '3246,2',
      ]);
      expect(contact(certificate(body, '8001015009186')).filter((l) => l.startsWith('324'))).toEqual(['3240,0']);
      expect(certificate(body, '8001015009087')).toContain('3214,"Main Road"');
      // Two accounts read in full: two more audit rows. The stored file and figures hold no account.
      expect((await audits(a)).length).toBe(before + 2);
      const row = (await a.pool.query('SELECT filing_file_content, figures::text AS figures FROM tax_return_versions WHERE id = $1', [versionId])).rows[0]!;
      expect(String(row.filing_file_content)).not.toMatch(/^324[0-6],/m);
      expect(String(row.filing_file_content)).toContain('3214,"Main Road"');
      expect(row.figures).not.toMatch(/62123456789|1234567890/);
      // Evidence of what was sent (coordinator decision): the stamp is the stored file's, the served hash is the bytes
      // sent, both on the response and the served one on this download's audit row, which carries no bank value.
      const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
      expect(out.headers.get('x-filing-file-stored-sha256')).toBe(sha(String(row.filing_file_content)));
      expect(out.headers.get('x-filing-file-served-sha256')).toBe(sha(body));
      expect(out.headers.get('x-filing-file-stored-sha256')).not.toBe(out.headers.get('x-filing-file-served-sha256'));
      expect(out.headers.has('x-filing-file-sha256')).toBe(false);
      const dl = (await a.pool.query(`SELECT changes::text AS changes FROM audit_log WHERE company_id = $1 AND entity_type = 'tax_return_version'
        AND action = 'export' AND entity_id = $2`, [a.company, versionId])).rows;
      expect(dl).toHaveLength(1);
      expect(JSON.parse(String(dl[0]!.changes)).metadata).toMatchObject({ servedSha256: sha(body), storedSha256: sha(String(row.filing_file_content)) });
      expect(String(dl[0]!.changes)).not.toMatch(/62123456789|1234567890|051001/);
      // A second download with the same accounts sends the same bytes; a changed account changes only the served hash.
      const again = await download(a.approver);
      expect(again.headers.get('x-filing-file-served-sha256')).toBe(sha(body));
      await a.pool.query(`UPDATE payroll_bank_details SET is_active = false WHERE id = $1`, [bankIds[emp.bare]]);
      const changed = await download(a.approver);
      expect(changed.headers.get('x-filing-file-stored-sha256')).toBe(sha(String(row.filing_file_content)));
      expect(changed.headers.get('x-filing-file-served-sha256')).not.toBe(sha(body));
      await a.pool.query(`UPDATE payroll_bank_details SET is_active = true WHERE id = $1`, [bankIds[emp.bare]]);
    });

    it('filing pins the rows of the latest download: refused after a change, then filed, then re-served byte for byte (R1, R2)', async () => {
      const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
      const fileIt = () => a.call(returnsRoute as never, 'POST', '/api/payroll/emp501/returns', undefined,
        { user: a.approver, body: { action: 'file', versionId, reference: '1234567890' } });
      const newAccount = async (employee: string, number: string, q: (t: string, v: unknown[]) => Promise<unknown> = (t, v) => a.pool.query(t, v)) => {
        await q('UPDATE payroll_bank_details SET is_active = false WHERE company_id = $1 AND employee_id = $2 AND is_active', [a.company, employee]);
        await q(`INSERT INTO payroll_bank_details (company_id, employee_id, bank_name, account_number, account_type, branch_code,
            account_holder, account_holder_relationship, is_active) VALUES ($1, $2, 'Capitec', $3, 'savings', '470010', 'T Molefe', 'own', true)`,
          [a.company, employee, number]);
      };
      const status = async () => String((await a.pool.query('SELECT status FROM tax_return_versions WHERE id = $1', [versionId])).rows[0]!.status);
      // R1: downloaded (the earlier case), then the account changes: filing is refused, nothing written.
      await newAccount(emp.full, '70000000007');
      const refused = await fileIt();
      expect([refused.statusCode, refused.body.error?.details?.code]).toEqual([409, 'BANK_DETAILS_CHANGED']);
      expect(JSON.stringify(refused.body)).toContain('download it again');
      expect(await status()).toBe('finalised');
      // Downloaded again: these bytes are what is filed.
      const last = await download(a.approver);
      expect(String(last.body)).toContain('3241,"70000000007"');
      // R2: a bank change open in another transaction while filing (its row would predate the filing) changes nothing.
      const open = await a.pool.connect();
      try {
        await open.query('BEGIN');
        await newAccount(emp.bare, '80000000008', (t, v) => open.query(t, v as unknown[]));
        const filed = await fileIt();
        expect(filed.statusCode, JSON.stringify(filed.body)).toBe(200);
        await open.query('COMMIT');
      } finally {
        open.release();
      }
      expect(await status()).toBe('filed');
      const again = await download(a.approver);
      expect(String(again.body)).toBe(String(last.body));
      expect(again.headers.get('x-filing-file-served-sha256')).toBe(sha(String(last.body)));
      expect(String(again.body)).not.toContain('80000000008');
      // Another change after filing: the filed file still re-serves the pinned rows.
      await newAccount(emp.full, '90000000009');
      const later = await download(a.approver);
      expect(String(later.body)).toBe(String(last.body));
      const pin = (await a.pool.query(`SELECT changes FROM audit_log WHERE company_id = $1 AND entity_type = 'tax_return_version'
        AND entity_id = $2 AND action = 'update' AND changes -> 'metadata' ->> 'bankRows' IS NOT NULL`, [a.company, versionId])).rows;
      expect(pin).toHaveLength(1);
      expect(pin[0]!.changes.metadata.servedSha256).toBe(sha(String(last.body)));
      expect(JSON.stringify(pin[0]!.changes)).not.toMatch(/70000000007|62123456789/);
    });

    it.each(['filed', 'finalised'])('a %s version finalised before EA2 (no bankOverlay marker) is served byte for byte as stored: no 324x line, served = stored', async (status) => {
      const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
      const { bankOverlay, ...pre } = (await a.pool.query('SELECT figures FROM tax_return_versions WHERE id = $1', [versionId])).rows[0]!.figures;
      expect(bankOverlay).toBe(1); // premise: EA2's finalise writes the marker
      const [start, end] = status === 'filed' ? ['2023-03-01', '2024-02-29'] : ['2022-03-01', '2023-02-28'];
      const preId = String((await a.pool.query(
        `INSERT INTO tax_return_versions (company_id, form_type, period_start, period_end, version_no, figures, posted_through,
           finalised_by, status, filed_at, filed_by)
         VALUES ($1, 'EMP501', $3, $4, 1, $2, now(), 'fixture', $5, CASE WHEN $5 = 'filed' THEN clock_timestamp() END,
           CASE WHEN $5 = 'filed' THEN 'fixture' END) RETURNING id`,
        [a.company, JSON.stringify(pre), start, end, status])).rows[0]!.id);
      const req = request({ 'sb-access-token': a.tokens[a.approver]!, active_company_id: a.company }, 'POST') as unknown as { url: string; body: unknown };
      req.url = '/api/payroll/emp501/returns/filing-file';
      req.body = { versionId: preId, format: 'irp5' };
      const out = response();
      await (filingFile as unknown as (q: unknown, s: NextApiResponse) => Promise<void>)(req, out.res);
      const body = String((out.state as unknown as { body: unknown }).body);
      expect((out.state as unknown as { statusCode: number }).statusCode).toBe(200);
      expect(body).not.toMatch(/^324[0-6],/m);
      expect(out.headers.get('x-filing-file-served-sha256')).toBe(sha(body));
      expect(out.headers.get('x-filing-file-stored-sha256')).toBe(out.headers.get('x-filing-file-served-sha256'));
      const dl = (await a.pool.query(`SELECT changes::text AS changes FROM audit_log WHERE company_id = $1 AND entity_type = 'tax_return_version'
        AND action = 'export' AND entity_id = $2`, [a.company, preId])).rows;
      expect(dl).toHaveLength(1);
      expect(JSON.parse(String(dl[0]!.changes)).metadata).toMatchObject({ liveBankFields: 'false', servedSha256: sha(body) });
    });

    it('a manager is refused and reads no account; a token is refused', async () => {
      const before = (await audits(a)).length;
      const manager = await a.addUser('manager');
      const out = await download(manager);
      expect(out.statusCode).toBe(403);
      expect(JSON.stringify(out.body)).not.toMatch(/62123456789|3241,/);
      const token = await download(await agent(a, a.approver, 'agent-download'));
      expect(token.statusCode).toBe(403);
      expect((await audits(a)).length).toBe(before);
    });
  });
});
