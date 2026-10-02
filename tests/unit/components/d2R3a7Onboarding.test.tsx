/**
 * D2 round 3 (a7): the onboarding wizard must not advance past a failed step, must show the server's message,
 * and a Retry must resume (never create a second company). Setup-guide ticks and the top-up purchase check the
 * status before the body.
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
vi.mock('@/components/onboarding/WizardSteps', async (orig) => {
  const real = await orig<typeof import('@/components/onboarding/WizardSteps')>();
  const Nothing = () => null;
  return {
    ...real, Step2: Nothing, Step3: Nothing, Step4: Nothing, Step5: Nothing, Step6: Nothing, Step7: Nothing, StepCoaTemplate: Nothing,
    Step1: ({ set }: { set: (k: string, v: unknown) => void }) => (
      <button onClick={() => { set('name', 'D2 Co'); set('directors', [{ name: 'D2 Director' }]); set('documents', [{ type: 'cipc_certificate', name: 'c.pdf' }]); }}>fill company</button>
    ),
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
const posts = (u: string) => vi.mocked(apiFetch).mock.calls.filter(([x, i]) => String(x).includes(u) && i?.method === 'POST').length;

/** me -> wizard; `fail` maps a URL fragment to the response of the failing step. */
const wizard = (fail: Record<string, () => Response> = {}) => script((u, m) => {
  if (u.includes('/api/auth/me')) return ok({ user: { onboarding_completed: false } });
  if (m !== 'POST') return undefined;
  const hit = Object.keys(fail).find(k => u.includes(k));
  return hit ? fail[hit]!() : u.includes('/companies') ? ok({ id: 'co-new' }) : ok({});
});
const toLastStep = async () => {
  await click('manual setup'); await click('fill company');
  for (let i = 0; i < 6; i++) await click(/continue/i);
  await click(/complete setup/i);
};

describe('onboarding submit', () => {
  it('company create 400: the server message, nothing else runs, no navigation', async () => {
    wizard({ '/companies': refuse }); render(<OnboardingWizard />); await toLastStep();
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(posts('coa-seed') + posts('company-directors') + posts('onboarding/complete')).toBe(0);
    expect(loc.href).toBe('');
  });
  it('company create empty-body 500: a plain sentence', async () => {
    wizard({ '/companies': empty500 }); render(<OnboardingWizard />); await toLastStep();
    expect(await screen.findByText('Could not create the company - try again')).toBeTruthy();
    expectNoRawError();
  });
  it('a 200 with no company id is a failure, not a silent skip of the later steps', async () => {
    wizard({ '/companies': () => ok({}) }); render(<OnboardingWizard />); await toLastStep();
    expect(await screen.findByText('The company was not created - try again')).toBeTruthy();
    expect(posts('coa-seed')).toBe(0);
  });
  it('chart-of-accounts seed refused: the message shows and completion is blocked', async () => {
    wizard({ 'coa-seed': refuse }); render(<OnboardingWizard />); await toLastStep();
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(posts('onboarding/complete')).toBe(0); expect(loc.href).toBe('');
  });
  it('directors refused (400): the message shows, documents and completion do not run', async () => {
    wizard({ 'company-directors': refuse }); render(<OnboardingWizard />); await toLastStep();
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(posts('onboarding/documents') + posts('onboarding/complete')).toBe(0); expect(loc.href).toBe('');
  });
  it('documents empty-body 500: a plain sentence and no navigation', async () => {
    wizard({ 'onboarding/documents': empty500 }); render(<OnboardingWizard />); await toLastStep();
    expect(await screen.findByText('Could not upload the documents - try again')).toBeTruthy();
    expect(posts('onboarding/complete')).toBe(0); expect(loc.href).toBe('');
    expectNoRawError();
  });
  it('complete refused: the message shows and the wizard does not navigate', async () => {
    wizard({ 'onboarding/complete': refuse }); render(<OnboardingWizard />); await toLastStep();
    expect(await screen.findByText(MSG)).toBeTruthy(); expect(loc.href).toBe('');
  });
  it('all 200: every step ran once and the wizard navigates to /accounting', async () => {
    wizard(); render(<OnboardingWizard />); await toLastStep();
    await waitFor(() => expect(loc.href).toBe('/accounting'));
    expect([posts('/companies'), posts('coa-seed'), posts('company-directors'), posts('onboarding/documents'), posts('onboarding/complete')]).toEqual([1, 1, 1, 1, 1]);
  });
  it('Retry after a seed failure resumes: no second company is created', async () => {
    let seeds = 0;
    script((u, m) => {
      if (u.includes('/api/auth/me')) return ok({ user: { onboarding_completed: false } });
      if (m !== 'POST') return undefined;
      if (u.includes('coa-seed')) return ++seeds === 1 ? refuse() : ok({});
      return u.includes('/companies') ? ok({ id: 'co-new' }) : ok({});
    });
    render(<OnboardingWizard />); await toLastStep();
    await screen.findByText(MSG);
    await click(/complete setup/i);
    await waitFor(() => expect(loc.href).toBe('/accounting'));
    expect(posts('/companies')).toBe(1); expect(seeds).toBe(2);
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
