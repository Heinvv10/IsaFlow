/**
 * A warning that appears while the user is in the field scrolls itself into view: `block: 'nearest'` honours the
 * scroller's bottom scroll padding, so on the invoice pages it ends up above the sticky action bar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FieldFrame } from '@/components/ui/FieldFrame';

const scrolls: Array<{ id: string; arg: unknown }> = [];
const original = Element.prototype.scrollIntoView;
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

function Field({ warning, error }: { warning?: string | null; error?: string | null }) {
  return (
    <>
      <FieldFrame id="d" label="Invoice date" warning={warning} error={error}><input id="d" /></FieldFrame>
      <button type="button">elsewhere</button>
    </>
  );
}

beforeEach(() => {
  scrolls.length = 0;
  Element.prototype.scrollIntoView = vi.fn(function (this: Element, arg?: unknown) { scrolls.push({ id: this.id, arg }); });
});
afterEach(() => { cleanup(); Element.prototype.scrollIntoView = original; });

describe('FieldFrame warning scrolls clear', () => {
  it('scrolls the warning into view when it appears while the field has focus, and again when its text changes', async () => {
    const view = render(<Field />);
    screen.getByRole('textbox').focus();
    await frame();
    expect(scrolls).toEqual([]);
    view.rerender(<Field warning="in a locked period" />);
    await frame();
    expect(scrolls).toEqual([{ id: 'd-warning', arg: { block: 'nearest' } }]);
    view.rerender(<Field warning="in a locked period" />);
    await frame();
    expect(scrolls).toHaveLength(1);
    view.rerender(<Field warning="in a closing period" />);
    await frame();
    expect(scrolls).toHaveLength(2);
  });
  it('focus that returns right after the warning appears (a calendar pick) still counts', async () => {
    const view = render(<Field />);
    view.rerender(<Field warning="in a locked period" />);
    screen.getByRole('textbox').focus();
    await frame();
    expect(scrolls).toHaveLength(1);
  });
  it('does not move the page for a warning the user is not at (a pre-filled value, or focus elsewhere)', async () => {
    const view = render(<Field warning="pre-filled" />);
    await frame();
    screen.getByRole('button', { name: 'elsewhere' }).focus();
    view.rerender(<Field warning="periods loaded" />);
    await frame();
    expect(scrolls).toEqual([]);
  });
  it('a warning hidden behind an error does not scroll, and scrolls once the error clears', async () => {
    const view = render(<Field />);
    screen.getByRole('textbox').focus();
    view.rerender(<Field warning="w" error="e" />);
    await frame();
    expect(scrolls).toEqual([]);
    view.rerender(<Field warning="w" />);
    await frame();
    expect(scrolls).toHaveLength(1);
  });
  it('text that changes again before the frame scrolls once, for the latest text', async () => {
    const view = render(<Field />);
    screen.getByRole('textbox').focus();
    view.rerender(<Field warning="first" />);
    view.rerender(<Field warning="second" />);
    await frame();
    expect(scrolls).toHaveLength(1);
  });
});
