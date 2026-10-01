/**
 * The chart's role-write refusals an MCP tool may THROW and have reach the
 * agent with their own wording (spread into `toolHelpers.REFUSAL_CODES`; kept
 * here because that file is over the 300-line cap).
 */
export const SYSTEM_ROLE_REFUSAL_CODES = [
  // A write that would leave a role without exactly one usable holder: names
  // only role keys, and is thrown so the registry's savepoint undoes the write.
  'SYSTEM_ROLE_INVARIANT',
  // Another request is changing the chart's role holders: one fixed "retry"
  // sentence naming nothing, raised before any write.
  'SYSTEM_ROLE_LOCK_TIMEOUT',
] as const;
