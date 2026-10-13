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
 * question is whether a server is there, not whether /health is open. When
 * nothing answers it says so on stderr, so a run by hand shows why the suite
 * skipped (vitest names the file the line came from).
 */
export async function liveGoTrue(): Promise<boolean> {
  const base = process.env.GOTRUE_URL;
  const missing = await whyNoGoTrue(base);
  if (missing) {
    process.stderr.write(`[skip] ${missing}: this suite needs a live GoTrue `
      + '(sign-in, TOTP enrolment or the admin user API), so it skips.\n');
  }
  return missing === null;
}

const PROBE_MS = 3000;

/** Why there is no GoTrue to test against, or null when one answered. */
async function whyNoGoTrue(base: string | undefined): Promise<string | null> {
  if (!base) return 'GOTRUE_URL is not set';
  const health = new URL(`${new URL(base).pathname.replace(/\/$/, '')}/health`, base);
  try {
    await fetch(health, { signal: AbortSignal.timeout(PROBE_MS) });
    return null;
  } catch (err) {
    // Connection refused / unreachable (TypeError: fetch failed) or no answer
    // in time: there is no GoTrue to test against. Anything else is a defect.
    if (err instanceof Error && err.name === 'TimeoutError') {
      return `GoTrue at ${base} did not answer within ${PROBE_MS / 1000} s`;
    }
    if (err instanceof TypeError) return `nothing answers at ${base} (${err.message})`;
    throw err;
  }
}
