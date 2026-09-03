/**
 * Journal Entry Meta — PRD-05 Phase 2
 * Posting-agent stamping helpers for every JE write path.
 */
import type { ActorType } from '@/lib/mcp/contracts/actor';

export interface JournalEntryMeta {
  /** Identity of the agent/system that created this entry.
   *  Format: 'human' | 'human:<userId>' | 'ai:<pipeline>:v1'
   *          | 'rule:<ruleId>' | 'import:<source>' | 'system:<job>'
   */
  postingAgent: string;
  /**
   * gl_journal_entries.actor_type (migration 530).
   *
   * OMITTED, NOT DEFAULTED, when the caller did not state it. A NULL column is
   * resolved from posting_agent at read time and reported as DERIVED; a
   * recorded value is reported as a fact. Defaulting this to 'human' would
   * convert the fallback below — which fires whenever ANY caller, agent
   * included, omits the meta — into a recorded claim that a person typed the
   * entry. 2,589 Brightsphere journals sit under exactly that fallback today.
   */
  actorType?: ActorType;
  /** PAT id / OAuth authorisation id behind an agent write. Null otherwise. */
  actorTokenJti?: string | null;
  /** captured_documents.id — the original source document, if any. */
  sourceDocumentId?: string | null;
  /** SHA-256 hex of the original file bytes (set by VLM pipeline). */
  sourceDocumentHash?: string | null;
  /** 0..1 confidence score from the VLM extraction step. */
  extractionConfidence?: number | null;
}

/**
 * The shape every service that stamps a downstream journal accepts. Widened
 * from the original `{ postingAgent?: string }` so the actor travels with the
 * stamp instead of being reconstructed from it — the stamp says WHAT posted,
 * the actor says which credential.
 */
export interface PostingActorOpts {
  postingAgent?: string;
  actorType?: ActorType;
  actorTokenJti?: string | null;
}

export function defaultHumanMeta(userId?: string): JournalEntryMeta {
  // No actorType: see JournalEntryMeta.actorType. This is the fallback path,
  // and a fallback must never assert something the caller did not.
  return { postingAgent: userId ? `human:${userId}` : 'human' };
}

/**
 * Turns caller opts into a meta, or undefined when the caller declared no
 * stamp at all (so the callee keeps its own default).
 */
export function actorMeta(opts?: PostingActorOpts): JournalEntryMeta | undefined {
  if (!opts?.postingAgent) return undefined;
  return {
    postingAgent: opts.postingAgent,
    ...(opts.actorType === undefined ? {} : { actorType: opts.actorType }),
    ...(opts.actorTokenJti === undefined ? {} : { actorTokenJti: opts.actorTokenJti }),
  };
}
