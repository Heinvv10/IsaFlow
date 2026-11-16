/**
 * Bulk accept of high-confidence suggestions, the READ half (audit WP6, Hein decision 2a.2): which lines of one bank
 * account would post if a person accepted every suggestion the categoriser is sure of, and the PREVIEW TOKEN that pins
 * exactly those lines.
 *
 * The token carries each line's id, its suggestion (GL account and VAT code) and a version (`updated_at` to the
 * microsecond). It is NOT a credential and needs no signature: confirm (bankBulkAcceptService) re-reads every line
 * under its row lock and posts it only when it still matches the token AND still passes the gate, so a forged or stale
 * token can at worst be refused. Nothing it names is posted from the token's say-so.
 *
 * "High confidence" is the auto-post gate's own ladder (`evaluate`), with the settings' enabled switches treated as on:
 * a person is choosing, so the switches do not apply, but the confidence floor, the amount caps, the LLM tier's own
 * thresholds and "a shared-pool suggestion is never bulk-posted" all do.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { evaluate } from './autoPostGate';
import { getAutoPostSettings, type AutoPostSettings } from './autoPostSettingsService';
import { feedStateOf } from './bankFeedStateGuard';

/** The most lines one confirm posts. A request is one transaction; this keeps it (and its locks) short. */
export const BULK_ACCEPT_MAX_LINES = 100;
/** A person may ask for more caution than the company's auto-post floor, never less than this. */
export const BULK_ACCEPT_MIN_CONFIDENCE_FLOOR = 0.8;
const CANDIDATE_SCAN_LIMIT = 1000;

export class BulkAcceptRefusal extends Error {
  readonly code = 'BULK_ACCEPT_REFUSED';
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = 'BulkAcceptRefusal';
  }
}
export const isBulkAcceptRefusal = (err: unknown): err is BulkAcceptRefusal =>
  err instanceof Error && (err as { code?: unknown }).code === 'BULK_ACCEPT_REFUSED';

export interface PreviewLine {
  id: string; date: string; description: string | null; amount: number;
  glAccountId: string; glAccountCode: string | null; glAccountName: string | null;
  vatCode: string | null; confidence: number; strategy: string | null; version: string;
}
export interface BulkAcceptPreview {
  bankAccountId: string; minConfidence: number;
  lines: PreviewLine[]; totalIn: number; totalOut: number;
  byAccount: Array<{ glAccountId: string; code: string | null; name: string | null; count: number; totalIn: number; totalOut: number }>;
  /** More lines qualified than one confirm posts: the first BULK_ACCEPT_MAX_LINES (by id) are listed. */
  truncated: boolean; totalEligible: number;
  previewToken: string;
}

/** One line of the token: id, GL account, VAT code, version. */
export interface TokenLine { i: string; g: string; x: string | null; s: string }
export interface PreviewToken { v: 1; a: string; t: number; l: TokenLine[] }

export const encodeToken = (t: PreviewToken): string => Buffer.from(JSON.stringify(t)).toString('base64url');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function decodeToken(raw: unknown): PreviewToken {
  const bad = () => new BulkAcceptRefusal('The preview token is not valid. Preview again and confirm that.');
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64 * 1024) throw bad();
  let t: PreviewToken;
  try { t = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as PreviewToken; } catch { throw bad(); }
  if (t?.v !== 1 || typeof t.a !== 'string' || !UUID.test(t.a) || typeof t.t !== 'number' || !Array.isArray(t.l)) throw bad();
  if (t.l.length === 0 || t.l.length > BULK_ACCEPT_MAX_LINES) throw new BulkAcceptRefusal(`A confirm posts 1 to ${BULK_ACCEPT_MAX_LINES} lines.`);
  const seen = new Set<string>();
  for (const l of t.l) {
    if (typeof l?.i !== 'string' || !UUID.test(l.i) || typeof l.g !== 'string' || !UUID.test(l.g) || typeof l.s !== 'string'
      || (l.x !== null && typeof l.x !== 'string') || seen.has(l.i.toLowerCase())) throw bad();
    seen.add(l.i.toLowerCase());
  }
  return t;
}

/** The gate settings a person's bulk accept is judged by: the company's caps and thresholds, the switches on. */
export function bulkAcceptSettings(base: AutoPostSettings, minConfidence: number): AutoPostSettings {
  return { ...base, enabled: true, llmEnabled: true, minConfidence, llmMinConfidence: Math.max(minConfidence, base.llmMinConfidence) };
}

export function resolveMinConfidence(base: AutoPostSettings, requested: number | undefined): number {
  const wanted = requested ?? base.minConfidence;
  if (!Number.isFinite(wanted) || wanted > 1) throw new BulkAcceptRefusal('minConfidence must be a number from 0.80 to 1.');
  return Math.max(BULK_ACCEPT_MIN_CONFIDENCE_FLOOR, wanted);
}

const money = (n: number) => Math.round(n * 100) / 100;

export async function previewBulkAccept(companyId: string, bankAccountId: string, requested?: number): Promise<BulkAcceptPreview> {
  const base = await getAutoPostSettings(companyId);
  const minConfidence = resolveMinConfidence(base, requested);
  const settings = bulkAcceptSettings(base, minConfidence);
  const rows = (await sql`
    SELECT bt.id::TEXT AS id, bt.transaction_date::TEXT AS date, bt.description, bt.amount, bt.status, bt.feed_state,
           bt.suggested_gl_account_id::TEXT AS gl, bt.suggested_confidence AS confidence, bt.suggested_vat_code AS vat,
           bt.suggested_strategy AS strategy, ga.account_code, ga.account_name,
           to_char(bt.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS version
    FROM bank_transactions bt
    LEFT JOIN gl_accounts ga ON ga.id = bt.suggested_gl_account_id AND ga.company_id = bt.company_id
    WHERE bt.company_id = ${companyId}::UUID AND bt.bank_account_id = ${bankAccountId}::UUID
      AND bt.status = 'imported' AND bt.suggested_gl_account_id IS NOT NULL AND bt.suggested_confidence >= ${minConfidence}::NUMERIC
    ORDER BY bt.id
    LIMIT ${CANDIDATE_SCAN_LIMIT}`) as DbRow[];
  const eligible = rows.filter((r) => feedStateOf(r) === 'posted' && evaluate(
    { status: String(r.status), amount: Number(r.amount), suggestedGlAccountId: String(r.gl) },
    Number(r.confidence), settings, r.strategy == null ? null : String(r.strategy)).outcome === 'post');
  const chosen = eligible.slice(0, BULK_ACCEPT_MAX_LINES);
  const lines: PreviewLine[] = chosen.map((r) => ({
    id: String(r.id), date: String(r.date), description: r.description == null ? null : String(r.description),
    amount: Number(r.amount), glAccountId: String(r.gl), glAccountCode: r.account_code == null ? null : String(r.account_code),
    glAccountName: r.account_name == null ? null : String(r.account_name), vatCode: r.vat == null ? null : String(r.vat),
    confidence: Number(r.confidence), strategy: r.strategy == null ? null : String(r.strategy), version: String(r.version),
  }));
  const groups = new Map<string, BulkAcceptPreview['byAccount'][number]>();
  let totalIn = 0;
  let totalOut = 0;
  for (const l of lines) {
    const g = groups.get(l.glAccountId) ?? { glAccountId: l.glAccountId, code: l.glAccountCode, name: l.glAccountName, count: 0, totalIn: 0, totalOut: 0 };
    g.count += 1;
    if (l.amount >= 0) { g.totalIn = money(g.totalIn + l.amount); totalIn = money(totalIn + l.amount); }
    else { g.totalOut = money(g.totalOut - l.amount); totalOut = money(totalOut - l.amount); }
    groups.set(l.glAccountId, g);
  }
  const token: PreviewToken = { v: 1, a: bankAccountId, t: minConfidence, l: lines.map((l) => ({ i: l.id, g: l.glAccountId, x: l.vatCode, s: l.version })) };
  return {
    bankAccountId, minConfidence, lines, totalIn, totalOut, byAccount: [...groups.values()],
    truncated: eligible.length > chosen.length, totalEligible: eligible.length, previewToken: encodeToken(token),
  };
}
