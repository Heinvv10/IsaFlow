/**
 * Review of the line-level invoice form, finding 6: "Hide Dimensions" hid the job, CC2 project and BU while lines
 * carried them, so the invoice saved coding the user could no longer see. Like the discount column, the dimensions
 * stay open (the button disabled, saying why) while any line carries one; clearing one there keeps them open.
 */
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { InvoiceLineItemsTable, type InvoiceLine } from '@/components/accounting/customer-invoices/InvoiceLineItemsTable';
import type { InvoiceLineCodingOptions } from '@/components/accounting/customer-invoices/useInvoiceLineCodingOptions';

afterEach(() => cleanup());

const OPTIONS: InvoiceLineCodingOptions = {
  accounts: [], projects: [{ id: 'job-1', label: 'Job One' }], cc2s: [{ id: 'cc2-1', label: 'CC2 One' }], bus: [{ id: 'bu-1', label: 'BU One' }],
  known: {}, status: 'ready', lookupFailed: false, error: '', retry: () => undefined,
};
const LINE: InvoiceLine = { key: 'a', description: 'Work', quantity: 1, unitPrice: 100, discount: 0, glAccountId: '', projectId: '', cc2Id: '', buId: '' };

function Grid({ initial }: { initial: InvoiceLine[] }) {
  const [lines, setLines] = useState(initial);
  return (
    <InvoiceLineItemsTable lines={lines} currencyCode="ZAR" lineTotal={(l) => l.unitPrice} options={OPTIONS} onAdd={() => undefined} onRemove={() => undefined}
      onUpdate={(key, field, value) => setLines((p) => p.map((l) => (l.key === key ? { ...l, [field]: value } : l)))} />
  );
}
const toggle = () => screen.getByRole('button', { name: /Dimensions/ }) as HTMLButtonElement;
const buPickers = () => screen.queryAllByRole('combobox', { name: 'BU' });
async function pickBu(name: string) {
  fireEvent.click(buPickers()[0]!);
  fireEvent.click(await screen.findByRole('option', { name }));
}

describe('the dimensions cannot be hidden while a line carries one', () => {
  it('a loaded line with a CC2: open, and Hide Dimensions is disabled, saying why', () => {
    render(<Grid initial={[{ ...LINE, cc2Id: 'cc2-1' }]} />);
    expect(toggle().textContent).toBe('Hide Dimensions');
    expect(toggle().disabled).toBe(true);
    expect(toggle().title).toMatch(/Clear the dimensions/);
    fireEvent.click(toggle());
    expect(buPickers()).toHaveLength(1);
  });

  it('no line carries one: Dimensions opens and hides freely', () => {
    render(<Grid initial={[LINE]} />);
    expect(buPickers()).toHaveLength(0);
    fireEvent.click(toggle());
    expect(buPickers()).toHaveLength(1);
    expect(toggle().disabled).toBe(false);
    fireEvent.click(toggle());
    expect(buPickers()).toHaveLength(0);
  });

  it('a BU picked locks them open; cleared again, they stay open and can then be hidden', async () => {
    render(<Grid initial={[LINE]} />);
    fireEvent.click(toggle());
    await pickBu('BU One');
    expect(toggle().disabled).toBe(true);
    await pickBu('No BU');
    expect(buPickers()).toHaveLength(1); // clearing it does not take the field away
    expect(toggle().disabled).toBe(false);
    fireEvent.click(toggle());
    expect(buPickers()).toHaveLength(0);
  });
});
