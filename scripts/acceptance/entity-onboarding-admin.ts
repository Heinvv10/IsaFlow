// Admin "Linked Companies" scenarios (role change, remove, last-owner refusal) for the acceptance run.
// Reached as admin.isaflow.co.za mapped to the dev server: on localhost the middleware redirects /admin/* to a path that 404s.
import type { Browser, Page } from 'playwright';
import {
  BASE_URL, attachLogs, check, cookieFor, finish, newResult, psql, type AllowedError, type Result,
} from './entity-onboarding-support';
import { shot } from './entity-onboarding-visual';
import { ADMIN_ID, DEMO_COMPANY, SOLO_COMPANY, THANDI_ID } from './entity-onboarding-seed';

const ADMIN_HOST = 'http://admin.isaflow.co.za';

/**
 * Every admin page mounts CompanyProvider (pages/_app.tsx), which calls GET /api/accounting/companies?action=user-companies.
 * withAuth answers 400 NO_ACTIVE_COMPANY when the request has no active_company_id cookie (src/lib/auth/withAuth.ts:52-53), and
 * this admin session has none: a platform admin acts on other tenants and belongs to none. Probed in `probeNoActiveCompany`.
 */
const NO_ACTIVE_COMPANY: AllowedError = {
  url: /\/api\/accounting\/companies\?action=user-companies/, status: 400,
  reason: 'admin session has no active_company_id cookie: withAuth NO_ACTIVE_COMPANY, CompanyProvider ignores it',
};
const LAST_OWNER: AllowedError = { url: /\/remove-from-company/, status: 409, reason: 'the last-owner refusal under test' };

/** Confirms the cause of the user-companies 400 instead of assuming it: no cookie, and the body says NO_ACTIVE_COMPANY. */
async function probeNoActiveCompany(ap: Page, r: Result) {
  const cookies = (await ap.context().cookies()).map(c => c.name);
  const res = await ap.evaluate(async () => {
    const resp = await fetch('/api/accounting/companies?action=user-companies');
    return { status: resp.status, text: await resp.text() };
  });
  check(r, !cookies.includes('active_company_id'), `admin session cookies: ${cookies.join(', ')} (no active_company_id)`);
  check(r, res.status === 400 && res.text.includes('NO_ACTIVE_COMPANY'), `user-companies without an active company: HTTP ${res.status} ${res.text.slice(0, 120)}`);
}

/** Chromium must be launched with this to reach the admin host name on the local dev server. */
export const ADMIN_LAUNCH_ARGS = [`--host-resolver-rules=MAP admin.isaflow.co.za ${BASE_URL.hostname}:${BASE_URL.port || '80'}`];

export async function runAdmin(abrowser: Browser, firstN: number): Promise<Result[]> {
  const actx = await abrowser.newContext({ viewport: { width: 1440, height: 900 } });
  actx.setDefaultTimeout(90000);
  await actx.addCookies([{ name: 'sb-access-token', value: cookieFor(ADMIN_ID, 'synth.admin@example.test', 'aal2'), url: ADMIN_HOST }]);
  await actx.addInitScript(() => localStorage.setItem('accounting-theme', 'dark'));
  const ap = await actx.newPage();
  const open = async () => {
    await ap.goto(`${ADMIN_HOST}/users/${THANDI_ID}`);
    await ap.getByRole('button', { name: 'companies', exact: true }).click();
    await ap.getByText('Linked Companies').waitFor({ timeout: 90000 });
  };
  const rowOf = (name: string) => ap.locator('tr', { hasText: name });
  const roleDb = (cid: string) => psql(`select coalesce(string_agg(role,','),'(no row)') from company_users where user_id='${THANDI_ID}' and company_id='${cid}'`);
  const out: Result[] = [];
  const scenario = async (offset: number, name: string, extraAllow: AllowedError[], body: (r: Result) => Promise<void>) => {
    const r = newResult(firstN + offset, 'admin', name, { allow: [NO_ACTIVE_COMPANY, ...extraAllow] });
    attachLogs(ap, r);
    try { await body(r); } catch (e) { r.notes.push(`ERROR: ${(e as Error).message.split('\n')[0]}`); r.failed = true; }
    await ap.waitForTimeout(500); // let the last response handler run before the verdict
    finish(r);
    out.push(r);
  };

  // always start this scenario from the same state, even if an earlier run left the link at another role
  psql(`insert into company_users (company_id, user_id, role, is_default) values ('${DEMO_COMPANY}', '${THANDI_ID}', 'bookkeeper', true) on conflict (company_id, user_id) do update set role = 'bookkeeper'`);
  await scenario(0, 'Admin: change role bookkeeper -> accountant', [], async (r) => {
    await open();
    await probeNoActiveCompany(ap, r);
    check(r, roleDb(DEMO_COMPANY) === 'bookkeeper', `before: ${roleDb(DEMO_COMPANY)} (expected bookkeeper)`);
    await rowOf('ISAFlow Demo').getByLabel(/Role in/).selectOption('accountant');
    await rowOf('ISAFlow Demo').getByRole('button', { name: 'Save role' }).waitFor();
    check(r, roleDb(DEMO_COMPANY) === 'bookkeeper', `dirty state: Save role visible and the DB still says ${roleDb(DEMO_COMPANY)} (expected bookkeeper)`);
    await shot(ap, r, 'admin-role-dirty', [['desktop', 'light'], ['desktop', 'dark']]);
    await rowOf('ISAFlow Demo').getByRole('button', { name: 'Save role' }).click();
    await ap.waitForTimeout(2000);
    check(r, roleDb(DEMO_COMPANY) === 'accountant', `after Save role: ${roleDb(DEMO_COMPANY)} (expected accountant)`);
    await shot(ap, r, 'admin-role-saved', [['desktop', 'light']]);
  });

  await scenario(1, 'Admin: remove ISAFlow Demo link', [], async (r) => {
    await open();
    await rowOf('ISAFlow Demo').getByRole('button', { name: 'Remove' }).click();
    await ap.getByText('Remove this link?').waitFor();
    await ap.getByRole('button', { name: 'Cancel' }).waitFor();
    await shot(ap, r, 'admin-remove-confirm', [['desktop', 'light'], ['desktop', 'dark']]);
    await ap.getByRole('button', { name: 'Confirm remove' }).click();
    await ap.waitForTimeout(2500);
    check(r, roleDb(DEMO_COMPANY) === '(no row)', `after Confirm remove: ${roleDb(DEMO_COMPANY)} (expected no row)`);
    await shot(ap, r, 'admin-remove-done', [['desktop', 'dark']]);
  });

  await scenario(2, 'Admin: remove last-owner link refused', [LAST_OWNER], async (r) => {
    await open();
    await rowOf('Synth Solo Owner').getByRole('button', { name: 'Remove' }).click();
    await ap.getByRole('button', { name: 'Confirm remove' }).click();
    const msg = ap.getByText(/last owner/i).first();
    await msg.waitFor({ timeout: 30000 });
    check(r, /Cannot remove the last owner of the company/.test((await msg.textContent()) ?? ''), `message shown: ${(await msg.textContent())?.trim()}`);
    const still = psql(`select count(*) from company_users where user_id='${THANDI_ID}' and company_id='${SOLO_COMPANY}'`);
    check(r, still === '1', `DB link rows remaining: ${still} (expected 1)`);
    await shot(ap, r, 'admin-last-owner-refused', [['desktop', 'light'], ['desktop', 'dark']]);
  });

  return out;
}
