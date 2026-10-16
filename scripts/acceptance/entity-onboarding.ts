// Browser acceptance, entity onboarding + admin links: needs dev on :3200 vs a throwaway DB, fake GoTrue, PORT/PGPASSWORD/JWT.
import { chromium, type Page, type BrowserContext } from 'playwright';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const WIZ = process.cwd(); // run from the repo root
// Directory holding sign.ts (signs a GoTrue-shaped HS256 session with JWT_SECRET) and scratch files.
const SCRATCH = process.env.ACCEPT_SCRATCH ?? '/tmp/isaflow-accept';
const OUT = `${WIZ}/docs/evidence/entity-onboarding`;
const BASE = 'http://localhost:3200';
const { PORT, PGPASSWORD, JWT } = process.env as Record<string, string>;
mkdirSync(`${SCRATCH}/files`, { recursive: true });

const psql = (sql: string) => execFileSync('psql', ['-h', '127.0.0.1', '-p', PORT!, '-U', 'postgres', '-d', 'isaflow_e2e', '-At', '-F', ' | ', '-c', sql],
  { env: { ...process.env, PGPASSWORD } }).toString().trim();
const cookieFor = (id: string, email: string, aal: string) =>
  execFileSync('bun', [`${SCRATCH}/sign.ts`, id, email, aal], { cwd: WIZ, env: { ...process.env, JWT_SECRET: JWT } }).toString();

// Test files: valid PDF header / 1x1 PNG
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
// unique bytes per file: the server refuses the same document attached twice
const uniq = (b: Buffer, tag: string) => Buffer.concat([b, Buffer.from(`\n${tag}-${Date.now()}-${Math.random()}\n`), Buffer.alloc(2048, 32)]); // padded: the server refuses files under 1 KB
const pdfFile = (name: string) => ({ name, mimeType: 'application/pdf', buffer: uniq(PDF, name) });
const pngFile = (name: string) => ({ name, mimeType: 'image/png', buffer: uniq(PNG, name) });

function saId(yymmdd: string, seq: number): string {
  const base = `${yymmdd}${String(seq).padStart(4, '0')}08`;
  let sum = 0;
  for (let i = 0; i < 12; i++) { let n = Number(base[i]); if (i % 2 === 0) sum += n; else { n *= 2; sum += n > 9 ? n - 9 : n; } }
  return base + String((10 - (sum % 10)) % 10);
}

type Result = { n: number; name: string; status: 'PASS' | 'FAIL'; notes: string[]; shots: string[] };
const results: Result[] = [];
const allShots: string[] = [];

async function shot(page: Page, r: Result, slug: string, combos: Array<['mobile' | 'desktop', 'light' | 'dark']>) {
  for (const [vp, theme] of combos) {
    await page.setViewportSize(vp === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await page.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
    await page.waitForTimeout(250);
    const file = `${String(r.n).padStart(2, '0')}-${slug}-${vp}-${theme}.png`;
    await page.screenshot({ path: `${OUT}/${file}`, fullPage: vp === 'mobile' });
    r.shots.push(file); allShots.push(file);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
}
const overflow: string[] = [];
async function checkMobile(page: Page, label: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  overflow.push(`${m.sw <= m.iw ? 'OK  ' : 'FAIL'} ${label}: scrollWidth ${m.sw} / innerWidth ${m.iw}`);
  await page.setViewportSize({ width: 1440, height: 900 });
}
const idFit: string[] = [];
async function checkIdInputsFit(page: Page, label: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLInputElement>('input[placeholder="ID number"]'))
    .map(i => ({ v: i.value, sw: i.scrollWidth, cw: i.clientWidth })));
  for (const r of rows) {
    idFit.push(`${r.sw <= r.cw && r.v.length === 13 ? 'OK  ' : 'FAIL'} ${label}: ID ${r.v.length} digits, input scrollWidth ${r.sw} / clientWidth ${r.cw}`);
    if (r.sw > r.cw || r.v.length !== 13) throw new Error(`ID input clipped at 390px: ${JSON.stringify(r)}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
const logoChecks: string[] = [];
async function checkLogoAndCards(page: Page) {
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await page.waitForTimeout(250);
  const m = await page.evaluate(() => {
    const img = document.querySelector('img[alt="ISAFlow"]') as HTMLImageElement | null;
    const body = getComputedStyle(document.querySelector('div.min-h-screen') as Element);
    const card = document.querySelector('[role=radio]') as HTMLElement;
    const label = card.querySelector('p') as HTMLElement;
    return { filter: img ? getComputedStyle(img).filter : 'no img', loaded: !!img && img.naturalWidth > 0, bg: body.backgroundColor,
      cardBg: getComputedStyle(card).backgroundColor, cardBorder: getComputedStyle(card).borderColor, labelColor: getComputedStyle(label).color,
      hintColor: getComputedStyle(card.querySelectorAll('p')[1] as HTMLElement).color };
  });
  logoChecks.push(JSON.stringify(m));
  await page.evaluate(() => document.documentElement.classList.add('dark'));
}
const ALL4: Array<['mobile' | 'desktop', 'light' | 'dark']> = [['mobile', 'light'], ['mobile', 'dark'], ['desktop', 'light'], ['desktop', 'dark']];

async function newCtx(browser: any, id: string, email: string, aal: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'sb-access-token', value: cookieFor(id, email, aal), domain: 'localhost', path: '/' }]);
  await ctx.addInitScript(() => localStorage.setItem('accounting-theme', 'dark'));
  return ctx;
}

let logTarget: string[] = [];
const hooked = new WeakSet<Page>();
function attachLogs(page: Page, notes: string[]) {
  logTarget = notes;
  if (hooked.has(page)) return;
  hooked.add(page);
  page.on('console', m => { if (m.type() === 'error') logTarget.push(`console.error: ${m.text().slice(0, 200)}`); });
  page.on('response', async resp => {
    const u = resp.url();
    if (u.includes('/api/onboarding/complete-setup') || (resp.status() >= 400 && u.includes('/api/') && !u.includes('extract')))
      logTarget.push(`HTTP ${resp.status()} ${resp.request().method()} ${u.replace(BASE, '')} ${(await resp.text().catch(() => '')).slice(0, 300)}`);
  });
}

const expectVisible = async (page: Page, text: string | RegExp) => {
  await page.getByText(text).first().waitFor({ state: 'visible', timeout: 8000 });
};
const cont = (page: Page) => page.getByRole('button', { name: /^Continue/ });

async function addPerson(userTag: number, page: Page, role: string, idx: number, name: string, idNo: string, withId: boolean) {
  await page.getByRole('button', { name: new RegExp(`\\+ Add ${role}`) }).click();
  await page.getByPlaceholder('Full name').nth(idx).fill(name);
  await page.getByPlaceholder('ID number').nth(idx).fill(idNo);
  if (withId) {
    await page.locator('label:has-text("Upload ID") input[type=file]').first().setInputFiles(pngFile(`id-${userTag}-${idx + 1}.png`));
    // extract-id has no VLM: wait for the extraction to settle (notice appears) before touching the next person
    await page.getByText(/AI extraction unavailable|No active company|Could not extract|Details extracted|ID verified|updated/).nth(idx).waitFor({ timeout: 90000 });
  }
}

async function runOnboarding(browser: any, n: number, slug: string, userN: number, cfg: {
  label: RegExp; typeLabel: string; name: string; reg?: [string, string]; people: string[]; peopleLabel: string; role: string;
  docLabel?: string; docFile?: string; blockFirst?: boolean; needsHint: RegExp; entityDb: string;
}): Promise<Result> {
  const r: Result = { n, name: `${cfg.typeLabel} (user onb${userN})`, status: 'FAIL', notes: [], shots: [] };
  const uid = `dddddddd-0000-4000-8000-00000000000${userN}`;
  // like a real signup (provisionTenant): placeholder company + owner membership, active_company_id cookie
  const ph = crypto.randomUUID();
  // previous run's companies stay (entity_changes is append-only); only the user's memberships are cleared
  psql(`delete from company_users where user_id='${uid}'; delete from companies where id='${ph}'`);
  psql(`insert into companies (id, name, is_active) values ('${ph}', 'Synth Signup ${userN}', true); insert into company_users (company_id, user_id, role, is_default) values ('${ph}', '${uid}', 'owner', true); update users set onboarding_completed=false where id='${uid}'`);
  const ctx = await newCtx(browser, uid, `onb${userN}@example.test`, 'aal2');
  await ctx.addCookies([{ name: 'active_company_id', value: ph, domain: 'localhost', path: '/' }]);
  const page = await ctx.newPage();
  attachLogs(page, r.notes);
  try {
    await page.goto(`${BASE}/onboarding`);
    await page.getByRole('radiogroup').waitFor({ timeout: 30000 });
    await page.getByRole('radio', { name: cfg.label }).click();
    await expectVisible(page, cfg.needsHint);
    r.notes.push(`entity step shows hint matching ${cfg.needsHint}`);
    await checkMobile(page, `${slug} entity step`);
    if (n === 1) await checkLogoAndCards(page);
    await shot(page, r, `${slug}-entity-step`, [['mobile', 'dark'], ['desktop', 'light']]);
    await cont(page).click();
    await page.getByRole('button', { name: /Enter Details Manually/ }).click({ timeout: 3000 }).catch(() => r.notes.push('no Smart Setup pre-step shown'));
    await page.getByPlaceholder('Acme').first().fill(cfg.name);
    if (cfg.reg) { await page.getByPlaceholder(cfg.reg[0], { exact: true }).fill(cfg.reg[1]); }
    await expectVisible(page, cfg.peopleLabel);
    for (let i = 0; i < cfg.people.length; i++) await addPerson(userN, page, cfg.role, i, cfg.people[i]!, saId('800101', 5000 + n * 10 + i), cfg.people.length > 0 && !cfg.docFile ? true : false);
    if (cfg.people.length) await expectVisible(page, new RegExp(`Required: .*`));
    if (cfg.people.length) await checkIdInputsFit(page, `${slug} details`);
    await shot(page, r, `${slug}-details-people`, n === 2 ? [['mobile', 'light'], ['mobile', 'dark']] : [['mobile', 'light'], ['desktop', 'dark']]);
    await checkMobile(page, `${slug} details`);
    for (let i = 0; i < 6; i++) { await cont(page).click(); await checkMobile(page, `${slug} step ${i + 3}`); }
    await page.getByRole('heading', { name: 'Statutory Documents' }).waitFor();
    if (cfg.docFile) {
      await expectVisible(page, cfg.docLabel!);
      if (cfg.blockFirst) {
        const disabled = await cont(page).isDisabled();
        r.notes.push(`Continue disabled without ${cfg.docLabel}: ${disabled}`);
        await page.getByText(/Upload the .* to continue\./).waitFor({ timeout: 5000 });
        r.notes.push(`blocked reason shown: ${await page.getByText(/Upload the .* to continue\./).textContent()}`);
        await shot(page, r, `${slug}-blocked-no-cipc`, ALL4);
        if (!disabled) throw new Error('Continue was enabled without the required document');
      }
      await page.getByLabel(`Upload ${cfg.docLabel}`).setInputFiles(pdfFile(cfg.docFile));
      await expectVisible(page, cfg.docFile);
      await shot(page, r, `${slug}-docs-uploaded`, n === 3 ? [['desktop', 'light']] : [['mobile', 'light'], ['desktop', 'dark']]);
    } else {
      await expectVisible(page, /Captured on the .* step/);
      const slots = await page.getByText(/CIPC|CK1|Letters of Authority/).count();
      r.notes.push(`company-document slots on docs step: ${slots}`);
      if (slots > 0) throw new Error('company document slot present for a person-ID entity');
      await shot(page, r, `${slug}-docs-step`, n === 1 ? ALL4 : [['mobile', 'dark'], ['desktop', 'light']]);
    }
    await cont(page).click();
    await checkMobile(page, `${slug} review`);
    await page.getByRole('button', { name: 'Complete Setup' }).click();
    await page.waitForURL(/\/accounting/, { timeout: 60000 });
    await page.waitForLoadState('domcontentloaded');
    await page.getByText(cfg.name).first().waitFor({ timeout: 45000 });
    await page.getByLabel('Skip tour').click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
    await page.waitForFunction(() => document.querySelectorAll('.animate-pulse').length === 0, undefined, { timeout: 8000 }).catch(async () => {
      const left = await page.evaluate(() => Array.from(document.querySelectorAll('.animate-pulse')).map(e => `${e.tagName}.${(e.getAttribute('class') ?? '').slice(0, 80)} text="${(e.textContent ?? '').slice(0, 20)}" top=${Math.round(e.getBoundingClientRect().top)}`));
      r.notes.push(`animate-pulse elements still present: ${JSON.stringify(left)}`);
    });
    r.notes.push(`accounting page loaded: shows "${cfg.name}", no skeleton, tour dismissed if present`);
    r.notes.push(`landed at ${page.url().replace(BASE, '')}`);
    const row = psql(`select c.id, c.entity_type, c.name, cu.role from companies c join company_users cu on cu.company_id=c.id where cu.user_id='${uid}' and c.id<>'${ph}'`);
    r.notes.push(`DB (new company, placeholder ${ph} excluded): ${row}`);
    const cookieNow = (await ctx.cookies()).find(c => c.name === 'active_company_id')?.value;
    const newId = row.split(' | ')[0] ?? '';
    r.notes.push(`active_company_id cookie after: ${cookieNow} (points at new company: ${cookieNow === newId})`);
    const ok = row.includes(`| ${cfg.entityDb} |`) && row.includes('| owner') && cookieNow === newId;
    const docs = psql(`select string_agg(document_type, ',') from company_documents d join company_users cu on cu.company_id=d.company_id where cu.user_id='${uid}' and d.company_id<>'${ph}'`);
    r.notes.push(`DB docs: ${docs || '(none)'}`);
    await page.waitForTimeout(1500);
    if (n <= 3) await shot(page, r, `${slug}-landed`, [['desktop', 'dark']]);
    r.status = ok ? 'PASS' : 'FAIL';
  } catch (e) {
    r.notes.push(`ERROR: ${(e as Error).message.split('\n')[0]}`);
    await page.screenshot({ path: `${SCRATCH}/fail-${n}.png`, fullPage: true }).catch(() => undefined);
  }
  await ctx.close();
  return r;
}

async function main() {
  const browser = await chromium.launch();
  const T = 'thandi.synth@example.test';
  const TID = 'bbbbbbbb-0000-4000-8000-000000000002';
  const DEMO = '00000000-0000-0000-0000-000000000001';

  results.push(await runOnboarding(browser, 1, 'sole-prop', 1, { label: /Sole proprietor/, typeLabel: 'sole_proprietor', name: 'Synth Plumbing', people: ['Synth Owner'], peopleLabel: 'Owner', role: 'Owner', needsHint: /no document required|needs: |Owner/, entityDb: 'sole_proprietor' }));
  results.push(await runOnboarding(browser, 2, 'partnership', 2, { label: /Partnership/, typeLabel: 'partnership', name: 'Synth Partners', people: ['Synth Partner One', 'Synth Partner Two'], peopleLabel: 'Partners', role: 'Partner', needsHint: /ID document of every partner/, entityDb: 'partnership' }));
  results.push(await runOnboarding(browser, 3, 'pty-ltd', 3, { label: /Private company/, typeLabel: 'pty_ltd', name: 'Synth Holdings (Pty) Ltd', reg: ['2020/123456/07', '2020/123456/07'], people: [], peopleLabel: 'Directors', role: 'Director', docLabel: 'CIPC Registration Certificate', docFile: 'cipc.pdf', blockFirst: true, needsHint: /CIPC registration certificate/, entityDb: 'pty_ltd' }));
  results.push(await runOnboarding(browser, 4, 'cc', 4, { label: /Close corporation/, typeLabel: 'cc', name: 'Synth Builders CC', reg: ['CK1998/012345/23', 'CK1998/012345/23'], people: [], peopleLabel: 'Members', role: 'Member', docLabel: 'CK1 / CK2 Founding Statement', docFile: 'ck1.pdf', needsHint: /CK1 or CK2/, entityDb: 'cc' }));
  results.push(await runOnboarding(browser, 5, 'trust', 5, { label: /^Trust/, typeLabel: 'trust', name: 'Synth Family Trust', reg: ['IT1234/2020', 'IT1234/2020'], people: [], peopleLabel: 'Trustees', role: 'Trustee', docLabel: "Master's Letters of Authority", docFile: 'loa.pdf', needsHint: /Letters of Authority/, entityDb: 'trust' }));

  // Admin
  // /admin/* on localhost redirects to NEXT_PUBLIC_ADMIN_URL/<path> (404 here): reach the admin host by name instead
  const abrowser = await chromium.launch({ args: ['--host-resolver-rules=MAP admin.isaflow.co.za 127.0.0.1:3200'] });
  const actx = await abrowser.newContext({ viewport: { width: 1440, height: 900 } });
  await actx.addCookies([{ name: 'sb-access-token', value: cookieFor('aaaaaaaa-0000-4000-8000-000000000001', 'synth.admin@example.test', 'aal2'), url: 'http://admin.isaflow.co.za' }]);
  await actx.addInitScript(() => localStorage.setItem('accounting-theme', 'dark'));
  const ap = await actx.newPage();
  const open = async () => {
    await ap.goto(`http://admin.isaflow.co.za/users/${TID}`);
    await ap.getByRole('button', { name: 'companies', exact: true }).click();
    await ap.getByText('Linked Companies').waitFor({ timeout: 30000 });
  };
  const rowOf = (name: string) => ap.locator('tr', { hasText: name });
  const roleDb = (cid: string) => psql(`select coalesce(string_agg(role,','),'(no row)') from company_users where user_id='${TID}' and company_id='${cid}'`);

  psql(`insert into company_users (company_id, user_id, role, is_default) values ('${DEMO}', '${TID}', 'bookkeeper', true) on conflict do nothing`);
  const r6: Result = { n: 6, name: 'Admin: change role bookkeeper -> accountant', status: 'FAIL', notes: [], shots: [] };
  attachLogs(ap, r6.notes);
  try {
    await open();
    r6.notes.push(`before: ${roleDb(DEMO)}`);
    await rowOf('ISAFlow Demo').getByLabel(/Role in/).selectOption('accountant');
    await rowOf('ISAFlow Demo').getByRole('button', { name: 'Save role' }).waitFor();
    r6.notes.push(`dirty state: Save role visible, DB still ${roleDb(DEMO)}`);
    await shot(ap, r6, 'admin-role-dirty', [['desktop', 'light'], ['desktop', 'dark']]);
    await rowOf('ISAFlow Demo').getByRole('button', { name: 'Save role' }).click();
    await ap.waitForTimeout(2000);
    const after = roleDb(DEMO);
    r6.notes.push(`after: ${after}`);
    await shot(ap, r6, 'admin-role-saved', [['desktop', 'light']]);
    r6.status = after === 'accountant' ? 'PASS' : 'FAIL';
  } catch (e) { r6.notes.push(`ERROR: ${(e as Error).message.split('\n')[0]}`); }
  results.push(r6);

  const r7: Result = { n: 7, name: 'Admin: remove ISAFlow Demo link', status: 'FAIL', notes: [], shots: [] };
  attachLogs(ap, r7.notes);
  try {
    await open();
    await rowOf('ISAFlow Demo').getByRole('button', { name: 'Remove' }).click();
    await ap.getByText('Remove this link?').waitFor();
    await ap.getByRole('button', { name: 'Cancel' }).waitFor();
    await shot(ap, r7, 'admin-remove-confirm', [['desktop', 'light'], ['desktop', 'dark']]);
    await ap.getByRole('button', { name: 'Confirm remove' }).click();
    await ap.waitForTimeout(2500);
    const after = roleDb(DEMO);
    r7.notes.push(`after: ${after}`);
    await shot(ap, r7, 'admin-remove-done', [['desktop', 'dark']]);
    r7.status = after === '(no row)' ? 'PASS' : 'FAIL';
  } catch (e) { r7.notes.push(`ERROR: ${(e as Error).message.split('\n')[0]}`); }
  results.push(r7);

  const r8: Result = { n: 8, name: 'Admin: remove last-owner link refused', status: 'FAIL', notes: [], shots: [] };
  attachLogs(ap, r8.notes);
  try {
    await open();
    await rowOf('Synth Solo Owner').getByRole('button', { name: 'Remove' }).click();
    await ap.getByRole('button', { name: 'Confirm remove' }).click();
    const msg = ap.getByText(/last owner/i).first();
    await msg.waitFor({ timeout: 10000 });
    r8.notes.push(`message: ${(await msg.textContent())?.trim()}`);
    const still = psql(`select count(*) from company_users where user_id='${TID}' and company_id='eeeeeeee-0000-4000-8000-000000000001'`);
    r8.notes.push(`DB link rows remaining: ${still}`);
    await shot(ap, r8, 'admin-last-owner-refused', [['desktop', 'light'], ['desktop', 'dark']]);
    r8.status = still === '1' ? 'PASS' : 'FAIL';
  } catch (e) { r8.notes.push(`ERROR: ${(e as Error).message.split('\n')[0]}`); await ap.screenshot({ path: `${SCRATCH}/fail-8.png`, fullPage: true }); }
  results.push(r8);

  await browser.close(); await abrowser.close();
  writeFileSync(`${SCRATCH}/results.json`, JSON.stringify(results, null, 2));
  for (const r of results) console.log(`${r.status} #${r.n} ${r.name}\n  ${r.notes.join('\n  ')}`);
  console.log(`${allShots.length} screenshots`);
  console.log('IDFIT\n' + idFit.join('\n'));
  console.log('OVERFLOW\n' + overflow.join('\n'));
  console.log('LOGO/CARDS ' + logoChecks.join('\n'));
}
main().catch(e => { console.error(e); process.exit(1); });
