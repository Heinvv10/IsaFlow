// Announcement create/edit dialog (admin audit 4.13 follow-up): a real modal dialog. Focus moves inside on open,
// Tab stays inside, Escape closes it (not while a save is in flight), and every field is labelled.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnnouncementModal, EMPTY_FORM } from '@/components/admin/AnnouncementModal';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
afterEach(() => { cleanup(); });

const open = (saving = false) => {
  const onClose = vi.fn();
  render(<AnnouncementModal initial={{ ...EMPTY_FORM }} onClose={onClose} onSave={vi.fn(async () => undefined)} saving={saving} />);
  return onClose;
};
const escape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

describe('AnnouncementModal', () => {
  it('is modal, takes focus and closes on Escape', async () => {
    const onClose = open();
    const dialog = screen.getByRole('dialog', { name: /new announcement/i });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape while saving', async () => {
    const onClose = open(true);
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    escape();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('labels every field', () => {
    open();
    const dialog = screen.getByRole('dialog');
    for (const [label, tag] of [['Title', 'INPUT'], ['Message', 'TEXTAREA'], ['Type', 'SELECT'], ['Target', 'SELECT'],
      ['Starts At (SAST)', 'INPUT'], ['Ends At (SAST, optional)', 'INPUT'], ['Dismissible by users', 'INPUT']] as const) {
      expect(within(dialog).getByLabelText(label).tagName, label).toBe(tag);
    }
  });
});
