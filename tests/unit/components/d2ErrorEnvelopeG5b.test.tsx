/**
 * D2 round (bank screens): the API error envelope is `{ success:false, error:{ code, message } }`; these call
 * sites read `json.message`, so the user saw only the generic fallback. Each test answers with the REAL
 * envelope carrying a unique message and asserts that exact text reaches the user (notify / error field).
 * A 200 carrying `success:false` (kept guard) must surface `error.message` too.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const { notify } = vi.hoisted(() => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/utils/toast', () => ({ notify }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { useBankRules, type BankRule } from '@/components/accounting/bank-rules/useBankRules';
import { buildBankTxActions } from '@/components/accounting/bank-transactions/useBankTxActions';
import { CreateRuleModal } from '@/components/accounting/CreateRuleModal';
import { BankTxAttachmentsModal } from '@/components/accounting/BankTxAttachmentsModal';
import type { BankTx } from '@/components/accounting/BankTxTable';

void mockedApiFetchModule;
useApiJsonOverMock();

const refuse = (status: number, message: string) =>
  new Response(JSON.stringify({ success: false, error: { code: 'X', message } }), { status });
const okBody = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
// Stable identity: the hook's preview effect depends on it (a fresh function per render loops forever).
const fetchPreview = async () => 0;
const methodOf = (init: unknown) => (init as RequestInit | undefined)?.method;

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); });

describe('useBankRules', () => {
  /** GET (load) succeeds; every POST to `failUrl` is refused with the envelope. */
  async function mount(failUrl: string, status: number, message: string) {
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (methodOf(init) === 'POST' && String(url).includes(failUrl)) return refuse(status, message);
      return okBody({ items: [] });
    });
    const hook = renderHook(() => useBankRules({ defaultBankId: 'bank-1', fetchPreview }));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    return hook;
  }
  const submitEvent = { preventDefault: () => undefined } as React.FormEvent<HTMLFormElement>;

  it('create rule: error field and toast carry the server message', async () => {
    const m = 'D2 server says no: rule pattern too broad 1101';
    const { result } = await mount('/bank-rules', 422, m);
    await act(async () => { await result.current.handleSubmit(submitEvent); });
    expect(result.current.error).toBe(m);
    expect(notify.error).toHaveBeenCalledWith(m);
  });

  it('update rule: error field and toast carry the server message', async () => {
    const m = 'D2 server says no: rule is locked by an apply run 1102';
    const { result } = await mount('/bank-rules-action', 409, m);
    act(() => { result.current.handleEdit({ id: 'r1', ruleName: 'R', matchField: 'description', matchType: 'contains', matchPattern: 'x', priority: 1 } as unknown as BankRule); });
    await act(async () => { await result.current.handleSubmit(submitEvent); });
    expect(result.current.error).toBe(m);
    expect(notify.error).toHaveBeenCalledWith(m);
  });

  it('doAction: error field and toast carry the server message', async () => {
    const m = 'D2 server says no: rule is in use 1103';
    const { result } = await mount('/bank-rules-action', 403, m);
    await act(async () => { await result.current.doAction('delete', 'r1'); });
    expect(result.current.error).toBe(m);
    expect(notify.error).toHaveBeenCalledWith(m);
  });

  it('bulk delete: error field and toast carry the server message', async () => {
    const m = 'D2 server says no: two of these rules are system rules 1104';
    const { result } = await mount('/bank-rules-action', 500, m);
    act(() => { result.current.setSelected(new Set(['r1', 'r2'])); });
    await act(async () => { await result.current.performBulkDelete(); });
    expect(result.current.error).toBe(m);
    expect(notify.error).toHaveBeenCalledWith(m);
  });
});

describe('buildBankTxActions', () => {
  const actions = () => buildBankTxActions({
    transactions: [], glAccounts: [], selectedBank: 'bank-1', selectedIds: new Set(), rowSelections: {},
    batchType: 'account', excludingTxId: null, createEntityTxId: null,
    setSmartRunning: vi.fn(), setRowSelections: vi.fn(), setTransactions: vi.fn(), setSelectedIds: vi.fn(),
    setShowBatchEdit: vi.fn(), setRulePrompt: vi.fn(), setExcludingTxId: vi.fn(),
    loadTransactions: vi.fn(), refreshBankAccounts: vi.fn(),
  });

  it('save note: a 4xx envelope reaches the toast', async () => {
    const m = 'D2 server says no: note exceeds the bank limit 2201';
    vi.mocked(apiFetch).mockImplementation(async () => refuse(400, m));
    await actions().handleUpdateNotes('tx-1', 'hello');
    expect(notify.error).toHaveBeenCalledWith(m);
  });

  it('save note: a 200 with success:false reaches the toast', async () => {
    const m = 'D2 server says no: note rejected on a 200 2202';
    vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ success: false, error: { message: m } }), { status: 200 }));
    await actions().handleUpdateNotes('tx-1', 'hello');
    expect(notify.error).toHaveBeenCalledWith(m);
  });

  it('download reconciliation report: a 4xx envelope reaches the toast', async () => {
    const m = 'D2 server says no: no reconciliation exists for this bank 2203';
    vi.mocked(apiFetch).mockImplementation(async () => refuse(404, m));
    await actions().handleDownloadReport('FNB');
    expect(notify.error).toHaveBeenCalledWith(m);
  });
});

describe('CreateRuleModal create', () => {
  const tx = { id: 'tx-1', description: 'ACME PAYMENT', amount: -115, transactionDate: '2026-06-30', status: 'imported' } as unknown as BankTx;
  const open = (res: () => Response) => {
    vi.mocked(apiFetch).mockImplementation(async () => res());
    render(
      <CreateRuleModal transaction={tx} bankAccountId="bank-1" glAccounts={[]} suppliers={[{ id: 'sup-1', name: 'ACME' }]}
        selection={{ type: 'supplier', entityId: 'sup-1', label: 'ACME' } as never} onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /create rule/i }));
  };

  it('a 4xx envelope reaches the toast', async () => {
    const m = 'D2 server says no: an identical rule exists 3301';
    open(() => refuse(409, m));
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(m));
  });

  it('a 200 with success:false reaches the toast', async () => {
    const m = 'D2 server says no: refused on a 200 3302';
    open(() => new Response(JSON.stringify({ success: false, error: { message: m } }), { status: 200 }));
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(m));
  });
});

describe('BankTxAttachmentsModal', () => {
  const att = { id: 'a1', bank_transaction_id: 'tx-1', file_url: 'https://x.invalid/f.pdf', file_name: 'slip.pdf', file_size: 10, uploaded_by: null, created_at: '2026-09-01T00:00:00Z' };
  const list = () => okBody([att]);
  const png = () => new File(['x'], 'photo.png', { type: 'image/png' });
  const openWith = async (onWrite: (method: string) => Response) => {
    vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
      const method = methodOf(init);
      return method === 'POST' || method === 'DELETE' ? onWrite(method) : list();
    });
    const { container } = render(<BankTxAttachmentsModal bankTransactionId="tx-1" onClose={vi.fn()} />);
    await screen.findByText('slip.pdf');
    return container;
  };
  const upload = (c: HTMLElement) => fireEvent.change(c.querySelector('input[type="file"]')!, { target: { files: [png()] } });
  const remove = () => fireEvent.click(screen.getByTitle('Remove'));
  const sf = (message: string) => new Response(JSON.stringify({ success: false, error: { message } }), { status: 200 });

  it('upload: a 4xx envelope reaches the toast', async () => {
    const m = 'D2 server says no: file failed the magic-byte check 4401';
    upload(await openWith(() => refuse(400, m)));
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(m));
  });

  it('upload: a 200 with success:false reaches the toast', async () => {
    const m = 'D2 server says no: upload refused on a 200 4402';
    upload(await openWith(() => sf(m)));
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(m));
  });

  it('delete: a 4xx envelope reaches the toast', async () => {
    const m = 'D2 server says no: attachment belongs to a posted entry 4403';
    await openWith(() => refuse(403, m));
    remove();
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(m));
  });

  it('delete: a 200 with success:false reaches the toast', async () => {
    const m = 'D2 server says no: delete refused on a 200 4404';
    await openWith(() => sf(m));
    remove();
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(m));
  });
});

describe('success paths (200 envelope { success:true, data })', () => {
  it('success: useBankRules renders the data it received and create completes', async () => {
    const rule = { id: 'r1', ruleName: 'Distinctive Rule 6620', matchField: 'description', matchType: 'contains', matchPattern: 'x', priority: 1 };
    vi.mocked(apiFetch).mockImplementation(async (_url, init) => okBody(methodOf(init) === 'POST' ? {} : { items: [rule] }));
    const hook = renderHook(() => useBankRules({ defaultBankId: 'bank-1', fetchPreview }));
    await waitFor(() => expect(hook.result.current.rules[0]?.ruleName).toBe('Distinctive Rule 6620'));
    await act(async () => { await hook.result.current.handleSubmit({ preventDefault: () => undefined } as React.FormEvent<HTMLFormElement>); });
    expect(notify.error).not.toHaveBeenCalled();
    expect(notify.success).toHaveBeenCalledWith(expect.stringContaining('created'));
  });

  it('success: buildBankTxActions save note completes', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => okBody({}));
    const loadTransactions = vi.fn();
    const a = buildBankTxActions({
      transactions: [], glAccounts: [], selectedBank: 'bank-1', selectedIds: new Set(), rowSelections: {},
      batchType: 'account', excludingTxId: null, createEntityTxId: null,
      setSmartRunning: vi.fn(), setRowSelections: vi.fn(), setTransactions: vi.fn(), setSelectedIds: vi.fn(),
      setShowBatchEdit: vi.fn(), setRulePrompt: vi.fn(), setExcludingTxId: vi.fn(),
      loadTransactions, refreshBankAccounts: vi.fn(),
    });
    await a.handleUpdateNotes('tx-1', 'hello');
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1);
    expect(notify.error).not.toHaveBeenCalled();
    expect(loadTransactions).not.toHaveBeenCalled();
  });

  it('success: CreateRuleModal create completes', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => okBody({ applied: 7 }));
    const onCreated = vi.fn();
    const tx = { id: 'tx-1', description: 'ACME PAYMENT', amount: -115, transactionDate: '2026-06-30', status: 'imported' } as unknown as BankTx;
    render(
      <CreateRuleModal transaction={tx} bankAccountId="bank-1" glAccounts={[]} suppliers={[{ id: 'sup-1', name: 'ACME' }]}
        selection={{ type: 'supplier', entityId: 'sup-1', label: 'ACME' } as never} onClose={vi.fn()} onCreated={onCreated} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /create rule/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(notify.success).toHaveBeenCalledWith(expect.stringContaining('7 transactions'));
  });

  it('success: BankTxAttachmentsModal renders the data it received and upload completes', async () => {
    const att = { id: 'a1', bank_transaction_id: 'tx-1', file_url: 'https://x.invalid/f.pdf', file_name: 'distinctive-slip-9931.pdf', file_size: 10, uploaded_by: null, created_at: '2026-09-01T00:00:00Z' };
    vi.mocked(apiFetch).mockImplementation(async (_url, init) => okBody(methodOf(init) === 'POST' ? {} : [att]));
    const { container } = render(<BankTxAttachmentsModal bankTransactionId="tx-1" onClose={vi.fn()} />);
    await screen.findByText('distinctive-slip-9931.pdf');
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['x'], 'photo.png', { type: 'image/png' })] } });
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('photo.png uploaded'));
  });
});
