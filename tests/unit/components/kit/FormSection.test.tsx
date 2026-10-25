import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { FormSection } from '@/components/ui/FormSection';
import { AutosaveStatus, formatSavedAgo } from '@/components/ui/AutosaveStatus';

describe('FormSection', () => {
  it('is a region named by its heading, with a numbered step', () => {
    render(
      <FormSection number={2} title="Line items" description="What you are selling">
        <p>fields</p>
      </FormSection>,
    );
    const section = screen.getByRole('region', { name: /Line items/ });
    expect(section).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Step 2: Line items');
    expect(screen.getByText('What you are selling')).toBeTruthy();
    expect(screen.getByText('fields')).toBeTruthy();
  });

  it('omits the badge when unnumbered', () => {
    render(<FormSection title="Notes">x</FormSection>);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Notes');
  });

  it('renders a sticky summary as a labelled complementary landmark', () => {
    render(
      <FormSection title="Totals" summary={<p>Total R 100.00</p>} summaryLabel="Invoice summary">
        body
      </FormSection>,
    );
    const aside = screen.getByRole('complementary', { name: 'Invoice summary' });
    expect(aside.textContent).toBe('Total R 100.00');
    expect(aside.className).toMatch(/sticky/);
  });

  it('has no summary landmark when none is given', () => {
    render(<FormSection title="Notes">x</FormSection>);
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('hosts the autosave status in its heading row', () => {
    render(
      <FormSection title="Draft" status={<AutosaveStatus state="dirty" />}>
        x
      </FormSection>,
    );
    expect(screen.getByRole('status').textContent).toBe('Unsaved changes');
  });
});

describe('formatSavedAgo', () => {
  it.each([
    [0, 'just now'],
    [999, 'just now'],
    [1_000, '1 s ago'],
    [2_400, '2 s ago'],
    [59_999, '59 s ago'],
    [60_000, '1 min ago'],
    [3_599_000, '59 min ago'],
    [3_600_000, '1 h ago'],
    [7_300_000, '2 h ago'],
    [-5_000, 'just now'],
  ])('%i ms -> %s', (ms, text) => {
    expect(formatSavedAgo(ms)).toBe(text);
  });
});

describe('AutosaveStatus', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts up from the save time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 15, 10, 0, 0));
    render(<AutosaveStatus state="saved" savedAt={Date.now() - 2_000} />);
    expect(screen.getByRole('status').textContent).toBe('Saved 2 s ago');
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByRole('status').textContent).toBe('Saved 5 s ago');
  });

  it('accepts a Date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 15, 10, 0, 0));
    render(<AutosaveStatus state="saved" savedAt={new Date(Date.now() - 125_000)} />);
    expect(screen.getByRole('status').textContent).toBe('Saved 2 min ago');
  });

  it('shows Saving… and Unsaved changes', () => {
    const { rerender } = render(<AutosaveStatus state="saving" />);
    expect(screen.getByRole('status').textContent).toBe('Saving…');
    rerender(<AutosaveStatus state="dirty" />);
    expect(screen.getByRole('status').textContent).toBe('Unsaved changes');
  });

  it('shows a save failure, with a custom message when given', () => {
    const { rerender } = render(<AutosaveStatus state="error" />);
    expect(screen.getByRole('status').textContent).toBe("Couldn't save");
    rerender(<AutosaveStatus state="error" errorMessage="Offline: changes kept on this device." />);
    expect(screen.getByRole('status').textContent).toBe('Offline: changes kept on this device.');
  });

  it('saved without a time just says Saved and starts no timer', () => {
    vi.useFakeTimers();
    render(<AutosaveStatus state="saved" />);
    expect(screen.getByRole('status').textContent).toBe('Saved');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops ticking when it unmounts', () => {
    vi.useFakeTimers();
    const { unmount } = render(<AutosaveStatus state="saved" savedAt={Date.now()} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
