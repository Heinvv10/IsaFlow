/**
 * D2 round 3 (a7): the onboarding wizard's one submit (POST /api/onboarding/complete-setup, a single transaction)
 * must show the server's message on a failure, never navigate on one, and a Retry must re-send the same request key
 * (so a retry after a lost response can never create a second company). Setup-guide ticks and the top-up purchase
 * check the status before the body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, empty500, expectNoRawError, ok, refuse, script } from '../helpers/d2R3a5';

configure({ asyncUtilTimeout: 4000 });
const loc = vi.hoisted(() => ({ href: '', search: '?new=1', replace: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/contexts/CompanyContext', () => { const v = { activeCompany: { id: 'co-1' }, companies: [], switchCompany: vi.fn() }; return { useCompany: () => v }; });
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/components/onboarding/SmartSetupChoice', () => ({ SmartSetupChoice: ({ onManual }: { onManual: () => void }) => <button onClick={onManual}>manual setup</button> }));
const OLD_ENDPOINTS = ['/api/accounting/companies', 'coa-seed', 'company-directors', 'onboarding/complete'];
vi.mock('@/components/onboarding/WizardSteps', async (orig) => {
  const real = await orig<typeof import('@/components/onboarding/WizardSteps')>();
  const Nothing = () => null;
  return {
    ...real, Step2: Nothing, Step3: Nothing, Step4: Nothing, Step5: Nothing, Step6: Nothing, Step7: Nothing, StepCoaTemplate: Nothing,
    Step1: ({ set }: { set: (k: string, v: unknown) => void }) => (<>
      <button onClick={() => { set('name', 'D2 Co'); set('directors', [{ name: 'D2 Director' }]); set('documents', [{ type: 'cipc_certificate', name: 'c.pdf' }]); }}>fill company</button>
      <button onClick={() => { set('name', 'D2 Co'); set('documents', [{ type: 'cipc_certificate', name: 'c.pdf', size: 16 * 1024 * 1024 }, { type: 'tax_clearance', name: 't.pdf', size: 15 * 1024 * 1024 }]); }}>fill huge</button>
    </>),
  };
});

import { apiFetch } from '@/lib/apiFetch';
import OnboardingWizard from '../../../pages/onboarding/index';
import { SetupGuideButton } from '../../../src/components/onboarding/SetupGuideButton';
import { TopUpModal } from '../../../src/components/billing/TopUpModal';

useApiJsonOverMock();
beforeEach(() => { loc.href = ''; vi.stubGlobal('location', loc); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const click = async (name: RegExp | string) => fireEvent.click(await screen.findByRole('button', { name }));
const postsTo = (u: string) => vi.mocked(apiFetch).mock.calls.filter(([x, i]) => String(x).endsWith(u) && i?.method === 'POST');
const posts = (u: string) => postsTo(u).length;
const SETUP = '/api/onboarding/complete-setup';

/** me -> wizard; complete-setup answers with `answer` (default: a created company). */
const wizard = (answer: () => Response = () => ok({ companyId: 'co-new', replayed: false })) => script((u, m) => {
  if (u.includes('/api/auth/me')) return ok({ user: { onboarding_completed: false } });
  if (m !== 'POST') return undefined;
  return u.includes(SETUP) ? answer() : ok({});
});
const toLastStep = async () => {
  fireEvent.click(await screen.findByRole('radio', { name: /Private company \(Pty\) Ltd/ }));
  await click(/continue/i);
  await click('manual setup'); await click('fill company');
  for (let i = 0; i < 6; i++) await click(/continue/i);
  await click(/complete setup/i);
};

describe('onboarding submit', () => {
  it('complete-setup 400: the server message, no navigation, and no call to the old step-by-step endpoints', async () => {
    wizard(refuse); render(<OnboardingWizard />); await toLastStep();
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(OLD_ENDPOINTS.map(posts)).toEqual([0, 0, 0, 0]);
    expect(loc.href).toBe('');
  });
  it('complete-setup empty-body 500: a plain sentence', async () => {
    wizard(empty500); render(<OnboardingWizard />); await toLastStep();
    expect(await screen.findByText('Could not finish setting up your company - try again')).toBeTruthy();
    expectNoRawError(); expect(loc.href).toBe('');
  });
  it('a 200 with no company id is a failure, not a navigation', async () => {
    wizard(() => ok({})); render(<OnboardingWizard />); await toLastStep();
    expect(await screen.findByText('The company was not set up - try again')).toBeTruthy();
    expect(loc.href).toBe('');
  });
  it('200: one request carries the business type, people and documents, then the wizard navigates', async () => {
    wizard(); render(<OnboardingWizard />); await toLastStep();
    await waitFor(() => expect(loc.href).toBe('/accounting'));
    expect(posts(SETUP)).toBe(1);
    expect(OLD_ENDPOINTS.map(posts)).toEqual([0, 0, 0, 0]);
    const body = JSON.parse(String(postsTo(SETUP)[0]![1]!.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      entityType: 'pty_ltd', coaTemplate: 'isaflow_standard', company: { name: 'D2 Co' },
      people: [{ name: 'D2 Director' }], documents: [{ type: 'cipc_certificate', name: 'c.pdf' }],
    });
    expect(String(body.requestKey)).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('after success the Complete Setup button stays busy while the page navigates (no second submit)', async () => {
    wizard(); render(<OnboardingWizard />); await toLastStep();
    await waitFor(() => expect(loc.href).toBe('/accounting'));
    expect(screen.queryByRole('button', { name: /complete setup/i })).toBeNull();
    expect((screen.getByRole('button', { name: /saving/i }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('a dropped connection says what could not be done and frees the button', async () => {
    script((u, m) => {
      if (u.includes('/api/auth/me')) return ok({ user: { onboarding_completed: false } });
      if (m === 'POST' && u.includes(SETUP)) throw new Error('socket hang up');
      return undefined;
    });
    render(<OnboardingWizard />); await toLastStep();
    expect(await screen.findByText('Could not finish setting up your company - try again')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Something went wrong|socket hang up/);
    await waitFor(() => expect((screen.getByRole('button', { name: /complete setup/i }) as HTMLButtonElement).disabled).toBe(false));
  });
  it('more than 30 MB of files: the message shows before any request is sent', async () => {
    wizard(); render(<OnboardingWizard />);
    fireEvent.click(await screen.findByRole('radio', { name: /Private company \(Pty\) Ltd/ }));
    await click(/continue/i); await click('manual setup'); await click('fill huge');
    for (let i = 0; i < 6; i++) await click(/continue/i);
    await click(/complete setup/i);
    expect(await screen.findByText('The uploaded files are larger than 30 MB together. Remove or shrink some and try again.')).toBeTruthy();
    expect(posts(SETUP)).toBe(0); expect(loc.href).toBe('');
  });
  it('Retry after a failure re-sends the same request key, so the server can never make a second company', async () => {
    let n = 0;
    wizard(() => (++n === 1 ? empty500() : ok({ companyId: 'co-new', replayed: true })));
    render(<OnboardingWizard />); await toLastStep();
    await screen.findByText('Could not finish setting up your company - try again');
    await click(/complete setup/i);
    await waitFor(() => expect(loc.href).toBe('/accounting'));
    const keys = postsTo(SETUP).map(([, i]) => (JSON.parse(String(i!.body)) as { requestKey: string }).requestKey);
    expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
  });
});

describe('SetupGuideButton', () => {
  const PREFS = { 'setup-guide-first-seen': new Date().toISOString() };
  const guide = (put: () => Response, load?: (u: string) => Response | undefined) => script((u, m) =>
    (m === 'PUT' ? put() : load?.(u) ?? (u.includes('setup-guide') ? ok({ completedTasks: [] }) : ok(PREFS))));
  const openAndMark = async () => {
    render(<SetupGuideButton />);
    fireEvent.click(await screen.findByLabelText(/setup guide . \d+ tasks remaining/i));
    fireEvent.click((await screen.findAllByRole('button', { name: /^done$/i }))[0]!);
  };
  it('a refused save (400) shows the server message and takes the tick back', async () => {
    guide(refuse); await openAndMark();
    expect(await screen.findByText(MSG)).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText(/setup guide . 21 tasks remaining/i)).toBeTruthy());
  });
  it('an empty-body 500 shows a plain sentence', async () => {
    guide(empty500); await openAndMark();
    expect(await screen.findByText('Could not save that task - try again')).toBeTruthy(); expectNoRawError();
  });
  it('a good save shows no error and keeps the tick (badge count drops by one)', async () => {
    guide(() => ok({})); render(<SetupGuideButton />);
    const btn = await screen.findByLabelText(/setup guide . \d+ tasks remaining/i);
    const before = Number(btn.textContent);
    fireEvent.click(btn); fireEvent.click((await screen.findAllByRole('button', { name: /^done$/i }))[0]!);
    await waitFor(() => expect(Number(screen.getByLabelText(/setup guide . \d+ tasks remaining/i).textContent)).toBe(before - 1));
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('a failed load hides the guide instead of showing every task as still to do', async () => {
    guide(() => ok({}), u => (u.includes('setup-guide') ? empty500() : undefined));
    const { container } = render(<SetupGuideButton />);
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 50));
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('TopUpModal purchase', () => {
  const BUNDLE = { id: 'b1', name: 'D2 Bundle', flows: 100, priceCents: 5000 };
  const modal = async (purchase: () => Response) => {
    script((u, m) => (m === 'POST' ? purchase() : ok([BUNDLE])));
    const onSuccess = vi.fn(); const onClose = vi.fn();
    render(<TopUpModal open onClose={onClose} onSuccess={onSuccess} />);
    fireEvent.click((await screen.findByText('D2 Bundle')).closest('button')!);
    return { onSuccess, onClose };
  };
  it('400: the server message, the modal stays open', async () => {
    const { onSuccess, onClose } = await modal(refuse);
    expect(await screen.findByText(MSG)).toBeTruthy(); expect(onSuccess).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  });
  it('empty-body 500: a plain sentence, not a parse error', async () => {
    await modal(empty500);
    expect(await screen.findByText('Could not start the purchase - try again')).toBeTruthy(); expectNoRawError();
  });
  it('200 (admin-recorded): success and close', async () => {
    const { onSuccess, onClose } = await modal(() => ok({ mode: 'admin_recorded' }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled()); expect(onClose).toHaveBeenCalled();
  });
  it('a failed bundle reload clears the previous bundles and shows the message', async () => {
    script(() => ok([BUNDLE]));
    const { rerender } = render(<TopUpModal open onClose={vi.fn()} onSuccess={vi.fn()} />);
    await screen.findByText('D2 Bundle');
    rerender(<TopUpModal open={false} onClose={vi.fn()} onSuccess={vi.fn()} />);
    script(() => empty500());
    rerender(<TopUpModal open onClose={vi.fn()} onSuccess={vi.fn()} />);
    expect(await screen.findByText('Could not load the top-up bundles - try again')).toBeTruthy();
    expect(screen.queryByText('D2 Bundle')).toBeNull();
  });
});
