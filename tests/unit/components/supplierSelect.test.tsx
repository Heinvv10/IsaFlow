// PUR-01: suppliers-list answers 25 rows by default, so a picker fed by the bare
// call cannot reach supplier #26. SupplierSelect must search server-side and
// resolve a preselected id that is not in the first page.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { SupplierSelect } from '@/components/accounting/supplier-invoices/SupplierSelect';

const ALL = Array.from({ length: 58 }, (_, i) => ({ id: `id-${i + 1}`, name: `Supplier ${String(i + 1).padStart(2, '0')}` }));

/** Mirrors the route: name-ordered, ?limit default 25, ?q substring, ?id single row. */
function fakeRoute(url: string): Response {
  const u = new URL(url, 'http://x');
  const id = u.searchParams.get('id');
  if (id) {
    const s = ALL.find((r) => r.id === id);
    return new Response(JSON.stringify(s ? { success: true, data: s } : { success: false }), { status: s ? 200 : 404 });
  }
  const q = (u.searchParams.get('q') ?? '').toLowerCase();
  const limit = Number(u.searchParams.get('limit') ?? '25');
  const rows = ALL.filter((r) => r.name.toLowerCase().includes(q)).slice(0, limit);
  return new Response(JSON.stringify({ success: true, data: { suppliers: rows, total: rows.length } }), { status: 200 });
}

afterEach(() => { vi.mocked(apiFetch).mockReset(); });

function Harness({ initial = '', onPick }: { initial?: string; onPick?: (id: string) => void }) {
  const [id, setId] = useState(initial);
  return <SupplierSelect name="supplierId" value={id} onChange={(v) => { setId(v); onPick?.(v); }} />;
}

describe('SupplierSelect', () => {
  it('finds and selects supplier #26 (beyond the 25-row default page)', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => fakeRoute(String(url)));
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    await waitFor(() => screen.getByRole('button', { name: 'Supplier 25' }), { timeout: 2000 });
    expect(screen.queryByRole('button', { name: 'Supplier 26' })).toBeNull();

    fireEvent.change(input, { target: { value: 'Supplier 26' } });
    const option = await screen.findByRole('button', { name: 'Supplier 26' }, { timeout: 2000 });
    fireEvent.click(option);

    expect(onPick).toHaveBeenLastCalledWith('id-26');
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Supplier 26');
  });

  it('shows the name of a preselected supplier that is not in the first page', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => fakeRoute(String(url)));
    render(<Harness initial="id-40" />);
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Supplier 40'), { timeout: 2000 });
  });
});
