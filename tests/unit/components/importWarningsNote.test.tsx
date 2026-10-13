/**
 * The import's own problems under a file: a long list collapses behind a
 * toggle, like the dropped-picks list; every message stays readable once open.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ImportWarningsNote } from '@/components/accounting/bank/ImportWarningsNote';

afterEach(() => cleanup());
const msgs = (n: number) => Array.from({ length: n }, (_, i) => `Row ${i + 1}: could not read the date`);

describe('ImportWarningsNote', () => {
  it('nothing for no problems', () => {
    expect(render(<ImportWarningsNote warnings={[]} />).container.textContent).toBe('');
  });

  it('a short list is open', () => {
    render(<ImportWarningsNote warnings={msgs(3)} />);
    expect(screen.getByText('Imported with problems')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('a long list collapses behind a toggle that says how many, and opens', () => {
    render(<ImportWarningsNote warnings={msgs(8)} />);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /Imported with problems — 8 messages/ }));
    expect(screen.getAllByRole('listitem')).toHaveLength(8);
  });

  it('renders at most 50 messages when open, and says how many more', () => {
    render(<ImportWarningsNote warnings={msgs(5000)} />);
    fireEvent.click(screen.getByRole('button', { name: /Imported with problems — 5000 messages/ }));
    expect(screen.getAllByRole('listitem')).toHaveLength(51); // 50 + the "and N more" line
    expect(screen.getByText('… and 4950 more')).toBeTruthy();
  });

  it('a list of exactly 50 shows all of it, with no "and more" line', () => {
    render(<ImportWarningsNote warnings={msgs(50)} />);
    fireEvent.click(screen.getByRole('button', { name: /50 messages/ }));
    expect(screen.getAllByRole('listitem')).toHaveLength(50);
    expect(screen.queryByText(/and \d+ more/)).toBeNull();
  });
});
