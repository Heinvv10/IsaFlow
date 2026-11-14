// Convert trial dialog (admin audit 4.13 follow-up): a real modal dialog. role=dialog + aria-modal named by its title,
// focus moves in, Tab / Shift+Tab wrap inside, Escape closes it (not while the conversion is running, when Close and
// Cancel are disabled too), focus goes back to the opener, and the plan radios are a group labelled "Select plan".
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ConvertTrialModal } from '@/components/admin/ConvertTrialModal';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
useApiJsonOverMock();

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
let releaseConvert: () => void = () => undefined;
beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    if (init?.method === 'POST') {
      await new Promise<void>((r) => { releaseConvert = r; });
      return ok({ firstChargeAt: '2026-12-01', hasActiveMandate: true });
    }
    return ok([{ id: 'p-1', name: 'Starter', code: 'starter', monthly_price_cents: 29900, currency: 'ZAR' }]);
  });
});
afterEach(() => { cleanup(); });

function Host({ onClose }: { onClose?: () => void }) {
  const [shown, setShown] = useState(false);
  return (
    <>
      <button onClick={() => setShown(true)}>Convert to Paid</button>
      {shown && <ConvertTrialModal companyId="c-1" companyName="Acme Ltd"
        onClose={() => { onClose?.(); setShown(false); }} onConverted={() => setShown(false)} />}
    </>
  );
}
const key = (k: string, shiftKey = false) => fireEvent.keyDown(document.activeElement ?? document.body, { key: k, shiftKey });
async function openDialog(onClose?: () => void) {
  render(<Host onClose={onClose} />);
  const opener = screen.getByRole('button', { name: 'Convert to Paid' });
  opener.focus();
  fireEvent.click(opener);
  const dialog = await screen.findByRole('dialog', { name: /convert to paid/i });
  await within(dialog).findByRole('radio', { name: /starter/i });
  return { opener, dialog };
}

describe('ConvertTrialModal', () => {
  it('is modal, takes focus, closes on Escape and gives focus back to the opener', async () => {
    const onClose = vi.fn();
    const { opener, dialog } = await openDialog(onClose);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    key('Escape');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  it('Tab and Shift+Tab wrap inside the dialog', async () => {
    const { dialog } = await openDialog();
    const close = within(dialog).getByRole('button', { name: 'Close' });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' }); // Convert is disabled until a plan is picked
    close.focus();
    key('Tab', true);
    expect(document.activeElement).toBe(cancel);
    key('Tab');
    expect(document.activeElement).toBe(close);
  });

  it('labels the plan choice', async () => {
    const { dialog } = await openDialog();
    const group = within(dialog).getByRole('radiogroup', { name: 'Select plan' });
    expect(within(group).getByRole('radio', { name: /starter/i })).toBeTruthy();
  });

  it('while converting: Escape is ignored and Close / Cancel are disabled', async () => {
    const onClose = vi.fn();
    const { dialog } = await openDialog(onClose);
    fireEvent.click(within(dialog).getByRole('radio', { name: /starter/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^convert to paid$/i }));
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true));
    expect((within(dialog).getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
    key('Escape');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBe(dialog);
    releaseConvert();
    expect(await within(dialog).findByText(/is now on a paid plan/)).toBeTruthy();
  });
});
