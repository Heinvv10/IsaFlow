/**
 * Whether anything answers HTTP at GOTRUE_URL.
 *
 * A few integration suites sign real users in, enrol real TOTP factors or call
 * GoTrue's admin user API, and nothing in the suite stands in for that. They
 * run against the dev GoTrue (GOTRUE_URL + SUPABASE_SERVICE_ROLE_KEY from
 * .env.local) or a disposable one on localhost, and skip when nothing answers:
 * as in the CI integration gate (scripts/ci/integration/run.sh), which starts
 * no GoTrue. Each such suite states that in a `ci-integration-skip:` comment,
 * which the gate prints for every suite it saw skip.
 *
 * Any HTTP response counts, a 401 from the Supabase gateway included: the
 * question is whether a server is there, not whether /health is open.
 */
export async function liveGoTrue(): Promise<boolean> {
  const base = process.env.GOTRUE_URL;
  if (!base) return false;
  const health = new URL(`${new URL(base).pathname.replace(/\/$/, '')}/health`, base);
  try {
    await fetch(health, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch (err) {
    // Connection refused / unreachable (TypeError: fetch failed) or no answer
    // in time: there is no GoTrue to test against. Anything else is a defect.
    if (err instanceof TypeError || (err instanceof Error && err.name === 'TimeoutError')) return false;
    throw err;
  }
}
