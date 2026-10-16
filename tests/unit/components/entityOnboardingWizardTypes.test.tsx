/**
 * The documents step's Continue for the remaining entity types (partnership, trust, ltd/npc,
 * other), and a same-tick double click on Complete Setup sending one request. The real page
 * renders; only apiFetch is scripted. Values are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, ok, script } from '../helpers/d2R3a5';

configure({ asyncUtilTimeout: 4000 });
const loc = vi.hoisted(() => ({ href: '', search: '', replace: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn(), replace: vi.fn() }) }));

import { apiFetch } from '@/lib/apiFetch';
import OnboardingWizard from '../../../pages/onboarding/index';

useApiJsonOverMock();
beforeEach(() => { loc.href = ''; vi.stubGlobal('location', loc); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** me -> wizard; ID extraction is unavailable (so a typed name is kept); complete-setup creates a company. */
const serve = () => script((u, m) => {
  if (u.includes('/api/auth/me')) return ok({ user: { onboarding_completed: false } });
  if (m !== 'POST') return undefined;
  if (u.endsWith('/api/onboarding/extract-id')) return empty500();
  return u.endsWith('/api/onboarding/complete-setup') ? ok({ companyId: 'co-new', replayed: false }) : ok({});
});
const setupPosts = () => vi.mocked(apiFetch).mock.calls.filter(([x, i]) => i?.method === 'POST' && String(x).endsWith('/api/onboarding/complete-setup'));

const click = async (name: RegExp | string) => fireEvent.click(await screen.findByRole('button', { name }));
const continueBtn = () => screen.getByRole('button', { name: /continue/i }) as HTMLButtonElement;
const fieldInput = (label: string) => screen.getByText(label).parentElement!.querySelector('input')!;
const type = (el: HTMLInputElement, value: string) => fireEvent.change(el, { target: { value } });
const upload = (input: HTMLInputElement, file: File) => {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
};
const png = (seed: string) => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), seed], `${seed}.png`, { type: 'image/png' });
const pdf = (name: string) => new File(['%PDF-1.4 synthetic'], name, { type: 'application/pdf' });
const toDocuments = async () => { for (let i = 0; i < 6; i++) await click(/continue/i); };

/** Step 0 -> details (through Smart Setup's manual choice when the type has one), with a name typed in. */
async function toDetails(entity: RegExp, nameLabel: string, viaSmartSetup: boolean) {
  serve(); render(<OnboardingWizard />);
  fireEvent.click(await screen.findByRole('radio', { name: entity }));
  await click(/continue/i);
  if (viaSmartSetup) await click(/Enter Details Manually/);
  type(await waitFor(() => fieldInput(nameLabel)), 'Synthetic Business');
}

async function addPartner(i: number, name: string, withId: boolean) {
  await click('+ Add Partner');
  type(screen.getAllByPlaceholderText('Full name')[i] as HTMLInputElement, name);
  if (withId) {
    upload(screen.getAllByText('Upload ID')[0]!.querySelector('input')!, png(name));
    await screen.findByText(`${name}.png`);
  }
}

describe('partnership', () => {
  it('people are Partners; one partner (with an ID) is not enough', async () => {
    await toDetails(/Partnership/, 'Partnership name', false);
    expect(screen.getByText('Partners')).toBeTruthy();
    await addPartner(0, 'Partner A', true);
    await toDocuments();
    expect(screen.getByText(/Add at least 2 partners, each with their ID document/)).toBeTruthy();
    expect(continueBtn().disabled).toBe(true);
  });
  it('two partners, one without an ID: still disabled; with both IDs: enabled', async () => {
    await toDetails(/Partnership/, 'Partnership name', false);
    await addPartner(0, 'Partner A', true);
    await addPartner(1, 'Partner B', false);
    await toDocuments();
    expect(screen.getByText(/Upload the ID document of Partner B/)).toBeTruthy();
    expect(continueBtn().disabled).toBe(true);
    for (let i = 0; i < 6; i++) await click(/back/i);
    upload(screen.getByText('Upload ID').querySelector('input')!, png('Partner B'));
    await screen.findByText('Partner B.png');
    await toDocuments();
    expect(await screen.findByText('Captured on the Partners step.')).toBeTruthy();
    expect(continueBtn().disabled).toBe(false);
  });
});

describe('document-proof entities', () => {
  it("trust: the Master's Letters of Authority is required", async () => {
    await toDetails(/Trust/, 'Trust name', false);
    await toDocuments();
    expect(continueBtn().disabled).toBe(true);
    upload(screen.getByLabelText("Upload Master's Letters of Authority") as HTMLInputElement, pdf('loa.pdf'));
    await waitFor(() => expect(continueBtn().disabled).toBe(false));
  });
  it('ltd and npc need the CIPC certificate', async () => {
    for (const entity of [/Public company \(Ltd\)/, /Non-profit company/]) {
      await toDetails(entity, 'Company name', true);
      await toDocuments();
      expect(screen.getByLabelText('Upload CIPC Registration Certificate')).toBeTruthy();
      expect(continueBtn().disabled).toBe(true);
      cleanup();
    }
  });
  it('"other": no required document, Continue is open', async () => {
    await toDetails(/^Other/, 'Name', false);
    await toDocuments();
    expect(screen.queryByText('Required')).toBeNull();
    expect(continueBtn().disabled).toBe(false);
  });
});

describe('Complete Setup', () => {
  it('a same-tick double click sends one request', async () => {
    await toDetails(/^Other/, 'Name', false);
    await toDocuments();
    await click(/continue/i);
    const btn = await screen.findByRole('button', { name: /complete setup/i });
    // Both clicks inside one act: React has not re-rendered (the button is still enabled) for the second.
    act(() => { btn.click(); btn.click(); });
    await waitFor(() => expect(loc.href).toBe('/accounting'));
    expect(setupPosts()).toHaveLength(1);
  });
});
