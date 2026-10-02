// D2 round 12c (2): TopUpModal 2xx success:false shows the server words; VAT201SarsSubmit does not hide a failed
// status check; BulkImportPanel's commit failure says the same sentence on both paths.
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, MSG, ok, on, serve } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: { warning: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/components/accounting/bank/BankAccountSelector', () => ({
  BankAccountSelector: ({ onChange }: { onChange: (id: string, o: unknown) => void }) => {
    useEffect(() => { onChange('acc1', { id: 'acc1', name: 'D2 Bank' }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return <span />;
  },
}));

import { apiFetch } from '@/lib/apiFetch';
import { TopUpModal } from '@/components/billing/TopUpModal';
import { VAT201SarsSubmit } from '@/components/accounting/sars/VAT201SarsSubmit';
import { BulkImportPanel } from '@/components/accounting/bank/BulkImportPanel';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

it('TopUpModal: a 2xx success:false shows the server message, not the fallback', async () => {
  serve(on('GET', '/bundles', () => new Response(JSON.stringify({ success: false, error: { message: MSG } }), { status: 200 })));
  render(<TopUpModal open onClose={vi.fn()} onSuccess={vi.fn()} />);
  expect(await screen.findByText(MSG)).toBeDefined();
});

describe('VAT201SarsSubmit efiling-status', () => {
  const ui = () => render(<VAT201SarsSubmit submissionId="s1" exceptionsReady exceptionsClean />);
  it('a 500 shows the error and a Retry that reveals the panel once armed', async () => {
    let n = 0;
    serve((u, m) => (m === 'GET' && u.includes('efiling-status') ? (n++ === 0 ? empty500() : ok({ configured: true })) : undefined));
    ui();
    expect(await screen.findByText('Could not check whether SARS e-filing is set up - try again')).toBeDefined();
    expect(screen.queryByTestId('sars-submit-section')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('sars-submit-section')).toBeDefined();
  });
  it('a clean "not configured" still renders nothing', async () => {
    serve(on('GET', 'efiling-status', () => ok({ configured: false })));
    const { container } = ui();
    await vi.waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 50));
    expect(container.innerHTML).toBe('');
  });
});

describe('BulkImportPanel commit failure', () => {
  const run = async (commit: () => Response | Promise<never>) => {
    serve(
      on('POST', 'bulk-preview', () => ok({ accountMatch: 'match', totalParsed: 1, rowHashes: [] })),
      on('POST', 'bulk-commit', commit as () => Response),
    );
    const { container } = render(<BulkImportPanel />);
    const input = container.querySelectorAll('input[type=file]')[1] as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['date,amount\n2026-01-01,10'], 'd2-statement.csv', { type: 'text/csv' })] } });
    await screen.findByText('d2-statement.csv');
    fireEvent.click(await screen.findByRole('button', { name: /Import 1 statement/ }));
  };
  it('an empty 500 says "Could not import this statement - try again"', async () => {
    await run(empty500);
    expect(await screen.findByText('Could not import this statement - try again')).toBeDefined();
  });
  it('a thrown request says the same sentence', async () => {
    await run(() => { throw new Error('socket hang up'); });
    expect(await screen.findByText('Could not import this statement - try again')).toBeDefined();
  });
});
