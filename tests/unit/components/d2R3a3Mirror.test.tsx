/**
 * D2 round 3 (a3): sent-mirror, capture mirror, audit-packs. Every handler checks the status BEFORE the body:
 * a 400 shows the server's message, an empty-body 500 a plain sentence (no "Network error", no JSON parse
 * error), a 200 takes effect; a failed list load clears the old rows.
 */
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import SentMirrorPage from '../../../pages/accounting/ar/settings/sent-mirror';
import CaptureMirrorPage from '../../../pages/accounting/capture/settings/mirror';
import AuditPacksPage from '../../../pages/accounting/audit-packs/index';
import { MSG, bad, boom, expectNoRawJsonError, ok } from '../helpers/d2CensusG4';
import { trio3 } from '../helpers/d2R3a3';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const CONN = { id: 'c-1', provider: 'imap', displayName: 'D2 Outbound Box', accountEmail: 'box@d2.co.za', status: 'active', sentFolder: 'Sent',
  scanIntervalMinutes: 15, messagesLinkedTotal: 1, messagesCapturedTotal: 2, messagesIngestedTotal: 3, allowedSenders: [], deniedSenders: [],
  lastScanAt: null, lastSuccessAt: null, lastError: null };
const isGet = (init?: RequestInit) => !init?.method || init.method === 'GET';
const fill = (ph: string, value: string, idx = 0) => fireEvent.change(screen.getAllByPlaceholderText(ph)[idx], { target: { value } });
const clickBtn = async (name: RegExp) => fireEvent.click(await screen.findByRole('button', { name }));
const clickTitle = async (t: string) => fireEvent.click(await screen.findByTitle(t));

function mirrorSuite(label: string, Page: () => JSX.Element, list: string, names: { name: string; email: string }, extra: string) {
  const base = (u: string, init?: RequestInit) => (u.includes(list) && isGet(init) && !u.includes('/log') ? ok({ items: [CONN] }) : undefined);
  describe(`${label}: list load`, () => {
    it('a failed reload clears the old rows and shows the server message', async () => {
      let gets = 0;
      vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes(list) && isGet(init)) return ++gets === 1 ? ok({ items: [CONN] }) : bad();
        return ok({});
      });
      render(<Page />);
      expect(await screen.findByText('D2 Outbound Box')).toBeTruthy();
      fireEvent.click(screen.getAllByRole('button')[0]);
      expect((await screen.findAllByText(MSG)).length).toBeGreaterThan(0);
      expect(screen.queryByText('D2 Outbound Box')).toBeNull();
    });
    it('an empty 500 shows a plain sentence', async () => {
      vi.mocked(apiFetch).mockReset().mockImplementation(async () => boom());
      render(<Page />);
      expect(await screen.findByText(new RegExp(`Could not load the ${extra} connections - try again`))).toBeTruthy();
      expectNoRawJsonError();
    });
  });
  describe(`${label}: add connection`, () => {
    const drive = async () => {
      await screen.findByText('D2 Outbound Box');
      await clickBtn(/add imap mailbox/i);
      fill(names.name, 'Box'); fill(names.email, 'a@b.co.za', 0); fill('imap.gmail.com', 'imap.d2.co.za'); fill(names.email, 'user', 1); fill('•••••••••••', 'pw');
      await clickBtn(/^connect$/i);
    };
    trio3({ name: `${label} create`, render: () => render(<Page />), drive, match: (u, i) => u.includes(list) && i?.method === 'POST',
      data: {}, others: base, plain: 'Could not add the connection - try again',
      succeeds: async () => { expect(await screen.findByText(/connection added/i)).toBeTruthy(); },
      stays: () => { expect(screen.queryByText(/connection added/i)).toBeNull(); expect(screen.getByRole('button', { name: /^connect$/i })).toBeTruthy(); } });
  });
  describe(`${label}: scan now`, () => {
    trio3({ name: `${label} scan`, render: () => render(<Page />), drive: async () => { await clickBtn(/scan now/i); },
      match: u => u.includes('scan-now'), data: { scanned: 4, linked: 1, captured: 1, ingested: 2 }, others: base,
      plain: 'Could not run the scan - try again', succeeds: async () => { expect(await screen.findByText(/Scanned 4/)).toBeTruthy(); } });
  });
  describe(`${label}: delete`, () => {
    trio3({ name: `${label} delete`, render: () => { vi.stubGlobal('confirm', () => true); return render(<Page />); }, drive: async () => { await clickTitle('Delete'); },
      match: (u, i) => i?.method === 'DELETE', data: {}, others: base, plain: 'Could not remove the connection - try again',
      succeeds: async () => { expect(await screen.findByText('Removed')).toBeTruthy(); }, stays: () => { expect(screen.queryByText('Removed')).toBeNull(); } });
  });
}

mirrorSuite('sent-mirror', () => <SentMirrorPage />, 'sent-mirror/connections', { name: 'Billing — Outbound', email: 'billing@company.co.za' }, 'sent-mirror');
mirrorSuite('capture mirror', () => <CaptureMirrorPage />, 'capture/mirror', { name: 'Finance Inbox', email: 'billing@company.co.za' }, 'mirror');

describe('capture mirror: disconnect', () => {
  trio3({ name: 'disconnect', render: () => { vi.stubGlobal('confirm', () => true); return render(<CaptureMirrorPage />); }, drive: async () => { await clickTitle('Disconnect'); },
    match: u => u.includes('/disconnect'), data: {}, others: u => (u.includes('capture/mirror') && !u.includes('/disconnect') ? ok({ items: [CONN] }) : undefined),
    plain: 'Could not disconnect the connection - try again', succeeds: async () => { expect(await screen.findByText('Disconnected')).toBeTruthy(); },
    stays: () => { expect(screen.queryByText('Disconnected')).toBeNull(); } });
});

const EXPORT = { id: 'e-1', periodStart: '2031-01-01', periodEnd: '2031-01-31', status: 'ready', jeCount: 1, lineCount: 1, documentCount: 0,
  totalDebits: 1, totalCredits: 1, pdfSha256: null, error: null, requestedAt: '2031-02-01', builtAt: null };
const SESSION = { id: 's-1', auditorEmail: 'auditor-d2@firm.co.za', issuedAt: '2031-02-01', expiresAt: '2031-03-01', revokedAt: null, lastUsedAt: null, useCount: 0 };
const listExports = (u: string, init?: RequestInit) => (u.endsWith('/audit-exports') && isGet(init) ? ok({ exports: [EXPORT] }) : undefined);

describe('audit-packs', () => {
  it('a failed pack list load clears old packs and shows a sentence for an empty 500', async () => {
    let gets = 0;
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/audit-exports') && isGet(init)) return ++gets === 1 ? ok({ exports: [EXPORT] }) : boom();
      return ok({});
    });
    render(<AuditPacksPage />);
    await screen.findByTitle('Invite auditor');
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(await screen.findByText('Could not load the audit packs - try again')).toBeTruthy();
    expect(screen.queryByTitle('Invite auditor')).toBeNull();
    expectNoRawJsonError();
  });
  const create = async () => { await clickBtn(/new pack/i); await clickBtn(/^(build|create|generate)/i); };
  trio3({ name: 'build pack', render: () => render(<AuditPacksPage />), drive: create, match: (u, i) => u.endsWith('/audit-exports') && i?.method === 'POST',
    data: { export: { ...EXPORT, jeCount: 7 } }, others: listExports, plain: 'Could not build the audit pack - try again',
    succeeds: async () => { expect(await screen.findByText(/Pack ready — 7 JEs/)).toBeTruthy(); }, stays: () => { expect(screen.queryByText(/Pack ready/)).toBeNull(); } });

  const invite = async () => {
    fireEvent.click(await screen.findByTitle('Invite auditor'));
    fireEvent.change(await screen.findByPlaceholderText('auditor@firm.co.za'), { target: { value: 'a@firm.co.za' } });
    await clickBtn(/create portal link/i);
  };
  const others = (u: string, init?: RequestInit) => listExports(u, init) ?? (u.includes('/sessions') && isGet(init) ? ok({ sessions: [] }) : undefined);
  trio3({ name: 'invite auditor', render: () => render(<AuditPacksPage />), drive: invite, match: (u, i) => u.includes('/sessions') && i?.method === 'POST',
    data: { portalUrl: 'https://portal.example/D2PORTAL', accessToken: 't' }, others, plain: 'Could not create the auditor invite - try again',
    succeeds: async () => { expect(await screen.findByDisplayValue(/D2PORTAL/)).toBeTruthy(); },
    stays: () => { expect(screen.queryByDisplayValue(/D2PORTAL/)).toBeNull(); } });

  it('invite created but the session refresh fails: the portal link stays and the error is shown', async () => {
    let gets = 0;
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (listExports(u, init)) return ok({ exports: [EXPORT] });
      if (u.includes('/sessions') && init?.method === 'POST') return ok({ portalUrl: 'https://portal.example/D2PORTAL', accessToken: 't' });
      if (u.includes('/sessions')) return ++gets === 1 ? ok({ sessions: [] }) : bad();
      return ok({});
    });
    render(<AuditPacksPage />);
    await invite();
    expect(await screen.findByDisplayValue(/D2PORTAL/)).toBeTruthy();
    expect((await screen.findAllByText(MSG)).length).toBeGreaterThan(0);
  });

  it('revoke succeeds but the session refresh fails: the user is told it was revoked and the old list is cleared', async () => {
    let gets = 0;
    vi.stubGlobal('confirm', () => true);
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (listExports(u, init)) return ok({ exports: [EXPORT] });
      if (u.includes('/sessions/') && init?.method === 'DELETE') return ok({});
      if (u.includes('/sessions')) return ++gets === 1 ? ok({ sessions: [SESSION] }) : boom();
      return ok({});
    });
    render(<AuditPacksPage />);
    fireEvent.click(await screen.findByTitle('Invite auditor'));
    await screen.findByText(/auditor-d2@firm\.co\.za/);
    fireEvent.click(await screen.findByTitle('Revoke'));
    await waitFor(() => expect(screen.getByText(/Session revoked, but the session list did not refresh/)).toBeTruthy());
    expect(screen.queryByText(/auditor-d2@firm\.co\.za/)).toBeNull();
    expectNoRawJsonError();
  });
});
