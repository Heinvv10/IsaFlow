/**
 * Golden path (m): the CSV / Excel migration wizard (#771) — parse, validate,
 * take on an opening trial balance and an AR opening invoice, import a GL
 * journal, find "Import from Sage".
 *
 * Runs in its OWN company (_migrationSandbox.ts), never in Demo: a take-on
 * leaves a migration session and step flags no supported API removes. The
 * API and browser contexts are each switched to the sandbox and back in
 * `finally`; the spec then re-reads Demo and requires its migration session
 * and its ledger over the dates this spec posts on to be unchanged. A red on
 * that check alone means something else wrote to Demo in that window during
 * the run (a local golden run, a peer worktree, an MCP poster on isaflow_dev):
 * look for a concurrent writer before suspecting the wizard.
 * Re-runs are deterministic: the opening-balance step REPLACES the session's
 * previous trial balance (it reverses it first), and the AR take-on invoice
 * is cancelled and the imported journal reversed by the test (by `finally` if
 * an assertion stopped it first), so the sandbox's balances are the same
 * after every run. Against prod Demo the same holds: the only lasting
 * footprint is the one sandbox company, created on the first post-deploy run
 * and reused on every later one.
 *
 * Not covered: the GL import page's own file upload and client-side parsing
 * (gl-import.tsx). The GL rows go through the JSON APIs the page calls.
 */
import { test, expect } from '@playwright/test';
import ExcelJS from 'exceljs';
import { Api, gpRef } from './_api';
import { expectNoSeriousA11yViolations, openScreen } from './helpers/axe';
import { A11Y_INLINE_SCREENS } from './helpers/a11yScreens';
import {
  activeCompanyId, findLedgerRow, findOrCreateMigrationSandbox, switchApiCompany, switchBrowserCompany,
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
const GOLDEN_CUSTOMER = '0GP-Golden-Customer'; // Api.fixtureCustomer's name

test('migration wizard: CSV + xlsx parse, row errors, opening balances, AR take-on, GL import, Sage findability', async ({
  page, baseURL,
}) => {
  test.setTimeout(180_000);
  const api = await Api.login(baseURL!);
  const homeCompanyId = await activeCompanyId(api);
  let passed = false;
  let browserSwitched = false;
  let importedEntryId = '';
  let importReversed = false;
  let arInvoiceId = '';
  let arCancelled = false;
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
    // The .xlsx carries one balance as a NUMBER cell, as Excel saves a typed figure.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Accounts');
    [ACCOUNTS_HEADER, ...ACCOUNTS_ROWS].forEach((r) => ws.addRow(r[0] === '2130' ? [...r.slice(0, 3), -1234] : r));
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
      expect(byCode['2130'].openingBalance).toBeCloseTo(-1234, 2); // (1 234.00), or the number -1234
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
    await openScreen(page, A11Y_INLINE_SCREENS.migrationOpeningBalances);
    await expectNoSeriousA11yViolations(page);
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

    // The ledger holds exactly this trial balance (a re-run replaced the last one).
    const tb = await api.get<any>(`/api/accounting/reports-trial-balance?fiscal_period_id=${period.id}`);
    const tbRow = (code: string) => tb.rows.find((r: any) => r.accountCode === code);
    for (const [code, [dr, cr]] of Object.entries(TB_EXPECTED)) {
      expect(Number(tbRow(code)?.debitBalance ?? 0), `TB debit ${code}`).toBeCloseTo(dr, 2);
      expect(Number(tbRow(code)?.creditBalance ?? 0), `TB credit ${code}`).toBeCloseTo(cr, 2);
    }
    expect(tb.balanced).toBe(true);

    // ── 3. AR opening invoice: day-first date, and a take-on posts no VAT ──
    // Day and month both ≤ 12 and different: only a day-first read gives y-m-dd.
    const [y, m] = effectiveDate.split('-');
    const dd = m === '02' ? '03' : '02';
    const ambiguous = `${dd}/${m}/${y}`;
    const isoDay = `${y}-${m}-${dd}`;
    // The sandbox's own fixture customer; the trial balance above has no AR control row (R-020).
    const customerId = await api.fixtureCustomer();
    const arTakeOns = async () => (await api.get<{ invoices: any[] }>(
      '/api/accounting/customer-invoices-list?q=GP-MIG-AR&limit=100',
    )).invoices.filter((i) => i.status !== 'cancelled');
    for (const stale of await arTakeOns()) { // left by a run that died before its cancel
      await api.post('/api/accounting/customer-invoices-detail', { id: stale.id, action: 'cancel' });
    }
    const arNumber = gpRef('MIG-AR');
    const ar = await api.post<any>('/api/accounting/migration/ar-invoices', {
      sessionId,
      invoices: [{
        invoiceNumber: arNumber, customerName: GOLDEN_CUSTOMER, customerId,
        invoiceDate: ambiguous, dueDate: ambiguous, subtotal: 1000, taxAmount: 150, totalAmount: 1150,
      }],
    });
    expect(ar.imported, JSON.stringify(ar.errors)).toBe(1);
    arInvoiceId = (await arTakeOns()).find((i) => i.invoice_number === arNumber)?.id;
    expect(arInvoiceId, 'the take-on invoice must be listed').toBeTruthy();
    const arLine = await findLedgerRow(api, '1120', effectiveDate, period.endDate,
      (r) => r.description === `Take-on AR invoice ${arNumber}`);
    expect(arLine, 'the take-on journal must be on the 1120 ledger').toBeTruthy();
    expect(arLine.entryDate).toBe(isoDay);
    const arEntry = await api.get<any>(`/api/accounting/journal-entries-detail?id=${arLine.journalEntryId}`);
    // The whole 1150 against AR and opening-balance equity; no VAT or revenue leg.
    expect(arEntry.lines.map((l: any) => [l.accountCode, Number(l.debit), Number(l.credit)]).sort())
      .toEqual([['1120', 1150, 0], ['3300', 0, 1150]]);
    const tbAr = await api.get<any>(`/api/accounting/reports-trial-balance?fiscal_period_id=${period.id}`);
    for (const code of VAT_ACCOUNT_CODES) {
      const row = tbAr.rows.find((r: any) => r.accountCode === code);
      expect(Number(row?.debitBalance ?? 0) + Number(row?.creditBalance ?? 0), `no VAT on ${code}`).toBe(0);
    }
    const vat = await api.get<any>(`/api/accounting/sars/sars-vat201?from=${effectiveDate}&to=${period.endDate}`);
    expect(vat.field1_standardRatedSupplies).toBe(0);
    expect(vat.field5_outputVAT).toBe(0);
    expect(vat.field10_totalInputVAT).toBe(0);

    await api.post('/api/accounting/customer-invoices-detail', { id: arInvoiceId, action: 'cancel' });
    arCancelled = true;

    // ── 4. GL import: day-first dates; a month-first-only date is refused ──
    // Two expense accounts outside the trial balance above, so a journal a
    // crashed run failed to reverse cannot move the balances step 2 asserts.
    const ref = gpRef('MIG-GL');
    const glRows = [
      { date: ambiguous, accountCode: '5200', description: `${ref} dr`, reference: ref, debit: 100, credit: 0 },
      { date: ambiguous, accountCode: '5300', description: `${ref} cr`, reference: ref, debit: 0, credit: 100 },
    ];
    const monthFirst = { ...glRows[0]!, date: `${m}/31/${y}` }; // 31 is not a month: refused, never swapped
    const check = await api.post<any>('/api/accounting/gl-import-validate', { rows: [...glRows, monthFirst] });
    expect(check.validations.map((v: any) => v.valid)).toEqual([true, true, false]);
    expect(check.validations[2].errors.join(' ')).toMatch(/Invalid date/);

    const imported = await api.post<any>('/api/accounting/gl-import', { rows: glRows, postImmediately: true });
    expect(imported.entriesCreated).toBe(1);
    expect(imported.heldForApproval).toEqual([]);
    // The journal list hides auto_* sources; the account ledger shows them.
    const line = await findLedgerRow(api, '5200', effectiveDate, period.endDate, (r) => r.reference === ref);
    expect(line, 'the imported journal must be on the 5200 ledger').toBeTruthy();
    importedEntryId = line.journalEntryId;
    expect(line.entryDate).toBe(isoDay); // DD/MM read day first
    expect(line.source).toBe('auto_gl_import');
    expect(Number(line.debit)).toBe(100);
    const glEntry = await api.get<any>(`/api/accounting/journal-entries-detail?id=${importedEntryId}`);
    expect(glEntry.status).toBe('posted');

    await api.post('/api/accounting/journal-entries-action', { id: importedEntryId, action: 'reverse' });
    importReversed = true;
    expect((await api.get<any>(`/api/accounting/journal-entries-detail?id=${importedEntryId}`)).reversedAt).toBeTruthy();

    // ── 5. "Import from Sage" is findable and lands on the upload wizard ──
    const search = await api.get<any>('/api/accounting/global-search?q=import%20from%20sage');
    expect(search.results.find((r: any) => r.type === 'page')?.url).toBe('/accounting/migration');
    expect((await api.getRaw('/accounting/migration')).status).toBe(200);
    await openScreen(page, A11Y_INLINE_SCREENS.migrationLanding);
    await expectNoSeriousA11yViolations(page);
    const opener = page.locator('a#sage');
    await expect(opener).toContainText('Moving from Sage');
    await expect(opener).toHaveAttribute('href', '/accounting/migration/chart-of-accounts');
    passed = true;
  } finally {
    // Every cleanup step runs; after a failure their errors are attached, not
    // thrown, so the test's own error is the one reported.
    const cleanupErrors: string[] = [];
    const attempt = async (what: string, fn: () => Promise<unknown>): Promise<boolean> => {
      try { await fn(); return true; } catch (err) { cleanupErrors.push(`${what}: ${String(err)}`); return false; }
    };
    if (arInvoiceId && !arCancelled) {
      await attempt('cancel AR take-on invoice', () =>
        api.post('/api/accounting/customer-invoices-detail', { id: arInvoiceId, action: 'cancel' }));
    }
    if (importedEntryId && !importReversed) {
      await attempt('reverse GL import', () =>
        api.post('/api/accounting/journal-entries-action', { id: importedEntryId, action: 'reverse' }));
    }
    if (browserSwitched) {
      await attempt('switch browser back', () => switchBrowserCompany(page.context(), homeCompanyId));
    }
    const apiHome = await attempt('switch API back', () => switchApiCompany(api, homeCompanyId));
    if (apiHome && demoBefore !== null) {
      await attempt('re-read Demo', async () => {
        const after = await demoState();
        if (passed) expect(after, 'Demo migration session and ledger must be untouched').toEqual(demoBefore);
        else expect.soft(after, 'Demo migration session and ledger must be untouched').toEqual(demoBefore);
      });
    }
    await api.dispose();
    if (cleanupErrors.length > 0) {
      if (passed) throw new Error(cleanupErrors.join('\n'));
      for (const e of cleanupErrors) test.info().annotations.push({ type: 'cleanup-error', description: e });
    }
  }
});
