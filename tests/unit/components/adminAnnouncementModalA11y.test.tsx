// Announcement create/edit dialog (admin audit 4.13 follow-up): a real modal dialog. Focus moves inside on open, Tab
// and Shift+Tab wrap inside, Escape closes it (not while a save is in flight, when Close and Cancel are disabled too),
// focus returns to the opener, and every field is labelled. With the company picker's results open, Escape closes only
// that list: the dialog (and the half-written announcement) stays.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { AnnouncementModal, EMPTY_FORM } from '@/components/admin/AnnouncementModal';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
useApiJsonOverMock();
beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async () => new Response(JSON.stringify({ success: true, data: {
    items: [{ id: 'c-1', name: 'Acme Ltd', status: 'active' }, { id: 'c-2', name: 'Acme Two', status: 'active' }],
  } }), { status: 200 }));
});
afterEach(() => { cleanup(); });

const open = (saving = false, target = 'all') => {
  const onClose = vi.fn();
  render(<AnnouncementModal initial={{ ...EMPTY_FORM, target }} onClose={onClose} onSave={vi.fn(async () => undefined)} saving={saving} />);
  return onClose;
};
const key = (k: string, shiftKey = false) => fireEvent.keyDown(document.activeElement ?? document.body, { key: k, shiftKey });

describe('AnnouncementModal', () => {
  it('is modal, takes focus and closes on Escape', async () => {
    const onClose = open();
    const dialog = screen.getByRole('dialog', { name: /new announcement/i });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    key('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('while saving: Escape is ignored and Close / Cancel are disabled', async () => {
    const onClose = open(true);
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    within(dialog).getByLabelText('Title').focus();
    key('Escape');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Tab from the last control wraps to the first, Shift+Tab from the first to the last', async () => {
    open();
    const dialog = screen.getByRole('dialog');
    const close = within(dialog).getByRole('button', { name: 'Close' });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' }); // Save is disabled on an empty form
    await waitFor(() => expect(document.activeElement).toBe(close));
    key('Tab', true);
    expect(document.activeElement).toBe(cancel);
    key('Tab');
    expect(document.activeElement).toBe(close);
  });

  it('gives focus back to the button that opened it', async () => {
    function Host() {
      const [shown, setShown] = useState(false);
      return (
        <>
          <button onClick={() => setShown(true)}>New announcement</button>
          {shown && <AnnouncementModal initial={{ ...EMPTY_FORM }} onClose={() => setShown(false)} onSave={vi.fn(async () => undefined)} saving={false} />}
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'New announcement' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    key('Escape');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('labels every field, the company picker included', () => {
    open(false, 'company');
    const dialog = screen.getByRole('dialog');
    for (const [label, tag] of [['Title', 'INPUT'], ['Message', 'TEXTAREA'], ['Type', 'SELECT'], ['Target', 'SELECT'],
      ['Target Companies', 'INPUT'], ['Starts At (SAST)', 'INPUT'], ['Ends At (SAST, optional)', 'INPUT'],
      ['Dismissible by users', 'INPUT']] as const) {
      expect(within(dialog).getByLabelText(label).tagName, label).toBe(tag);
    }
    expect(within(dialog).getByLabelText('Target Companies').getAttribute('role')).toBe('combobox');
  });

  it('Escape with the company results open closes the list only, not the dialog', async () => {
    const onClose = open(false, 'company');
    const picker = within(screen.getByRole('dialog')).getByLabelText('Target Companies');
    picker.focus();
    fireEvent.change(picker, { target: { value: 'Acme' } });
    expect(await screen.findByRole('listbox')).toBeTruthy();
    expect(picker.getAttribute('aria-expanded')).toBe('true');
    key('Escape');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    key('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
