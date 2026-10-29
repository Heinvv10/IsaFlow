// Slot seeding goes through the app's routes and creates only what a search does not find (idempotent per slot).
import { describe, expect, it } from 'vitest';
import { MIGRATION_SOURCE, SEED, seedMonths, seedSlot, type SeedApi } from '../../../scripts/ci/golden/seedSlotData';
import { assertLocalBaseUrl, seedThroughContext, type SeedContext } from '../../../scripts/ci/golden/seedSlotClient';

/** An in-memory stand-in for the app: it stores what the seeder posts and answers the searches the seeder makes. */
function fakeApp() {
  const suppliers: Array<{ id: string; name: string }> = [];
  const invoices: Array<{ id: string; invoiceNumber: string; status: string; invoiceDate: string }> = [];
  const journals: Array<{ id: string; description: string; status: string; entryDate: string }> = [];
  const bank: Array<{ description: string }> = [];
  const posts: string[] = [];
  const statements: Array<{ csvContent: string; statementDate: string }> = [];
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
        statements.push({ csvContent: body.csvContent, statementDate: body.statementDate });
        for (const line of String(body.csvContent).split('\n').slice(1)) bank.push({ description: line.split(',')[1]! });
        return {};
      }
      if (path === '/api/accounting/migration/session') { session = { sourceSystem: body.sourceSystem }; return {}; }
      throw new Error(`unexpected POST ${path}`);
    },
  };
  return { api, suppliers, invoices, journals, bank, posts, statements, session: () => session };
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

  it('writes only into the last 10 complete months, none before 2026-01 (closed periods) and none in the future', async () => {
    const app = fakeApp();
    const now = new Date('2026-10-29T10:00:00Z');
    await seedSlot(app.api, () => 'import-id', now);
    const dates = [...app.invoices.map((i) => i.invoiceDate), ...app.journals.map((j) => j.entryDate),
      ...app.statements.flatMap((st) => st.csvContent.split('\n').slice(1).map((l) => l.split(',')[0]!.replace(/\//g, '-')))];
    expect(dates).toHaveLength(SEED.invoices + SEED.journals + SEED.bankRows);
    for (const d of dates) expect(d >= '2026-01-01' && d <= '2026-09-30', d).toBe(true);
    expect(app.statements[0]!.statementDate).toBe('2026-10-29');
    expect(app.invoices.map((i) => i.invoiceNumber)).toEqual(Array.from({ length: SEED.invoices }, (_, k) => `GSEED-AP-${k + 1}`));
  });

  it('follows the run date: a run in March 2027 seeds 2026-05 to 2027-02, not the fixed 2026 months', async () => {
    const app = fakeApp();
    await seedSlot(app.api, () => 'import-id', new Date('2027-03-05T10:00:00Z'));
    const dates = [...app.invoices.map((i) => i.invoiceDate), ...app.journals.map((j) => j.entryDate)];
    for (const d of dates) expect(d >= '2026-05-01' && d <= '2027-02-28', d).toBe(true);
    expect(new Set(dates.map((d) => d.slice(0, 7))).size).toBe(10);
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

describe('seedSlot refuses a list response of a shape it does not know', () => {
  const paths = ['suppliers-list', 'supplier-invoices', 'journal-entries', 'chart-of-accounts', 'bank-accounts'];

  it.each(paths)('stops on an unreadable %s response instead of reading it as empty and creating again', async (path) => {
    const app = fakeApp();
    const api: SeedApi = {
      get: async (p: string) => (p.startsWith(`/api/accounting/${path}`) ? { renamed: [] } : app.api.get(p)),
      post: app.api.post,
    };
    await expect(seedSlot(api, () => 'import-id')).rejects.toThrow(/unexpected list response/);
    if (path === 'suppliers-list') expect(app.suppliers).toHaveLength(0);
  });

  it('still reads an empty list in a known shape as empty', async () => {
    const app = fakeApp();
    const report = await seedSlot(app.api, () => 'import-id');
    expect(report.suppliers).toBe(SEED.suppliers);
  });
});

describe('seedMonths', () => {
  it('is the last 10 complete months, floored at the first open period', () => {
    expect(seedMonths(new Date('2027-03-05T00:00:00Z'))).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02']);
    expect(seedMonths(new Date('2026-10-29T00:00:00Z'))).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
    expect(seedMonths(new Date('2026-02-01T00:00:00Z'))).toEqual(['2026-01']);
  });

  it('crosses a year end and refuses when no complete month is open yet', () => {
    expect(seedMonths(new Date('2028-01-01T00:00:00Z')).at(-1)).toBe('2027-12');
    expect(() => seedMonths(new Date('2026-01-31T00:00:00Z'))).toThrow(/first open period/);
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
