/**
 * Round 22: the unresolved-row notice offers "Eliminate this row" (not for a drafted one), advises by why the row is unresolved (no receiver
 * expense when the receiver cancelled / rejected), and the form it opens is dated on the row, always needs a reason and sends the row's id.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
useApiJsonOverMock();
import { apiFetch } from '@/lib/apiFetch';
import EliminationsPage from '@/../pages/accounting/group/eliminations';
import { MirroredDroppedNotice, parseDroppedMirrored } from '@/components/accounting/group/MirroredDroppedNotice';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const GROUP = '80000000-0000-4000-8000-000000000001';
const ROW = '90000000-0000-4000-8000-000000000001';
const row = (code: string, detail = 'why') => ({ transactionId: `t-${code}`, keyDate: '2026-12-30', description: `Sale ${code}`, amount: 1000, kind: 'unresolved' as const, detail, code });

describe('MirroredDroppedNotice: advice by reason, and the button', () => {
  it('a receiver that CANCELLED has no expense: the notice says so instead of promising the receiver\'s expense is in the figures', () => {
    render(<MirroredDroppedNotice rows={[row('cancelled')]} onEliminate={() => undefined} />);
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).toMatch(/carries no expense for this sale/);
    expect(text).toMatch(/the sender's revenue, and the receiver's expense only where the receiver booked one/);
    expect(text).not.toMatch(/still include that intercompany revenue and expense/);
  });

  it('rejected / dismissed / failed each say the receiver booked no expense; a drafted row says to post it and has no button', () => {
    const onEliminate = vi.fn();
    render(<MirroredDroppedNotice rows={[row('rejected'), row('dismissed'), row('failed'), row('drafted'), row('variance')]} onEliminate={onEliminate} />);
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text.match(/The receiver booked no expense for this sale/g)).toHaveLength(3);
    expect(text).toMatch(/A manual elimination of it is drafted: post it below/);
    const buttons = screen.getAllByRole('button', { name: 'Eliminate this row' });
    expect(buttons).toHaveLength(4);                                    // every row but the drafted one
    fireEvent.click(buttons[3]!);
    expect(onEliminate).toHaveBeenCalledWith(expect.objectContaining({ transactionId: 't-variance', code: 'variance' }));
  });

  it('a CREDIT NOTE (carried negative) is worded as one, never as a sale', () => {
    render(<MirroredDroppedNotice rows={[{ ...row('rejected'), amount: -400 }, row('failed')]} onEliminate={() => undefined} />);
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).toMatch(/The receiver booked no expense for this credit note: .* the sender can cancel the credit note \(an elimination you made of it by hand must then be reversed[^)]*\)\./);
    expect(text).toMatch(/The receiver booked no expense for this sale: .* the sender can cancel the sale \(an elimination you made of it by hand must then be reversed[^)]*\)\./);
    expect(text).toMatch(/2 mirrored documents have no elimination/);
  });

  it('no button without a handler; the code survives parsing', () => {
    render(<MirroredDroppedNotice rows={[row('variance')]} />);
    expect(screen.queryByRole('button', { name: 'Eliminate this row' })).toBeNull();
    expect(parseDroppedMirrored({ droppedMirrored: [row('rejected')] })[0]).toMatchObject({ code: 'rejected' });
  });
});

describe('the Eliminations page: Eliminate this row', () => {
  function serve(amount = 1000, items: unknown[] = []) {
    const posts: Array<Record<string, unknown>> = [];
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      const u = String(url);
      if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body)) as Record<string, unknown>); return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }); }
      const data = u.includes('action=accounts') ? { items: [{ id: 'a4000-id', accountCode: 'G4000' }, { id: 'a5000-id', accountCode: 'G5000' }] }
        : u.includes('company-groups') ? [{ id: GROUP, name: 'Group' }]
        : { items, droppedMirrored: [{ ...row('variance', 'cut-off: different financial years'), transactionId: ROW, amount }] };
      return new Response(JSON.stringify({ success: true, data }), { status: 200 });
    });
    return posts;
  }

  it('opens the form dated on the row, with a reason always required, and sends the row\'s id', async () => {
    const posts = serve();
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Eliminate this row' }));
    expect(screen.getByText(/Eliminating the mirrored sale of 2026-12-30/)).toBeTruthy();
    fireEvent.change(screen.getAllByPlaceholderText('e.g. 4000')[0]!, { target: { value: 'G4000' } });
    fireEvent.change(screen.getAllByPlaceholderText('e.g. 4000')[1]!, { target: { value: 'G5000' } });
    const amounts = screen.getAllByPlaceholderText('0.00');
    fireEvent.change(amounts[0]!, { target: { value: '1000' } });
    fireEvent.change(amounts[3]!, { target: { value: '1000' } });
    fireEvent.submit(screen.getByRole('button', { name: /Create Elimination/ }).closest('form')!);
    expect(await screen.findByText(/A manual elimination of a mirrored row needs a reason/)).toBeTruthy();    // (refused on the page, nothing posted)
    expect(posts).toHaveLength(0);
    fireEvent.change(document.getElementById('elimination-manual-reason')!, { target: { value: 'The receiver booked it in January' } });
    fireEvent.submit(screen.getByRole('button', { name: /Create Elimination/ }).closest('form')!);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ action: 'create-elimination', periodStart: '2026-12-30', periodEnd: '2026-12-30', sourceIntercompanyId: ROW,
      manualReason: 'The receiver booked it in January' });
  });

  it('a credit note row opens a form that says credit note, not sale', async () => {
    serve(-1000);
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Eliminate this row' }));
    expect(screen.getByText(/Eliminating the mirrored credit note of 2026-12-30/)).toBeTruthy();
    expect((screen.getByPlaceholderText('Describe the elimination adjustment...') as HTMLInputElement).value).toMatch(/^Manual elimination of mirrored credit note: /);
  });

  it('the plain "Manual Elimination" button after it carries no row', async () => {
    const posts = serve();
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Eliminate this row' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: /Manual Elimination/ }));
    expect(screen.queryByText(/Eliminating the mirrored sale/)).toBeNull();
    expect(posts).toHaveLength(0);
  });
});

describe('the Eliminations page: a draft can be discarded', () => {
  it('a draft has a Discard button that posts discard-elimination for it; a posted one has none', async () => {
    const posts: Array<Record<string, unknown>> = [];
    const adj = (id: string, status: string) => ({ id, adjustmentNumber: id, adjustmentType: 'interco_revenue', description: id, periodStart: '2026-12-30', periodEnd: '2026-12-30', status,
      lines: [{ debit: 5, credit: 0 }] });
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body)) as Record<string, unknown>); return new Response(JSON.stringify({ data: { discarded: true } }), { status: 200 }); }
      const data = String(url).includes('company-groups') ? [{ id: GROUP, name: 'Group' }] : { items: [adj('draft-1', 'draft'), adj('posted-1', 'posted')], droppedMirrored: [] };
      return new Response(JSON.stringify({ success: true, data }), { status: 200 });
    });
    render(<EliminationsPage />);
    const discard = await screen.findAllByRole('button', { name: /Discard/ });
    expect(discard).toHaveLength(1);
    fireEvent.click(discard[0]!);
    const dialog = await screen.findByRole('dialog');                                   // (it asks first: nothing is sent yet)
    expect(dialog.textContent).toMatch(/recorded against your name and cannot be undone/);
    expect(posts).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(posts).toEqual([]);
    fireEvent.click(screen.getAllByRole('button', { name: /Discard/ })[0]!);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(posts).toEqual([{ action: 'discard-elimination', adjustmentId: 'draft-1' }]));
  });
});
