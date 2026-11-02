import { NextRequest } from 'next/server';
import { expect, it } from 'vitest';
import { middleware } from '../../middleware';

// Behind nginx, Next 15 hands middleware request.url = https://localhost:<PORT>/...
// while the Host header still names the public host (2026-11-02 outage).
const locationOf = async (path: string, host: string, cookie?: string) => {
  const headers: Record<string, string> = { host };
  if (cookie) headers.cookie = cookie;
  const res = await middleware(new NextRequest(`https://localhost:3112${path}`, { headers }));
  return res.headers.get('location');
};

it('app host: logged-out redirect stays on app.isaflow.co.za', async () => {
  expect(await locationOf('/accounting', 'app.isaflow.co.za'))
    .toBe('https://app.isaflow.co.za/login?returnTo=%2Faccounting');
});

it('admin host: logged-out redirect stays on admin.isaflow.co.za', async () => {
  expect(await locationOf('/', 'admin.isaflow.co.za'))
    .toBe('https://admin.isaflow.co.za/login?returnTo=%2F');
});

it('app host root redirects to app.isaflow.co.za/accounting', async () => {
  expect(await locationOf('/', 'app.isaflow.co.za')).toBe('https://app.isaflow.co.za/accounting');
});

it('onboarding redirect stays on the public host', async () => {
  expect(await locationOf('/accounting', 'app.isaflow.co.za', 'sb-access-token=x'))
    .toBe('https://app.isaflow.co.za/onboarding');
});

it('marketing host: logged-out redirect stays on isaflow.co.za', async () => {
  expect(await locationOf('/accounting', 'isaflow.co.za'))
    .toBe('https://isaflow.co.za/login?returnTo=%2Faccounting');
});

it('Host is matched case-insensitively', async () => {
  expect(await locationOf('/accounting', 'App.IsaFlow.co.za'))
    .toBe('https://app.isaflow.co.za/login?returnTo=%2Faccounting');
});

// An unlisted Host never becomes a redirect origin: middleware keeps request.url,
// and Next's router (HOSTNAME=localhost, scripts/isaflow@.service) sends that
// same-origin Location as a relative /login. verify-deploy.sh step 1b checks it live.
it('an unknown Host is not trusted as a redirect origin', async () => {
  expect(await locationOf('/accounting', 'evil.example')).toBe('https://localhost:3112/login?returnTo=%2Faccounting');
});
