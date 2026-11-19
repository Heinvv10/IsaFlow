/**
 * Shared by the nav fly-out component tests (navFlyoutIntent / navFlyoutPlacement / navFlyoutFocus). happy-dom
 * cannot lay out, so rects, sizes and the ResizeObserver are stubbed here; the browser checks live in the PR evidence.
 */
import { vi } from 'vitest';
import { fireEvent } from '@testing-library/react';

export const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

export const expanded = (el: HTMLElement) => el.getAttribute('aria-expanded') === 'true';
/** A top-nav row's open sub-panel (aria-controls). */
export const subPanel = (row: HTMLElement) => document.getElementById(row.getAttribute('aria-controls') as string) as HTMLElement;
/** Pointer moves, as the document sees them. */
export const moves = (...pts: Array<[number, number]>) => pts.forEach(([x, y]) => fireEvent.mouseMove(document, { clientX: x, clientY: y }));
/** The sidebar's portalled panels, in the order they opened. */
export const sidebarPanels = () => [...document.querySelectorAll<HTMLElement>('[data-sidebar-flyout]')];

const isPanel = (el: HTMLElement) => el.hasAttribute('data-nav-panel') || el.hasAttribute('data-sidebar-flyout');

/** Every box at one rect; every panel `width` wide with `height` of content. happy-dom's window is 1024 x 768. */
export function stubUniformLayout(box = rect(300, 600, 210, 40), width = 220, height = 500) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(box);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return isPanel(this) ? height : 0; });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return isPanel(this) ? width : 0; });
}

/**
 * A layout where boxes differ: a panel sits where its style puts it, a row inside a panel sits at that panel's left
 * edge and spans its width, and anything else (a tab row) gets `tabRow(el)`. Panels are `width(el)` wide.
 */
export function stubPanelLayout(tabRow: (el: HTMLElement) => DOMRect, width: (panel: HTMLElement) => number = () => 220, height = 200) {
  const px = (v: string) => parseFloat(v) || 0;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (isPanel(this)) return rect(px(this.style.left), px(this.style.top), width(this), height);
    const panel = this.parentElement?.closest<HTMLElement>('[data-nav-panel], [data-sidebar-flyout]');
    if (panel) return rect(px(panel.style.left), px(panel.style.top) + 10, width(panel), 36);
    return tabRow(this);
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return isPanel(this) ? height : 0; });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return isPanel(this) ? width(this) : 0; });
}

/** A ResizeObserver whose callbacks the test fires; `observed` lists what was observed. */
export function fakeResizeObserver() {
  const instances: Array<{ cb: ResizeObserverCallback; observed: Element[] }> = [];
  class FakeRO {
    observed: Element[] = [];
    constructor(public cb: ResizeObserverCallback) { instances.push(this); }
    observe(el: Element) { this.observed.push(el); }
    unobserve() {}
    disconnect() { this.observed = []; }
  }
  vi.stubGlobal('ResizeObserver', FakeRO);
  return {
    /** Fire every live observer that watches `el`, as a resize of `el` would. */
    resize(el: Element) {
      for (const ro of instances) if (ro.observed.includes(el)) ro.cb([], ro as unknown as ResizeObserver);
    },
  };
}
