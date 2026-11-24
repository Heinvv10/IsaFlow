// The shared ui ConfirmDialog (acceptLabel/cancelLabel): Cancel and the accept button are 44px on phones, the buttons wrap, and a long message scrolls inside a box capped to the viewport.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from '../../../src/components/ui/ConfirmDialog';

afterEach(cleanup);
const cls = (el: Element) => el.className.split(' ');
const MIN = 'max-lg:min-h-11';
const open = (over: Record<string, unknown> = {}) => render(<ConfirmDialog open title="Revoke this extension?" message="It will stop sending transactions." acceptLabel="Revoke" onAccept={vi.fn()} onCancel={vi.fn()} {...over} />);

describe('ui ConfirmDialog on touch', () => {
  it('Cancel and the accept button are 44px, in both tones', () => {
    for (const tone of ['default', 'destructive']) {
      const { unmount } = open({ tone });
      expect(cls(screen.getByRole('button', { name: 'Cancel' })), tone).toContain(MIN);
      expect(cls(screen.getByRole('button', { name: /Revoke/ })), tone).toContain(MIN);
      unmount();
    }
  });

  it('the button row wraps instead of overflowing with long labels', () => {
    open({ acceptLabel: 'Revoke every paired extension', cancelLabel: 'Keep them all for now' });
    expect(cls(screen.getByRole('button', { name: 'Keep them all for now' }).parentElement!)).toContain('max-lg:flex-wrap');
  });

  it('a long message scrolls inside a box capped to the viewport while the title and the buttons stay pinned, and a long unbroken token wraps', () => {
    open({ message: 'x'.repeat(2000) }); // one unbroken token: only break-words keeps it inside the box
    const heading = screen.getByRole('heading', { name: 'Revoke this extension?' });
    const box = heading.closest('div[class*="max-w-sm"]')!;
    expect(cls(box)).toEqual(expect.arrayContaining(['max-lg:flex', 'max-lg:flex-col', 'max-lg:max-h-[calc(100dvh-2rem)]']));
    expect(cls(box).filter((c) => /^(flex|flex-col|max-h-)/.test(c))).toEqual([]); // nothing unprefixed: desktop keeps its plain block box
    const [title, body, buttons] = [...box.children];
    expect(cls(title!)).toContain('max-lg:shrink-0');
    expect(cls(body!)).toEqual(expect.arrayContaining(['max-lg:overflow-y-auto', 'max-lg:overscroll-contain', 'max-lg:break-words']));
    expect(cls(buttons!)).toContain('max-lg:shrink-0');
  });
});
