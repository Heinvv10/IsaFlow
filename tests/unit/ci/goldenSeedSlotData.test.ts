// Slot seeding goes through the app's routes and creates only what a search does not find (idempotent per slot).
import { describe, expect, it } from 'vitest';
import { MIGRATION_SOURCE, SEED, seedSlot, type SeedApi } from '../../../scripts/ci/golden/seedSlotData';
import { assertLocalBaseUrl, seedThroughContext, type SeedContext } from '../../../scripts/ci/golden/seedSlotClient';

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
      if (path.startsWith('/api/accounting/journal-entries')) {
        // As the route behaves: limit capped at 200, entry_date DESC, the status filter exact.
        const q = new URL(path, 'http://x').searchParams;
        const matching = journals.filter((j) => j.status === q.get('status')).sort((a, b) => b.entryDate.localeCompare(a.entryDate));
        const limit = Math.min(Number(q.get('limit') ?? 50), 200);
        const offset = Number(q.get('offset') ?? 0);
        return { entries: matching.slice(offset, offset + limit), total: matching.length };
      }
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
      journalsCreated: SEED.journals, journalsPosted: SEED.journals, bankRowsImported: SEED.bankRows, migrationSession: 'created',
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
    expect(again).toEqual({ suppliers: SEED.suppliers, invoicesCreated: 0, invoicesApproved: 0, journalsCreated: 0, journalsPosted: 0, bankRowsImported: 0, migrationSession: 'kept' });
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

describe('seedSlot journals: idempotent however many journals later runs add', () => {
  /** What golden runs add after the seed: journals dated after every GSEED one, so they sort in front of them. */
  const laterJournals = (app: ReturnType<typeof fakeApp>, count: number, status: string): void => {
    for (let k = 0; k < count; k++) app.journals.push({ id: `later-${status}-${k}`, description: `golden journal ${k}`, status, entryDate: '2026-10-28' });
  };

  it('finds its posted journals behind 450 newer ones and creates none again', async () => {
    const app = fakeApp();
    await seedSlot(app.api, () => 'import-id');
    laterJournals(app, 450, 'posted');
    const before = app.journals.length;
    const again = await seedSlot(app.api, () => 'import-id');
    expect(again.journalsCreated).toBe(0);
    expect(again.journalsPosted).toBe(0);
    expect(app.journals).toHaveLength(before);
  });

  it('posts a GSEED draft left by a failed post instead of creating another, even behind 450 newer drafts', async () => {
    const app = fakeApp();
    await seedSlot(app.api, () => 'import-id');
    app.journals.find((j) => j.description === 'GSEED-JNL-4')!.status = 'draft';
    laterJournals(app, 450, 'draft');
    laterJournals(app, 450, 'posted');
    const before = app.journals.length;
    const again = await seedSlot(app.api, () => 'import-id');
    expect(again.journalsCreated).toBe(0);
    expect(again.journalsPosted).toBe(1);
    expect(app.journals).toHaveLength(before);
    expect(app.journals.find((j) => j.description === 'GSEED-JNL-4')!.status).toBe('posted');
  });

  it('a post that fails leaves a draft the next run finishes, and never a second draft', async () => {
    const app = fakeApp();
    const failing: SeedApi = { get: app.api.get, post: async (path, body) => { if (path.endsWith('journal-entries-action')) throw new Error('post refused'); return app.api.post(path, body); } };
    await expect(seedSlot(failing, () => 'import-id')).rejects.toThrow('post refused');
    expect(app.journals).toHaveLength(1);
    await seedSlot(app.api, () => 'import-id');
    expect(app.journals.filter((j) => j.description === 'GSEED-JNL-1')).toHaveLength(1);
    expect(app.journals).toHaveLength(SEED.journals);
    expect(app.journals.every((j) => j.status === 'posted')).toBe(true);
  });
});

describe('assertLocalBaseUrl', () => {
  it.each(['http://localhost:3450', 'http://127.0.0.1:3450', 'http://localhost:3200', 'http://localhost:3239', 'http://localhost:3300', 'http://localhost:3799'])('accepts %s', (url) => {
    expect(() => assertLocalBaseUrl(url)).not.toThrow();
  });

  it.each(['https://app.isaflow.co.za', 'https://dev.isaflow.co.za', 'http://100.96.203.105:3200', 'http://localhost.evil.test', 'nope'])('refuses %s', (url) => {
    expect(() => assertLocalBaseUrl(url)).toThrow();
  });

  // Production's next-server runs on this box at :3101; any other port is not a dev server either.
  it.each(['http://localhost:3101', 'http://127.0.0.1:3101', 'http://localhost:3199', 'http://localhost:3240', 'http://localhost:3299', 'http://localhost:3800', 'http://localhost:80', 'http://localhost', 'http://localhost:7770'])('refuses the local port of %s', (url) => {
    expect(() => assertLocalBaseUrl(url)).toThrow(/port/);
  });
});

/** A fake request context that logs in and, when `scopedTo` differs from the slot's company, reports the wrong active company. */
function fakeContext(scopedTo: string, calls: string[]): SeedContext {
  const reply = (data: unknown, status = 200) => ({ status: () => status, text: async () => JSON.stringify({ data }), json: async () => ({ success: true, data }) });
  return {
    get: async (path: string) => { calls.push(`GET ${path}`); return reply(path.includes('user-companies') ? { activeCompanyId: scopedTo } : []); },
    post: async (path: string) => { calls.push(`POST ${path}`); return reply({}); },
    storageState: async () => ({ cookies: [{ name: 'isaflow_csrf', value: 'tok' }] }),
  };
}

describe('seedThroughContext', () => {
  const slot = { companyId: '601d0000-0000-4000-8000-000000000002', email: 'golden-slot-2@isaflow.dev', password: 'pw' };

  it('writes nothing when the session is scoped to another company than the slot\'s', async () => {
    const calls: string[] = [];
    await expect(seedThroughContext(fakeContext('00000000-0000-0000-0000-000000000001', calls), slot)).rejects.toThrow(/not the slot company/);
    const writes = calls.filter((c) => c.startsWith('POST') && !c.includes('/api/auth/'));
    expect(writes).toEqual([]);
  });

  it('switches into the slot company before its first write', async () => {
    const calls: string[] = [];
    // Every list the seeder reads comes back empty, so it goes on to write; the point is the order.
    await seedThroughContext(fakeContext(slot.companyId, calls), slot).catch(() => undefined);
    const firstWrite = calls.findIndex((c) => c.startsWith('POST /api/accounting/'));
    expect(calls.indexOf('POST /api/auth/switch-company')).toBeGreaterThan(-1);
    expect(calls.indexOf('POST /api/auth/switch-company')).toBeLessThan(firstWrite);
  });
});
