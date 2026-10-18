// Admin "Linked Companies" scenarios (role change, remove, last-owner refusal) for the acceptance run.
// Reached as admin.isaflow.co.za mapped to the dev server: on localhost the middleware redirects /admin/* to a path that 404s.
import {
  BASE_URL, attachLogs, chromium, cookieFor, psql, shot, type Result,
} from './entity-onboarding-support';
import { ADMIN_ID, DEMO_COMPANY, SOLO_COMPANY, THANDI_ID } from './entity-onboarding-seed';

const ADMIN_HOST = 'http://admin.isaflow.co.za';

export async function runAdmin(firstN: number): Promise<Result[]> {
  const abrowser = await chromium.launch({ args: [`--host-resolver-rules=MAP admin.isaflow.co.za ${BASE_URL.hostname}:${BASE_URL.port || '80'}`] });
  const actx = await abrowser.newContext({ viewport: { width: 1440, height: 900 } });
  await actx.addCookies([{ name: 'sb-access-token', value: cookieFor(ADMIN_ID, 'synth.admin@example.test', 'aal2'), url: ADMIN_HOST }]);
  await actx.addInitScript(() => localStorage.setItem('accounting-theme', 'dark'));
  const ap = await actx.newPage();
  const open = async () => {
    await ap.goto(`${ADMIN_HOST}/users/${THANDI_ID}`);
    await ap.getByRole('button', { name: 'companies', exact: true }).click();
    await ap.getByText('Linked Companies').waitFor({ timeout: 30000 });
  };
  const rowOf = (name: string) => ap.locator('tr', { hasText: name });
  const roleDb = (cid: string) => psql(`select coalesce(string_agg(role,','),'(no row)') from company_users where user_id='${THANDI_ID}' and company_id='${cid}'`);
  const out: Result[] = [];

  psql(`insert into company_users (company_id, user_id, role, is_default) values ('${DEMO_COMPANY}', '${THANDI_ID}', 'bookkeeper', true) on conflict do nothing`);
  const r6: Result = { n: firstN, name: 'Admin: change role bookkeeper -> accountant', status: 'FAIL', notes: [], shots: [] };
  attachLogs(ap, r6);
  try {
    await open();
    r6.notes.push(`before: ${roleDb(DEMO_COMPANY)}`);
    await rowOf('ISAFlow Demo').getByLabel(/Role in/).selectOption('accountant');
    await rowOf('ISAFlow Demo').getByRole('button', { name: 'Save role' }).waitFor();
    r6.notes.push(`dirty state: Save role visible, DB still ${roleDb(DEMO_COMPANY)}`);
    await shot(ap, r6, 'admin-role-dirty', [['desktop', 'light'], ['desktop', 'dark']]);
    await rowOf('ISAFlow Demo').getByRole('button', { name: 'Save role' }).click();
    await ap.waitForTimeout(2000);
    const after = roleDb(DEMO_COMPANY);
    r6.notes.push(`after: ${after}`);
    await shot(ap, r6, 'admin-role-saved', [['desktop', 'light']]);
    r6.status = after === 'accountant' ? 'PASS' : 'FAIL';
  } catch (e) { r6.notes.push(`ERROR: ${(e as Error).message.split('\n')[0]}`); }
  out.push(r6);

  const r7: Result = { n: firstN + 1, name: 'Admin: remove ISAFlow Demo link', status: 'FAIL', notes: [], shots: [] };
  attachLogs(ap, r7);
  try {
    await open();
    await rowOf('ISAFlow Demo').getByRole('button', { name: 'Remove' }).click();
    await ap.getByText('Remove this link?').waitFor();
    await ap.getByRole('button', { name: 'Cancel' }).waitFor();
    await shot(ap, r7, 'admin-remove-confirm', [['desktop', 'light'], ['desktop', 'dark']]);
    await ap.getByRole('button', { name: 'Confirm remove' }).click();
    await ap.waitForTimeout(2500);
    const after = roleDb(DEMO_COMPANY);
    r7.notes.push(`after: ${after}`);
    await shot(ap, r7, 'admin-remove-done', [['desktop', 'dark']]);
    r7.status = after === '(no row)' ? 'PASS' : 'FAIL';
  } catch (e) { r7.notes.push(`ERROR: ${(e as Error).message.split('\n')[0]}`); }
  out.push(r7);

  const r8: Result = { n: firstN + 2, name: 'Admin: remove last-owner link refused', status: 'FAIL', notes: [], shots: [] };
  attachLogs(ap, r8);
  try {
    await open();
    await rowOf('Synth Solo Owner').getByRole('button', { name: 'Remove' }).click();
    await ap.getByRole('button', { name: 'Confirm remove' }).click();
    const msg = ap.getByText(/last owner/i).first();
    await msg.waitFor({ timeout: 10000 });
    r8.notes.push(`message: ${(await msg.textContent())?.trim()}`);
    const still = psql(`select count(*) from company_users where user_id='${THANDI_ID}' and company_id='${SOLO_COMPANY}'`);
    r8.notes.push(`DB link rows remaining: ${still}`);
    await shot(ap, r8, 'admin-last-owner-refused', [['desktop', 'light'], ['desktop', 'dark']]);
    r8.status = still === '1' ? 'PASS' : 'FAIL';
  } catch (e) { r8.notes.push(`ERROR: ${(e as Error).message.split('\n')[0]}`); }
  out.push(r8);

  await abrowser.close();
  return out;
}
