// The shared accounting ConfirmDialog (the last step of every delete flow): the close X, Cancel and the confirm button are 44px on phones; the footer wraps.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from '../../../src/components/accounting/ConfirmDialog';

afterEach(cleanup);
const cls = (el: Element) => el.className.split(' ');
const MIN = 'max-lg:min-h-11';
const open = (over: Record<string, unknown> = {}) => render(<ConfirmDialog open title="Delete business unit" message="Delete FIN?" confirmLabel="Delete" confirmTone="danger" onCancel={vi.fn()} onConfirm={vi.fn()} {...over} />);

describe('ConfirmDialog on touch', () => {
  it('the close X is a 44px square', () => {
    open();
    expect(cls(screen.getByRole('button', { name: 'Close' }))).toEqual(expect.arrayContaining([MIN, 'max-lg:min-w-11', 'max-lg:inline-flex', 'max-lg:items-center', 'max-lg:justify-center']));
  });

  it('Cancel and the confirm button are 44px, in both tones', () => {
    for (const confirmTone of ['danger', 'primary']) {
      const { unmount } = open({ confirmTone });
      expect(cls(screen.getByRole('button', { name: 'Cancel' })), confirmTone).toContain(MIN);
      expect(cls(screen.getByRole('button', { name: 'Delete' })), confirmTone).toContain(MIN);
      unmount();
    }
  });

  it('the button row wraps instead of overflowing with long labels', () => {
    open({ confirmLabel: 'Delete everything on this page', cancelLabel: 'Keep it for now' });
    expect(cls(screen.getByRole('button', { name: 'Keep it for now' }).parentElement!)).toContain('max-lg:flex-wrap');
  });

  it('a long message scrolls inside the box on a phone: the box is capped to the viewport and the header and footer keep their size, so the buttons stay reachable', () => {
    open({ message: 'x '.repeat(2000) });
    const box = screen.getByRole('dialog').firstElementChild!;
    expect(cls(box)).toEqual(expect.arrayContaining(['max-lg:flex', 'max-lg:flex-col', 'max-lg:max-h-[calc(100dvh-2rem)]']));
    const [header, body, footer] = [...box.children];
    expect(cls(header!)).toContain('max-lg:shrink-0');
    expect(cls(body!)).toContain('max-lg:overflow-y-auto');
    expect(cls(footer!)).toContain('max-lg:shrink-0');
  });
});
