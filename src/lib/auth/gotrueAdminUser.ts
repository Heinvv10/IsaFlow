/**
 * GoTrue admin: read one user by id. Beside gotrue.ts, which is at its size
 * limit; same request helpers.
 */
import { callAuthUpstream, readAuthUpstreamJson } from './authUpstream';
import { adminHeaders, gotrueFetch, type GoTrueUser } from './gotrue';

/**
 * The GoTrue user with this id, or null when GoTrue has none (404). Bounded
 * and classified (D9): an outage throws AuthUpstreamUnavailableError.
 */
export async function adminGetUser(userId: string): Promise<GoTrueUser | null> {
  const res = await callAuthUpstream('gotrue adminGetUser', (signal) => gotrueFetch(
    `/admin/users/${encodeURIComponent(userId)}`,
    { method: 'GET', signal },
    adminHeaders()
  ));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`gotrue adminGetUser failed: ${res.status}`);
  return readAuthUpstreamJson('gotrue adminGetUser', res) as Promise<GoTrueUser>;
}
