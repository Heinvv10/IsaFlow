import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { PresentDeck } from '@/components/accounting/present/PresentDeck';
import type { Slide } from '@/components/accounting/present/presentSlides';

afterEach(cleanup);

const SLIDES: Slide[] = [
  { id: 'cover', kind: 'cover', title: 'Cover', data: {} },
  { id: 'is:0', kind: 'income_statement', title: 'Income Statement', data: {} },
  { id: 'bs:1', kind: 'balance_sheet', title: 'Balance Sheet', data: {} },
];

const renderSlide = (s: Slide) => <p>{s.title}</p>;

describe('PresentDeck', () => {
  it('shows only the current slide', () => {
    render(<PresentDeck slides={SLIDES} renderSlide={renderSlide} />);
    expect(screen.getByText('Cover')).toBeTruthy();
    expect(screen.queryByText('Income Statement')).toBeNull();
  });

  it('advances on the right arrow and on space', () => {
    render(<PresentDeck slides={SLIDES} renderSlide={renderSlide} />);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('Income Statement')).toBeTruthy();
    fireEvent.keyDown(window, { key: ' ' });
    expect(screen.getByText('Balance Sheet')).toBeTruthy();
  });

  it('goes back on the left arrow and holds at the first slide', () => {
    render(<PresentDeck slides={SLIDES} renderSlide={renderSlide} />);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByText('Cover')).toBeTruthy();
  });

  it('holds at the last slide rather than wrapping to the cover', () => {
    render(<PresentDeck slides={SLIDES} renderSlide={renderSlide} />);
    fireEvent.keyDown(window, { key: 'End' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('Balance Sheet')).toBeTruthy();
  });

  it('jumps to the first slide on Home', () => {
    render(<PresentDeck slides={SLIDES} renderSlide={renderSlide} />);
    fireEvent.keyDown(window, { key: 'End' });
    fireEvent.keyDown(window, { key: 'Home' });
    expect(screen.getByText('Cover')).toBeTruthy();
  });

  it('exits on Escape', () => {
    const onExit = vi.fn();
    render(<PresentDeck slides={SLIDES} renderSlide={renderSlide} onExit={onExit} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('states the position, so a presenter knows how far in they are', () => {
    render(<PresentDeck slides={SLIDES} renderSlide={renderSlide} />);
    expect(screen.getByText('1 / 3')).toBeTruthy();
  });

  it('renders an empty deck without throwing', () => {
    render(<PresentDeck slides={[]} renderSlide={renderSlide} />);
    expect(screen.queryByText('1 / 0')).toBeNull();
  });

  it('does not page when focus is in a text input', () => {
    render(
      <div>
        <input aria-label="filter" />
        <PresentDeck slides={SLIDES} renderSlide={renderSlide} />
      </div>,
    );
    const input = screen.getByLabelText('filter');
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    expect(screen.getByText('Cover')).toBeTruthy();
  });

  it('does not page when focus is in a select', () => {
    render(
      <div>
        <select aria-label="period">
          <option value="a">a</option>
        </select>
        <PresentDeck slides={SLIDES} renderSlide={renderSlide} />
      </div>,
    );
    const select = screen.getByLabelText('period');
    select.focus();
    fireEvent.keyDown(select, { key: 'ArrowRight' });
    expect(screen.getByText('Cover')).toBeTruthy();
  });

  it('exits fullscreen on Escape when the deck is fullscreen', () => {
    const exitFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(document, 'fullscreenElement', {
      value: document.documentElement,
      configurable: true,
    });
    Object.defineProperty(document, 'exitFullscreen', {
      value: exitFullscreen,
      configurable: true,
    });
    const onExit = vi.fn();
    render(<PresentDeck slides={SLIDES} renderSlide={renderSlide} onExit={onExit} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    // @ts-expect-error -- test-only cleanup of a property defined only above
    delete document.fullscreenElement;
    // @ts-expect-error -- test-only cleanup of a property defined only above
    delete document.exitFullscreen;
  });

  it('does not call exitFullscreen on Escape when the deck is not fullscreen', () => {
    const exitFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(document, 'exitFullscreen', {
      value: exitFullscreen,
      configurable: true,
    });
    const onExit = vi.fn();
    render(<PresentDeck slides={SLIDES} renderSlide={renderSlide} onExit={onExit} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(exitFullscreen).not.toHaveBeenCalled();
    // @ts-expect-error -- test-only cleanup of a property defined only above
    delete document.exitFullscreen;
  });
});
