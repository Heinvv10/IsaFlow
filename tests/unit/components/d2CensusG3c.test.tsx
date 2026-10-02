// D2 census group 3c: the two-factor panel (status load, enroll, confirm, disable). A non-2xx shows the server's message
// (400) or a plain sentence (empty 500), never a raw "Unexpected end of JSON input". The REAL assertOk / apiErrorMessage run.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { apiFetch } from '@/lib/apiFetch';
import { MSG, bad, boom, expectNoRawJsonError, ok } from '../helpers/d2CensusG3';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { TwoFactorSection } from '../../../src/components/accounting/my-account/TwoFactorSection';

useApiJsonOverMock();
afterEach(() => { cleanup(); });
type Respond = () => Response;
type Routes = Partial<Record<'status' | 'enroll' | 'confirm' | 'disable', Respond>>;
const OFF = { enabled: false, factor_id: null };
const ON = { enabled: true, factor_id: 'f1' };
function answer(r: Routes) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown) => {
    const u = String(url);
    const key = (['status', 'enroll', 'confirm', 'disable'] as const).find(k => u.endsWith(`2fa-${k}`));
    return (key && r[key]) ? r[key]!() : ok({});
  });
}
const type = (code: string) => fireEvent.change(screen.getByLabelText('TOTP code'), { target: { value: code } });
const click = async (name: RegExp) => fireEvent.click(await screen.findByRole('button', { name }));
const ENROLL = { factor_id: 'f1', qr_code: '<svg xmlns="http://www.w3.org/2000/svg"/>', secret: 'D2SECRETXYZ' };

describe('2fa status load', () => {
  it('400: shows the server message', async () => {
    answer({ status: bad }); render(<TwoFactorSection />);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('500 with an empty body: shows a plain sentence, not the JSON parse error', async () => {
    answer({ status: boom }); render(<TwoFactorSection />);
    expect(await screen.findByText(/Could not load your two-factor status/)).toBeTruthy();
    expectNoRawJsonError();
  });
  it('200: shows the enabled state and no error', async () => {
    answer({ status: () => ok(ON) }); render(<TwoFactorSection />);
    expect(await screen.findByText(/Two-factor authentication is enabled/)).toBeTruthy();
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });
});

describe('2fa enroll', () => {
  const start = async (enroll: Respond) => { answer({ status: () => ok(OFF), enroll }); render(<TwoFactorSection />); await click(/Enable 2FA/); };
  it('400: shows the server message', async () => { await start(bad); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('500 with an empty body: shows a plain sentence, not the JSON parse error', async () => {
    await start(boom);
    expect(await screen.findByText(/Could not start two-factor setup/)).toBeTruthy();
    expectNoRawJsonError();
  });
  it('200: shows the secret to enter in the authenticator app', async () => {
    await start(() => ok(ENROLL));
    expect(await screen.findByText('D2SECRETXYZ')).toBeTruthy();
  });
});

describe('2fa confirm', () => {
  const confirm = async (c: Respond, status: Respond = () => ok(OFF)) => {
    answer({ status, enroll: () => ok(ENROLL), confirm: c }); render(<TwoFactorSection />);
    await click(/Enable 2FA/); await screen.findByText('D2SECRETXYZ'); type('123456'); await click(/^Enable 2FA$/);
  };
  it('400: shows the server message', async () => { await confirm(bad); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('500 with an empty body: shows a plain sentence, not the JSON parse error', async () => {
    await confirm(boom);
    expect(await screen.findByText(/Could not verify the code/)).toBeTruthy();
    expectNoRawJsonError();
  });
  it('200: the panel moves to the enabled state', async () => {
    let calls = 0;
    await confirm(() => ok({}), () => ok(++calls === 1 ? OFF : ON));
    expect(await screen.findByText(/Two-factor authentication is enabled/)).toBeTruthy();
  });
});

describe('2fa disable', () => {
  const disable = async (d: Respond, status: Respond = () => ok(ON)) => {
    answer({ status, disable: d }); render(<TwoFactorSection />);
    await screen.findByText(/Two-factor authentication is enabled/); type('123456'); await click(/Disable 2FA/);
  };
  it('400: shows the server message', async () => { await disable(bad); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('500 with an empty body: shows a plain sentence, not the JSON parse error', async () => {
    await disable(boom);
    expect(await screen.findByText(/Could not disable two-factor/)).toBeTruthy();
    expectNoRawJsonError();
  });
  it('200: the panel moves to the disabled state', async () => {
    let calls = 0;
    await disable(() => ok({}), () => ok(++calls === 1 ? ON : OFF));
    expect(await screen.findByText(/Adds a second step to every login/)).toBeTruthy();
  });
});
