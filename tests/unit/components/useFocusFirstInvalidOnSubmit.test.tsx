// A failed submit on a phone must land the user on the first invalid field, not leave them scrolled past it.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { useFocusFirstInvalidOnSubmit } from '@/hooks/useFocusFirstInvalidOnSubmit';

function BannerForm({ role, preExisting = false }: { role?: string; preExisting?: boolean }) {
  useFocusFirstInvalidOnSubmit();
  const [shown, setShown] = useState(preExisting);
  return (
    <form onSubmit={(e) => { e.preventDefault(); setTimeout(() => setShown(true), 60); }}>
      {shown && <div role={role} className="bg-red-500/10" data-testid="banner">Could not save</div>}
      <button type="submit">Save</button>
    </form>
  );
}

function Form({ failOn = ['name', 'email'], async: delayed = false }: { failOn?: string[]; async?: boolean }) {
  useFocusFirstInvalidOnSubmit();
  const [bad, setBad] = useState<string[]>([]);
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (delayed) setTimeout(() => setBad(failOn), 120); else setBad(failOn); }}>
      <input aria-label="name" aria-invalid={bad.includes('name')} />
      <input aria-label="email" aria-invalid={bad.includes('email')} />
      <input aria-label="phone" aria-invalid={bad.includes('phone')} />
      <button type="submit">Save</button>
    </form>
  );
}

const setViewport = (phone: boolean) => {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({ matches: phone && q.includes('max-width'), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as never;
};
const scroll = vi.fn();
beforeEach(() => { scroll.mockReset(); Element.prototype.scrollIntoView = scroll; setViewport(true); });
afterEach(cleanup);
const submit = () => act(() => { screen.getByText('Save').click(); });

describe('focus the first invalid field after a failed submit (phones)', () => {
  it('focuses and scrolls to the first invalid field', async () => {
    render(<Form />);
    submit();
    await waitFor(() => expect(screen.getByLabelText('name')).toHaveFocus());
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' }));
  });

  it('picks the first invalid field in DOM order, not the first one flagged', async () => {
    render(<Form failOn={['phone', 'email']} />);
    submit();
    await waitFor(() => expect(screen.getByLabelText('email')).toHaveFocus());
  });

  it('also catches errors that arrive after an async validation round-trip', async () => {
    render(<Form async />);
    submit();
    await waitFor(() => expect(screen.getByLabelText('name')).toHaveFocus(), { timeout: 1500 });
  });

  it('does nothing when the submit left no invalid field', async () => {
    render(<Form failOn={[]} />);
    submit();
    await new Promise((r) => setTimeout(r, 450));
    expect(document.body).toHaveFocus();
    expect(scroll).not.toHaveBeenCalled();
  });

  it('leaves desktop alone', async () => {
    setViewport(false);
    render(<Form />);
    submit();
    await new Promise((r) => setTimeout(r, 450));
    expect(screen.getByLabelText('name')).not.toHaveFocus();
    expect(scroll).not.toHaveBeenCalled();
  });

  it('does not steal focus from an invalid field the user is already in', async () => {
    render(<Form />);
    screen.getByLabelText('email').focus();
    submit();
    await new Promise((r) => setTimeout(r, 450));
    expect(screen.getByLabelText('email')).toHaveFocus();
  });

  it('scrolls a new error banner into view (not focus) when no field is flagged', async () => {
    render(<BannerForm />);
    submit();
    await waitFor(() => expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' })));
    expect(scroll.mock.contexts[0]).toBe(screen.getByTestId('banner'));
    expect(screen.getByTestId('banner')).not.toHaveFocus();
  });

  it('also finds a role=alert banner without the red tint', async () => {
    render(<BannerForm role="alert" />);
    submit();
    await waitFor(() => expect(scroll).toHaveBeenCalled());
  });

  it('ignores a banner that was already on screen before the submit', async () => {
    render(<BannerForm preExisting />);
    submit();
    await new Promise((r) => setTimeout(r, 450));
    expect(scroll).not.toHaveBeenCalled();
  });
});
