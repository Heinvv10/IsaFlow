/**
 * Golden path (m): the CSV / Excel migration wizard (#771) — parse, validate,
 * take on an opening trial balance, import a GL journal, find "Import from Sage".
 *
 * Runs in its OWN company (_migrationSandbox.ts), never in Demo: a take-on
 * leaves a migration session and step flags no supported API removes. The
 * API and browser contexts are each switched to the sandbox and back in
 * `finally`; the spec then re-reads Demo and requires its migration session
 * and its ledger over the dates this spec posts on to be unchanged.
 * Re-runs are deterministic: the opening-balance step REPLACES the session's
 * previous trial balance (it reverses it first), and the imported journal is
 * reversed by the test (by `finally` if an assertion stopped it first), so
 * the sandbox's balances are the same after every run. Against prod Demo the
 * same holds: the only lasting footprint is the one sandbox company, created
 * on the first post-deploy run and reused on every later one.
 */
import { test, expect } from '@playwright/test';
import ExcelJS from 'exceljs';
import { Api, gpRef } from './_api';
import {
  activeCompanyId, findOrCreateMigrationSandbox, switchApiCompany, switchBrowserCompany,
} from './_migrationSandbox';

/** Pastel accounts export: upper-case / padded headers, SA amount formats, one unreadable balance. */
const ACCOUNTS_HEADER = ['ACCNUMBER', ' Description ', 'AccType', 'Closing Balance'];
const ACCOUNTS_ROWS = [
  ['1110', 'Bank', 'Bank', '1 234,56'],
  ['1210', 'Equipment', 'Fixed Assets', 'R1,234.00'],
  ['2130', 'Loan', 'Current Liabilities', '(1 234.00)'],
  ['3100', 'Share Capital', "Owners' Equity", '500.00 Cr'],
  ['5200', 'Rent', 'Expenses', 'abc'],
];
const csvOf = (rows: string[][]) => rows.map((r) => r.map((c) => `"${c}"`).join(',')).join('\r\n') + '\r\n';

/** Opening trial balance as Sage exports it: a `#` note line, loose headers, SA formats, Cr marker. */
const TB_HEADER = '# Trial balance exported from Sage Business Cloud\r\n Account Code ,account name,DEBIT,credit\r\n';
const TB_GOOD = [
  '1110,Bank,"1 234,56",',
  '1210,Equipment,"R1,234.00",',
  '2130,Loan,,500.00 Cr',
  '3100,Share Capital,"(1 968.56)",',
];
/** Expected closing balances after the take-on: [debit, credit]. */
const TB_EXPECTED: Record<string, [number, number]> = {
  '1110': [1234.56, 0], '1210': [1234, 0], '2130': [0, 500], '3100': [0, 1968.56],
};
const VAT_ACCOUNT_CODES = ['1140', '1145', '2120'];

test('migration wizard: CSV + xlsx parse, row errors, opening balances, GL import, Sage findability', async ({
  page, baseURL,
}) => {
  test.setTimeout(180_000);
  const api = await Api.login(baseURL!);
  const homeCompanyId = await activeCompanyId(api);
  let browserSwitched = false;
  let importedEntryId = '';
  let importReversed = false;
  // Demo, read before and after: its migration session and every ledger
  // movement in the date range all of this spec's postings are dated in.
  let demoState: () => Promise<unknown> = async () => null;
  let demoBefore: unknown = null;
  try {
    const sandboxId = await findOrCreateMigrationSandbox(api);
    expect(sandboxId).not.toBe(homeCompanyId);
    await switchApiCompany(api, sandboxId);

    // The sandbox's first open period, fixed for its lifetime: re-runs post on the same dates.
    const periods = await api.get<any[]>('/api/accounting/fiscal-periods');
    const period = periods.filter((p) => p.status === 'open').sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
    expect(period, 'sandbox must have an open fiscal period').toBeTruthy();
    const effectiveDate: string = period.startDate;

    await switchApiCompany(api, homeCompanyId);
    demoState = async () => ({
      session: (await api.get<any>('/api/accounting/migration/session')).session,
      ledger: (await api.get<any>(
        `/api/accounting/reports-general-ledger?period_start=${effectiveDate}&period_end=${period.endDate}`,
      )).accounts.map((a: any) => [a.accountCode, a.totalDebit, a.totalCredit, a.transactions.length]),
    });
    demoBefore = await demoState();
    await switchApiCompany(api, sandboxId);

    // ── 1. Upload/parse: CSV and a real .xlsx give the same accounts ───────
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Accounts');
    [ACCOUNTS_HEADER, ...ACCOUNTS_ROWS].forEach((r) => ws.addRow(r));
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    const parse = (name: string, mimeType: string, buffer: Buffer) =>
      api.postMultipart<{ parsed: any[]; count: number }>('/api/accounting/migration-parse', {
        source: 'pastel', fileType: 'accounts', file: { name, mimeType, buffer },
      });
    const fromCsv = await parse('accounts.csv', 'text/csv', Buffer.from(csvOf([ACCOUNTS_HEADER, ...ACCOUNTS_ROWS])));
    const fromXlsx = await parse('accounts.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsx);
    for (const parsed of [fromCsv, fromXlsx]) {
      expect(parsed.count).toBe(5);
      const byCode = Object.fromEntries(parsed.parsed.map((a) => [a.sourceCode, a]));
      expect(byCode['1110'].openingBalance).toBeCloseTo(1234.56, 2); // 1 234,56
      expect(byCode['1210'].openingBalance).toBeCloseTo(1234, 2); // R1,234.00
      expect(byCode['2130'].openingBalance).toBeCloseTo(-1234, 2); // (1 234.00)
      expect(byCode['3100'].openingBalance).toBeCloseTo(-500, 2); // 500.00 Cr
      expect(byCode['1110'].sourceName).toBe('Bank'); // padded header matched
      // Pastel category names translate to account types.
      expect([byCode['1210'].mappedType, byCode['2130'].mappedType, byCode['3100'].mappedType])
        .toEqual(['asset', 'liability', 'equity']);
      // An unreadable amount is a row error, never a silent 0.
      expect(byCode['5200'].parseError).toMatch(/"abc" is not a number/);
      for (const code of ['1110', '1210', '2130', '3100']) expect(byCode[code].parseError).toBeUndefined();
    }
    expect(fromXlsx.parsed).toEqual(fromCsv.parsed);

    // ── 2. Opening balances through the wizard page ───────────────────────
    const current = await api.get<any>('/api/accounting/migration/session');
    const sessionId: string = current.session?.id
      ?? (await api.post<any>('/api/accounting/migration/session', { sourceSystem: 'sage_cloud' })).session.id;

    await switchBrowserCompany(page.context(), sandboxId);
    browserSwitched = true;
    await page.goto('/accounting/migration/opening-balances');
    const fileInput = page.locator('input[type="file"]');
    const upload = (body: string) =>
      fileInput.setInputFiles({ name: 'trial-balance.csv', mimeType: 'text/csv', buffer: Buffer.from(body) });

    // A file with an unreadable amount: that row is reported, the import stays off.
    await upload(TB_HEADER + [...TB_GOOD, '5200,Rent,abc,'].join('\r\n'));
    const problems = page.getByRole('alert').filter({ hasText: 'could not be read' });
    await expect(problems).toContainText('1 row(s) could not be read');
    await expect(problems).toContainText('Row 5 (account 5200): debit "abc" is not a number');
    await expect(page.getByRole('button', { name: 'Set Opening Balances' })).toBeDisabled();

    // The clean file: `#` line ignored, headers matched loosely, balanced.
    await upload(TB_HEADER + TB_GOOD.join('\r\n'));
    await expect(problems).toHaveCount(0);
    await expect(page.getByText('Balanced', { exact: true })).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(4);
    await page.locator('input[type="date"]').fill(effectiveDate);
    await page.getByRole('button', { name: 'Set Opening Balances' }).click();
    const posted = page.getByText(/Opening balances posted: 4 account line\(s\)\. Journal entry [0-9a-f-]{36}/);
    await expect(posted).toBeVisible({ timeout: 30_000 });
    const obEntryId = /Journal entry ([0-9a-f-]{36})/.exec((await posted.textContent()) ?? '')![1]!;

    const ob = await api.get<any>(`/api/accounting/journal-entries-detail?id=${obEntryId}`);
    expect(ob.status).toBe('posted');
    expect(ob.source).toBe('auto_migration');
    expect(ob.lines).toHaveLength(4);
    const sum = (lines: any[], k: 'debit' | 'credit') => lines.reduce((t, l) => t + Number(l[k]), 0);
    expect(sum(ob.lines, 'debit')).toBeCloseTo(2468.56, 2);
    expect(sum(ob.lines, 'credit')).toBeCloseTo(2468.56, 2);
    const session = (await api.get<any>('/api/accounting/migration/session')).session;
    expect(session.id).toBe(sessionId);
    expect(session.openingBalancesSet).toBe(true);

    // The ledger holds exactly this trial balance (a re-run replaced the last one) and no VAT.
    const tb = await api.get<any>(`/api/accounting/reports-trial-balance?fiscal_period_id=${period.id}`);
    const tbRow = (code: string) => tb.rows.find((r: any) => r.accountCode === code);
    for (const [code, [dr, cr]] of Object.entries(TB_EXPECTED)) {
      expect(Number(tbRow(code)?.debitBalance ?? 0), `TB debit ${code}`).toBeCloseTo(dr, 2);
      expect(Number(tbRow(code)?.creditBalance ?? 0), `TB credit ${code}`).toBeCloseTo(cr, 2);
    }
    expect(tb.balanced).toBe(true);
    for (const code of VAT_ACCOUNT_CODES) {
      expect(Number(tbRow(code)?.debitBalance ?? 0) + Number(tbRow(code)?.creditBalance ?? 0), `no VAT on ${code}`).toBe(0);
    }
    const vat = await api.get<any>(`/api/accounting/sars/sars-vat201?from=${effectiveDate}&to=${period.endDate}`);
    expect(vat.field5_outputVAT).toBe(0);
    expect(vat.field10_totalInputVAT).toBe(0);

    // ── 3. GL import: day-first dates; a month-first-only date is refused ──
    // Two expense accounts outside the trial balance above, so a journal a
    // crashed run failed to reverse cannot move the balances step 2 asserts.
    const [y, m] = effectiveDate.split('-');
    const ref = gpRef('MIG-GL');
    const glRows = [
      { date: `15/${m}/${y}`, accountCode: '5200', description: `${ref} dr`, reference: ref, debit: 100, credit: 0 },
      { date: `15/${m}/${y}`, accountCode: '5300', description: `${ref} cr`, reference: ref, debit: 0, credit: 100 },
    ];
    const monthFirst = { ...glRows[0]!, date: `${m}/31/${y}` }; // 31 is not a month: refused, never swapped
    const check = await api.post<any>('/api/accounting/gl-import-validate', { rows: [...glRows, monthFirst] });
    expect(check.validations.map((v: any) => v.valid)).toEqual([true, true, false]);
    expect(check.validations[2].errors.join(' ')).toMatch(/Invalid date/);

    const imported = await api.post<any>('/api/accounting/gl-import', { rows: glRows, postImmediately: true });
    expect(imported.entriesCreated).toBe(1);
    expect(imported.heldForApproval).toEqual([]);
    // The journal list hides auto_* sources; the account ledger shows them.
    const ledger = await api.get<any>(
      `/api/accounting/reports-account-ledger?account_code=5200&from=${effectiveDate}&to=${period.endDate}`,
    );
    const line = ledger.rows.find((r: any) => r.reference === ref);
    expect(line, 'the imported journal must be on the 5200 ledger').toBeTruthy();
    importedEntryId = line.journalEntryId;
    expect(line.entryDate).toBe(`${y}-${m}-15`); // 15/MM read day first
    expect(line.source).toBe('auto_gl_import');
    expect(Number(line.debit)).toBe(100);
    const glEntry = await api.get<any>(`/api/accounting/journal-entries-detail?id=${importedEntryId}`);
    expect(glEntry.status).toBe('posted');

    await api.post('/api/accounting/journal-entries-action', { id: importedEntryId, action: 'reverse' });
    importReversed = true;
    expect((await api.get<any>(`/api/accounting/journal-entries-detail?id=${importedEntryId}`)).reversedAt).toBeTruthy();

    // ── 4. "Import from Sage" is findable and lands on the upload wizard ──
    const search = await api.get<any>('/api/accounting/global-search?q=import%20from%20sage');
    expect(search.results.find((r: any) => r.type === 'page')?.url).toBe('/accounting/migration');
    expect((await api.getRaw('/accounting/migration')).status).toBe(200);
    await page.goto('/accounting/migration');
    const opener = page.locator('a#sage');
    await expect(opener).toContainText('Moving from Sage');
    await expect(opener).toHaveAttribute('href', '/accounting/migration/chart-of-accounts');
  } finally {
    try {
      // An assertion between import and reversal must not strand the journal.
      if (importedEntryId && !importReversed) {
        await api.post('/api/accounting/journal-entries-action', { id: importedEntryId, action: 'reverse' });
      }
      if (browserSwitched) await switchBrowserCompany(page.context(), homeCompanyId);
    } finally {
      await switchApiCompany(api, homeCompanyId);
      if (demoBefore !== null) {
        expect(await demoState(), 'Demo migration session and ledger must be untouched').toEqual(demoBefore);
      }
      await api.dispose();
    }
  }
});
