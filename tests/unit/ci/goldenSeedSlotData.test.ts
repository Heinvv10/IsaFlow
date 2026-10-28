// Slot seeding goes through the app's routes and creates only what a search does not find (idempotent per slot).
import { describe, expect, it } from 'vitest';
import { MIGRATION_SOURCE, SEED, seedSlot, type SeedApi } from '../../../scripts/ci/golden/seedSlotData';
import { assertLocalBaseUrl } from '../../../scripts/ci/golden/seedSlotClient';

/** An in-memory stand-in for the app: it stores what the seeder posts and answers the searches the seeder makes. */
function fakeApp() {
  const suppliers: Array<{ id: string; name: string }> = [];
  const invoices: Array<{ id: string; invoiceNumber: string; status: string; invoiceDate: string }> = [];
  const journals: Array<{ id: string; description: string; status: string; entryDate: string }> = [];
  const bank: Array<{ description: string }> = [];
  const posts: string[] = [];
  let session: unknown = null;
  const api: SeedApi = {
    get: async (path: string) => {
      if (path.startsWith('/api/accounting/suppliers-list')) return { suppliers };
      if (path.startsWith('/api/accounting/supplier-invoices')) return { invoices, total: invoices.length };
      if (path.startsWith('/api/accounting/journal-entries')) return { entries: journals.filter((j) => j.status === 'posted') };
      if (path.startsWith('/api/accounting/chart-of-accounts')) return [{ id: 'rev', isSystemAccount: true }];
      if (path.startsWith('/api/accounting/bank-accounts')) return [{ id: 'bank-gl' }];
      if (path.startsWith('/api/accounting/bank-transactions')) return { total: bank.length };
      if (path.startsWith('/api/accounting/migration/session')) return { session };
      throw new Error(`unexpected GET ${path}`);
    },
    post: async (path: string, body: any) => {
      posts.push(path);
      if (path === '/api/accounting/suppliers-list') { const s = { id: `s${suppliers.length + 1}`, name: body.name }; suppliers.push(s); return s; }
      if (path === '/api/accounting/supplier-invoices') {
        const r = { id: `i${invoices.length + 1}`, invoiceNumber: body.invoiceNumber, status: 'draft', invoiceDate: body.invoiceDate };
        invoices.push(r);
        return r;
      }
      if (path === '/api/accounting/supplier-invoices-action') { invoices.find((i) => i.id === body.invoiceId)!.status = 'approved'; return {}; }
      if (path === '/api/accounting/journal-entries') {
        const j = { id: `j${journals.length + 1}`, description: body.description, status: 'draft', entryDate: body.entryDate };
        journals.push(j);
        return j;
      }
      if (path === '/api/accounting/journal-entries-action') { journals.find((j) => j.id === body.id)!.status = 'posted'; return {}; }
      if (path === '/api/accounting/bank-transactions-bulk-commit') {
        for (const line of String(body.csvContent).split('\n').slice(1)) bank.push({ description: line.split(',')[1]! });
        return {};
      }
      if (path === '/api/accounting/migration/session') { session = { sourceSystem: body.sourceSystem }; return {}; }
      throw new Error(`unexpected POST ${path}`);
    },
  };
  return { api, suppliers, invoices, journals, bank, posts, session: () => session };
}

describe('seedSlot', () => {
  it('creates the volumes the specs need, approves every invoice and posts every journal', async () => {
    const app = fakeApp();
    const report = await seedSlot(app.api, () => 'import-id');
    expect(report).toEqual({
      suppliers: SEED.suppliers, invoicesCreated: SEED.invoices, invoicesApproved: SEED.invoices,
      journalsCreated: SEED.journals, bankRowsImported: SEED.bankRows, migrationSession: 'created',
    });
    expect(app.invoices.every((i) => i.status === 'approved')).toBe(true);
    expect(app.journals.every((j) => j.status === 'posted')).toBe(true);
    expect(app.bank).toHaveLength(SEED.bankRows);
    expect(app.session()).toEqual({ sourceSystem: MIGRATION_SOURCE });
  });

  it('writes only into periods that are open (2026-01 onward) and never in the future of a 2026-10 run', async () => {
    const app = fakeApp();
    await seedSlot(app.api, () => 'import-id');
    for (const d of [...app.invoices.map((i) => i.invoiceDate), ...app.journals.map((j) => j.entryDate)]) {
      expect(d >= '2026-01-01' && d <= '2026-10-31').toBe(true);
    }
    expect(app.invoices.map((i) => i.invoiceNumber)).toEqual(Array.from({ length: SEED.invoices }, (_, k) => `GSEED-AP-${k + 1}`));
  });

  it('a second run creates and posts nothing', async () => {
    const app = fakeApp();
    await seedSlot(app.api, () => 'import-id');
    const before = app.posts.length;
    const again = await seedSlot(app.api, () => 'import-id');
    expect(again).toEqual({ suppliers: SEED.suppliers, invoicesCreated: 0, invoicesApproved: 0, journalsCreated: 0, bankRowsImported: 0, migrationSession: 'kept' });
    expect(app.posts.length).toBe(before);
  });

  it('a run that stopped between create and approve only approves the stranded invoices', async () => {
    const app = fakeApp();
    await seedSlot(app.api, () => 'import-id');
    app.invoices[4]!.status = 'draft';
    app.invoices[9]!.status = 'pending_approval';
    const again = await seedSlot(app.api, () => 'import-id');
    expect(again.invoicesCreated).toBe(0);
    expect(again.invoicesApproved).toBe(2);
  });
});

describe('assertLocalBaseUrl', () => {
  it('accepts a local dev server only', () => {
    expect(() => assertLocalBaseUrl('http://localhost:3450')).not.toThrow();
    expect(() => assertLocalBaseUrl('http://127.0.0.1:3450')).not.toThrow();
  });

  it.each(['https://app.isaflow.co.za', 'https://dev.isaflow.co.za', 'http://100.96.203.105:3200', 'http://localhost.evil.test', 'nope'])('refuses %s', (url) => {
    expect(() => assertLocalBaseUrl(url)).toThrow();
  });
});
