/**
 * The note thread popover.
 *
 * The accessibility behaviour here is pinned, not decorated: the dialog is
 * announced with the row's LABEL, not its internal id ("Notes on acc:4000"
 * names a key, not a line); it takes focus when it opens; Tab is trapped
 * inside it; Escape closes; and focus returns to whatever opened it.
 *
 * The keyboard tests drive REAL focus. Dispatching keydown on the container
 * was what let the original bug through: the listener sat on a `<div>` nothing
 * ever focused, so a real Escape went to `<body>` and did nothing, while a
 * test that aimed the event at the container passed.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AnnotationThread } from '@/components/accounting/annotations/AnnotationThread';
import type { Annotation } from '@/modules/accounting/services/annotations/annotationService';

const ann = (over: Partial<Annotation> = {}): Annotation => ({
  id: 'a1', rowId: 'acc:4000', periodStart: '2026-03-01', periodEnd: '2026-08-31',
  body: 'Check the March reversal.', author: 'user-1', authorName: 'Hein van Vuuren',
  createdAt: '2026-09-01T00:00:00.000Z', resolvedAt: null, ...over,
});

function renderThread(over: Partial<Parameters<typeof AnnotationThread>[0]> = {}) {
  const props = {
    rowId: 'acc:4000',
    rowLabel: 'Sales',
    annotations: [ann()],
    onCreate: vi.fn(),
    onResolve: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  return { props, ...render(<AnnotationThread {...props} />) };
}

describe('AnnotationThread', () => {
  it('announces itself with the row label, never the row id', () => {
    renderThread();

    expect(screen.getByRole('dialog', { name: 'Notes on Sales' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: /acc:4000/ })).toBeNull();
  });

  it('shows only the notes belonging to this row', () => {
    renderThread({ annotations: [ann(), ann({ id: 'a2', rowId: 'acc:5000', body: 'OTHER ROW NOTE' })] });

    expect(screen.getByText('Check the March reversal.')).toBeTruthy();
    expect(screen.queryByText('OTHER ROW NOTE')).toBeNull();
  });

  it('bylines a note with the author name rather than the raw user id', () => {
    renderThread();
    expect(screen.getByText(/Hein van Vuuren/)).toBeTruthy();
  });

  it('falls back to the author id when the name is null', () => {
    renderThread({ annotations: [ann({ authorName: null })] });
    expect(screen.getByText(/user-1/)).toBeTruthy();
  });

  it('offers Resolve on an open note and not on a settled one', () => {
    renderThread({ annotations: [ann({ id: 'a1', resolvedAt: '2026-09-02T00:00:00.000Z' })] });

    expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
    expect(screen.getByText('Resolved')).toBeTruthy();
  });

  it('calls back with the annotation id when Resolve is clicked', () => {
    const { props } = renderThread();
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));

    expect(props.onResolve).toHaveBeenCalledWith('a1');
  });

  it('will not save an empty or whitespace-only note', () => {
    const { props } = renderThread();
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    expect(save.disabled).toBe(true);
    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it('saves the trimmed body and clears the draft', () => {
    const { props } = renderThread();
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '  needs a credit note  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(props.onCreate).toHaveBeenCalledWith('needs a credit note');
    expect(box.value).toBe('');
  });

  it('takes focus when it opens, and announces itself as modal', () => {
    renderThread();
    const dialog = screen.getByRole('dialog');

    expect(document.activeElement).toBe(dialog);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('closes on a REAL Escape — the key pressed where focus actually is', () => {
    const { props } = renderThread();
    // No element named here: whatever has focus after opening is what a person
    // would be pressing Escape on. Aiming the event at the container instead is
    // what hid the original bug.
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores other keys', () => {
    const { props } = renderThread();
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });

    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('still closes on Escape pressed from a control inside it', () => {
    const { props } = renderThread();
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    box.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('traps Tab inside the dialog rather than letting it walk into the page', () => {
    const outside = document.createElement('button');
    outside.textContent = 'behind the dialog';
    document.body.appendChild(outside);

    renderThread();
    const dialog = screen.getByRole('dialog');
    // Same rule the trap uses: a disabled control is not a tab stop, and Save
    // is disabled until the draft has text.
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), textarea'));
    const first = controls[0]!;
    const last = controls[controls.length - 1]!;

    last.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);

    expect(document.activeElement).not.toBe(outside);
    outside.remove();
  });

  it('returns focus to the element that opened it when it unmounts', () => {
    const opener = document.createElement('button');
    opener.textContent = 'notes';
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { unmount } = render(
      <AnnotationThread rowId="acc:4000" rowLabel="Sales" annotations={[ann()]}
        onCreate={vi.fn()} onResolve={vi.fn()} onClose={vi.fn()} />,
    );
    // No hand-focus here any more: the dialog takes focus itself on open, and
    // a test that had to move focus for it was hiding the missing behaviour.
    expect(document.activeElement).not.toBe(opener);

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('says so plainly when the row has no notes yet', () => {
    renderThread({ annotations: [] });
    expect(screen.getByText('No notes on this row yet.')).toBeTruthy();
  });
});
