/**
 * The optional, ASSERT-ONLY `company_id` argument.
 *
 * The connector resolves to whichever company the token is bound to, and that
 * is invisible to the agent. During the Velocity Fibre migration it changed
 * mid-session and produced a confidently wrong conclusion — "the connector
 * isn't pointed at Velocity Fibre" — that took real effort to unwind. A tool
 * that writes to a ledger should not depend on invisible, externally-mutable
 * state without at least letting the caller state what it believes.
 *
 * **This argument never SELECTS a company.** The scope still comes only from
 * the bearer token (`McpToolContext`, built by the transport from the
 * authenticated request). All this does is COMPARE the caller's belief with
 * the token's company and refuse loudly on a mismatch. That preserves the
 * module's load-bearing invariant — companyId/userId never come from tool args
 * — while removing the failure mode it was silent about: writing confidently
 * to the wrong entity.
 *
 * The distinction matters for the drift test in `tools-read.test.ts`, which
 * used to assert that NO tool schema mentions "company" at all. That rule was
 * a proxy for the real one. The real one is: no tool may take its SCOPE from
 * an argument. The test now pins that instead, per-tool.
 */
import type { McpToolResult } from './types';
import { UUID_RE } from '@/lib/validation';

/** Schema fragment to spread into any tool that accepts the assertion. */
export const COMPANY_ASSERT_PROPERTY = {
  company_id: {
    type: 'string',
    description:
      'OPTIONAL guard, not a selector. The connector always acts on the company your token is bound to; ' +
      'passing this asserts which company you BELIEVE that is, and the call is refused if it differs. ' +
      'It can never redirect a write to another company. Resolve it once with list_companies.',
  },
} as const;

/**
 * @returns a refusal when the caller asserted a different company, else null.
 *
 * A malformed value refuses too. Silently ignoring an unparseable assertion
 * would defeat the point: the caller would read success as confirmation that
 * its belief was checked.
 */
export function assertCompanyMatches(
  args: Record<string, unknown>,
  companyId: string,
): McpToolResult | null {
  if (!('company_id' in args)) return null;
  const asserted = args.company_id;
  if (asserted === null || asserted === undefined) return null;

  if (typeof asserted !== 'string' || !UUID_RE.test(asserted)) {
    return { content: [{ type: 'text', text: 'invalid company_id' }], isError: true };
  }
  if (asserted !== companyId) {
    // Naming the ACTIVE company is safe and is the whole point: the caller
    // already holds a token for it, so this leaks nothing it cannot read from
    // company_profile — and without the actual value the agent cannot correct
    // itself, which is the failure this exists to prevent.
    return {
      content: [{
        type: 'text',
        text:
          `company_id does not match this token's company. You asserted ${asserted}; ` +
          `this token is bound to ${companyId}. Nothing was written. ` +
          'Re-check with list_companies before retrying.',
      }],
      isError: true,
    };
  }
  return null;
}
