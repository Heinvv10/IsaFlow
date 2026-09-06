import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NoteMarker } from '@/components/accounting/annotations/NoteMarker';

describe('NoteMarker', () => {
  it('labels itself for a screen reader with the count and the row', () => {
    render(<NoteMarker note={{ count: 2, hasOpen: true }} onClick={vi.fn()} label="Sales" />);
    expect(screen.getByRole('button', { name: '2 notes on Sales' })).toBeTruthy();
  });

  it('uses the singular for one note', () => {
    render(<NoteMarker note={{ count: 1, hasOpen: false }} onClick={vi.fn()} label="Sales" />);
    expect(screen.getByRole('button', { name: '1 note on Sales' })).toBeTruthy();
  });

  it('calls back on click', () => {
    const onClick = vi.fn();
    render(<NoteMarker note={{ count: 1, hasOpen: true }} onClick={onClick} label="Sales" />);
    screen.getByRole('button').click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
