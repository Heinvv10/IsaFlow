/**
 * Wave 3 PR V follow-ups: a repeating row's controls carry the row number, and the Scan & Fill popover is anchored.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { LineItemsSection, type LineItem } from '@/components/accounting/recurringInvoices/LineItemsSection';
import { ScanAndFillButton } from '@/components/accounting/ScanAndFillButton';

vi.mock('@/lib/apiFetch', () => ({
  apiFetch: vi.fn(async () => ({ json: async () => ({ data: { available: true } }) })),
  assertOk: vi.fn(),
  apiErrorMessage: vi.fn(),
  ApiEnvelopeError: class extends Error {},
}));
vi.mock('@/utils/toast', () => ({ notify: vi.fn() }));

afterEach(cleanup);

const line = (key: string): LineItem => ({ key, description: '', quantity: 1, unitPrice: 0, glAccountId: '' });

describe('recurring invoice LineItemsSection', () => {
  it('names every control with its row number', () => {
    render(
      <LineItemsSection lines={[line('a'), line('b')]} taxRate={15} onTaxRateChange={vi.fn()}
        onUpdateLine={vi.fn()} onAddLine={vi.fn()} onRemoveLine={vi.fn()} inputCls="" />,
    );
    for (const n of [1, 2]) {
      expect(screen.getByLabelText(`Line ${n} description`)).toBeTruthy();
      expect(screen.getByLabelText(`Line ${n} quantity`)).toBeTruthy();
      expect(screen.getByLabelText(`Line ${n} unit price`)).toBeTruthy();
      expect(screen.getByRole('button', { name: `Remove line ${n}` })).toBeTruthy();
    }
  });
});

describe('ScanAndFillButton', () => {
  it('is a positioned root, so its absolute warnings popover anchors to it', async () => {
    const { container } = render(<ScanAndFillButton onExtracted={vi.fn()} />);
    await waitFor(() => expect(container.firstElementChild).not.toBeNull());
    expect((container.firstElementChild as HTMLElement).classList.contains('relative')).toBe(true);
  });
});
