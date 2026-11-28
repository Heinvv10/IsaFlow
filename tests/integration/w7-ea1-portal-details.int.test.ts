/**
 * Wave 7 EA1 (W5; Hein's ruling 10): the employee portal's `me` answers the signed-in employee's own address and their
 * bank account as the bank name and last four digits, read-only, on two tenants. Nothing here can send: see
 * ss-employee-portal.helpers.ts (capture mailer, @example.invalid).
 *  - each employee sees their own address and bank line only, never a colleague's or another company's;
 *  - the full account number, branch code and holder appear nowhere in the answer;
 *  - an employee with no address or bank details gets nulls;
 *  - the portal offers no write: `me` answers GET only.
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import me from '../../pages/api/employee-portal/me';
import { rig } from './brkr.helpers';
import { captured, cleanup, doAccept, doMe, invite, lastToken, person, portal, putSetting, setPlatform, type R } from './ss-employee-portal.helpers';

vi.hoisted(() => { process.env.PORTAL_JWT_SECRET ??= 'ss-employee-portal-secret-for-tests-0123456789abcdef'; });

let a: R;
let b: R;
const emp = { one: '', two: '', bee: '' };
const jars: Record<string, Record<string, string>> = {};

async function onboard(r: R, employeeId: string, ip: string): Promise<Record<string, string>> {
  expect((await invite(r, employeeId)).statusCode).toBe(200);
  const jar: Record<string, string> = {};
  expect((await doAccept(jar, { token: lastToken(), password: 'correct horse battery' }, ip)).statusCode).toBe(200);
  return jar;
}

async function addressOf(r: R, id: string, street: string, postalCode: string): Promise<void> {
  await r.pool.query(`UPDATE payroll_employees SET residential_street_number = '7', residential_street = $2, residential_city = 'Pretoria',
    residential_postal_code = $3, residential_country_code = 'ZA', postal_same_as_residential = true WHERE id = $1`, [id, street, postalCode]);
}
async function bankOf(r: R, id: string, bank: string, account: string): Promise<void> {
  await r.pool.query(`INSERT INTO payroll_bank_details (company_id, employee_id, bank_name, account_number, account_type, branch_code, account_holder, effective_from)
    VALUES ($1, $2, $3, $4, 'cheque', '250655', 'Holder Name', CURRENT_DATE)`, [r.company, id, bank, account]);
}

beforeAll(async () => {
  a = await rig('ea1-portal-details-a');
  b = await rig('ea1-portal-details-b');
  await a.setup();
  await b.setup();
  await a.pool.query("DELETE FROM rate_limit_counters WHERE key LIKE 'employee-portal-%' OR key LIKE 'send:employee-portal-invite:%'");
  for (const r of [a, b]) { await setPlatform(r, true); expect((await putSetting(r, true)).statusCode).toBe(200); }
  emp.one = await person(a, 'ea1-one@example.invalid', 'One');
  emp.two = await person(a, 'ea1-two@example.invalid', 'Two');
  emp.bee = await person(b, 'ea1-bee@example.invalid', 'Bee');
  await addressOf(a, emp.one, 'Kingfisher Avenue', '0028');
  await addressOf(a, emp.two, 'Heron Crescent', '0081');
  await addressOf(b, emp.bee, 'Sparrow Lane', '0181');
  await bankOf(a, emp.one, 'FNB', '62000123456');
  // 10x digits on the other tenant: a different number, its own last four.
  await bankOf(b, emp.bee, 'Capitec', '1357924680');
  jars.one = await onboard(a, emp.one, '198.18.2.1');
  jars.two = await onboard(a, emp.two, '198.18.2.2');
  jars.bee = await onboard(b, emp.bee, '198.18.2.3');
}, 240_000);
afterAll(async () => {
  for (const r of [a, b]) {
    await r.pool.query('DELETE FROM payroll_bank_details WHERE company_id = $1', [r.company]);
    await cleanup(r);
  }
  expect(captured.every((m) => [m.to].flat().every((to) => String(to).endsWith('@example.invalid')))).toBe(true);
});

type Me = { address: { residential: { street: string; postalCode: string } } | null; bank: { bankName: string; accountLast4: string } | null };
const read = async (jar: Record<string, string>) => {
  const res = await doMe(jar);
  expect(res.statusCode).toBe(200);
  return { data: res.body.data as Me, text: JSON.stringify(res.body) };
};

describe('the portal\'s "Your details"', () => {
  it('each employee reads their own address and bank line only, on both tenants', async () => {
    const one = await read(jars.one!);
    expect(one.data.address?.residential).toMatchObject({ street: 'Kingfisher Avenue', postalCode: '0028' });
    expect(one.data.bank).toEqual({ bankName: 'FNB', accountLast4: '3456' });
    const bee = await read(jars.bee!);
    expect(bee.data.address?.residential).toMatchObject({ street: 'Sparrow Lane', postalCode: '0181' });
    expect(bee.data.bank).toEqual({ bankName: 'Capitec', accountLast4: '4680' });
    for (const leak of ['Heron', 'Sparrow', 'Capitec']) expect(one.text).not.toContain(leak);
    for (const leak of ['Kingfisher', 'Heron', 'FNB']) expect(bee.text).not.toContain(leak);
  });

  it('never carries the full account number, the branch code or the holder', async () => {
    for (const jar of [jars.one!, jars.bee!]) {
      const { text } = await read(jar);
      for (const leak of ['62000123456', '1357924680', '250655', 'Holder Name']) expect(text).not.toContain(leak);
    }
  });

  it('no bank details: null; a colleague\'s bank line is not theirs', async () => {
    const two = await read(jars.two!);
    expect(two.data.address?.residential.street).toBe('Heron Crescent');
    expect(two.data.bank).toBeNull();
    expect(two.text).not.toContain('Kingfisher');
  });

  it('read-only and session-bound: no write method, nothing without a session', async () => {
    for (const method of ['PUT', 'POST', 'PATCH', 'DELETE']) {
      expect((await portal(me, method, jars.one!, { residential: { street: 'Forged Road' } })).statusCode, method).toBe(405);
    }
    expect((await doMe({})).statusCode).toBe(401);
    expect((await a.pool.query('SELECT residential_street FROM payroll_employees WHERE id = $1', [emp.one])).rows[0]!.residential_street).toBe('Kingfisher Avenue');
  });
});
