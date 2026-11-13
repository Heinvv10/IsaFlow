/** Sage MCP tools against a stub client: argument checks, filters built, paging, balance maths. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callTool, TOOLS } from '../../../packages/sage-readonly-mcp/src/tools';
import { partyBalance } from '../../../packages/sage-readonly-mcp/src/partyBalance';
import { SageRequestError, type SageClient } from '../../../packages/sage-readonly-mcp/src/client';

type Row = Record<string, unknown>;
const stub = {
  list: vi.fn<(resource: string, opts?: { filter?: string; orderBy?: string; page?: number }) => Promise<{ totalResults: number; returnedResults: number; results: Row[] }>>(),
  get: vi.fn<(resource: string, id: string | number) => Promise<Row>>(),
  download: vi.fn<(id: string | number) => Promise<{ bytes: Buffer; contentType: string | null }>>(),
};
const client = stub as unknown as SageClient;
let downloadDir: string;

const page = (results: Row[], total = results.length) => ({ totalResults: total, returnedResults: results.length, results });
const data = (r: { content: Array<{ text: string }>; isError?: boolean }) => {
  expect(r.isError, r.content[0]!.text).toBeFalsy();
  return JSON.parse(r.content[0]!.text) as Record<string, any>;
};
const call = (name: string, args: Row) => callTool(name, args, { client, downloadDir });

beforeEach(() => {
  vi.resetAllMocks();
  downloadDir = join(mkdtempSync(join(tmpdir(), 'sage-tools-')), 'dl');
});

describe('tool surface', () => {
  it('exposes exactly the five read tools, each with a closed schema', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(
      ['sage_download_attachment', 'sage_get_document', 'sage_list', 'sage_party_balance', 'sage_pull_since'],
    );
    for (const t of TOOLS) {
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(JSON.stringify(t.inputSchema)).not.toMatch(/password|api_?key|token|company/i);
    }
  });

  it('turns a client refusal into a tool error, and an unknown tool into one too', async () => {
    stub.get.mockRejectedValue(new SageRequestError('Sage TaxInvoice 1: HTTP 404', 404));
    const r = await call('sage_get_document', { type: 'ti', id: 1 });
    expect(r).toEqual({ content: [{ type: 'text', text: 'Sage TaxInvoice 1: HTTP 404' }], isError: true });
    expect((await call('sage_delete', {})).isError).toBe(true);
  });
});

describe('sage_pull_since', () => {
  it('filters on Modified per kind, ordered, and pages until done', async () => {
    stub.list.mockImplementation(async (_r, o) => (o!.page === 0 ? page([{ ID: 1 }], 150) : page([{ ID: 2 }], 150)));
    const out = data(await call('sage_pull_since', { siv: '2026-11-01', max_pages: 5 }));
    expect(stub.list).toHaveBeenCalledWith('SupplierInvoice', { filter: "Modified ge datetime'2026-11-01T00:00:00'", orderBy: 'Modified,ID', page: 0 });
    expect(stub.list).toHaveBeenCalledTimes(2);
    expect(out.siv).toMatchObject({ resource: 'SupplierInvoice', total: 150, returned: 2, next_page: null });
  });

  it('stops at max_pages and says where to continue', async () => {
    stub.list.mockResolvedValue(page([{ ID: 1 }], 1000));
    const out = data(await call('sage_pull_since', { bank: '2026-11-01T08:30', page_start: { bank: 3 } }));
    expect(stub.list).toHaveBeenCalledWith('BankTransaction', expect.objectContaining({ filter: "Modified ge datetime'2026-11-01T08:30:00'", page: 3 }));
    expect(out.bank.next_page).toBe(4);
  });

  it('refuses a malformed date before any request', async () => {
    expect((await call('sage_pull_since', { ti: "2026-11-01' or 1 eq 1" })).isError).toBe(true);
    expect((await call('sage_pull_since', {})).isError).toBe(true);
    expect(stub.list).not.toHaveBeenCalled();
  });
});

describe('sage_get_document and sage_list', () => {
  it('maps short kinds to resources', async () => {
    stub.get.mockResolvedValue({ ID: 9 });
    expect(data(await call('sage_get_document', { type: 'cret', id: 9 })).resource).toBe('CustomerReturn');
    expect(stub.get).toHaveBeenCalledWith('CustomerReturn', 9);
    expect((await call('sage_get_document', { type: 'Journal', id: 9 })).isError).toBe(true);
  });

  it('lists one page with a next_page cursor', async () => {
    stub.list.mockResolvedValue(page([{ ID: 1 }], 250));
    const out = data(await call('sage_list', { service: 'Supplier', filter: "Name eq 'X'", page: 1 }));
    expect(stub.list).toHaveBeenCalledWith('Supplier', { filter: "Name eq 'X'", orderBy: undefined, page: 1 });
    expect(out).toMatchObject({ total: 250, next_page: 2 });
  });
});

describe('sage_download_attachment', () => {
  it('writes the bytes to the download dir (600) and returns path, size and sha256 only', async () => {
    stub.download.mockResolvedValue({ bytes: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' });
    const out = data(await call('sage_download_attachment', { id: 55, file_name: '../../etc/passwd' }));
    expect(out.path.startsWith(downloadDir)).toBe(true);
    expect(out.path).not.toContain('..');
    expect(readFileSync(out.path, 'utf8')).toBe('%PDF-1.4');
    expect(statSync(out.path).mode & 0o077).toBe(0);
    expect(out).toMatchObject({ bytes: 8, content_type: 'application/pdf', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
});

describe('sage_party_balance', () => {
  it('without as_at returns Sage\'s own Balance field', async () => {
    stub.get.mockResolvedValue({ ID: 5, Name: 'Build It', Balance: 1234.5 });
    const out = data(await partyBalance({ party: 'supplier', id: 5 }, client));
    expect(out).toEqual({ party: 'supplier', id: 5, name: 'Build It', balance: 1234.5, method: 'sage_balance_field' });
  });

  it('resolves an exact name, escaping quotes, and refuses an ambiguous one', async () => {
    stub.list.mockResolvedValueOnce(page([{ ID: 5, Name: "O'Neil", Balance: 1 }]));
    await partyBalance({ party: 'customer', name: "O'Neil" }, client);
    expect(stub.list).toHaveBeenCalledWith('Customer', { filter: "Name eq 'O''Neil'" });
    stub.list.mockResolvedValueOnce(page([{ ID: 5 }, { ID: 6 }]));
    expect((await partyBalance({ party: 'customer', name: 'Dup' }, client)).isError).toBe(true);
  });

  it('as_at computes invoices − returns − payments, lists adjustments uncounted, and compares to Sage today', async () => {
    stub.get.mockResolvedValue({ ID: 5, Name: 'Build It', Balance: 700 });
    const totals: Record<string, number[]> = {
      SupplierInvoice: [1000, 200], SupplierReturn: [100], SupplierPayment: [400], SupplierAdjustment: [50],
    };
    stub.list.mockImplementation(async (r) => page((totals[r] ?? []).map((t) => ({ Total: t, SupplierId: 5 }))));
    const out = data(await partyBalance({ party: 'supplier', id: 5, as_at: '2026-11-13' }, client, new Date('2026-11-13T10:00:00Z')));
    expect(stub.list).toHaveBeenCalledWith('SupplierInvoice', { filter: "SupplierId eq 5 and Date le datetime'2026-11-13T23:59:59'", page: 0 });
    expect(out.documents_balance).toBe(700);
    expect(out.incomplete).toBe(true);
    expect(out.balance).toBeUndefined();
    expect(out.components.find((c: Row) => c.resource === 'SupplierAdjustment')).toMatchObject({ total: 50, counted: false });
    expect(out).toMatchObject({ method: 'computed_from_documents', sage_balance_field: 700, difference: 0 });
  });

  it('as_at in the past does not compare against today\'s Balance', async () => {
    stub.get.mockResolvedValue({ ID: 5, Balance: 999 });
    stub.list.mockResolvedValue(page([]));
    const out = data(await partyBalance({ party: 'supplier', id: 5, as_at: '2026-01-31' }, client, new Date('2026-11-13T10:00:00Z')));
    expect(out.sage_balance_field).toBeUndefined();
    expect((await partyBalance({ party: 'supplier', id: 5, as_at: '31/01/2026' }, client)).isError).toBe(true);
  });
});

describe('review hardening (round 1)', () => {
  it('a missing or non-numeric Total is refused, never summed as 0', async () => {
    stub.get.mockResolvedValue({ ID: 5, Balance: 1 });
    stub.list.mockResolvedValue(page([{ ID: 9, SupplierId: 5 }]));
    const r = await call('sage_party_balance', { party: 'supplier', id: 5, as_at: '2026-01-31' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/no numeric Total/);
  });

  it('a row of another party (Sage ignored the filter) is refused', async () => {
    stub.get.mockResolvedValue({ ID: 5, Balance: 1 });
    stub.list.mockResolvedValue(page([{ ID: 9, SupplierId: 6, Total: 10 }]));
    const r = await call('sage_party_balance', { party: 'supplier', id: 5, as_at: '2026-01-31' });
    expect(r.content[0]!.text).toMatch(/another party/);
  });

  it('impossible dates are refused before any request', async () => {
    expect((await call('sage_pull_since', { siv: '2026-02-30' })).isError).toBe(true);
    expect((await call('sage_pull_since', { siv: '2026-11-01T25:00' })).isError).toBe(true);
    expect((await call('sage_party_balance', { party: 'supplier', id: 5, as_at: '2026-99-99' })).isError).toBe(true);
    expect(stub.list).not.toHaveBeenCalled();
  });

  it('an inherited property name is not a document type', async () => {
    for (const type of ['constructor', 'toString', '__proto__']) {
      expect((await call('sage_get_document', { type, id: 1 })).isError).toBe(true);
      expect((await call('sage_list', { service: type })).isError).toBe(true);
    }
    expect(stub.get).not.toHaveBeenCalled();
  });

  it('download replaces a planted symlink instead of writing through it', async () => {
    const { symlinkSync, lstatSync, writeFileSync: w, mkdirSync: mk, readFileSync: rd } = await import('node:fs');
    mk(downloadDir, { recursive: true });
    const victim = join(downloadDir, '..', 'victim.txt');
    w(victim, 'original');
    symlinkSync(victim, join(downloadDir, '55-attachment'));
    stub.download.mockResolvedValue({ bytes: Buffer.from('new'), contentType: null });
    const out = data(await call('sage_download_attachment', { id: 55 }));
    expect(lstatSync(out.path).isSymbolicLink()).toBe(false);
    expect(rd(victim, 'utf8')).toBe('original');
  });
});
