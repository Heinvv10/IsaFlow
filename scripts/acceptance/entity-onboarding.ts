// Browser acceptance, entity onboarding for ALL EIGHT entity types + admin links.
// Needs: dev server on BASE (default :3200) against a THROWAWAY Postgres, JWT secret for sign.ts, env PORT (postgres) / PGPASSWORD / JWT.
// Run from the repo root: bun scripts/acceptance/entity-onboarding.ts
import type { Browser, Page } from 'playwright';
import {
  BASE, OUT, PAIR, SCRATCH, allShots, attachLogs, check, checkIdInputsFit, checkLogoAndCards, checkMobile, chromium, cont,
  expectVisible, newCtx, pdfFile, pngDataUrl, pngFile, psql, psqlPretty, saId, shot, shotLanded, type Result,
} from './entity-onboarding-support';
import { onbUserId, seedThrowawayDb } from './entity-onboarding-seed';
import { CASES, type Case, type Person } from './entity-onboarding-cases';
import { runAdmin } from './entity-onboarding-admin';
import { writeReport } from './entity-onboarding-report';

const NOTICE = /AI extraction unavailable|No active company|Could not extract|Details extracted|ID verified|updated/;
const idNo = (c: Case, i: number) => saId('800101', 5000 + c.n * 10 + i);

async function addPerson(page: Page, c: Case, idx: number, p: Person, noticesBefore: number) {
  await page.getByRole('button', { name: new RegExp(`\\+ Add ${c.role}`) }).click();
  await page.getByPlaceholder('Full name').nth(idx).fill(p.name);
  await page.getByPlaceholder('ID number').nth(idx).fill(idNo(c, idx));
  if (p.withId) await uploadId(page, c, idx, noticesBefore);
}

/** Attaches an ID document to the first person still lacking one; extract-id has no VLM, so wait for its notice to settle. */
async function uploadId(page: Page, c: Case, idx: number, noticesBefore: number) {
  await page.locator('label:has-text("Upload ID") input[type=file]').first().setInputFiles(pngFile(`id-${c.n}-${idx + 1}.png`));
  await page.getByText(NOTICE).nth(noticesBefore).waitFor({ timeout: 90000 });
}

/** The same POST the wizard makes, with the proof missing: the server must refuse it, and write nothing. */
async function expectServerRefusal(page: Page, r: Result, uid: string, ph: string, label: string, body: Record<string, unknown>, expect: string) {
  const res = await page.evaluate(async (b) => {
    const m = document.cookie.split('; ').find(x => x.startsWith('isaflow_csrf='));
    const resp = await fetch('/api/onboarding/complete-setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': m ? m.slice('isaflow_csrf='.length) : '' }, body: JSON.stringify(b),
    });
    return { status: resp.status, text: await resp.text() };
  }, body);
  (r.refusals ??= []).push({ label, status: res.status, body: res.text.slice(0, 400) });
  check(r, res.status === 400 && res.text.includes(expect), `server refuses (${label}): HTTP ${res.status}, body contains "${expect}"`);
  const made = psql(`select count(*) from company_users where user_id='${uid}' and company_id<>'${ph}'`);
  check(r, made === '0', `server wrote no company for the refused request (${label}); new memberships: ${made}`);
}

const backToDetails = async (page: Page) => {
  for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('heading', { name: 'Business Details' }).waitFor();
};
const toDocuments = async (page: Page, slug: string) => {
  for (let i = 0; i < 6; i++) { await cont(page).click(); await checkMobile(page, `${slug} step ${i + 3}`); }
  await page.getByRole('heading', { name: 'Statutory Documents' }).waitFor();
};

async function runOnboarding(browser: Browser, c: Case): Promise<Result> {
  const r: Result = { n: c.n, name: `${c.typeLabel} (user onb${c.n})`, entity: c.entityDb, status: 'FAIL', notes: [], shots: [] };
  const uid = onbUserId(c.n);
  // like a real signup (provisionTenant): placeholder company + owner membership, active_company_id cookie
  const ph = crypto.randomUUID();
  // previous runs' companies stay (entity_changes is append-only); only the user's memberships are cleared
  psql(`delete from company_users where user_id='${uid}'; delete from companies where id='${ph}'`);
  psql(`insert into companies (id, name, is_active) values ('${ph}', 'Synth Signup ${c.n}', true); insert into company_users (company_id, user_id, role, is_default) values ('${ph}', '${uid}', 'owner', true); update users set onboarding_completed=false where id='${uid}'`);
  const ctx = await newCtx(browser, uid, `onb${c.n}@example.test`, 'aal2');
  await ctx.addCookies([{ name: 'active_company_id', value: ph, url: BASE }]);
  const page = await ctx.newPage();
  attachLogs(page, r);
  const proofDoc = c.doc ? (() => { const f = pdfFile(c.doc.file); return { type: c.doc.type, name: f.name, data: `data:application/pdf;base64,${f.buffer.toString('base64')}`, mimeType: f.mimeType, size: f.buffer.length }; })() : null;
  const bodyOf = (people: Person[], docs: unknown[]) => ({
    requestKey: crypto.randomUUID(), entityType: c.entityDb, coaTemplate: 'isaflow_standard',
    company: { name: c.name, ...(c.reg ? { registrationNumber: c.reg } : {}) },
    people: people.map((p, i) => ({ name: p.name, idNumber: idNo(c, i), ...(p.withId ? { idDocument: { name: `id-${i}.png`, data: pngDataUrl(`srv-${c.n}-${i}`) } } : {}) })),
    documents: docs,
  });
  try {
    // 1. entity step
    await page.goto(`${BASE}/onboarding`);
    await page.getByRole('radiogroup').waitFor({ timeout: 30000 });
    await page.getByRole('radio', { name: c.label }).click();
    await expectVisible(page, c.needsHint);
    r.notes.push(`entity step shows hint matching ${c.needsHint}`);
    await checkMobile(page, `${c.slug} entity step`);
    if (c.n === 1) await checkLogoAndCards(page);
    await shot(page, r, `${c.slug}-entity-step`, PAIR);
    await cont(page).click();
    await page.getByRole('button', { name: /Enter Details Manually/ }).click({ timeout: 3000 }).catch(() => r.notes.push('no Smart Setup pre-step shown'));

    // 2. details + people. A blank name always blocks Continue.
    await page.getByRole('heading', { name: 'Business Details' }).waitFor();
    check(r, await cont(page).isDisabled(), 'Continue disabled while the name is blank');
    if (c.proof === 'none') await shot(page, r, `${c.slug}-blocked-no-name`, PAIR);
    await page.getByPlaceholder('Acme').first().fill(c.name);
    if (c.reg) await page.getByPlaceholder(c.regPlaceholder!, { exact: true }).fill(c.reg);
    await expectVisible(page, c.peopleLabel);
    const first = c.firstPass ?? c.people;
    for (let i = 0; i < first.length; i++) await addPerson(page, c, i, first[i]!, first.slice(0, i).filter(p => p.withId).length);
    if (c.proof === 'person_ids') await expectVisible(page, /Required: .*/);
    const details = async () => {
      if (c.people.some(p => p.withId)) await checkIdInputsFit(page, `${c.slug} details`);
      await shot(page, r, `${c.slug}-details-people`, PAIR);
      await checkMobile(page, `${c.slug} details`);
    };
    if (!c.firstPass) await details();
    await toDocuments(page, c.slug);

    // 3. documents step: the negative, with the reason visible
    if (c.proof === 'none') {
      check(r, await cont(page).isEnabled(), 'documents step: Continue enabled with nothing uploaded (no proof required)');
      check(r, (await page.locator('#continue-blocked').count()) === 0, 'documents step: no blocked reason shown');
      await shot(page, r, `${c.slug}-docs-step`, PAIR);
    } else {
      check(r, await cont(page).isDisabled(), `documents step: Continue disabled without the ${c.proof === 'document' ? c.doc!.label : 'ID document'}`);
      const reason = ((await page.locator('#continue-blocked').textContent({ timeout: 5000 }).catch(() => null)) ?? '').trim();
      check(r, reason === c.blockedText, `blocked reason shown: "${reason}"`);
      await shot(page, r, `${c.slug}-blocked-no-proof`, PAIR);
      await expectServerRefusal(page, r, uid, ph, 'proof missing, as the wizard holds it', bodyOf(first, []), c.blockedText!.replace(/ to continue\.$/, ''));
    }
    for (const mk of c.refusals) { const x = mk(bodyOf(c.people, proofDoc ? [proofDoc] : []), proofDoc); await expectServerRefusal(page, r, uid, ph, x.label, x.body, x.expect); }

    // 4. supply the proof
    if (c.proof === 'document') {
      await page.getByLabel(`Upload ${c.doc!.label}`).setInputFiles(pdfFile(c.doc!.file));
      await expectVisible(page, c.doc!.file);
      check(r, await cont(page).isEnabled(), 'Continue enabled once the document is attached');
    } else if (c.proof === 'person_ids') {
      await backToDetails(page);
      await uploadId(page, c, first.length - 1, first.slice(0, -1).filter(p => p.withId).length);
      await details();
      await toDocuments(page, c.slug);
      await expectVisible(page, /Captured on the .* step/);
      check(r, (await page.getByText(/CIPC|CK1|Letters of Authority/).count()) === 0, 'no company-document slot on a person-ID entity');
    }
    if (c.proof !== 'none') await shot(page, r, `${c.slug}-docs-satisfied`, PAIR);
    await cont(page).click();
    await checkMobile(page, `${c.slug} review`);
    check(r, await page.getByRole('button', { name: 'Complete Setup' }).isEnabled(), 'review: Complete Setup enabled');

    // 5. complete and land
    await page.getByRole('button', { name: 'Complete Setup' }).click();
    await page.waitForURL(/\/accounting/, { timeout: 60000 });
    await page.waitForLoadState('domcontentloaded');
    await page.getByText(c.name).first().waitFor({ timeout: 45000 });
    await page.getByLabel('Skip tour').click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
    await page.waitForFunction(() => document.querySelectorAll('.animate-pulse').length === 0, undefined, { timeout: 8000 }).catch(async () => {
      const left = await page.evaluate(() => Array.from(document.querySelectorAll('.animate-pulse')).map(e => `${e.tagName}.${(e.getAttribute('class') ?? '').slice(0, 80)} text="${(e.textContent ?? '').slice(0, 20)}"`));
      r.notes.push(`animate-pulse elements still present: ${JSON.stringify(left)}`);
    });
    r.notes.push(`landed at ${page.url().replace(BASE, '')}; page shows "${c.name}"`);
    await page.waitForTimeout(1500);
    await shotLanded(page, r, `${c.slug}-landed`, PAIR, c.name);

    // 6. the database, for the NEW company (placeholder excluded)
    const newId = psql(`select c.id from companies c join company_users cu on cu.company_id=c.id where cu.user_id='${uid}' and c.id<>'${ph}'`);
    const cookieNow = (await ctx.cookies()).find(x => x.name === 'active_company_id')?.value;
    check(r, /^[0-9a-f-]{36}$/.test(newId), `exactly one new company for the user: ${newId}`);
    check(r, cookieNow === newId, `active_company_id cookie points at the new company: ${cookieNow}`);
    check(r, r.completeSetupStatus === 200, `complete-setup HTTP ${r.completeSetupStatus}`);
    check(r, psql(`select entity_type from companies where id='${newId}'`) === c.entityDb, `companies.entity_type = ${c.entityDb}`);
    check(r, psql(`select role from company_users where company_id='${newId}' and user_id='${uid}'`) === 'owner', 'company_users.role = owner');
    const want = [...c.people].map(p => `${p.name}/${c.role}/${p.withId}`).sort().join(',');
    const got = psql(`select coalesce(string_agg(name||'/'||role||'/'||(id_document_data is not null), ',' order by name), '') from company_directors where company_id='${newId}'`);
    check(r, got === want, `people rows (name/role/has-ID): "${got}" expected "${want}"`);
    const docWant = c.doc ? c.doc.type : '';
    check(r, psql(`select coalesce(string_agg(document_type, ',' order by document_type), '') from company_documents where company_id='${newId}'`) === docWant, `attached document types = "${docWant}"`);
    check(r, psql(`select onboarding_completed from users where id='${uid}'`) === 't', 'users.onboarding_completed = true');
    const q = [
      `select id, name, entity_type, registration_number from companies where id='${newId}'`,
      `select company_id, user_id, role, is_default from company_users where company_id='${newId}'`,
      `select name, id_number, role, id_document_name, (id_document_data is not null) as has_id_document from company_directors where company_id='${newId}' order by name`,
      `select document_type, document_name, mime_type, file_size from company_documents where company_id='${newId}' order by document_type`,
    ];
    r.dbEvidence = q.map(s => `psql> ${s};\n${psqlPretty(s)}`);
    r.status = r.failed ? 'FAIL' : 'PASS';
  } catch (e) {
    r.notes.push(`ERROR: ${(e as Error).message.split('\n')[0]}`);
    await page.screenshot({ path: `${SCRATCH}/fail-${c.n}.png`, fullPage: true }).catch(() => undefined);
    await page.screenshot({ path: `${OUT}/${String(c.n).padStart(2, '0')}-${c.slug}-FAILED-desktop-dark.png` }).catch(() => undefined);
  }
  await ctx.close();
  return r;
}

async function main() {
  seedThrowawayDb();
  const only = process.env.ONLY?.split(',').map(Number);
  const browser = await chromium.launch();
  const results: Result[] = [];
  for (const c of CASES.filter(x => !only || only.includes(x.n))) results.push(await runOnboarding(browser, c));
  await browser.close();
  if (!only || only.some(n => n > 8)) results.push(...await runAdmin(9));
  await writeReport(results);
  for (const r of results) console.log(`${r.status} #${r.n} ${r.name}\n  ${r.notes.join('\n  ')}`);
  console.log(`${allShots.length} screenshots`);
  if (results.some(r => r.status === 'FAIL')) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exit(1); });
