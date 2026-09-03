/**
 * Who posted this. The identity every write records, and the audit trail reads.
 *
 * Today 4,300 programmatic postings on Brightsphere are attributed to "Hein van
 * Vuuren" and are indistinguishable from entries someone typed. For an
 * accounting system that is not a logging gap — it is an assurance failure. An
 * auditor cannot form a view on controls over a ledger that cannot say who
 * posted to it, and "the agent did it" is a different control conclusion from
 * "a director did it", even when the journal is identical.
 *
 * The fix is UPSTREAM of the audit_trail endpoint. `postingAgent.ts` already
 * stamps `mcp:<tool>:v1` on MCP postings, which distinguishes agent from human —
 * but it does not record WHICH TOKEN, so two agents on one company cannot be
 * told apart, and a revoked token's postings cannot be listed. This adds the
 * token identity alongside the existing stamp; it does not replace it.
 */
import type { McpToolContext } from '../types';

/**
 * - `human`  — a person typing into the UI.
 * - `agent`  — an MCP token acting on a person's behalf.
 * - `system` — IsaFlow itself: recurring journals, year-end close, migrations.
 *
 * Stored as text, not an enum type, so adding a fourth never needs a migration
 * on a table this large.
 */
export type ActorType = 'human' | 'agent' | 'system';

export const ACTOR_TYPES: readonly ActorType[] = ['human', 'agent', 'system'];

export function isActorType(value: unknown): value is ActorType {
  return typeof value === 'string' && (ACTOR_TYPES as readonly string[]).includes(value);
}

/**
 * The identity recorded on a write and returned by `audit_trail`.
 *
 * `userId` is retained on an agent write and is NOT redundant: the token was
 * granted by a person, that person authorised the scope, and removing them from
 * the record would lose the accountability the token derives from. The point is
 * to say BOTH — this posting was made by an agent, acting for this user, using
 * this token.
 */
export interface ActorIdentity {
  actorType: ActorType;
  /** The person: the UI user, or the user who granted the token. */
  userId: string;
  /** PAT id or OAuth authorisation id. Null for human and system writes. */
  tokenJti: string | null;
  /** OAuth client id where the token came from a connector rather than a PAT. */
  oauthAppId: string | null;
  /** The existing `mcp:<tool>:v1` stamp, or `human:<userId>`. Unchanged. */
  postingAgent: string;
}

/**
 * Builds the actor for an MCP write. Every write path in a tool handler passes
 * this down to the service, and the service records it.
 *
 * An MCP context is ALWAYS `agent`, even when the token is a PAT the user minted
 * for themselves and is driving by hand. What the record must support is the
 * question "could this have been posted without a human reading it first", and
 * for anything arriving over the MCP transport the honest answer is yes.
 */
export function actorForMcp(ctx: McpToolContext, postingAgent: string): ActorIdentity {
  return {
    actorType: 'agent',
    userId: ctx.userId,
    tokenJti: ctx.tokenJti,
    oauthAppId: ctx.oauthAppId,
    postingAgent,
  };
}

/** Builds the actor for a UI write. */
export function actorForHuman(userId: string): ActorIdentity {
  return {
    actorType: 'human',
    userId,
    tokenJti: null,
    oauthAppId: null,
    postingAgent: `human:${userId}`,
  };
}

/** Builds the actor for IsaFlow's own writes — recurring journals, year-end, jobs. */
export function actorForSystem(process: string): ActorIdentity {
  return {
    actorType: 'system',
    userId: SYSTEM_USER_ID,
    tokenJti: null,
    oauthAppId: null,
    postingAgent: `system:${process}`,
  };
}

/**
 * Sentinel user for system writes. A nil UUID rather than a real account, so
 * that no person is ever shown as the author of a job the software ran.
 */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
