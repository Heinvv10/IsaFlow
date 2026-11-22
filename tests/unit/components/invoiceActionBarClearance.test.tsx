/**
 * Review of the line-level invoice form, finding 5: the invoice pages' action bar is sticky at the bottom of the
 * viewport, so a field the keyboard focused near the bottom landed under it. While the bar is in the page, its scroller
 * (the shell's <main>) keeps the bar's height, plus a gap, as its bottom scroll padding, which focus scrolling honours
 * (Chromium ignores a scroll-margin on the field itself). The bar's height varies (it wraps on a phone), so it is
 * measured. happy-dom has no layout: this pins the wiring with a stubbed height; the browser measurement is in the PR.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvoiceActionBar } from '@/components/accounting/customer-invoices/NewInvoiceParts';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const bar = (container: HTMLElement) => container.querySelector('[role="group"][aria-label="Invoice actions"]') as HTMLElement;

describe('the sticky invoice action bar never covers a focused field', () => {
  it('pads its scroller by its own height plus a gap, and puts the scroller back as it was when it goes', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { height: this.getAttribute('aria-label') === 'Invoice actions' ? 169.4 : 0 } as DOMRect;
    });
    const scroller = document.createElement('main');
    scroller.style.overflowY = 'auto';
    scroller.style.scrollPaddingBottom = '4px';
    document.body.appendChild(scroller);
    const { container, unmount } = render(<div><input aria-label="field" /><InvoiceActionBar status={null}><button>Save</button></InvoiceActionBar></div>, { container: scroller });
    expect(bar(container)).toBeTruthy();
    expect(scroller.style.scrollPaddingBottom).toBe('186px'); // ceil(169.4) + 16
    unmount();
    expect(scroller.style.scrollPaddingBottom).toBe('4px');
    scroller.remove();
  });

  it('every ancestor that may scroll is padded: a wrapper that never scrolls, and <main> that starts scrolling later', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 63 } as DOMRect);
    const sized = (el: HTMLElement, scroll: number, client: number) => {
      Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scroll });
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: client });
    };
    const main = document.createElement('main');
    main.style.overflowY = 'auto';
    main.style.scrollPaddingBottom = '2px';
    sized(main, 800, 800); // a short invoice: <main> does not scroll yet
    const wrapper = document.createElement('div');
    wrapper.style.overflowY = 'auto';
    sized(wrapper, 500, 500); // overflow-auto, but as tall as its content: it never scrolls
    main.appendChild(wrapper);
    document.body.appendChild(main);
    const { unmount } = render(<InvoiceActionBar status={null}><button>Save</button></InvoiceActionBar>, { container: wrapper });
    sized(main, 2000, 800); // lines added: now <main> scrolls, and a field focused at its foot must clear the bar
    expect(main.style.scrollPaddingBottom).toBe('79px');
    expect(wrapper.style.scrollPaddingBottom).toBe('79px'); // harmless while it does not scroll; right if it ever does
    unmount();
    expect(main.style.scrollPaddingBottom).toBe('2px');
    expect(wrapper.style.scrollPaddingBottom).toBe('');
    main.remove();
  });

  it('with no scrolling ancestor, the page itself scrolls: its scrolling element is padded', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 63 } as DOMRect);
    const page = document.scrollingElement as HTMLElement;
    const { unmount } = render(<InvoiceActionBar status={null}><button>Save</button></InvoiceActionBar>);
    expect(page.style.scrollPaddingBottom).toBe('79px');
    unmount();
    expect(page.style.scrollPaddingBottom).toBe('');
  });
});
