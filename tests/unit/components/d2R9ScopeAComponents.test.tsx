// D2 round 9 (scope A): every changed behaviour below goes RED when its source change is reverted.
//   AccountRow keeps the editor open when the parent reports a failed save; AfsExportTab fetches the export and says
//   when it is refused; CaptureApiKeysSection renders keys from a 200 envelope; ExchangeRatesPanel's empty-5xx convert
//   does not claim "no rate"; EvidenceDrillModal's JE detail shows the server's refusal; VatPeriodLocksTable/Panel unlock
//   reports a rejection; ShareLinkDialog create says "create"; VAT201 panels say what failed; ErrorBoundary never shows
//   error.message; CaptureInboxPanel reports a failed supplier-rule load; VatPeriodLockForm reports a failed count.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, expectNoJargon, MSG, ok, on, refuse, serve } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1' }) }));
vi.mock('@/components/useModalDialog', () => ({ useModalDialog: () => ({ current: null }) }));

import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { notify } from '@/utils/toast';
import { AccountRow } from '@/components/accounting/dashboard/AccountRow';
import { AfsExportTab } from '@/components/accounting/afs/AfsExportTab';
import { CaptureApiKeysSection } from '@/components/accounting/capture/CaptureApiKeysSection';
import { ExchangeRatesPanel } from '@/components/accounting/currencies/ExchangeRatesPanel';
import { EvidenceDrillModal } from '@/components/accounting/evidence/EvidenceDrillModal';
import { VatPeriodLocksTable } from '@/components/accounting/sars/VatPeriodLocksTable';
import { VatPeriodLocksPanel } from '@/components/accounting/sars/VatPeriodLocksPanel';
import { VatPeriodLockForm } from '@/components/accounting/sars/VatPeriodLockForm';
import { ShareLinkDialog } from '@/components/accounting/share/ShareLinkDialog';
import { VAT201ExceptionsPanel } from '@/components/accounting/sars/VAT201ExceptionsPanel';
import { VAT201SarsSubmit } from '@/components/accounting/sars/VAT201SarsSubmit';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { CaptureInboxPanel, type CaptureEventRow } from '@/components/accounting/capture/CaptureInboxPanel';
import { RollbackButton } from '@/components/accounting/migration/WizardParts';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); vi.mocked(notify.error).mockClear(); vi.mocked(log.warn).mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AccountRow editor', () => {
  const account = { id: 'a1', accountCode: '5000', accountName: 'Rent', accountType: 'expense', normalBalance: 'debit', level: 3,
    isActive: true, isSystemAccount: false, children: [] } as never;
  const open = (onUpdate: () => Promise<boolean>) => {
    render(<table><tbody><AccountRow account={account} level={0} viewMode="flat" parentOptions={[]} onUpdate={onUpdate} onDelete={async () => true as never} /></tbody></table>);
    fireEvent.click(screen.getByTitle('Edit'));
    fireEvent.click(screen.getByTitle('Save'));
  };
  it('a failed save (onUpdate resolves false) keeps the editor open with the typed edits', async () => {
    const onUpdate = vi.fn().mockResolvedValue(false);
    open(onUpdate);
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByTitle('Save') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTitle('Save')).toBeTruthy();
  });
  it('a saved edit (onUpdate resolves true) closes the editor', async () => {
    open(vi.fn().mockResolvedValue(true));
    await waitFor(() => expect(screen.queryByTitle('Save')).toBeNull());
    expect(screen.getByTitle('Edit')).toBeTruthy();
  });
});

describe('AfsExportTab', () => {
  const click = () => { render(<AfsExportTab documentId="d-1" fiscalYear={2026} />); fireEvent.click(screen.getAllByRole('button', { name: /download/i })[0]!); };
  it('a refused export (400) shows the server message and never says Downloaded', async () => {
    serve(on('GET', '/export?format=pdf', () => refuse()));
    click();
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText('Downloaded')).toBeNull();
  });
  it('an empty 500 shows a plain sentence', async () => {
    serve(on('GET', '/export?format=pdf', empty500));
    click();
    expect(await screen.findByText('Could not generate the export - try again')).toBeDefined();
    expectNoJargon();
  });
  it('a 200 is fetched and saved as a blob, then reads Downloaded', async () => {
    const create = vi.fn(() => 'blob:afs'); const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    serve(on('GET', '/export?format=pdf', () => new Response('%PDF-1.4', { status: 200, headers: { 'Content-Disposition': 'attachment; filename="afs-d-1.pdf"' } })));
    click();
    expect(await screen.findByText('Downloaded')).toBeDefined();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('CaptureApiKeysSection', () => {
  const KEYS = [{ id: 'k1', label: 'FibreFlow PWA', key_prefix: 'isa_abc1', is_active: true, last_used_at: null, created_at: '2026-09-01T00:00:00Z' }];
  it('200: the keys from the envelope are rendered', async () => {
    serve(on('GET', 'capture/api-keys', () => ok(KEYS)));
    render(<CaptureApiKeysSection showToast={vi.fn()} />);
    expect(await screen.findByText('FibreFlow PWA')).toBeDefined();
    expect(screen.getByText(/isa_abc1/)).toBeDefined();
  });
});

describe('ExchangeRatesPanel convert', () => {
  const CUR = [{ code: 'ZAR', name: 'Rand', symbol: 'R', decimalPlaces: 2, isActive: true }, { code: 'USD', name: 'Dollar', symbol: '$', decimalPlaces: 2, isActive: true }] as never;
  const convert = () => {
    render(<ExchangeRatesPanel currencies={CUR} exchangeRates={[]} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('100'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
  };
  it('empty 500 says the conversion could not be done, not that no rate exists', async () => {
    serve(on('GET', 'convert=true', empty500));
    convert();
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Could not convert the amount - try again'));
  });
  it('200 shows the converted amount', async () => {
    serve(on('GET', 'convert=true', () => ok({ converted: 900, rate: 18 })));
    convert();
    expect(await screen.findByText('@ 18')).toBeDefined();
  });
});

describe('EvidenceDrillModal JE detail', () => {
  const ROW = { jeId: 'je-1', entryDate: '2026-09-01', entryNumber: 'JE1', description: 'Rent', debit: 10, credit: 0, postingAgent: 'human', extractionConfidence: null,
    sourceDocumentId: 'doc-1', documentVendor: 'Landlord', documentReference: null };
  it('a refused JE detail shows the server message', async () => {
    serve(on('GET', 'evidence/je/', () => refuse()), on('GET', '/evidence', () => ok({ rows: [ROW] })));
    render(<EvidenceDrillModal accountId="a" accountName="Rent" periodStart="2026-09-01" periodEnd="2026-09-30" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Landlord/ }));
    expect(await screen.findByText(MSG)).toBeDefined();
  });
  it('an empty 500 JE detail shows a plain sentence', async () => {
    serve(on('GET', 'evidence/je/', empty500), on('GET', '/evidence', () => ok({ rows: [ROW] })));
    render(<EvidenceDrillModal accountId="a" accountName="Rent" periodStart="2026-09-01" periodEnd="2026-09-30" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Landlord/ }));
    expect(await screen.findByText('Could not load JE detail - try again')).toBeDefined();
  });
});

describe('VAT period unlock', () => {
  const LOCK = { id: 'l1', periodStart: '2026-03-01', periodEnd: '2026-04-30', outputTax: 10, inputTax: 4, netVat: 6, lockedByName: 'Hein', lockedAt: '2026-05-01T00:00:00Z',
    active: true, notes: null, unlockedAt: null, unlockedByName: null, unlockReason: null } as never;
  const unlockVia = async (screenRender: () => void) => {
    screenRender();
    fireEvent.click(await screen.findByRole('button', { name: /^Unlock$/ }));
    fireEvent.change(screen.getByLabelText(/Reason \(required\)/), { target: { value: 'wrong figures' } });
    fireEvent.click(screen.getAllByRole('button', { name: /unlock/i }).at(-1)!);
  };
  it('table: a rejected onUnlock shows a sentence and frees the button (was an unhandled rejection)', async () => {
    await unlockVia(() => render(<VatPeriodLocksTable locks={[LOCK]} onUnlock={() => Promise.reject(new TypeError('Failed to fetch'))} />));
    expect(await screen.findByText('Could not unlock the VAT period - try again')).toBeDefined();
    expect(document.body.textContent).not.toContain('Failed to fetch');
  });
  it('table: a 200 unlock closes the confirm box', async () => {
    await unlockVia(() => render(<VatPeriodLocksTable locks={[LOCK]} onUnlock={() => Promise.resolve(null)} />));
    await waitFor(() => expect(screen.queryByLabelText(/Reason \(required\)/)).toBeNull());
  });
  const panel = async (post: () => Response) => {
    serve(on('GET', 'vat-period-locks', () => ok({ locks: [LOCK] })), on('POST', 'vat-period-locks', post));
    await unlockVia(() => render(<VatPeriodLocksPanel />));
  };
  it('panel: empty 500 says what failed', async () => {
    await panel(empty500);
    await screen.findByText('Could not unlock the VAT period - try again');
    expectNoJargon();
  });
  it('panel: a thrown request (network) says what failed', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
      if ((init as RequestInit | undefined)?.method === 'POST') throw new TypeError('Failed to fetch');
      void url; return ok({ locks: [LOCK] });
    });
    await unlockVia(() => render(<VatPeriodLocksPanel />));
    await screen.findByText('Could not unlock the VAT period - try again');
  });
  it('panel: a 400 shows the server message', async () => {
    await panel(() => refuse());
    expect(await screen.findByText(MSG)).toBeDefined();
  });
  it('panel: a failed list load clears stale rows and says why', async () => {
    serve(on('GET', 'vat-period-locks', empty500));
    render(<VatPeriodLocksPanel />);
    expect(await screen.findByText('Could not load the VAT period locks - try again')).toBeDefined();
    expect(screen.queryByText(/Hein/)).toBeNull();
  });
});

describe('VatPeriodLockForm exception count', () => {
  const pick = () => {
    const { container } = render(<VatPeriodLockForm onLock={vi.fn().mockResolvedValue(null)} />);
    fireEvent.change(container.querySelector('input[name="periodStart"]')!, { target: { value: '2026-03-01' } });
    fireEvent.change(container.querySelector('input[name="periodEnd"]')!, { target: { value: '2026-04-30' } });
  };
  it('a failed count says it could not check instead of silently showing nothing', async () => {
    serve(on('GET', 'vat-exceptions', empty500));
    pick();
    expect(await screen.findByText(/Could not check the VAT exceptions for this period/)).toBeDefined();
  });
  it('a network failure is also told', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new TypeError('Failed to fetch'));
    pick();
    expect(await screen.findByText(/Could not check the VAT exceptions for this period/)).toBeDefined();
  });
  it('a good count shows no notice', async () => {
    serve(on('GET', 'vat-exceptions', () => ok({ totalExceptions: 0 })));
    pick();
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
    expect(screen.queryByText(/Could not check the VAT exceptions/)).toBeNull();
  });
});

describe('ShareLinkDialog create', () => {
  it('an empty 500 on create says "create", not "load"', async () => {
    serve(on('GET', 'share/links', () => ok({ links: [] })), on('POST', 'share/links', empty500));
    render(<ShareLinkDialog params={{ packType: 'board', from: '2026-01-01', to: '2026-01-31' } as never} onClose={vi.fn()} />);
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /^create/i }));
    expect(await screen.findByText('Could not create the share link - try again')).toBeDefined();
  });
});

describe('VAT201 panels', () => {
  it('exceptions: an empty 500 says it could not load the exceptions', async () => {
    serve(on('GET', 'vat-exceptions', empty500));
    render(<VAT201ExceptionsPanel from="2026-03-01" to="2026-04-30" reloadKey={1} />);
    expect(await screen.findByText('Could not load exceptions - try again')).toBeDefined();
    expect(screen.queryByText(/something went wrong/i)).toBeNull();
  });
  it('SARS submit: an empty 500 says the VAT201 was not submitted', async () => {
    serve(on('GET', 'efiling-status', () => ok({ configured: true })), on('POST', 'efiling-submit', empty500));
    render(<VAT201SarsSubmit submissionId="s-1" exceptionsReady exceptionsClean />);
    fireEvent.click(await screen.findByTestId('sars-submit-btn'));
    expect(await screen.findByText('Could not submit the VAT201 to SARS - try again')).toBeDefined();
  });
  it('SARS submit: a network failure says the same', async () => {
    vi.mocked(apiFetch).mockImplementation(async (_u: unknown, init?: unknown) => {
      if ((init as RequestInit | undefined)?.method === 'POST') throw new TypeError('Failed to fetch');
      return ok({ configured: true });
    });
    render(<VAT201SarsSubmit submissionId="s-1" exceptionsReady exceptionsClean />);
    fireEvent.click(await screen.findByTestId('sars-submit-btn'));
    expect(await screen.findByText('Could not submit the VAT201 to SARS - try again')).toBeDefined();
  });
});

describe('RollbackButton', () => {
  it('an empty 500 says the import could not be rolled back', async () => {
    vi.stubGlobal('confirm', () => true);
    serve(on('POST', 'migration-rollback', empty500));
    render(<RollbackButton source={'sage' as never} />);
    fireEvent.click(screen.getByRole('button'));
    expect(await screen.findByText('Could not roll back the import - try again')).toBeDefined();
  });
});

describe('ErrorBoundary', () => {
  it('shows a plain sentence, never the raw render error', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Boom = (): ReactNode => { throw new Error("Cannot read properties of undefined (reading 'map')"); };
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByText(/This page hit a problem/)).toBeDefined();
    expect(document.body.textContent).not.toContain('Cannot read properties');
    expect(log.error).toHaveBeenCalled();
    quiet.mockRestore();
  });
});

describe('CaptureInboxPanel supplier rule', () => {
  const EVENT = { eventId: 'e1', receivedAt: '2026-09-01T00:00:00Z', channel: 'email', sender: 's', subject: 'x', status: 'extracted', capturedDocumentId: 'd1', error: null,
    vendorName: 'V', documentDate: null, referenceNumber: 'R1', totalAmount: 10, documentType: 'invoice', extractedData: null, resolvedSupplierId: 'sup-1' } as CaptureEventRow;
  const open = () => render(<CaptureInboxPanel event={EVENT} onClose={vi.fn()} onPost={vi.fn()} onDiscard={vi.fn()} posting={false} discarding={false} />);
  it('a 500 on the rule load is reported, not shown as "no rule"', async () => {
    serve(on('GET', 'supplier-rules/sup-1', empty500));
    open();
    expect(await screen.findByText(/Could not load this supplier's auto-publish rule/)).toBeDefined();
    expect(screen.queryByText('No rule configured for this supplier')).toBeNull();
  });
  it('a 404 is the ordinary "no rule" state', async () => {
    serve(on('GET', 'supplier-rules/sup-1', () => new Response('', { status: 404 })));
    open();
    expect(await screen.findByText('No rule configured for this supplier')).toBeDefined();
    expect(screen.queryByText(/Could not load this supplier/)).toBeNull();
  });
  it('a 200 rule with auto-publish on reads as eligible', async () => {
    serve(on('GET', 'supplier-rules/sup-1', () => ok({ autoPublish: true, autoPublishMaxAmount: null, autoPublishMinConfidence: 0.5, requirePoMatch: false })));
    open();
    expect(await screen.findByText('Auto-publish eligible')).toBeDefined();
  });
});
