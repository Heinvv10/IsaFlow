/** OAuth consent renders every write permission as an explicit checkbox. */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConsentScopeList } from '@/components/oauth/ConsentScopeList';

const WRITES = ['write:invoices', 'write:journals', 'write:post'];

describe('ConsentScopeList write opt-ins', () => {
  it('renders requested write scopes unticked and keeps reads static', () => {
    const onToggle = vi.fn();
    render(
      <ConsentScopeList
        autoGranted={['read:reports', 'offline_access']}
        optIn={WRITES}
        optInChecked={{}}
        onToggle={onToggle}
      />,
    );

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes).toHaveLength(WRITES.length);
    expect(boxes.every((box) => !box.checked)).toBe(true);
    expect(screen.getByText(/only gets the write permissions you tick/i)).toBeTruthy();
    expect(screen.getByText(/irreversible/i)).toBeTruthy();
    expect(screen.getByText('Read your financial reports')).toBeTruthy();
  });

  it('reports each write permission toggle independently', () => {
    const onToggle = vi.fn();
    render(
      <ConsentScopeList
        autoGranted={['read:reports']}
        optIn={WRITES}
        optInChecked={{ 'write:journals': true }}
        onToggle={onToggle}
      />,
    );

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([false, true, false]);
    fireEvent.click(boxes[0]!);
    expect(onToggle).toHaveBeenCalledWith('write:invoices', true);
  });
});
