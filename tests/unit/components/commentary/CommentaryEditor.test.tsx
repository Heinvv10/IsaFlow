/**
 * `CommentaryEditor` on its own: the busy state and the double-click guard that
 * the panel-level tests cannot reach, because React flushes between their
 * events and a state flag looks like it works.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CommentaryEditor } from '@/components/accounting/commentary/CommentaryEditor';

const approveBtn = () => screen.getByRole('button', { name: 'Approve edited text' }) as HTMLButtonElement;
const cancelBtn = () => screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('CommentaryEditor', () => {
  it('sends a double click ONCE, even when both clicks land before React re-renders', async () => {
    const d = deferred<boolean>();
    const onApprove = vi.fn().mockReturnValue(d.promise);
    render(<CommentaryEditor initialText="A sentence." packRemainingEms={100} onApprove={onApprove} onCancel={vi.fn()} />);
    act(() => { approveBtn().click(); approveBtn().click(); });
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith('A sentence.');
    await act(async () => { d.resolve(true); await d.promise; });
  });

  it('is busy while the approval is in flight: both buttons disabled', async () => {
    const d = deferred<boolean>();
    render(<CommentaryEditor initialText="A sentence." packRemainingEms={100} onApprove={() => d.promise} onCancel={vi.fn()} />);
    fireEvent.click(approveBtn());
    await waitFor(() => expect(approveBtn().disabled).toBe(true));
    expect(cancelBtn().disabled).toBe(true);
    await act(async () => { d.resolve(false); await d.promise; });
  });

  it('after a refusal it is usable again, with the typed text, and can be sent a second time', async () => {
    const onApprove = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<CommentaryEditor initialText="A sentence." packRemainingEms={100} onApprove={onApprove} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Typed text.' } });
    fireEvent.click(approveBtn());
    await waitFor(() => expect(approveBtn().disabled).toBe(false));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Typed text.');
    fireEvent.click(approveBtn());
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(2));
  });

  it('stays busy after an accepted approval: the parent closes it, a second send must not be possible', async () => {
    const onApprove = vi.fn().mockResolvedValue(true);
    render(<CommentaryEditor initialText="A sentence." packRemainingEms={100} onApprove={onApprove} onCancel={vi.fn()} />);
    fireEvent.click(approveBtn());
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(approveBtn().disabled).toBe(true);
    fireEvent.click(approveBtn());
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('with no room figure (a pack with no fixed page) shows no count and imposes no limit', () => {
    render(<CommentaryEditor initialText="A sentence." packRemainingEms={null} onApprove={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x'.repeat(5000) } });
    expect(approveBtn().disabled).toBe(false);
  });
});
