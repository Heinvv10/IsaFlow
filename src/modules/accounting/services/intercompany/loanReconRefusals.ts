/**
 * The loan reconciliation's refusals and fixed sentences (P5, plan section (c)). Pure. Every refusal answers a fixed sentence and no figure,
 * id or database text. ORDER: a person's own session (a Login-as session, or one without a session id, is refused: platform staff must not see
 * a third tenant's figure through the tenant they impersonate), then the dark flag `intercompany_loan_clearing`, then the intercompany write
 * role, then the request (a connection UUID; ANY `asOf` parameter is a 400: there is no user-chosen date, (k).2), then not_found (the same
 * answer for a connection of another pair, a random id and a cash connection without messages: no existence oracle).
 */
import { isUuidParam } from '@/lib/validation';
import { DEFAULT_LIMIT, MAX_LIMIT, MAX_RECON_OFFSET, SECTIONS, type PartnerState, type ReconQuery, type SectionKey } from './loanReconTypes';

export type ReconCode = 'impersonating' | 'not_own_session' | 'not_enabled' | 'forbidden' | 'bad_request' | 'not_found' | 'too_many' | 'timeout';

export const RECON_SENTENCES: Record<ReconCode, string> = {
  impersonating: 'This report cannot be opened while impersonating another user. End the impersonation and act as yourself.',
  not_own_session: 'Open this report from your own signed-in session.',
  not_enabled: 'Intercompany loan reconciliation is not enabled for this company.',
  forbidden: 'The intercompany loan reconciliation needs an owner, admin or manager role in this company.',
  bad_request: 'The request is not valid.',
  not_found: 'Connection not found',
  too_many: 'This connection has too many to reconcile in one view.',
  timeout: 'The report took too long; try again.',
};

export const RECON_STATUS: Record<ReconCode, 400 | 403 | 404 | 422 | 503> = {
  impersonating: 403, not_own_session: 403, not_enabled: 403, forbidden: 403, bad_request: 400, not_found: 404, too_many: 422, timeout: 503,
};

export class ReconRefusal extends Error {
  readonly status: 400 | 403 | 404 | 422 | 503;
  /** `sentence` replaces the code's fixed one only for a bad request (parseReconQuery's own fixed sentences). */
  constructor(readonly code: ReconCode, sentence?: string) {
    super(sentence ?? RECON_SENTENCES[code]);
    this.name = 'ReconRefusal';
    this.status = RECON_STATUS[code];
  }
}

export const reconRefusal = (code: ReconCode, sentence?: string) => new ReconRefusal(code, sentence);

/** The first refusal of the person, in the order of (c); null when they may read. */
export function firstRefusal(g: { session: 'self' | 'impersonation' | 'unknown'; flagOn: boolean; canWrite: boolean }): ReconCode | null {
  if (g.session === 'impersonation') return 'impersonating';
  if (g.session !== 'self') return 'not_own_session';
  if (!g.flagOn) return 'not_enabled';
  if (!g.canWrite) return 'forbidden';
  return null;
}

const one = (v: unknown): string | undefined | null => (v === undefined ? undefined : typeof v === 'string' ? v : null);
const whole = (v: string | undefined | null, min: number, max: number, fallback: number): number | null => {
  if (v === undefined) return fallback;
  if (v === null || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
};

export type ParsedReconQuery = { ok: true; value: ReconQuery & { connectionId: string } } | { ok: false; error: string };

/** The report's query: the connection, the section and the page. An `asOf` (in any form) is refused. */
export function parseReconQuery(q: Record<string, unknown>): ParsedReconQuery {
  if (Object.keys(q).some((k) => k.toLowerCase() === 'asof' || k.toLowerCase() === 'as_of')) {
    return { ok: false, error: 'The report is as of today: it takes no date.' };
  }
  const id = one(q.connectionId);
  if (!id || !isUuidParam(id)) return { ok: false, error: 'connectionId must be a valid UUID' };
  const section = one(q.section);
  if (section === null || (section !== undefined && !(SECTIONS as readonly string[]).includes(section))) {
    return { ok: false, error: `section must be one of ${SECTIONS.join(', ')}` };
  }
  const limit = whole(one(q.limit), 1, MAX_LIMIT, DEFAULT_LIMIT);
  if (limit === null) return { ok: false, error: `limit must be a whole number from 1 to ${MAX_LIMIT}` };
  // every page re-runs the whole statement: the offset is capped where the capped lists end (round 1, LOW-9)
  const offset = whole(one(q.offset), 0, MAX_RECON_OFFSET, 0);
  if (offset === null) return { ok: false, error: `offset must be a whole number from 0 to ${MAX_RECON_OFFSET}` };
  return { ok: true, value: { connectionId: id.toLowerCase(), section: (section ?? 'attention') as SectionKey, limit, offset } };
}

/** Why the partner's figures are withheld, in words the page shows ("Withheld: <sentence>"). partner_setup is ONE generic sentence for a
 *  NULL, header or shared partner loan account ((k).3): it names none of them. */
export const WITHHELD_SENTENCES: Record<Exclude<PartnerState, 'ok'>, string> = {
  connection_not_active: 'This connection is not active.',
  not_group: 'This is not a group connection.',
  not_one_group: 'The two companies are no longer in one group.',
  loan_unset: 'Set a postable loan account on your side of this connection first.',
  partner_flag_off: 'The partner has not turned on intercompany loan clearing.',
  partner_setup: 'The partner has not finished setting up its loan account for this connection.',
};
