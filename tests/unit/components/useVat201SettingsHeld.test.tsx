import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';

const gate = vi.hoisted(() => ({ release: (() => undefined) as () => void }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co' }, loading: false }) }));
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: () => new Promise((resolve) => {
    gate.release = () => resolve({ ok: true, json: async () => ({ data: { vatPeriod: 'monthly', vatPeriodAlignment: 'odd', vatSystemType: 'invoice' } }) });
  }),
  assertOk: async () => undefined,
}));

import { useVat201Settings } from '@/components/accounting/sars/useVat201Settings';

const noop = (): void => undefined;
let seen = { from: '', ready: false };
function Probe({ held }: { held: { current: boolean } }) {
  const s = useVat201Settings(noop, held);
  seen = { from: s.from, ready: s.settingsReady };
  // The deep link lands first, then the company settings arrive.
  useEffect(() => { if (held.current) { s.setFrom('2026-01-01'); s.setTo('2026-02-28'); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
afterEach(cleanup);

describe('useVat201Settings with a deep link', () => {
  it('a settings load that resolves after the link does not put the default period back', async () => {
    render(<Probe held={{ current: true }} />);
    await act(async () => { gate.release(); });
    await waitFor(() => expect(seen.ready).toBe(true));
    expect(seen.from).toBe('2026-01-01');
  });
  it('without a link the settings default is applied', async () => {
    render(<Probe held={{ current: false }} />);
    await act(async () => { gate.release(); });
    await waitFor(() => expect(seen.ready).toBe(true));
    expect(seen.from).not.toBe('2026-01-01');
  });
});
