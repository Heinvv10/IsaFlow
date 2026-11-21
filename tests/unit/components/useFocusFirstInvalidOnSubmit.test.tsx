// A failed submit on a phone must land the user on the first invalid field, not leave them scrolled past it.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { useFocusFirstInvalidOnSubmit } from '@/hooks/useFocusFirstInvalidOnSubmit';

function BannerForm({ role, preExisting = false, slow = false, stale = false }: { role?: string; preExisting?: boolean; slow?: boolean; stale?: boolean }) {
  useFocusFirstInvalidOnSubmit();
  const [shown, setShown] = useState(preExisting);
  return (
    <form onSubmit={(e) => { e.preventDefault(); setTimeout(() => setShown(true), slow ? 2500 : 60); }}>
      {stale && <input aria-label="old" aria-invalid className="hidden" />}
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

// Evaluates the real `(max-width: Npx)` query against a pretend viewport width, so a breakpoint typo fails.
let width = 390; let reducedMotion = false;
const setViewport = (phone: boolean) => { width = phone ? 390 : 1280; };
window.matchMedia = ((q: string) => {
  const max = /max-width:\s*([\d.]+)px/.exec(q);
  const matches = max ? width <= Number(max[1]) : q.includes('prefers-reduced-motion') ? reducedMotion : false;
  return { matches, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() };
}) as never;
const scroll = vi.fn();
beforeEach(() => { scroll.mockReset(); Element.prototype.scrollIntoView = scroll; setViewport(true); reducedMotion = false; });
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

  // Scope and filtering: only a real error banner, inside the form's own container, may pull the page.
  function Scoped({ kind, after = 60, initial = 'Could not save' }: { kind: 'chip' | 'toast' | 'elsewhere' | 'text'; after?: number; initial?: string }) {
    useFocusFirstInvalidOnSubmit();
    const [on, setOn] = useState(false);
    return (
      <div>
        <div data-testid="container">
          {kind === 'text' && <div role="alert" data-testid="banner">{on ? 'Second failure' : initial}</div>}
          <form onSubmit={(e) => { e.preventDefault(); setTimeout(() => setOn(true), after); }}>
            {kind === 'chip' && on && <span className="bg-red-500/10">Inactive</span>}
            <button type="submit">Save</button>
          </form>
          {kind === 'toast' && on && <div className="fixed bottom-4"><div role="alert">Saved</div></div>}
        </div>
        {kind === 'elsewhere' && on && <div role="alert" data-testid="far">Other widget failed</div>}
      </div>
    );
  }

  it('ignores an inline red chip that appears after a search-style submit', async () => {
    render(<Scoped kind="chip" />);
    submit();
    await new Promise((r) => setTimeout(r, 450));
    expect(scroll).not.toHaveBeenCalled();
  });

  it('ignores a toast (fixed position, role=alert)', async () => {
    render(<Scoped kind="toast" />);
    submit();
    await new Promise((r) => setTimeout(r, 450));
    expect(scroll).not.toHaveBeenCalled();
  });

  it('ignores a banner outside the form container', async () => {
    render(<Scoped kind="elsewhere" />);
    submit();
    await new Promise((r) => setTimeout(r, 450));
    expect(scroll).not.toHaveBeenCalled();
  });

  it('scrolls to a banner that stayed mounted but changed its text (second failure)', async () => {
    render(<Scoped kind="text" />);
    submit();
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(scroll.mock.contexts[0]).toBe(screen.getByTestId('banner'));
  });

  it('still catches an error that arrives after a slow server response', async () => {
    render(<BannerForm slow />);
    submit();
    await waitFor(() => expect(scroll).toHaveBeenCalled(), { timeout: 5000 });
  });

  it('skips a stale invalid field in a collapsed panel and finds the banner instead', async () => {
    const real = HTMLElement.prototype.checkVisibility;
    HTMLElement.prototype.checkVisibility = function (this: HTMLElement) { return !this.classList.contains('hidden'); };
    try {
      render(<BannerForm stale />);
      submit();
      await waitFor(() => expect(scroll).toHaveBeenCalled());
      expect(screen.getByLabelText('old')).not.toHaveFocus();
    } finally { HTMLElement.prototype.checkVisibility = real; }
  });

  it('uses the real lg breakpoint: 1023px is a phone, 1024px is not', async () => {
    width = 1023;
    const { unmount } = render(<BannerForm />);
    submit();
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    unmount(); scroll.mockReset(); width = 1024;
    render(<BannerForm />);
    submit();
    await new Promise((r) => setTimeout(r, 450));
    expect(scroll).not.toHaveBeenCalled();
  });

  it('scrolls instantly under reduced motion and smoothly otherwise', async () => {
    reducedMotion = true;
    render(<BannerForm />);
    submit();
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' }));
    cleanup(); scroll.mockReset(); reducedMotion = false;
    render(<BannerForm />);
    submit();
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' }));
  });

  it('also scrolls instantly under reduced motion when it lands on an invalid field', async () => {
    reducedMotion = true;
    render(<Form />);
    submit();
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' }));
  });

  it('stops watching once it has acted: one scroll per submit', async () => {
    render(<BannerForm />);
    submit();
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 450));
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it('a second quick submit replaces the first watch instead of doubling it', async () => {
    render(<BannerForm />);
    submit(); submit();
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 450));
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it('cleans up when the app unmounts mid-watch', async () => {
    const { unmount } = render(<BannerForm slow />);
    submit();
    unmount();
    await new Promise((r) => setTimeout(r, 2800));
    expect(scroll).not.toHaveBeenCalled();
  });

  it('does not throw where matchMedia is missing', async () => {
    const real = window.matchMedia;
    (window as unknown as { matchMedia?: unknown }).matchMedia = undefined;
    try {
      render(<BannerForm />);
      expect(() => submit()).not.toThrow();
    } finally { window.matchMedia = real; }
  });
});
