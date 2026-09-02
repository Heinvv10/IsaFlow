/**
 * practiceApi — envelope handling for the practice reference-data fetchers.
 *
 * These tests feed the fetchers the EXACT body the handlers emit
 * (`apiResponse.success` → `{ success, data, meta }`). That is the whole point:
 * the shipped bug was a call site that guessed `{ workItems }` / a bare array,
 * silently produced `[]`, and left the required Work Item dropdown empty so
 * time entry could never be submitted. A test that mocks a convenient shape
 * would have passed against the broken code.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchWorkItems,
  fetchJobCategories,
  fetchActiveClients,
  fetchEntryTemplates,
  resolveStaffRate,
  createWorkItem,
  CLIENT_PICKER_LIMIT,
} from '@/components/practice/practiceApi';

/** Exactly what `apiResponse.success(res, data)` puts on the wire. */
function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, data, meta: { timestamp: 'x' } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorEnvelope(status: number, message: string): Response {
  return new Response(JSON.stringify({ success: false, error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const WORK_ITEM = {
  id: 'wi-1', companyId: 'c1', categoryId: 'cat-1', name: 'VAT201 submission',
  sortOrder: 0, isActive: true, defaultBillable: true, defaultRateOverride: null,
  createdAt: '2026-09-01', updatedAt: '2026-09-01',
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The URL the fetchers actually requested. */
function requestedUrl(call = 0): string {
  return String(fetchMock.mock.calls[call]?.[0]);
}

describe('fetchWorkItems', () => {
  it('unwraps the { success, data } envelope the handler really sends', async () => {
    fetchMock.mockResolvedValue(envelope([WORK_ITEM]));

    const items = await fetchWorkItems('cat-1');

    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe('VAT201 submission');
    expect(items[0]!.defaultBillable).toBe(true);
  });

  it('requests only active items by default, and inactive ones on demand', async () => {
    // A fresh Response per call: a body can only be read once.
    fetchMock.mockImplementation(() => Promise.resolve(envelope([])));

    await fetchWorkItems('cat-1');
    expect(requestedUrl()).toContain('includeInactive=false');

    await fetchWorkItems('cat-1', true);
    expect(requestedUrl(1)).toContain('includeInactive=true');
  });

  it('scopes the request to the requested category', async () => {
    fetchMock.mockResolvedValue(envelope([]));
    await fetchWorkItems('cat-1');
    expect(requestedUrl()).toContain('categoryId=cat-1');
  });

  it('THROWS instead of returning [] when the payload is not an array', async () => {
    // The regression guard. The old call site turned this into `[]`, which the
    // UI rendered as "this category has no work items" — indistinguishable from
    // a real empty category, and unfixable by the user.
    fetchMock.mockResolvedValue(envelope({ workItems: [WORK_ITEM] }));

    await expect(fetchWorkItems('cat-1')).rejects.toThrow(/expected an array/);
  });

  it('throws on a body with no data envelope at all', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([WORK_ITEM]), { status: 200 }),
    );
    await expect(fetchWorkItems('cat-1')).rejects.toThrow(/data.*envelope/);
  });

  it('propagates a server error rather than showing an empty list', async () => {
    fetchMock.mockResolvedValue(errorEnvelope(500, 'boom'));
    await expect(fetchWorkItems('cat-1')).rejects.toThrow('boom');
  });
});

describe('fetchJobCategories', () => {
  it('unwraps the envelope to a bare array', async () => {
    fetchMock.mockResolvedValue(envelope([{ id: 'cat-1', name: 'VAT' }]));
    const cats = await fetchJobCategories();
    expect(cats.map((c) => c.name)).toEqual(['VAT']);
  });
});

describe('fetchActiveClients', () => {
  it('reads the clients field out of the { clients, total } payload', async () => {
    fetchMock.mockResolvedValue(envelope({ clients: [{ id: 'p1', legalName: 'Acme' }], total: 1 }));
    const clients = await fetchActiveClients();
    expect(clients).toHaveLength(1);
    expect(clients[0]!.legalName).toBe('Acme');
  });

  it('asks for active clients past the service default LIMIT 50', async () => {
    fetchMock.mockResolvedValue(envelope({ clients: [], total: 0 }));
    await fetchActiveClients();
    expect(requestedUrl()).toContain('status=active');
    expect(requestedUrl()).toContain(`limit=${CLIENT_PICKER_LIMIT}`);
    expect(CLIENT_PICKER_LIMIT).toBeGreaterThan(50);
  });

  it('throws when the clients field is missing rather than yielding []', async () => {
    fetchMock.mockResolvedValue(envelope([{ id: 'p1' }]));
    await expect(fetchActiveClients()).rejects.toThrow(/no 'clients' field/);
  });

  it('throws when clients is present but not an array', async () => {
    fetchMock.mockResolvedValue(envelope({ clients: null, total: 0 }));
    await expect(fetchActiveClients()).rejects.toThrow(/not an array/);
  });
});

describe('fetchEntryTemplates', () => {
  it('reads templates out of the nested { templates } payload', async () => {
    fetchMock.mockResolvedValue(envelope({ templates: [{ id: 't1', name: 'Monthly VAT' }] }));
    const templates = await fetchEntryTemplates();
    expect(templates[0]!.name).toBe('Monthly VAT');
  });

  it('returns an array, never the wrapper object', async () => {
    // BulkRangeModal read `data` directly and got `{ templates: [...] }` — an
    // object. `templates.map(...)` then threw and took the modal down, so the
    // Fill Range button was dead. Assert the array-ness the callers rely on.
    fetchMock.mockResolvedValue(envelope({ templates: [{ id: 't1', name: 'A' }] }));
    const templates = await fetchEntryTemplates();
    expect(Array.isArray(templates)).toBe(true);
    expect(() => templates.map((t) => t.id)).not.toThrow();
  });

  it('throws when templates is present but not an array', async () => {
    fetchMock.mockResolvedValue(envelope({ templates: { t1: 'A' } }));
    await expect(fetchEntryTemplates()).rejects.toThrow(/not an array/);
  });
});

describe('resolveStaffRate', () => {
  it('reads the rate out of the nested { rate } payload', async () => {
    fetchMock.mockResolvedValue(envelope({ rate: 850 }));
    await expect(resolveStaffRate('u1', 'c1', '2026-09-02')).resolves.toBe(850);
  });

  it('maps the 404 "no rate configured" case to null, not an error', async () => {
    fetchMock.mockResolvedValue(errorEnvelope(404, 'No rate configured'));
    await expect(resolveStaffRate('u1', 'c1', '2026-09-02')).resolves.toBeNull();
  });

  it('still throws on a real failure', async () => {
    fetchMock.mockResolvedValue(errorEnvelope(500, 'db down'));
    await expect(resolveStaffRate('u1', 'c1', '2026-09-02')).rejects.toThrow('db down');
  });

  it('rejects a present-but-non-numeric rate instead of passing it off as a number', async () => {
    fetchMock.mockResolvedValue(envelope({ rate: null }));
    await expect(resolveStaffRate('u1', 'c1', '2026-09-02')).rejects.toThrow(/not a number/);
  });
});

describe('createWorkItem', () => {
  it('posts the category, name and billable flag', async () => {
    fetchMock.mockResolvedValue(envelope(WORK_ITEM, 201));

    await createWorkItem('cat-1', 'Payroll run', false);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('/api/accounting/practice/work-items');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      categoryId: 'cat-1', name: 'Payroll run', defaultBillable: false,
    });
  });

  it('surfaces the server message when the create is rejected', async () => {
    fetchMock.mockResolvedValue(errorEnvelope(400, 'job category not found'));
    await expect(createWorkItem('other-tenant-cat', 'X', true))
      .rejects.toThrow('job category not found');
  });
});
