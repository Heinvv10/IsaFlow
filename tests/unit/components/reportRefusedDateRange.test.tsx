// Refuse one date of a report's range and change the other: nothing runs, the report goes, and fixing the date runs
// the new range exactly once. Before this the changed date ran the report on the refused date's previous value,
// under a notice saying the report was for the previous filters. Pages are in reportRangePages.ts.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { typeDate } from '../helpers/dateFields';
import { gatePage, serve, settle } from '../helpers/reportDateGatePages';
import { RANGE_PAGES, type RangePage } from '../helpers/reportRangePages';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
const route = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true, push: vi.fn(), pathname: '/' }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', loading: false, activeCompany: { id: 'c1', vatPeriod: 'monthly', vatSystemType: 'invoice' } }) }));
vi.mock('@/components/accounting/charts/CashPositionChart', () => ({ CashPositionChart: () => <div /> }));

const SHOWN = /Fix the date marked in red: the report shown/;
const NOT_RUN = 'Fix the date marked in red to run the report.';
const NOW = 'REPORT-NOW';
const LATE = 'REPORT-LATE';
// Dates no page opens on, whatever day this runs: the 3rd is no month start, and next January is no today.
const year = new Date().getFullYear();
const FROM_A = `${year}-02-03`;
const FROM_B = `${year}-03-03`;
const TO_A = `${year + 1}-01-15`;
const TO_B = `${year + 1}-01-16`;

const textbox = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement;
const urls = (path: string) => vi.mocked(apiFetch).mock.calls.map(([url]) => String(url)).filter((url) => url.includes(path));
const body = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

async function open(page: RangePage) {
  const gate = gatePage(page.file);
  serve({ ...gate, data: page.data(NOW) });
  const { default: Page } = await gate.load();
  render(<Page />);
  await screen.findByText(NOW);
  await settle();
}

beforeAll(async () => { await Promise.all(RANGE_PAGES.map((p) => gatePage(p.file).load())); }, 120_000);
beforeEach(() => { route.query = {}; });
afterEach(cleanup);

describe.each(RANGE_PAGES)('$file', (page) => {
  const { paths, fromParam, toParam } = page;
  const summary = () => (page.summary ? screen.queryByText(page.summary) : null);
  const notice = () => (page.notice ? screen.queryByTestId(page.notice) : null);

  it.each([
    { refused: 'From', other: 'To', changed: TO_A, fixed: FROM_A, from: FROM_A, to: TO_A },
    { refused: 'To', other: 'From', changed: FROM_A, fixed: TO_A, from: FROM_A, to: TO_A },
  ])('$refused refused, $other changed: no request, no report; the fix runs the new range once', async ({ refused, other, changed, fixed, from, to }) => {
    await open(page);
    if (page.summary) expect(summary()).toBeTruthy();
    if (page.notice) expect(notice()).toBeTruthy();
    const before = paths.map((path) => urls(path).length);

    typeDate(textbox(refused), 'zz');
    await screen.findByText(SHOWN);
    typeDate(textbox(other), changed);
    await settle();
    expect(paths.map((path) => urls(path).length)).toEqual(before);
    expect(screen.queryByText(NOW)).toBeNull();
    expect(summary()).toBeNull();
    expect(notice()).toBeNull();
    expect(screen.getByText(NOT_RUN)).toBeTruthy();

    typeDate(textbox(refused), fixed);
    await screen.findByText(NOW);
    await settle();
    expect(paths.map((path) => urls(path).length)).toEqual(before.map((n) => n + 1));
    for (const path of paths) {
      const last = urls(path).at(-1)!;
      expect(last).toContain(`${fromParam}=${from}`);
      expect(last).toContain(`${toParam}=${to}`);
    }
    expect(screen.queryByText(NOT_RUN)).toBeNull();
  });

  it('a refusal that ends on the same range keeps the report and sends nothing', async () => {
    await open(page);
    const field = textbox('From');
    const shown = field.value;
    const before = urls(paths[0]!).length;
    typeDate(field, 'zz');
    await screen.findByText(SHOWN);
    expect(screen.getByText(NOW)).toBeTruthy();
    typeDate(field, shown);
    await waitFor(() => expect(screen.queryByText(SHOWN)).toBeNull());
    await settle();
    expect(urls(paths[0]!).length).toBe(before);
    expect(screen.getByText(NOW)).toBeTruthy();
  });

  it('an older response does not replace the range that followed it', async () => {
    await open(page);
    const base = vi.mocked(apiFetch).getMockImplementation()!;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(apiFetch).mockImplementation(async (url, ...rest) => {
      if (!String(url).includes(`${toParam}=${TO_A}`)) return base(url, ...rest);
      await held;
      return body({ data: page.data(LATE) });
    });
    typeDate(textbox('To'), TO_A);
    await waitFor(() => expect(urls(paths[0]!).some((url) => url.includes(TO_A))).toBe(true));
    typeDate(textbox('To'), TO_B);
    await screen.findByText(NOW);
    release();
    await settle();
    expect(screen.queryByText(LATE)).toBeNull();
    expect(screen.getByText(NOW)).toBeTruthy();
  });

  it('a load that failed is retried when a refusal ends on the same range', async () => {
    await open(page);
    const base = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url, ...rest) => (String(url).includes(`${toParam}=${TO_A}`)
      ? body({ success: false, error: { message: 'Refused' } }, 500) : base(url, ...rest)));
    typeDate(textbox('To'), TO_A);
    await screen.findByText(/Refused/);
    await settle();
    const field = textbox('From');
    const shown = field.value;
    const before = urls(paths[0]!).length;
    typeDate(field, 'zz');
    await waitFor(() => expect(field.getAttribute('aria-invalid')).toBe('true'));
    typeDate(field, shown);
    await waitFor(() => expect(urls(paths[0]!).length).toBe(before + 1));
  });
});

it('management-accounts: Run runs the same range again, once', async () => {
  await open(RANGE_PAGES.find((p) => p.file === 'management-accounts')!);
  const before = urls('reports-management-accounts');
  fireEvent.click(screen.getByRole('button', { name: /^Run$/ }));
  await waitFor(() => expect(urls('reports-management-accounts').length).toBe(before.length + 1));
  await settle();
  expect(urls('reports-management-accounts').length).toBe(before.length + 1);
  expect(urls('reports-management-accounts').at(-1)).toBe(before.at(-1));
});
