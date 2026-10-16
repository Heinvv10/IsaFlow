/**
 * The onboarding wizard's step 0 ("What kind of business is this?") decides every later step:
 * the registration field, the people label and role, the one required document and Continue's
 * gating on it, and what Smart Setup reads. The real page, steps and Smart Setup render; only
 * apiFetch is scripted. Values are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, script } from '../helpers/d2R3a5';

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

/** me -> wizard; extract/extract-id answer as given; complete-setup creates a company. */
const serve = (extract: Record<string, unknown> = {}) => script((u, m) => {
  if (u.includes('/api/auth/me')) return ok({ user: { onboarding_completed: false } });
  if (m !== 'POST') return undefined;
  if (u.endsWith('/api/onboarding/extract-id')) return ok({ name: 'Owner A', idNumber: 'SYNTH-ID-0001' });
  if (u.endsWith('/api/onboarding/extract')) return ok(extract);
  return u.endsWith('/api/onboarding/complete-setup') ? ok({ companyId: 'co-new', replayed: false }) : ok({});
});
const posts = (u?: string) => vi.mocked(apiFetch).mock.calls
  .filter(([x, i]) => i?.method === 'POST' && (!u || String(x).endsWith(u)));

const click = async (name: RegExp | string) => fireEvent.click(await screen.findByRole('button', { name }));
const continueBtn = () => screen.getByRole('button', { name: /continue/i }) as HTMLButtonElement;
const choose = async (label: RegExp) => { fireEvent.click(await screen.findByRole('radio', { name: label })); await click(/continue/i); };
const fieldInput = (label: string) => screen.getByText(label).parentElement!.querySelector('input')!;
const type = (el: HTMLInputElement, value: string) => fireEvent.change(el, { target: { value } });
const pdf = (name: string) => new File(['%PDF-1.4 synthetic'], name, { type: 'application/pdf' });
const png = (name: string) => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], name, { type: 'image/png' });
const upload = (input: HTMLInputElement, file: File) => {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
};
/** From the details step to the documents step (address, logo, banking, financial, account structure). */
const toDocuments = async () => { for (let i = 0; i < 6; i++) await click(/continue/i); };

describe('step 0: what kind of business is this?', () => {
  it('offers the eight entity types and Continue waits for a choice', async () => {
    serve(); render(<OnboardingWizard />);
    expect(await screen.findAllByRole('radio')).toHaveLength(8);
    expect(continueBtn().disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /Sole proprietor/ }));
    expect(continueBtn().disabled).toBe(false);
  });
});

describe('sole proprietor', () => {
  const toDetails = async () => {
    serve(); render(<OnboardingWizard />);
    await choose(/Sole proprietor/);
    expect(await screen.findByText(/Upload the Owner's ID document/)).toBeTruthy(); // Smart Setup reads the owner ID, not CIPC
    await click(/Enter Details Manually/);
  };

  it('no CIPC field; people are "Owner" and there is only one; the documents step needs the owner ID, not CIPC', async () => {
    await toDetails();
    expect(screen.getByText('Business name')).toBeTruthy();
    expect(screen.queryByText(/CIPC registration number/i)).toBeNull();
    expect(screen.getByText('Owner')).toBeTruthy();
    await click('+ Add Owner');
    expect(screen.queryByRole('button', { name: '+ Add Owner' })).toBeNull();
    type(fieldInput('Business name'), 'Synthetic Trading');
    type(screen.getByPlaceholderText('Full name') as HTMLInputElement, 'Owner A');
    await toDocuments();
    expect(screen.getByText('Upload the ID document of Owner A (Back to the Owner step)')).toBeTruthy();
    expect(screen.queryByText('CIPC Registration Certificate')).toBeNull();
    expect(continueBtn().disabled).toBe(true);
  });

  it('with the owner ID uploaded, the documents step lets them through and the one request says sole_proprietor', async () => {
    await toDetails();
    await click('+ Add Owner');
    type(fieldInput('Business name'), 'Synthetic Trading');
    type(screen.getByPlaceholderText('Full name') as HTMLInputElement, 'Owner A');
    upload(screen.getByText('Upload ID').querySelector('input')!, png('owner-id.png'));
    await screen.findByText('owner-id.png');
    await toDocuments();
    expect(await screen.findByText('Captured on the Owner step.')).toBeTruthy();
    expect(continueBtn().disabled).toBe(false);
    await click(/continue/i);
    expect(posts('/api/onboarding/complete-setup')).toHaveLength(0); // nothing is written before the submit
    await click(/complete setup/i);
    await waitFor(() => expect(loc.href).toBe('/accounting'));
    const body = JSON.parse(String(posts('/api/onboarding/complete-setup')[0]![1]!.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ entityType: 'sole_proprietor', company: { name: 'Synthetic Trading' }, documents: [] });
    expect(body.people).toEqual([{ name: 'Owner A', idNumber: 'SYNTH-ID-0001', idDocument: { name: 'owner-id.png', data: expect.stringMatching(/^data:image\/png;base64,/) } }]);
  });
});

describe('company types', () => {
  it('pty_ltd: CIPC number, Directors, and the documents step waits for the CIPC certificate; nothing is posted before submit', async () => {
    serve(); render(<OnboardingWizard />);
    await choose(/Private company \(Pty\) Ltd/);
    await click(/Enter Details Manually/);
    expect(screen.getByText('CIPC registration number')).toBeTruthy();
    expect(screen.getByText('Directors')).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Add Director' })).toBeTruthy();
    type(fieldInput('Company name'), 'Synthetic (Pty) Ltd');
    await toDocuments();
    expect(continueBtn().disabled).toBe(true);
    upload(screen.getByLabelText('Upload CIPC Registration Certificate') as HTMLInputElement, pdf('cipc.pdf'));
    await waitFor(() => expect(continueBtn().disabled).toBe(false));
    await click(/continue/i);
    expect(await screen.findByText('Review & Complete')).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it('cc: CK number, Members, and the CK1/CK2 is the required document', async () => {
    serve(); render(<OnboardingWizard />);
    await choose(/Close corporation/);
    await click(/Enter Details Manually/);
    expect(screen.getByText('CK number')).toBeTruthy();
    expect(screen.getByText('Members')).toBeTruthy();
    type(fieldInput('Company name'), 'Synthetic CC');
    await toDocuments();
    expect(screen.getByLabelText('Upload CK1 / CK2 Founding Statement')).toBeTruthy();
    expect(screen.queryByLabelText('Upload CIPC Registration Certificate')).toBeNull();
    expect(continueBtn().disabled).toBe(true);
  });

  it("trust: no Smart Setup, the Master's reference, Trustees", async () => {
    serve(); render(<OnboardingWizard />);
    await choose(/Trust/);
    expect(await screen.findByText('Business Details')).toBeTruthy();
    expect(screen.getByText("Master's reference (IT number)")).toBeTruthy();
    expect(screen.getByText('Trustees')).toBeTruthy();
  });
});

describe('Smart Setup: a certificate that says another entity type', () => {
  const extractAs = async () => {
    serve({ name: 'Synthetic CC', registrationNumber: '1998/012345/23', directors: [{ name: 'Member A', idNumber: 'SYNTH-ID-0002' }] });
    render(<OnboardingWizard />);
    await choose(/Private company \(Pty\) Ltd/);
    await click(/Upload Documents/);
    upload(screen.getByLabelText('Upload CIPC Registration Certificate') as HTMLInputElement, pdf('cert.pdf'));
    await waitFor(() => expect((screen.getByRole('button', { name: /Extract Details/ }) as HTMLButtonElement).disabled).toBe(false));
    await click(/Extract Details/);
    expect(await screen.findByText(/This document looks like a/)).toBeTruthy();
  };

  it('asks, and "Keep" leaves the chosen type', async () => {
    await extractAs();
    await click(/Keep Private company/);
    expect(await screen.findByText('CIPC registration number')).toBeTruthy();
    expect(screen.getByText('Directors')).toBeTruthy();
  });

  it('switching takes the extracted type and files the certificate as its proof (documents step skipped)', async () => {
    await extractAs();
    await click(/It is a Close corporation/);
    expect(await screen.findByText('CK number')).toBeTruthy();
    expect(screen.getByText('Members')).toBeTruthy();
    expect((fieldInput('Company name')).value).toBe('Synthetic CC');
    await toDocuments();
    expect(await screen.findByText('Review & Complete')).toBeTruthy();
    expect(screen.getByText('CK1 / CK2 Founding Statement — cert.pdf')).toBeTruthy();
  });
});
