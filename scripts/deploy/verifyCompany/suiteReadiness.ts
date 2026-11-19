/**
 * The provisioner's last gate before the logins are published: log in through the app as the golden suite will, with a client that
 * keeps cookies as the suite's does (suiteSession.ts), and run the suite's own start-up checks (the verify login's session, its
 * company, the six system accounts; the approver's session and company: tests/e2e/golden-paths/helpers/suitePreconditions.ts). A
 * company this passes is one the suite's global setup starts in, at that address; one it fails is never published (incident 2026-11-18).
 */
import { approverProblems, suitePreconditionProblems } from '../../../tests/e2e/golden-paths/helpers/suitePreconditions';
import type { Login } from './envFile';
import { SuiteSession } from './suiteSession';

/** @returns one message per reason the golden suite would not start at `baseUrl` as these logins; empty when it would. */
export async function suiteProblems(baseUrl: string, logins: { verify: Login; approver: Login }, timeoutMs: number): Promise<string[]> {
  const verify = new SuiteSession(baseUrl, timeoutMs);
  const status = await verify.login(logins.verify.email, logins.verify.password);
  if (status !== 200) return [`the verify login through ${baseUrl} answered ${status}`];
  const problems = await suitePreconditionProblems(verify.get, { baseUrl, verifyLogin: true });
  const approver = new SuiteSession(baseUrl, timeoutMs);
  const aStatus = await approver.login(logins.approver.email, logins.approver.password);
  if (aStatus !== 200) problems.push(`the approver login through ${baseUrl} answered ${aStatus}`);
  else problems.push(...(await approverProblems(approver.get, baseUrl)));
  return problems.map((p) => `the golden suite would not start: ${p}`);
}
