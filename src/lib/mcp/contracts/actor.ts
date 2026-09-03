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
 * Stored as TEXT with a CHECK constraint (migration 530), not as an enum type.
 * Widening it is then an ALTER of one constraint; widening an enum is
 * ALTER TYPE ADD VALUE, whose transactional behaviour is version-dependent and
 * which rewrites dependent objects on a table holding every journal in the
 * system.
 *
 * NULL on every row written before migration 530. Those are resolved from
 * `posting_agent` at READ time rather than backfilled — a derived value can be
 * corrected when the derivation turns out to be wrong, and a backfilled one
 * cannot afterwards be told from a recorded one, which is the property that
 * makes an audit trail worth having.
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

/**
 * How an actor was established. Returned beside every `actor_type` so a reader
 * can tell a recorded fact from an inference.
 */
export type ActorProvenance = 'recorded' | 'derived';

export interface ResolvedActorType {
  actorType: ActorType;
  provenance: ActorProvenance;
  /** Present on a derived value: why it may be wrong. */
  caveat?: string;
}

/**
 * Resolves the actor of a row written BEFORE migration 530, which has no
 * `actor_type`, from its `posting_agent` stamp.
 *
 * THIS IS AN INFERENCE, AND IT IS KNOWN TO BE IMPERFECT. `createJournalEntry`
 * falls back to `defaultHumanMeta(userId)` whenever a caller does not pass the
 * meta, which stamps `human:<userId>` on postings an agent actually made — the
 * same defect that hides them from `list_agent_postings` today
 * (`src/lib/mcp/.claude.md`). So an `mcp:` stamp proves an agent, but a
 * `human:` stamp proves nothing: it means "not stamped as an agent", which is
 * a weaker claim and includes an unknown number of agent postings.
 *
 * Reporting that asymmetry is the whole point. An audit trail that presents an
 * inference as a fact is worse than one that admits the gap, because a reader
 * cannot tell which rows to go and check by hand.
 */
export function resolveLegacyActorType(postingAgent: string | null): ResolvedActorType {
  if (postingAgent?.startsWith('mcp:')) {
    return {
      actorType: 'agent',
      provenance: 'derived',
      caveat: 'Inferred from the mcp: posting-agent stamp; actor_type was not recorded on this row.',
    };
  }
  if (postingAgent?.startsWith('system:')) {
    return {
      actorType: 'system',
      provenance: 'derived',
      caveat: 'Inferred from the system: posting-agent stamp.',
    };
  }
  return {
    actorType: 'human',
    provenance: 'derived',
    caveat:
      'NOT PROVEN HUMAN. Rows written before migration 530 carry no actor_type, and createJournalEntry stamps human:<userId> whenever a caller omits the posting meta — so agent postings are known to appear here. Treat as "not stamped as an agent", not as "typed by a person".',
  };
}

/** A row written after migration 530 records its actor; nothing is inferred. */
export function resolveRecordedActorType(actorType: ActorType): ResolvedActorType {
  return { actorType, provenance: 'recorded' };
}
