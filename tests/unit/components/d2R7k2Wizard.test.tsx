/**
 * D2 round 7 (k2): onboarding Step 1. A refused/failed CIPC director check must NOT read as the green
 * "All directors match" line, and a refused ID extraction must say why (server message, plain fallback).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, bad, empty500, ok, route } from '../helpers/d2R3a1Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { Step1, INITIAL_WIZARD, type Director, type WizardData } from '@/components/onboarding/WizardSteps';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

const DIR: Director = { name: 'Thandi Nkosi', idNumber: '8001015009087', role: 'Director' };
const data = (): WizardData => ({ ...INITIAL_WIZARD, directors: [{ ...DIR }], cipcDirectors: [{ ...DIR }] });
const CIPC_SENTENCE = 'Could not check the directors against CIPC - try again';
const EXTRACT_SENTENCE = 'Could not extract details from ID. Please enter manually.';
const GREEN = /All directors match the CIPC certificate/;
const raw = () => expect(document.body.textContent).not.toMatch(/JSON|Unexpected end|HTTP \d/);

const editName = () => fireEvent.change(screen.getByPlaceholderText('Full name'), { target: { value: 'Thandi Nkosi Jr' } });

describe('Step1 CIPC director validation', () => {
  it('a 400 shows the server message and never the green all-match line', async () => {
    route((u) => (u.includes('validate-directors') ? bad(400) : ok()));
    render(<Step1 d={data()} set={vi.fn()} />);
    expect(screen.getByText(GREEN)).toBeTruthy();
    editName();
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText(GREEN)).toBeNull();
  });
  it('an empty-body 500 shows a plain sentence, no raw error and no green line', async () => {
    route((u) => (u.includes('validate-directors') ? empty500() : ok()));
    render(<Step1 d={data()} set={vi.fn()} />);
    editName();
    expect(await screen.findByText(CIPC_SENTENCE)).toBeTruthy();
    raw();
    expect(screen.queryByText(GREEN)).toBeNull();
  });
  it('a 200 with no warnings is the green line; a 200 with warnings lists them', async () => {
    route((u) => (u.includes('validate-directors') ? ok({ warnings: [{ type: 'missing_from_entry', message: 'D2 Missing director' }] }) : ok()));
    render(<Step1 d={data()} set={vi.fn()} />);
    editName();
    expect(await screen.findByText('D2 Missing director')).toBeTruthy();
    expect(screen.queryByText(GREEN)).toBeNull();
    cleanup();
    route(() => ok({ warnings: [] }));
    render(<Step1 d={data()} set={vi.fn()} />);
    editName();
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(await screen.findByText(GREEN)).toBeTruthy();
  });
  it('a later good check replaces the failure line', async () => {
    let n = 0;
    route(() => (++n === 1 ? empty500() : ok({ warnings: [] })));
    render(<Step1 d={data()} set={vi.fn()} />);
    editName();
    expect(await screen.findByText(CIPC_SENTENCE)).toBeTruthy();
    editName();
    await waitFor(() => expect(screen.queryByText(CIPC_SENTENCE)).toBeNull());
    expect(await screen.findByText(GREEN)).toBeTruthy();
  });
});

describe('Step1 ID extraction', () => {
  const upload = async (res: () => Response) => {
    route((u) => (u.includes('extract-id') ? res() : ok({ warnings: [] })));
    const set = vi.fn();
    const { container } = render(<Step1 d={data()} set={set} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'id.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);
    // set('directors', updated) is called for the "extracting" step, then for the outcome
    await waitFor(() => expect(lastDirector(set).extracting).toBe(false));
    return lastDirector(set);
  };
  const lastDirector = (set: ReturnType<typeof vi.fn>): Director => {
    const calls = set.mock.calls.filter(([k]) => k === 'directors');
    return (calls[calls.length - 1]![1] as Director[])[0]!;
  };

  it('a 400 puts the server message on the director, status failed', async () => {
    const dir = await upload(() => bad(400));
    expect(dir.idVerification).toBe('failed');
    expect(dir.idVerificationMsg).toBe(MSG);
  });
  it('an empty-body 500 puts the plain sentence on the director', async () => {
    const dir = await upload(() => empty500());
    expect(dir.idVerification).toBe('failed');
    expect(dir.idVerificationMsg).toBe(EXTRACT_SENTENCE);
  });
  it('a 200 with details verifies the director', async () => {
    const dir = await upload(() => ok({ name: 'Thandi Nkosi', idNumber: '8001015009087' }));
    expect(dir.idVerification).toBe('verified');
  });
  it('a 200 with no details keeps the plain failed sentence', async () => {
    const dir = await upload(() => new Response(JSON.stringify({ success: false }), { status: 200 }));
    expect(dir.idVerification).toBe('failed');
    expect(dir.idVerificationMsg).toBe(EXTRACT_SENTENCE);
  });
});
