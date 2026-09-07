/**
 * A refused pack download reaches the reader as the REASON, not as a file.
 *
 * The figure integrity gate (spec §7.2) refuses to render a pack whose
 * balance sheet does not foot, and it is right to — a real client's is out by
 * R450, and that sentence is the entire value of the gate. What the first
 * rendered proof found is that the sentence never arrived. Two independent
 * failures, both exercised below:
 *
 *   1. The download path blobbed whatever came back. A JSON 500 body blobs
 *      perfectly well, so the user received a corrupt file named `.pdf`
 *      instead of a message. `assertOk` runs BEFORE `blob()` for that reason,
 *      and the real `assertOk` is used here rather than the module mock the
 *      sibling suites install — a stubbed `assertOk` would make this test
 *      pass on exactly the code that shipped the corrupt file.
 *   2. What `assertOk` threw was written to the console and dropped. The
 *      reader watched the spinner stop and saw nothing at all.
 *
 * So the assertions are: the gate's own words are ON SCREEN, and nothing was
 * handed to the browser to save.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const useRouterMock = vi.fn();
vi.mock('next/router', () => ({ useRouter: () => useRouterMock() }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'viewer' }) }));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const apiFetchMock = vi.fn();
// `apiFetch` is stubbed; `assertOk` is NOT — it is the function under test as
// much as the screen is. See the file header.
vi.mock('@/lib/apiFetch', async () => {
  const actual = await vi.importActual<typeof import('@/lib/apiFetch')>('@/lib/apiFetch');
  return { ...actual, apiFetch: (...a: unknown[]) => apiFetchMock(...a) };
});

import ReportPacksPage from '../../../../pages/accounting/reports/report-packs';

/** The real refusal, from the rendered proof against Brightsphere. */
const REFUSAL =
  'Pack figure integrity failed, so this render is refused (spec §7.2). 1 problem:\n' +
  "  The balance sheet does not foot: assets do not equal liabilities plus equity. " +
  "'packFigureSet.current.totalAssets' states 3191495.16 but " +
  '+ packFigureSet.current.totalLiabilities 5368200.63 ' +
  '+ packFigureSet.current.totalEquity -2176255.47 comes to 3191945.16.';

const PACK = {
  type: 'board',
  companyName: 'Brightsphere',
  period: '2026-01-01 to 2026-09-05',
  generatedAt: '2026-09-06T00:00:00.000Z',
  sections: [{ type: 'commentary', title: 'Commentary', data: { summary: 'All good.' } }],
};

const packLoad = {
  status: 200,
  ok: true,
  headers: { get: () => null },
  json: async () => ({ data: { pack: PACK, unclassifiedAccounts: null } }),
};

/** What the PDF route now answers with: 422, the gate's message verbatim. */
function refusal() {
  return {
    status: 422,
    ok: false,
    headers: { get: () => null },
    text: async () => JSON.stringify({
      success: false,
      error: { code: 'BUSINESS_RULE_VIOLATION', message: REFUSAL },
    }),
    blob: vi.fn(async () => new Blob(['irrelevant'])),
  };
}

beforeEach(() => {
  apiFetchMock.mockReset();
  useRouterMock.mockReset();
  useRouterMock.mockReturnValue({ isReady: true, pathname: '/accounting/reports/report-packs', query: {} });
});

async function loadedScreen() {
  apiFetchMock.mockResolvedValue(packLoad);
  render(<ReportPacksPage />);
  await waitFor(() => expect(screen.getByText(/Brightsphere/)).toBeInTheDocument());
}

describe('Report Packs — a PDF the integrity gate refused', () => {
  it("puts the gate's own sentence on screen, amount and accounts intact", async () => {
    await loadedScreen();

    apiFetchMock.mockResolvedValue(refusal());
    screen.getByRole('button', { name: /PDF/ }).click();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not be downloaded/);
    // The figures are what make the message actionable: a director can hand
    // this to their bookkeeper and it names the break. A paraphrase would not.
    expect(alert).toHaveTextContent(/does not foot/);
    expect(alert).toHaveTextContent(/3191495\.16/);
    expect(alert).toHaveTextContent(/3191945\.16/);
  });

  it('hands the browser nothing to save — no blob, no object URL', async () => {
    await loadedScreen();

    const response = refusal();
    apiFetchMock.mockResolvedValue(response);
    const createObjectUrl = vi.fn(() => 'blob:never');
    const original = URL.createObjectURL;
    URL.createObjectURL = createObjectUrl as unknown as typeof URL.createObjectURL;

    try {
      screen.getByRole('button', { name: /PDF/ }).click();
      await screen.findByRole('alert');
      // This is the corrupt-download defect stated directly: the JSON error
      // body must never become a file. Reading it as a blob at all is the
      // step that produced `board-brightsphere.pdf` holding a 500 body.
      expect(response.blob).not.toHaveBeenCalled();
      expect(createObjectUrl).not.toHaveBeenCalled();
    } finally {
      URL.createObjectURL = original;
    }
  });

  it('shows no refusal notice when the download succeeds', async () => {
    await loadedScreen();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
