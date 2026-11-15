// Admin invoice dialogs (admin audit 4.13 follow-up): Create Invoice and Settle send are real modal dialogs.
// role=dialog + aria-modal named by their title, focus moves in on open, Tab / Shift+Tab wrap inside, Escape closes
// (not while the request is running, when every control is disabled and focus stays in the dialog; nor while a
// Create Invoice field holds a draft), focus goes back to the opener, Create Invoice opens on its first field, a
// failure is announced (role=alert) and takes focus, and every Create Invoice field is labelled.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { CreateInvoiceModal } from '@/components/admin/billing/CreateInvoiceModal';
import { SettleSendModal } from '@/components/admin/billing/SettleSendModal';
import type { Invoice } from '@/components/admin/billing/invoiceModel';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
useApiJsonOverMock();

let release: () => void = () => undefined;
beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async () => {
    await new Promise<void>((r) => { release = r; });
    return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
  });
});
afterEach(() => { cleanup(); });

const INVOICE: Invoice = { id: 'i-1', invoice_number: 'INV-1', company_id: 'c-1', company_name: 'Acme Ltd', billing_email: 'a@b.test',
  status: 'draft', subtotal_cents: 10000, tax_cents: 1500, total_cents: 11500, currency: 'ZAR', due_date: null, paid_at: null,
  payment_method: null, created_at: '2026-11-01T00:00:00Z', send_claimed_at: '2026-11-14T10:00:00Z' };

function Host({ label, dialog }: { label: string; dialog: (close: () => void) => ReactNode }) {
  const [shown, setShown] = useState(false);
  return (<><button onClick={() => setShown(true)}>{label}</button>{shown && dialog(() => setShown(false))}</>);
}
const key = (k: string, shiftKey = false) => fireEvent.keyDown(document.activeElement ?? document.body, { key: k, shiftKey });

const CASES = [
  { name: 'Create Invoice', title: /create invoice/i, start: /^create$/i,
    host: (onClose: () => void) => <Host label="Open" dialog={(close) => <CreateInvoiceModal onClose={() => { onClose(); close(); }} onCreated={close} />} />,
    fill: (d: HTMLElement) => {
      fireEvent.change(within(d).getByLabelText('Company ID'), { target: { value: 'c-1' } });
      fireEvent.change(within(d).getByLabelText('Subtotal (R)'), { target: { value: '100' } });
    } },
  { name: 'Settle send', title: /settle send of inv-1/i, start: /mark as sent/i,
    host: (onClose: () => void) => <Host label="Open" dialog={(close) => <SettleSendModal invoice={INVOICE} onClose={() => { onClose(); close(); }} onSettled={close} />} />,
    fill: () => undefined },
] as const;

async function openDialog(c: (typeof CASES)[number], onClose = vi.fn()) {
  render(c.host(onClose));
  const opener = screen.getByRole('button', { name: 'Open' });
  opener.focus();
  fireEvent.click(opener);
  const dialog = await screen.findByRole('dialog', { name: c.title });
  return { opener, dialog, onClose };
}

describe.each(CASES)('$name dialog', (c) => {
  it('is modal, takes focus, closes on Escape and gives focus back to the opener', async () => {
    const { opener, dialog, onClose } = await openDialog(c);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    key('Escape');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  it('Tab from the last control wraps to the first, Shift+Tab from the first to the last', async () => {
    const { dialog } = await openDialog(c);
    const buttons = within(dialog).getAllByRole('button').filter((b) => !(b as HTMLButtonElement).disabled);
    const first = within(dialog).getByRole('button', { name: 'Close' });
    const last = buttons[buttons.length - 1]!;
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    first.focus();
    key('Tab', true);
    expect(document.activeElement).toBe(last);
    key('Tab');
    expect(document.activeElement).toBe(first);
  });

  it('while the request runs: Escape is ignored, every control is disabled, Tab keeps focus inside', async () => {
    const { dialog, onClose } = await openDialog(c);
    c.fill(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: c.start }));
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
    const controls = [...dialog.querySelectorAll<HTMLElement>('button, input, textarea, select')]
      .filter((el) => !(el instanceof HTMLInputElement && el.type === 'hidden'));
    expect(controls.length).toBeGreaterThan(0);
    // :disabled, not .disabled: a field inside a disabled <fieldset> is disabled without its own attribute.
    expect(controls.filter((el) => !el.matches(':disabled')).map((el) => el.outerHTML.slice(0, 60))).toEqual([]);
    // Focus sits on the dialog itself, not on a control that just turned disabled (a browser drops that to body).
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.matches(':disabled')).toBe(false);
    key('Tab');
    expect(dialog.contains(document.activeElement)).toBe(true);
    key('Tab', true);
    expect(dialog.contains(document.activeElement)).toBe(true);
    key('Escape');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBe(dialog);
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a successful request closes the dialog and gives focus back to the opener', async () => {
    const { opener, dialog } = await openDialog(c);
    c.fill(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: c.start }));
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('fail, retry, fail: the alert goes while retrying (focus on the dialog) and the new one takes focus', async () => {
    let calls = 0;
    let releaseRetry: () => void = () => undefined;
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => {
      calls += 1;
      if (calls === 2) await new Promise<void>((r) => { releaseRetry = r; });
      return new Response(JSON.stringify({ success: false, error: { message: 'The server said no' } }), { status: 400 });
    });
    const { dialog } = await openDialog(c);
    c.fill(dialog);
    const start = within(dialog).getByRole('button', { name: c.start });
    fireEvent.click(start);
    const first = await within(dialog).findByRole('alert');
    await waitFor(() => expect(document.activeElement).toBe(first));
    fireEvent.click(start);
    await waitFor(() => expect(within(dialog).queryByRole('alert')).toBeNull());
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.matches(':disabled')).toBe(false);
    releaseRetry();
    const second = await within(dialog).findByRole('alert');
    expect(second.textContent).toContain('The server said no');
    await waitFor(() => expect(document.activeElement).toBe(second));
  });

  it('a failed request is announced and takes focus', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async () =>
      new Response(JSON.stringify({ success: false, error: { message: 'The server said no' } }), { status: 400 }));
    const { dialog } = await openDialog(c);
    c.fill(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: c.start }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('The server said no');
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });
});

describe('Create Invoice draft and first focus', () => {
  it('opens with focus on Company ID', async () => {
    const { dialog } = await openDialog(CASES[0]);
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText('Company ID')));
  });

  it.each([['Company ID', 'c-9'], ['Subtotal (R)', '12'], ['Notes (optional)', 'half a sentence']])(
    'Escape in %s with something typed keeps the dialog (and the draft)', async (label, text) => {
      const { dialog, onClose } = await openDialog(CASES[0]);
      const field = within(dialog).getByLabelText(label);
      fireEvent.change(field, { target: { value: text } });
      field.focus();
      key('Escape');
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toBe(dialog);
      expect((field as HTMLInputElement).value).toBe(text);
    });
});

describe('Create Invoice repeated error and due-date draft', () => {
  it('the same validation error twice takes focus again (and is a new alert)', async () => {
    const { dialog } = await openDialog(CASES[0]);
    const create = within(dialog).getByRole('button', { name: /^create$/i });
    create.focus();
    fireEvent.click(create);
    const first = await within(dialog).findByRole('alert');
    await waitFor(() => expect(document.activeElement).toBe(first));
    create.focus();
    fireEvent.click(create);
    await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('alert'));
    expect(document.activeElement?.textContent).toContain('Company ID is required');
    expect(document.activeElement).not.toBe(first); // remounted: re-announced
  });

  it.each([['12 Dec'], ['12 Dex']])('Escape in Due Date with %j typed keeps the dialog and the text', async (text) => {
    const { dialog, onClose } = await openDialog(CASES[0]);
    const due = within(dialog).getByLabelText('Due Date (optional)') as HTMLInputElement;
    fireEvent.change(due, { target: { value: text } });
    due.focus();
    key('Escape');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(due.value).toBe(text);
  });

  it('Escape in an empty Due Date still closes the dialog', async () => {
    const { dialog, onClose } = await openDialog(CASES[0]);
    within(dialog).getByLabelText('Due Date (optional)').focus();
    key('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Create Invoice labels', () => {
  it('names every field', async () => {
    const { dialog } = await openDialog(CASES[0]);
    for (const [label, tag] of [['Company ID', 'INPUT'], ['Subtotal (R)', 'INPUT'], ['Due Date (optional)', 'INPUT'], ['Notes (optional)', 'TEXTAREA']] as const) {
      expect(within(dialog).getByLabelText(label).tagName, label).toBe(tag);
    }
  });
});
