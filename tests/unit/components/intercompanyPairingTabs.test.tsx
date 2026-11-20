// Intercompany P3: the direction tabs follow the WAI-ARIA tabs pattern (controlled panel, roving tabindex, arrow / Home / End keys).
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { PairingTabs } from '@/components/accounting/intercompany/pairing/PairingTabs';
import type { PairingDirection } from '@/modules/accounting/services/intercompany/pairingTypes';

function Harness() {
  const [direction, setDirection] = useState<PairingDirection>('ar');
  return <PairingTabs direction={direction} onChange={setDirection} labels={{ ar: 'Owed to you', ap: 'Owed by you' }}><p>panel for {direction}</p></PairingTabs>;
}

describe('PairingTabs', () => {
  it('has one tab in the tab order, a focusable panel the tab controls, and arrow / Home / End keys that move focus and select', () => {
    render(<Harness />);
    const ar = screen.getByRole('tab', { name: 'Owed to you' });
    const ap = screen.getByRole('tab', { name: 'Owed by you' });
    expect([ar.tabIndex, ap.tabIndex]).toEqual([0, -1]);
    const panel = screen.getByRole('tabpanel');
    expect(panel.tabIndex).toBe(0);
    expect(ar).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', ar.id);

    ar.focus();
    fireEvent.keyDown(ar, { key: 'ArrowRight' });
    expect(ap).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(ap);
    expect([ar.tabIndex, ap.tabIndex]).toEqual([-1, 0]);
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', ap.id);
    expect(screen.getByText('panel for ap')).toBeInTheDocument();
    fireEvent.keyDown(ap, { key: 'ArrowRight' });
    expect(ar).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(ar, { key: 'ArrowLeft' });
    expect(ap).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(ap, { key: 'Home' });
    expect(ar).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(ar, { key: 'End' });
    expect(ap).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(ap, { key: 'a' });
    expect(ap).toHaveAttribute('aria-selected', 'true');
  });
});
