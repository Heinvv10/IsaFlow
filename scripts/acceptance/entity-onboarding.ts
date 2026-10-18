// Browser acceptance, entity onboarding for ALL EIGHT entity types + server refusals + admin links.
// Needs: dev server on BASE (default :3200) against the THROWAWAY Postgres `isaflow_e2e` on localhost, JWT secret for sign.ts,
// env PORT (postgres) / PGPASSWORD / JWT. Run from the repo root. The evidence set was produced with the Node bundle:
//   bun build scripts/acceptance/entity-onboarding.ts --target node --format esm --external playwright --outfile node_modules/.cache/entity-onboarding.mjs
//   node node_modules/.cache/entity-onboarding.mjs
// Running it directly with `bun scripts/acceptance/entity-onboarding.ts` works but is unreliable on the shared box: Playwright
// under Bun lost its Chromium intermittently (calls hung without an error); the watchdog in withBrowser then retries the scenario.
// ONLY=1,4,12 runs just those scenarios (1-8 entity types, 9-11 admin group, 12 refusals, 13 probes); a partial run
// writes RESULTS.partial.md to the scratch dir and never touches the evidence RESULTS.md.
import type { Browser, Page } from 'playwright';
import {
  BASE, OUT, PAIR, SCRATCH, allShots, attachLogs, check, closeWithin, cont, expectVisible, finish, newResult, pdfFile, pngDataUrl, pngFile,
  psql, psqlPretty, saId, trace, withBrowser, type Result,
} from './entity-onboarding-support';
import { checkIdInputsFit, checkLogoAndCards, checkMobile, expectNoSkeleton, shot, shotLanded } from './entity-onboarding-visual';
import { openUser, seedThrowawayDb } from './entity-onboarding-seed';
import { CASES, type Case, type Person } from './entity-onboarding-cases';
import { REFUSAL_ALLOW, expectRefusal, runProbes, runRefusals } from './entity-onboarding-server';
import type { Body } from './entity-onboarding-refusals';
import { ADMIN_LAUNCH_ARGS, runAdmin } from './entity-onboarding-admin';
import { writeReport } from './entity-onboarding-report';

// extract-id has no VLM in this setup: the wizard keeps the typed name and ID number and says so. That outcome is the expectation.
const NOTICE = 'AI extraction unavailable.';
const idNo = (c: Case, i: number) => saId('800101', 5000 + c.n * 10 + i);
const stripContinue = (t: string) => t.replace(/ to continue\.$/, '');

async function addPerson(page: Page, c: Case, idx: number, p: Person, noticesBefore: number) {
  await page.getByRole('button', { name: new RegExp(`\\+ Add ${c.role}`) }).click();
  await page.getByPlaceholder('Full name').nth(idx).fill(p.name);
  await page.getByPlaceholder('ID number').nth(idx).fill(idNo(c, idx));
  if (p.withId) await uploadId(page, c, idx, noticesBefore);
}

/** Attaches an ID document to the first person still lacking one, then waits for the extraction notice: "AI extraction unavailable." */
async function uploadId(page: Page, c: Case, idx: number, noticesBefore: number) {
  await page.locator('label:has-text("Upload ID") input[type=file]').first().setInputFiles(pngFile(`id-${c.n}-${idx + 1}.png`));
  await page.getByText(NOTICE).nth(noticesBefore).waitFor({ timeout: 90000 });
}

const backToDetails = async (page: Page) => {
  for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('heading', { name: 'Business Details' }).waitFor();
};
const toDocuments = async (page: Page, r: Result, slug: string, measure: boolean) => {
  for (let i = 0; i < 6; i++) { await cont(page).click(); if (measure) await checkMobile(page, r, `${slug} step ${i + 3}`); }
  await page.getByRole('heading', { name: 'Statutory Documents' }).waitFor();
};

/** The request the wizard would send for the state it is in (people so far, the given documents). */
const bodyOf = (c: Case, people: Person[], docs: Body['documents']): Body => ({
  requestKey: crypto.randomUUID(), entityType: c.entityDb, coaTemplate: 'isaflow_standard',
  company: { name: c.name, ...(c.reg ? { registrationNumber: c.reg } : {}) },
  people: people.map((p, i) => ({ name: p.name, idNumber: idNo(c, i), ...(p.withId ? { idDocument: { name: `id-${i}.png`, data: pngDataUrl(`srv-${c.n}-${i}`) } } : {}) })),
  documents: docs,
});

/** The documents step with the proof missing: Continue dimmed, the exact reason shown, and the server refusing the same state. */
async function expectBlocked(page: Page, r: Result, c: Case, shotSlug: string, text: string, people: Person[]) {
  check(r, await cont(page).isDisabled(), 'documents step: Continue is disabled');
  const reason = ((await page.locator('#continue-blocked').textContent({ timeout: 5000 }).catch(() => null)) ?? '').trim();
  check(r, reason === text, `blocked reason shown: "${reason}" (expected "${text}")`);
  await shot(page, r, shotSlug, PAIR);
  await expectRefusal(page, r, `proof missing, as the wizard holds it: ${stripContinue(text)}`, bodyOf(c, people, []), stripContinue(text));
}

async function runOnboarding(browser: Browser, c: Case): Promise<Result> {
  const r = newResult(c.n, 'onboarding', `${c.typeLabel} (user onb${c.n})`, {
    entity: c.entityDb,
    allow: [REFUSAL_ALLOW, { url: /\/api\/onboarding\/extract-id/, status: 503, reason: 'no VLM in this setup; the wizard says "AI extraction unavailable."' }],
  });
  const { ctx, page, uid, placeholder: ph } = await openUser(browser, c.n);
  attachLogs(page, r);
  try {
    // 1. entity step
    await page.goto(`${BASE}/onboarding`);
    await page.getByRole('radiogroup').waitFor({ timeout: 90000 });
    await page.getByRole('radio', { name: c.label }).click();
    await expectVisible(page, c.needsHint);
    r.notes.push(`entity step shows hint matching ${c.needsHint}`);
    await checkMobile(page, r, `${c.slug} entity step`);
    if (c.n === 1) await checkLogoAndCards(page, r);
    await shot(page, r, `${c.slug}-entity-step`, PAIR);
    await cont(page).click();

    // 2. Smart Setup pre-step: shown exactly for the entities smartSetupSourceFor can read something for
    const manual = page.getByRole('button', { name: /Enter Details Manually/ });
    if (c.smartSetup) {
      const shown = await manual.click({ timeout: 30000 }).then(() => true, () => false);
      check(r, shown, 'Smart Setup pre-step shown and "Enter Details Manually" clicked');
    } else {
      await page.getByRole('heading', { name: 'Business Details' }).waitFor({ timeout: 30000 });
      check(r, (await manual.count()) === 0, 'no Smart Setup pre-step for this entity');
    }

    // 3. details: a blank name blocks Continue; people label, role and the required-proof line follow the entity
    await page.getByRole('heading', { name: 'Business Details' }).waitFor();
    check(r, await cont(page).isDisabled(), 'Continue disabled while the name is blank');
    if (c.proof === 'none') await shot(page, r, `${c.slug}-blocked-no-name`, PAIR);
    await page.getByPlaceholder('Acme').first().fill(c.name);
    if (c.reg) await page.getByPlaceholder(c.regPlaceholder!, { exact: true }).fill(c.reg);
    await expectVisible(page, c.peopleLabel);
    // Structural, not by label text: the VAT / tax / registration fields share one three-column row, so an entity with a
    // registration field has 3 inputs in it and one without has 2 (the Field component carries no id, name or data attribute).
    const fieldRow = page.locator('div[class*="sm:grid-cols-3"]').filter({ has: page.locator('input') }).first();
    check(r, (await fieldRow.locator('input').count()) === (c.regLabel ? 3 : 2), `details step: ${c.regLabel ? 'registration field present (3 inputs in the VAT/tax row)' : 'no registration field (2 inputs in the VAT/tax row)'}`);
    if (c.regLabel) check(r, (await page.getByText(c.regLabel).count()) >= 1, `registration field is labelled "${c.regLabel}"`);
    if (c.requiredLine) await page.getByText(c.requiredLine, { exact: true }).waitFor({ timeout: 8000 });
    check(r, (await page.getByText(/^Required: /).count()) === (c.requiredLine ? 1 : 0), c.requiredLine ? `details step shows "${c.requiredLine}"` : 'details step shows no "Required:" line');
    const details = async () => {
      if (c.people.some(p => p.withId)) await checkIdInputsFit(page, r, `${c.slug} details`);
      await shot(page, r, `${c.slug}-details-people`, PAIR);
      await checkMobile(page, r, `${c.slug} details`);
    };

    // 4. people and the documents step
    const typed: Person[] = [];
    const idsDone = () => typed.filter(p => p.withId).length;
    const type = async (people: Person[]) => { for (const p of people) { await addPerson(page, c, typed.length, p, idsDone()); typed.push(p); } };
    if (c.proof === 'person_ids') {
      for (const [k, stage] of c.stages!.entries()) {
        await type(stage.add);
        await toDocuments(page, r, c.slug, k === 0);
        await expectBlocked(page, r, c, `${c.slug}-blocked-${k + 1}`, stage.blockedText, typed);
        await backToDetails(page);
      }
      await uploadId(page, c, typed.length - 1, typed.slice(0, -1).filter(p => p.withId).length); // the missing ID document
      await details();
      await toDocuments(page, r, c.slug, false);
      await expectVisible(page, /Captured on the .* step/);
      check(r, (await page.getByText(/CIPC|CK1|Letters of Authority/).count()) === 0, 'no company-document slot on a person-ID entity');
      check(r, await cont(page).isEnabled(), 'Continue enabled once every ID document is attached');
      await shot(page, r, `${c.slug}-docs-satisfied`, PAIR);
    } else {
      await type(c.people);
      await details();
      await toDocuments(page, r, c.slug, true);
      if (c.proof === 'document') {
        await expectBlocked(page, r, c, `${c.slug}-blocked-no-proof`, c.blockedText!, c.people);
        await page.getByLabel(`Upload ${c.doc!.label}`).setInputFiles(pdfFile(c.doc!.file));
        await expectVisible(page, c.doc!.file);
        check(r, await cont(page).isEnabled(), 'Continue enabled once the document is attached');
        await shot(page, r, `${c.slug}-docs-satisfied`, PAIR);
      } else {
        check(r, await cont(page).isEnabled(), 'documents step: Continue enabled with nothing uploaded (no proof required)');
        check(r, (await page.locator('#continue-blocked').count()) === 0, 'documents step: no blocked reason shown');
        await shot(page, r, `${c.slug}-docs-step`, PAIR);
        await expectRefusal(page, r, 'blank name, the one thing this entity requires', { ...bodyOf(c, c.people, []), company: { name: '' } }, 'Enter the name');
      }
    }
    await cont(page).click();
    await checkMobile(page, r, `${c.slug} review`);
    check(r, await page.getByRole('button', { name: 'Complete Setup' }).isEnabled(), 'review: Complete Setup enabled');

    // 5. complete and land
    await page.getByRole('button', { name: 'Complete Setup' }).click();
    await page.waitForURL(/\/accounting/, { timeout: 60000 });
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('heading', { name: c.name }).first().waitFor({ state: 'visible', timeout: 90000 });
    await page.getByLabel('Skip tour').click({ timeout: 5000 }).catch(() => r.notes.push('no tour shown'));
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => r.notes.push('network did not go idle within 15s'));
    await expectNoSkeleton(page, r);
    r.notes.push(`landed at ${page.url().replace(BASE, '')}; page shows "${c.name}"`);
    await shotLanded(page, r, `${c.slug}-landed`, PAIR, c.name);

    // 6. the database, for the NEW company (placeholder excluded)
    const newId = psql(`select c.id from companies c join company_users cu on cu.company_id=c.id where cu.user_id='${uid}' and c.id<>'${ph}'`);
    const cookieNow = (await ctx.cookies()).find(x => x.name === 'active_company_id')?.value;
    check(r, /^[0-9a-f-]{36}$/.test(newId), `exactly one new company for the user: ${newId}`);
    check(r, cookieNow === newId, `active_company_id cookie points at the new company: ${cookieNow}`);
    check(r, r.completeSetupStatus === 200, `complete-setup HTTP ${r.completeSetupStatus}`);
    check(r, psql(`select name from companies where id='${newId}'`) === c.name, `companies.name = "${c.name}"`);
    check(r, psql(`select entity_type from companies where id='${newId}'`) === c.entityDb, `companies.entity_type = ${c.entityDb}`);
    const regWant = c.reg ?? '<NULL>';
    check(r, psql(`select coalesce(registration_number, '<NULL>') from companies where id='${newId}'`) === regWant, `companies.registration_number = ${regWant}`);
    check(r, psql(`select role from company_users where company_id='${newId}' and user_id='${uid}'`) === 'owner', 'company_users.role = owner');
    const want = c.people.map((p, i) => `${p.name}/${c.role}/${idNo(c, i)}/${p.withId}`).sort().join(',');
    const got = psql(`select coalesce(string_agg(name||'/'||role||'/'||coalesce(id_number, '<NULL>')||'/'||(id_document_data is not null), ',' order by name), '') from company_directors where company_id='${newId}'`);
    check(r, got === want, `people rows (name/role/id_number/has-ID): "${got}" expected "${want}"`);
    const docWant = c.doc ? c.doc.type : '';
    check(r, psql(`select coalesce(string_agg(document_type, ',' order by document_type), '') from company_documents where company_id='${newId}'`) === docWant, `attached document types = "${docWant}"`);
    check(r, psql(`select onboarding_completed from users where id='${uid}'`) === 't', 'users.onboarding_completed = true');
    r.dbEvidence = [
      `select id, name, entity_type, registration_number from companies where id='${newId}'`,
      `select company_id, user_id, role, is_default from company_users where company_id='${newId}'`,
      `select name, id_number, role, id_document_name, (id_document_data is not null) as has_id_document from company_directors where company_id='${newId}' order by name`,
      `select document_type, document_name, mime_type, file_size from company_documents where company_id='${newId}' order by document_type`,
    ].map(s => `psql> ${s};\n${psqlPretty(s)}`);
  } catch (e) {
    r.failed = true;
    r.notes.push(`ERROR: ${(e as Error).message.split('\n')[0]}`);
    await page.screenshot({ path: `${SCRATCH}/fail-${c.n}.png`, fullPage: true }).catch(() => undefined);
    await page.screenshot({ path: `${OUT}/${String(c.n).padStart(2, '0')}-${c.slug}-FAILED-desktop-dark.png` }).catch(() => undefined);
  }
  await page.waitForTimeout(500); // let the last response handler run before the verdict
  await closeWithin(ctx);
  finish(r);
  return r;
}

/** Runs a scenario on its own browser; up to 2 retries if the browser dies or the scenario hangs (see withBrowser), disclosed in the notes. */
async function attempt(n: number, kind: Result['kind'], name: string, launchArgs: string[], run: (b: Browser) => Promise<Result[]>): Promise<Result[]> {
  try {
    trace(`#${n} start`);
    const { value, attempts } = await withBrowser(`#${n}`, launchArgs, 900000, run);
    value[0]?.notes.unshift(...attempts.map(a => `RETRY ${a}`));
    return value;
  } catch (e) {
    const r = newResult(n, kind, name);
    r.failed = true;
    r.notes.push(`ERROR: ${(e as Error).message.split('\n')[0]} (after 2 retries)`);
    finish(r);
    return [r];
  }
}

async function main() {
  const only = process.env.ONLY ? process.env.ONLY.split(',').map(s => Number(s.trim())) : null;
  const want = (n: number) => only === null || only.includes(n);
  const cases = CASES.filter(c => want(c.n));
  const admin = [9, 10, 11].some(want);
  if (only !== null && cases.length === 0 && !admin && !want(12) && !want(13)) {
    console.error(`ONLY=${process.env.ONLY} matches no scenario (valid: 1-8 entity types, 9-11 admin, 12 refusals, 13 probes); nothing run, RESULTS.md untouched`);
    process.exit(2);
  }
  seedThrowawayDb();
  // The dev server compiles pages on first hit, and a compile that lands mid-run has twice corrupted its chunk cache
  // ("Cannot find module './77500.js'", every page then 500s). Compile the public pages up front.
  for (const path of ['/offline', '/login']) await fetch(`${BASE}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(180000) }).then(r => trace(`warm-up ${path}: HTTP ${r.status}`), e => trace(`warm-up ${path}: ${(e as Error).message}`));
  const results: Result[] = [];
  for (const c of cases) results.push(...await attempt(c.n, 'onboarding', `${c.typeLabel} (user onb${c.n})`, [], async b => [await runOnboarding(b, c)]));
  if (want(12)) results.push(...await attempt(12, 'server', 'Server refusals', [], async b => [await runRefusals(b, 12)]));
  if (want(13)) results.push(...await attempt(13, 'server', 'Server probes', [], async b => [await runProbes(b, 13)]));
  if (admin) results.push(...await attempt(9, 'admin', 'Admin scenarios', ADMIN_LAUNCH_ARGS, b => runAdmin(b, 9)));
  await writeReport(results, only === null);
  for (const r of results) console.log(`${r.status} #${r.n} ${r.name}\n  ${r.notes.join('\n  ')}`);
  console.log(`${allShots.length} screenshots`);
  process.exit(results.some(r => r.status === 'FAIL') ? 1 : 0); // not process.exitCode: a lingering handle must not hold the run open
}
main().catch(e => { console.error(e); process.exit(1); });
