/**
 * MCP practice tools — reads, setup writes, and the two billable ones.
 *
 * The load-bearing properties here are the ones an agent could otherwise abuse
 * or an implementation could quietly drop:
 *   - `origin` is forced to 'assisted' and never taken from args, so
 *     agent-booked hours stay distinguishable from typed ones.
 *   - both time tools are scoped to the token's own user, so an agent cannot
 *     read or submit a colleague's entries by default.
 *   - a dry run runs the real guards and returns `wroteNothing`, so it neither
 *     greenlights a call the live path would refuse nor burns the key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/practice/practiceClientService', () => ({
  listPracticeClients: vi.fn(),
}));
vi.mock('@/modules/accounting/services/practice/practiceJobCategoryService', () => ({
  listJobCategories: vi.fn(),
  listWorkItems: vi.fn(),
  createJobCategory: vi.fn(),
  createWorkItem: vi.fn(),
}));
vi.mock('@/modules/accounting/services/practice/practiceTimeEntryService', () => ({
  listPracticeEntries: vi.fn(),
  createPracticeEntry: vi.fn(),
  validateClientCategoryWorkItem: vi.fn(),
  getEntryStatusesByIds: vi.fn(),
}));
vi.mock('@/modules/accounting/services/practice/practiceTimeEntryWorkflow', () => ({
  submitPracticeEntries: vi.fn(),
}));
vi.mock('@/modules/accounting/services/practice/practiceStaffRateService', () => ({
  resolveRate: vi.fn(),
}));

import { listPracticeClients } from '@/modules/accounting/services/practice/practiceClientService';
import {
  listJobCategories,
  listWorkItems,
  createJobCategory,
  createWorkItem,
} from '@/modules/accounting/services/practice/practiceJobCategoryService';
import {
  listPracticeEntries,
  createPracticeEntry,
  validateClientCategoryWorkItem,
  getEntryStatusesByIds,
} from '@/modules/accounting/services/practice/practiceTimeEntryService';
import { submitPracticeEntries } from '@/modules/accounting/services/practice/practiceTimeEntryWorkflow';
import { resolveRate } from '@/modules/accounting/services/practice/practiceStaffRateService';
import {
  listPracticeClientsTool,
  listJobCategoriesTool,
  listWorkItemsTool,
  listTimeEntriesTool,
} from '@/lib/mcp/tools/practice';
import { createJobCategoryTool, createWorkItemTool } from '@/lib/mcp/tools/writePracticeSetup';
import { logTimeEntryTool, submitTimeEntriesTool } from '@/lib/mcp/tools/writePracticeTime';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import { savepointNameFor } from '@/lib/mcp/registry';
import { PAT_SCOPES } from '@/lib/auth/patScopes';
import { OAUTH_SCOPES } from '@/lib/auth/oauthScopes';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = '22222222-2222-2222-2222-222222222222';
const ME = '33333333-3333-3333-3333-333333333333';
const CAT = '44444444-4444-4444-4444-444444444444';
const ITEM = '55555555-5555-5555-5555-555555555555';
const CLIENT = '66666666-6666-6666-6666-666666666666';
const ENTRY = '77777777-7777-7777-7777-777777777777';
const KEY = { idempotency_key: 'k-1' };

const ctx: McpToolContext = {
  userId: ME, companyId: COMPANY,
  scopes: ['read:practice', 'write:practice'], tokenJti: 'j', oauthAppId: null,
};

function text(r: { content: Array<{ text: string }> }) { return r.content[0]!.text; }
function json(r: { content: Array<{ text: string }> }) { return JSON.parse(text(r)); }

const workItem = {
  id: ITEM, companyId: COMPANY, categoryId: CAT, name: 'VAT201 submission',
  sortOrder: 0, isActive: true, defaultBillable: true, defaultRateOverride: null,
  createdAt: 'now', updatedAt: 'now',
};

const entry = {
  id: ENTRY, companyId: COMPANY, userId: ME, entryDate: '2026-09-01', hours: 2,
  practiceClientId: CLIENT, jobCategoryId: CAT, workItemId: ITEM,
  taskDescription: 'VAT201', notes: null, billable: true, appliedRate: 850,
  lineTotal: 1700, origin: 'assisted' as const, status: 'draft' as const,
  approvedBy: null, approvedAt: null, billedAt: null, invoiceId: null, jobId: null,
  writeOffReason: null, writtenOffBy: null, writtenOffAt: null,
};

beforeEach(() => vi.clearAllMocks());

// ─────────────────────────────────────────────────────────── registration ──

describe('registration', () => {
  const names = [
    'list_practice_clients', 'list_job_categories', 'list_work_items', 'list_time_entries',
    'create_job_category', 'create_work_item', 'log_time_entry', 'submit_time_entries',
  ];

  it('every practice tool is registered and mirrored in the client list', () => {
    for (const n of names) {
      expect(MCP_TOOLS.map((t) => t.name)).toContain(n);
      expect(CLIENT_MCP_TOOL_NAMES).toContain(n);
    }
  });

  it('write tools survive savepoint-name truncation and stay distinct', () => {
    // `mcp_${name}` is capped at 31 chars; a collision would let one tool
    // release another's savepoint.
    const writes = ['create_job_category', 'create_work_item', 'log_time_entry', 'submit_time_entries'];
    const saved = writes.map(savepointNameFor);
    for (const s of saved) expect(s.length).toBeLessThanOrEqual(31);
    expect(new Set(saved).size).toBe(writes.length);
  });

  it('the practice scopes exist in both vocabularies', () => {
    for (const s of ['read:practice', 'write:practice'] as const) {
      expect(PAT_SCOPES).toContain(s);
      expect(OAUTH_SCOPES).toContain(s);
    }
  });

  it('no practice tool requires write:post — none of them posts a journal', () => {
    for (const t of MCP_TOOLS.filter((x) => x.name.includes('practice') || x.name.includes('time_entr') || x.name.includes('work_item') || x.name.includes('job_categor'))) {
      expect(t.requiresPost).toBeUndefined();
    }
  });
});

// ───────────────────────────────────────────────────────────────── reads ──

describe('list_work_items', () => {
  it('returns the items for a category', async () => {
    vi.mocked(listWorkItems).mockResolvedValue([workItem]);
    const r = await listWorkItemsTool.handler({ category_id: CAT }, ctx);
    expect(json(r).work_items[0]).toMatchObject({ id: ITEM, name: 'VAT201 submission', default_billable: true });
  });

  it('refuses a malformed category_id before it reaches a ::UUID cast', async () => {
    const r = await listWorkItemsTool.handler({ category_id: 'not-a-uuid' }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('invalid category_id');
    expect(listWorkItems).not.toHaveBeenCalled();
  });

  it('passes the authenticated company, never one from args', async () => {
    vi.mocked(listWorkItems).mockResolvedValue([]);
    await listWorkItemsTool.handler({ category_id: CAT }, ctx);
    expect(vi.mocked(listWorkItems).mock.calls[0]![0]).toBe(COMPANY);
  });
});

describe('list_time_entries', () => {
  it('defaults to the calling user only', async () => {
    vi.mocked(listPracticeEntries).mockResolvedValue({ entries: [entry], total: 1 });
    await listTimeEntriesTool.handler({}, ctx);
    expect(vi.mocked(listPracticeEntries).mock.calls[0]![1]).toMatchObject({ userId: ME });
  });

  it('widens to the whole company only when all_users is explicitly true', async () => {
    vi.mocked(listPracticeEntries).mockResolvedValue({ entries: [], total: 0 });
    await listTimeEntriesTool.handler({ all_users: true }, ctx);
    expect(vi.mocked(listPracticeEntries).mock.calls[0]![1]!.userId).toBeUndefined();
  });

  it('bounds the result — the service is otherwise unlimited', async () => {
    vi.mocked(listPracticeEntries).mockResolvedValue({ entries: [], total: 0 });
    await listTimeEntriesTool.handler({ limit: 9999 }, ctx);
    expect(vi.mocked(listPracticeEntries).mock.calls[0]![1]!.limit).toBe(200);
  });

  it('rejects an impossible calendar date rather than letting ::DATE abort the tx', async () => {
    const r = await listTimeEntriesTool.handler({ date_from: '2026-02-31' }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('invalid date_from');
    expect(listPracticeEntries).not.toHaveBeenCalled();
  });
});

describe('list_practice_clients', () => {
  it('maps the service payload', async () => {
    vi.mocked(listPracticeClients).mockResolvedValue({
      clients: [{ id: CLIENT, legalName: 'Acme', tradingName: null, status: 'active', billingModel: 'hourly' } as never],
      total: 1,
    });
    const r = await listPracticeClientsTool.handler({ status: 'active' }, ctx);
    expect(json(r)).toMatchObject({ total: 1, clients: [{ id: CLIENT, legal_name: 'Acme' }] });
  });
});

describe('list_job_categories', () => {
  it('excludes inactive by default', async () => {
    vi.mocked(listJobCategories).mockResolvedValue([]);
    await listJobCategoriesTool.handler({}, ctx);
    expect(vi.mocked(listJobCategories).mock.calls[0]![1]).toBe(false);
  });
});

// ────────────────────────────────────────────────────────── setup writes ──

describe('create_job_category', () => {
  it('refuses a duplicate name instead of splitting the practice\'s reporting', async () => {
    vi.mocked(listJobCategories).mockResolvedValue([
      { id: CAT, name: ' VAT ', isActive: true } as never,
    ]);
    const r = await createJobCategoryTool.handler({ name: 'vat', ...KEY }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('already exists');
    expect(createJobCategory).not.toHaveBeenCalled();
  });

  it('maps a unique-index violation back to the duplicate refusal', async () => {
    vi.mocked(listJobCategories).mockResolvedValue([]);
    vi.mocked(createJobCategory).mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
    const r = await createJobCategoryTool.handler({ name: 'VAT', ...KEY }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('already exists');
  });

  it('creates and points the agent at the required next step', async () => {
    vi.mocked(listJobCategories).mockResolvedValue([]);
    vi.mocked(createJobCategory).mockResolvedValue({
      id: CAT, name: 'VAT', reportingTag: null, isActive: true,
    } as never);
    const r = await createJobCategoryTool.handler({ name: 'VAT', ...KEY }, ctx);
    expect(json(r).id).toBe(CAT);
    expect(json(r).next_step).toContain('create_work_item');
  });
});

describe('create_work_item', () => {
  it('refuses a duplicate name within the category', async () => {
    vi.mocked(listJobCategories).mockResolvedValue([{ id: CAT, name: 'VAT' } as never]);
    vi.mocked(listWorkItems).mockResolvedValue([workItem]);
    const r = await createWorkItemTool.handler(
      { category_id: CAT, name: 'vat201 SUBMISSION', ...KEY }, ctx,
    );
    expect(r.isError).toBe(true);
    expect(createWorkItem).not.toHaveBeenCalled();
  });

  it('defaults default_billable to true when omitted', async () => {
    vi.mocked(listJobCategories).mockResolvedValue([{ id: CAT, name: 'VAT' } as never]);
    vi.mocked(listWorkItems).mockResolvedValue([]);
    vi.mocked(createWorkItem).mockResolvedValue(workItem as never);
    await createWorkItemTool.handler({ category_id: CAT, name: 'New', ...KEY }, ctx);
    expect(vi.mocked(createWorkItem).mock.calls[0]![2]).toMatchObject({ defaultBillable: true });
  });

  it('honours an explicit false', async () => {
    vi.mocked(listJobCategories).mockResolvedValue([{ id: CAT, name: 'VAT' } as never]);
    vi.mocked(listWorkItems).mockResolvedValue([]);
    vi.mocked(createWorkItem).mockResolvedValue(workItem as never);
    await createWorkItemTool.handler(
      { category_id: CAT, name: 'Admin', default_billable: false, ...KEY }, ctx,
    );
    expect(vi.mocked(createWorkItem).mock.calls[0]![2]).toMatchObject({ defaultBillable: false });
  });

  it('refuses another tenant\'s category with the shared NOT_FOUND, never a distinct message', async () => {
    // A "belongs to another company" reply would be an existence oracle: it
    // would confirm the id is real. It must read exactly like a genuine miss.
    vi.mocked(listJobCategories).mockResolvedValue([]);
    const r = await createWorkItemTool.handler({ category_id: CAT, name: 'X', ...KEY }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('Not found');
    expect(createWorkItem).not.toHaveBeenCalled();
  });

  it('keeps the shared wording when the service loses a race on the same check', async () => {
    vi.mocked(listJobCategories).mockResolvedValue([{ id: CAT, name: 'VAT' } as never]);
    vi.mocked(listWorkItems).mockResolvedValue([]);
    vi.mocked(createWorkItem).mockRejectedValue(new Error('job category not found'));
    const r = await createWorkItemTool.handler({ category_id: CAT, name: 'X', ...KEY }, ctx);
    expect(text(r)).toBe('Not found');
  });

  it('maps a unique-index violation back to the duplicate-name refusal', async () => {
    // Migration 527 is what actually stops the read-then-write race; the
    // pre-check only wins when it is not raced.
    vi.mocked(listJobCategories).mockResolvedValue([{ id: CAT, name: 'VAT' } as never]);
    vi.mocked(listWorkItems).mockResolvedValue([]);
    vi.mocked(createWorkItem).mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
    const r = await createWorkItemTool.handler({ category_id: CAT, name: 'X', ...KEY }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('already exists');
  });
});

// ─────────────────────────────────────────────────────────── time writes ──

describe('log_time_entry', () => {
  const base = {
    entry_date: '2026-09-01', hours: 2, practice_client_id: CLIENT,
    job_category_id: CAT, work_item_id: ITEM, task_description: 'VAT201', ...KEY,
  };

  it('books the entry to the token\'s user and forces origin=assisted', async () => {
    vi.mocked(createPracticeEntry).mockResolvedValue(entry);
    // An agent trying to pass itself off as a person must not succeed.
    await logTimeEntryTool.handler({ ...base, origin: 'manual' } as never, ctx);
    const [company, userId, input] = vi.mocked(createPracticeEntry).mock.calls[0]!;
    expect(company).toBe(COMPANY);
    expect(userId).toBe(ME);
    expect(input.origin).toBe('assisted');
  });

  it('never accepts a rate from the agent', () => {
    const props = logTimeEntryTool.inputSchema.properties as Record<string, unknown>;
    expect(props.applied_rate).toBeUndefined();
    expect(props.rate).toBeUndefined();
    expect(props.line_total).toBeUndefined();
  });

  it.each([
    ['zero', 0], ['negative', -1], ['over a day', 24.5], ['not a number', 'x'],
  ])('refuses hours that are %s', async (_label, hours) => {
    const r = await logTimeEntryTool.handler({ ...base, hours } as never, ctx);
    expect(r.isError).toBe(true);
    expect(createPracticeEntry).not.toHaveBeenCalled();
  });

  it('refuses a future date', async () => {
    const future = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const r = await logTimeEntryTool.handler({ ...base, entry_date: future }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('future');
    expect(createPracticeEntry).not.toHaveBeenCalled();
  });

  it('refuses hours that round to zero in the NUMERIC(6,2) column', async () => {
    // 0.004 is > 0 in JS but stores as 0.00. Before the fix the entry was
    // written with zero hours and a real line_total — invisible on a timesheet,
    // billable on an invoice.
    const r = await logTimeEntryTool.handler({ ...base, hours: 0.004 }, ctx);
    expect(r.isError).toBe(true);
    expect(createPracticeEntry).not.toHaveBeenCalled();
  });

  it('refuses a backdated entry beyond the window, and names the way through', async () => {
    const old = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10);
    const r = await logTimeEntryTool.handler({ ...base, entry_date: old }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('allow_backdating');
    expect(createPracticeEntry).not.toHaveBeenCalled();
  });

  it('allows the same backdated entry once the caller says it means it', async () => {
    const old = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10);
    vi.mocked(createPracticeEntry).mockResolvedValue(entry);
    const r = await logTimeEntryTool.handler(
      { ...base, entry_date: old, allow_backdating: true }, ctx,
    );
    expect(r.isError).toBeUndefined();
    expect(createPracticeEntry).toHaveBeenCalled();
  });

  it('applies the backdate guard to dry_run too, so a dry run cannot greenlight it', async () => {
    const old = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10);
    vi.mocked(validateClientCategoryWorkItem).mockResolvedValue(undefined);
    const r = await logTimeEntryTool.handler({ ...base, entry_date: old, dry_run: true }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('allow_backdating');
  });

  it('accepts an entry just inside the window without the flag', async () => {
    const recent = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    vi.mocked(createPracticeEntry).mockResolvedValue(entry);
    const r = await logTimeEntryTool.handler({ ...base, entry_date: recent }, ctx);
    expect(r.isError).toBeUndefined();
  });

  it('refuses an over-long task_description before the 500-char column', async () => {
    const r = await logTimeEntryTool.handler({ ...base, task_description: 'x'.repeat(501) }, ctx);
    expect(r.isError).toBe(true);
    expect(createPracticeEntry).not.toHaveBeenCalled();
  });

  it('dry_run runs the real taxonomy guard, writes nothing, and frees the key', async () => {
    vi.mocked(validateClientCategoryWorkItem).mockResolvedValue(undefined);
    vi.mocked(resolveRate).mockResolvedValue(850);

    const r = await logTimeEntryTool.handler({ ...base, dry_run: true }, ctx);

    expect(validateClientCategoryWorkItem).toHaveBeenCalledWith(COMPANY, CLIENT, CAT, ITEM);
    expect(createPracticeEntry).not.toHaveBeenCalled();
    expect(r.wroteNothing).toBe(true);
    expect(json(r).would_create).toMatchObject({ applied_rate: 850, line_total: 1700 });
  });

  it('dry_run fails the same way the live path would, rather than greenlighting it', async () => {
    vi.mocked(validateClientCategoryWorkItem).mockRejectedValue(
      new Error('work item not found, not active, or does not belong to selected category'),
    );
    const r = await logTimeEntryTool.handler({ ...base, dry_run: true }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('work item');
  });

  it('reports a missing rate rather than inventing one', async () => {
    vi.mocked(validateClientCategoryWorkItem).mockResolvedValue(undefined);
    vi.mocked(resolveRate).mockResolvedValue(null);
    const r = await logTimeEntryTool.handler({ ...base, dry_run: true }, ctx);
    expect(json(r).would_create.applied_rate).toBeNull();
    expect(json(r).would_create.line_total).toBeNull();
  });
});

describe('submit_time_entries', () => {
  it('scopes both the lookup and the write to the calling user', async () => {
    vi.mocked(getEntryStatusesByIds).mockResolvedValue(new Map([[ENTRY, 'draft']]));
    vi.mocked(submitPracticeEntries).mockResolvedValue(1);

    await submitTimeEntriesTool.handler({ entry_ids: [ENTRY], ...KEY }, ctx);

    // Looked up BY ID — not by pulling the user's whole timesheet.
    expect(vi.mocked(getEntryStatusesByIds).mock.calls[0]!).toEqual([COMPANY, [ENTRY], ME]);
    expect(listPracticeEntries).not.toHaveBeenCalled();

    // Third argument is the user scope — without it an agent could push a
    // colleague's drafts into the approval flow.
    expect(vi.mocked(submitPracticeEntries).mock.calls[0]!).toEqual([COMPANY, [ENTRY], ME]);
  });

  it('skips ids that are not the user\'s own draft, and names why', async () => {
    const other = '88888888-8888-8888-8888-888888888888';
    vi.mocked(getEntryStatusesByIds).mockResolvedValue(new Map([[ENTRY, 'approved']]));
    const r = await submitTimeEntriesTool.handler({ entry_ids: [ENTRY, other], ...KEY }, ctx);

    expect(r.isError).toBe(true);
    expect(text(r)).toContain("status is 'approved'");
    expect(text(r)).toContain('not found');
    expect(text(r)).toContain(other);
    expect(submitPracticeEntries).not.toHaveBeenCalled();
  });

  it('refuses a malformed id, naming its position', async () => {
    const r = await submitTimeEntriesTool.handler({ entry_ids: [ENTRY, 'junk'], ...KEY }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('entry_ids[1]');
    expect(getEntryStatusesByIds).not.toHaveBeenCalled();
  });

  it('refuses an empty list and an over-long one', async () => {
    expect((await submitTimeEntriesTool.handler({ entry_ids: [], ...KEY }, ctx)).isError).toBe(true);
    const many = Array.from({ length: 201 }, () => ENTRY);
    expect((await submitTimeEntriesTool.handler({ entry_ids: many, ...KEY }, ctx)).isError).toBe(true);
  });

  it('dry_run reports the split without writing, and frees the key', async () => {
    vi.mocked(getEntryStatusesByIds).mockResolvedValue(new Map([[ENTRY, 'draft']]));
    const r = await submitTimeEntriesTool.handler({ entry_ids: [ENTRY], dry_run: true, ...KEY }, ctx);
    expect(r.wroteNothing).toBe(true);
    expect(json(r).would_submit).toEqual([ENTRY]);
    expect(submitPracticeEntries).not.toHaveBeenCalled();
  });

  it('deduplicates repeated ids so one entry cannot be counted twice', async () => {
    vi.mocked(getEntryStatusesByIds).mockResolvedValue(new Map([[ENTRY, 'draft']]));
    vi.mocked(submitPracticeEntries).mockResolvedValue(1);
    await submitTimeEntriesTool.handler({ entry_ids: [ENTRY, ENTRY, ENTRY], ...KEY }, ctx);
    expect(vi.mocked(submitPracticeEntries).mock.calls[0]![1]).toEqual([ENTRY]);
  });
});
