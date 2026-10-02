// D2 census group 4 (c): a failed load/action shows the server's message (400) or a plain sentence (empty 500), never a blank view or raw JSON.
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { MSG, bad400, empty500, okRes, rawJsonError, router } from '../helpers/d2CensusH4';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: {}, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/SageCommitSummary', () => ({ SageCommitSummary: () => null }));
vi.mock('@/hooks/useAdminPrefix', () => ({ useAdminHref: () => (p: string) => p }));
vi.mock('@/components/accounting/evidence/EvidenceDrillModal', () => ({ EvidenceDrillModal: () => null }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'admin' }, loading: false }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import SageImportPage from '../../../pages/admin/tools/sage-import';
import { AfsReviewTab } from '../../../src/components/accounting/afs/AfsReviewTab';
import { TopUpModal } from '../../../src/components/billing/TopUpModal';
import TrialBalancePage from '../../../pages/accounting/trial-balance/index';

const script = (routes: Array<[string, () => Response]>, fallback: unknown = []) => vi.mocked(apiFetch).mockReset().mockImplementation(router(routes, fallback));
const noRawJson = () => expect(document.body.textContent ?? '').not.toMatch(rawJsonError);
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

describe('Sage import company list', () => {
  const SITE = '/api/admin/companies';
  it('shows the server message on a 400', async () => { script([[SITE, bad400]]); render(<SageImportPage />); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    script([[SITE, empty500]]); render(<SageImportPage />);
    expect(await screen.findByText('Could not load companies - try again')).toBeTruthy(); noRawJson();
  });
  it('offers the companies on success', async () => {
    script([[SITE, () => okRes({ items: [{ id: 'c1', name: 'D2 Target Co' }] })]]); render(<SageImportPage />);
    expect(await screen.findByRole('option', { name: 'D2 Target Co' })).toBeTruthy();
  });
});

describe('AFS review tab', () => {
  const DOC = { id: 'doc-1', status: 'draft', lockedAt: null, version: 1 } as never;
  const SECTION = { id: 's1', sectionType: 'directors_report', status: 'draft' };
  const open = (o: { sections?: () => Response; comments?: () => Response; workflow?: () => Response; onDocUpdate?: () => void }) => {
    script([['/comments', o.comments ?? (() => okRes({ items: [] }))], ['/workflow', o.workflow ?? (() => okRes({}))],
      ['/api/accounting/afs/doc-1', o.sections ?? (() => okRes({ document: { sections: [SECTION] } }))]]);
    render(<AfsReviewTab documentId="doc-1" doc={DOC} onDocUpdate={o.onDocUpdate ?? vi.fn()} />);
  };
  it('shows the server message when the sections load is refused', async () => { open({ sections: bad400 }); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty-500 sections load, not "No sections found"', async () => {
    open({ sections: empty500 }); expect(await screen.findByText('Could not load the sections - try again')).toBeTruthy(); noRawJson();
    expect(screen.queryByText('No sections found for this document.')).toBeNull();
  });
  it('lists the sections on success', async () => { open({}); expect(await screen.findByText('directors report')).toBeTruthy(); });
  const comment = async (onPost: () => Response) => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown, init?: unknown) => {
      if (!String(url).includes('/comments')) return okRes({ document: { sections: [SECTION] } });
      return (init as RequestInit | undefined)?.method === 'POST' ? onPost() : okRes({ items: [] });
    });
    render(<AfsReviewTab documentId="doc-1" doc={DOC} onDocUpdate={vi.fn()} />);
    const input = await screen.findByPlaceholderText('Add comment…');
    fireEvent.change(input, { target: { value: 'D2 note' } }); fireEvent.keyDown(input, { key: 'Enter' });
  };
  it('shows the server message when a comment is refused', async () => { await comment(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence when a comment post gets an empty 500', async () => {
    await comment(empty500); expect(await screen.findByText('Could not post the comment - try again')).toBeTruthy(); noRawJson();
  });
  it('adds the posted comment on success', async () => {
    await comment(() => okRes({ id: 'cm1', body: 'D2 posted note', createdAt: '2026-01-01', resolved: false }));
    expect(await screen.findByText('D2 posted note')).toBeTruthy();
  });
  const submit = async (workflow: () => Response, onDocUpdate = vi.fn()) => {
    open({ workflow, onDocUpdate }); await screen.findByText('directors report'); fireEvent.click(screen.getByRole('button', { name: /Submit for Review/ })); return onDocUpdate;
  };
  it('shows the server message when a workflow action is refused', async () => { await submit(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence when a workflow action gets an empty 500', async () => {
    await submit(empty500); expect(await screen.findByText('Could not complete that action - try again')).toBeTruthy(); noRawJson();
  });
  it('hands the updated document on after a successful workflow action', async () => {
    const fn = await submit(() => okRes({ document: { id: 'doc-1', status: 'in_review' } })); await waitFor(() => expect(fn).toHaveBeenCalledWith({ id: 'doc-1', status: 'in_review' }));
  });
});

describe('Top-up modal bundles', () => {
  const SITE = 'flows/bundles';
  const open = (r: () => Response) => { script([[SITE, r]]); render(<TopUpModal open onClose={vi.fn()} onSuccess={vi.fn()} />); };
  it('shows the server message on a 400', async () => { open(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    open(empty500); expect(await screen.findByText('Could not load the top-up bundles - try again')).toBeTruthy(); noRawJson();
  });
  it('lists the bundles on success', async () => { open(() => okRes([{ id: 'b1', name: 'D2 Starter Pack', flows: 100, priceCents: 5000 }])); expect(await screen.findByText('D2 Starter Pack')).toBeTruthy(); });
});

describe('Trial balance fiscal period list', () => {
  const SITE = 'fiscal-periods';
  const open = (r: () => Response) => { script([[SITE, r]], { items: [], rows: [] }); render(<TrialBalancePage />); };
  it('shows the server message on a 400 instead of a spinner', async () => { open(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    open(empty500); expect(await screen.findByText('Could not load the fiscal periods - try again')).toBeTruthy(); noRawJson();
  });
  it('offers the periods on success', async () => {
    open(() => okRes({ items: [{ id: 'p1', periodName: 'D2 January 2026', startDate: '2026-01-01', endDate: '2026-01-31', status: 'open' }] }));
    expect((await screen.findAllByRole('option', { name: 'D2 January 2026 (open)' })).length).toBeGreaterThan(0);
  });
});
