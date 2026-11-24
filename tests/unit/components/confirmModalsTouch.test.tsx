// The accounting confirm modals with their own markup: BulkConfirmModal (fiscal periods), ConfirmSendModal (statements) and the year-end typed-confirmation field.
// Below lg their buttons and close X are 44px, the box is capped to the viewport as a flex column so the buttons stay reachable, and the button rows wrap.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ data: { yearLabel: '2026', netIncome: 1300, entryDate: '2026-02-28', entryNumber: 'YE-2026', retainedEarnings: { accountCode: '3100', accountName: 'Retained Earnings' } } }), { status: 200 })),
}));

import { BulkConfirmModal } from '../../../src/components/accounting/fiscal-periods/BulkConfirmModal';
import { ConfirmSendModal } from '../../../src/components/accounting/statements/ConfirmSendModal';
import { YearEndConfirmDialog } from '../../../src/components/accounting/yearEnd/YearEndConfirmDialog';

afterEach(cleanup);
const cls = (el: Element) => el.className.split(' ');
const MIN = 'max-lg:min-h-11';
const CAP = ['max-lg:flex', 'max-lg:flex-col', 'max-lg:max-h-[calc(100dvh-2rem)]'];
const SQUARE = [MIN, 'max-lg:min-w-11', 'max-lg:inline-flex', 'max-lg:items-center', 'max-lg:justify-center'];

describe('BulkConfirmModal on touch', () => {
  const open = (action: 'bulk_close' | 'bulk_lock' | 'bulk_reopen' = 'bulk_close') => render(<BulkConfirmModal action={action} count={3} busy={false} onCancel={vi.fn()} onConfirm={vi.fn()} />);

  it('Cancel and the confirm button are 44px for every action', () => {
    for (const action of ['bulk_close', 'bulk_lock', 'bulk_reopen'] as const) {
      const { unmount } = open(action);
      expect(cls(screen.getByRole('button', { name: 'Cancel' })), action).toContain(MIN);
      expect(cls(screen.getAllByRole('button').find((b) => b.textContent !== 'Cancel')!), action).toContain(MIN);
      unmount();
    }
  });

  it('the box is capped to the viewport with a pinned footer, and the footer wraps', () => {
    open();
    const box = screen.getByRole('dialog').firstElementChild!;
    expect(cls(box)).toEqual(expect.arrayContaining(CAP));
    const [head, foot] = [...box.children];
    expect(cls(head!)).toContain('max-lg:overflow-y-auto');
    expect(cls(foot!)).toEqual(expect.arrayContaining(['max-lg:shrink-0', 'max-lg:flex-wrap']));
  });
});

describe('ConfirmSendModal on touch', () => {
  const open = () => render(<ConfirmSendModal count={12} asAtDate="2026-11-24" isSending={false} onConfirm={vi.fn()} onCancel={vi.fn()} />);

  it('the close X is a named 44px square; Cancel and Send are 44px', () => {
    open();
    expect(cls(screen.getByRole('button', { name: 'Close' }))).toEqual(expect.arrayContaining(SQUARE));
    expect(cls(screen.getByRole('button', { name: 'Cancel' }))).toContain(MIN);
    expect(cls(screen.getByRole('button', { name: /Send 12 Statements/ }))).toContain(MIN);
  });

  it('the box is capped to the viewport; the body scrolls, the header and actions stay', () => {
    open();
    const box = screen.getByRole('dialog').firstElementChild!;
    expect(cls(box)).toEqual(expect.arrayContaining(CAP));
    const [head, body, actions] = [...box.children];
    expect(cls(head!)).toContain('max-lg:shrink-0');
    expect(cls(body!)).toContain('max-lg:overflow-y-auto');
    expect(cls(actions!)).toEqual(expect.arrayContaining(['max-lg:shrink-0', 'max-lg:flex-wrap']));
  });
});

describe('YearEndConfirmDialog typed-confirmation field on touch', () => {
  it('the field is 44px tall', async () => {
    render(<YearEndConfirmDialog year={{ year_label: '2026', start_date: '2025-03-01', end_date: '2026-02-28', total_revenue: 5000, total_expenses: 3700 }} busy={false} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const input = await screen.findByRole('textbox');
    await waitFor(() => expect(input).not.toBeDisabled());
    expect(cls(input)).toContain(MIN);
  });
});
