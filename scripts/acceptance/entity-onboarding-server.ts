// Server-side checks for the entity-onboarding acceptance: POST /api/onboarding/complete-setup straight from a signed-in
// page (same cookies and CSRF header as the wizard), judged by status, message and what the database holds afterwards.
// Reads only; the seeding and the browser sessions live in entity-onboarding-seed.ts.
import type { Browser, Page } from 'playwright';
import { psql, psqlPretty, attachLogs, check, closeWithin, finish, newResult, BASE, type Result } from './entity-onboarding-support';
import { openUser } from './entity-onboarding-seed';
import { probeCatalogue, refusalCatalogue, type Body } from './entity-onboarding-refusals';

export const REFUSAL_ALLOW = { url: /\/api\/onboarding\/complete-setup/, status: 400, reason: 'intentional refusal under test' };

/**
 * The same POST the wizard makes (session cookies and CSRF double-submit header), sent through the browser context's request
 * API rather than an in-page fetch: the upload-limit cases carry 20-40 MB bodies, which should not be marshalled through the page.
 */
export async function postSetup(page: Page, body: Body | Record<string, unknown>): Promise<{ status: number; text: string }> {
  const csrf = (await page.context().cookies()).find(c => c.name === 'isaflow_csrf')?.value ?? '';
  const res = await page.request.post(`${BASE}/api/onboarding/complete-setup`, {
    data: body, headers: { 'X-CSRF-Token': csrf, Origin: BASE }, timeout: 180000,
  });
  return { status: res.status(), text: await res.text() };
}

/** Row counts of the four tables a setup writes. A refused request must leave all four exactly as they were. Counts are table-wide: a concurrent writer can only cause a false FAIL, never a false PASS. */
const counts = () => psql('select (select count(*) from companies) as c, (select count(*) from company_directors) as d, (select count(*) from company_documents) as docs, (select count(*) from company_users) as m')
  .split(' | ').map(Number);
const TABLES = ['companies', 'company_directors', 'company_documents', 'company_users'];

const messageOf = (text: string) => { try { return String((JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text); } catch { return text.slice(0, 200); } };

/** The server must answer 400 with exactly `expect` as its message (the request breaks one rule only), and create no row in companies, company_directors, company_documents or company_users. */
export async function expectRefusal(page: Page, r: Result, label: string, body: Body | Record<string, unknown>, expect: string) {
  const before = counts();
  const res = await postSetup(page, body);
  const after = counts();
  const message = messageOf(res.text);
  const created = TABLES.map((t, i) => `${t} +${after[i]! - before[i]!}`).join(', ');
  (r.refusals ??= []).push({ label, status: res.status, message, created });
  check(r, res.status === 400 && message === expect, `server refuses (${label}): HTTP ${res.status}, message is exactly "${expect}"`);
  check(r, after.every((n, i) => n === before[i]), `no rows created by the refused request (${label}): ${created}`);
}

/** Scenario 12: the refusal catalogue, one user, every case independent. */
export async function runRefusals(browser: Browser, n: number): Promise<Result> {
  const r = newResult(n, 'server', 'Server refusals (duplicates, limits, document types, registration numbers, files)', { allow: [REFUSAL_ALLOW] });
  const { ctx, page } = await openUser(browser, 9);
  attachLogs(page, r);
  try {
    await page.goto(`${BASE}/onboarding`);
    await page.getByRole('radiogroup').waitFor({ timeout: 90000 });
    for (const c of refusalCatalogue()) await expectRefusal(page, r, c.label, c.body, c.expect);
  } catch (e) { r.notes.push(`ERROR: ${(e as Error).message.split('\n')[0]}`); r.failed = true; }
  await page.waitForTimeout(500);
  await closeWithin(ctx);
  finish(r);
  return r;
}

/** Scenario 13: requests the rules accept although part of the input is ignored or unchecked: what is STORED must match the rules. */
export async function runProbes(browser: Browser, n: number): Promise<Result> {
  const r = newResult(n, 'server', 'Server probes (accepted: what is stored for a registration number)');
  const { ctx, page } = await openUser(browser, 10);
  attachLogs(page, r);
  r.dbEvidence = [];
  try {
    await page.goto(`${BASE}/onboarding`);
    await page.getByRole('radiogroup').waitFor({ timeout: 90000 });
    for (const p of probeCatalogue()) {
      const res = await postSetup(page, p.body);
      const id = (JSON.parse(res.text) as { data?: { companyId?: string } }).data?.companyId ?? '';
      check(r, res.status === 200 && /^[0-9a-f-]{36}$/.test(id), `${p.label}: HTTP ${res.status}, company ${id}`);
      if (!id) continue;
      const stored = psql(`select coalesce(registration_number, '<NULL>') from companies where id='${id}'`);
      const want = p.expectReg ?? '<NULL>';
      check(r, stored === want, `${p.label}: registration_number stored as "${stored}" (rules say "${want}")`);
      const docs = psql(`select coalesce(string_agg(document_type, ',' order by document_type), '') from company_documents where company_id='${id}'`);
      check(r, docs === (p.expectDocs ?? ''), `${p.label}: stored document types "${docs}" (expected "${p.expectDocs ?? ''}")`);
      for (const q of [`select entity_type, name, registration_number from companies where id='${id}'`, `select document_type, document_name, file_size from company_documents where company_id='${id}' order by document_type`]) r.dbEvidence.push(`psql> ${q};\n${psqlPretty(q)}`);
    }
  } catch (e) { r.notes.push(`ERROR: ${(e as Error).message.split('\n')[0]}`); r.failed = true; }
  await page.waitForTimeout(500);
  await closeWithin(ctx);
  finish(r);
  return r;
}
