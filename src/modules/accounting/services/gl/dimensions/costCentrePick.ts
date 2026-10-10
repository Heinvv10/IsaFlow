/**
 * A user-picked cost centre goes into the right dimension slot — the one rule
 * every writer that used to set only the legacy `costCenterId` now uses: AP
 * expense lines, expense claims, provisional capture, the GL import, the REST
 * journal body, recurring journals and templates, and petty cash (PR #688
 * rounds 3-4). A line's CC1 is cc1_id alone (reports/dimensionPnlService.ts),
 * so a centre written only to the legacy cost_center_id was invisible to every
 * report; these paths no longer write that column.
 *
 * Run by the writer BEFORE createJournalEntry, so on a new assignment the
 * dimension policy's CC2 -> FNO derivation and the slot checks see the result.
 * Never on a historical copy: a reversal or reclassification carries cc1_id
 * and cc2_id exactly as stored.
 *
 *  - a CC1 (`cc_type 'cc1'`) fills cc1Id — only when the line has no CC1 and
 *    no CC2. With a CC2, derivation supplies the CC1 (a bill whose header names
 *    one FNO and whose item names a project under another posted refused);
 *  - a CC2 fills cc2Id when the line has none;
 *  - a slot the line already fills keeps its own value; the pick is dropped;
 *  - an INACTIVE centre is dropped, and the line posts without it. A withdrawn
 *    picker option on a claim or a receipt used to post (into the legacy
 *    column); refusing it now would strand the document;
 *  - anything else — another company's id, no centre at all, an untyped
 *    centre — is REFUSED (CostCentrePickRefusal, a PreWriteDimensionRefusal: a 4xx).
 *
 * `storedPosting` (AP only). A bill posts what it stores, in historical-copy
 * mode, so nothing derives or checks an FNO after this. There a CC2 pick also
 * brings its FNO: on a line with no CC1 the project's FNO becomes the CC1 (what
 * a new assignment derives), and on a line that has a CC1 the project is placed
 * unless its FNO is ANOTHER CC1 — then it is dropped, never stored as a pair no
 * report can reconcile. A project with no FNO at all contradicts nothing and is
 * placed beside any CC1, exactly as derivation leaves that pair on a new line.
 *
 * EVERY DROP IS REPORTED: `warnings` names the line and the centre's code, for
 * the caller to return with its posting result, and log.warn records the ids.
 * A pick that only repeats what the slot already holds is not a drop.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { UUID_RE } from '@/lib/validation';
import { PreWriteDimensionRefusal, type DimensionIds } from './dimensionTypes';
import { deriveFnoId, loadCostCentreChains } from './dimensionDerivation';

export const COST_CENTRE_OUTSIDE_COMPANY = 'One or more journal lines name a cost centre outside this company';
export const COST_CENTRE_NOT_A_CC1_OR_CC2 = 'CC1 must name an active CC1 cost centre in this company';

/** A pick that cannot be placed or dropped. `lineIndex` is the 0-based line it was on. */
export class CostCentrePickRefusal extends PreWriteDimensionRefusal {
  declare readonly lineIndex: number;
  constructor(message: string, lineIndex: number) {
    super(message, lineIndex);
    this.name = 'CostCentrePickRefusal';
  }
}

export interface PickedCentre {
  ccType: string | null;
  isActive: boolean;
  /** storedPosting only, CC2 only: the project's FNO, or null when its chain reaches none. */
  fnoId?: string | null;
}

export type DropReason = 'inactive' | 'occupied' | 'conflict';
export type PickOutcome =
  | { kind: 'cc1' }
  | { kind: 'cc2'; cc1Id?: string }
  | { kind: 'same' }
  | { kind: 'drop'; reason: DropReason }
  | { kind: 'refuse'; message: string };

const eq = (a: string | undefined, b: string): boolean => a !== undefined && a.toLowerCase() === b.toLowerCase();

/**
 * THE rule. `centre` is the picked id's row in the line's own company, or
 * undefined when it has none; `centre.fnoId` is set only for a stored posting.
 */
export function costCentreSlot(pickId: string, centre: PickedCentre | undefined, line: DimensionIds): PickOutcome {
  if (centre === undefined) return { kind: 'refuse', message: COST_CENTRE_OUTSIDE_COMPANY };
  if (centre.ccType !== 'cc1' && centre.ccType !== 'cc2') return { kind: 'refuse', message: COST_CENTRE_NOT_A_CC1_OR_CC2 };
  if (eq(centre.ccType === 'cc1' ? line.cc1Id : line.cc2Id, pickId)) return { kind: 'same' };
  if (!centre.isActive) return { kind: 'drop', reason: 'inactive' };
  if (centre.ccType === 'cc1') return line.cc1Id || line.cc2Id ? { kind: 'drop', reason: 'occupied' } : { kind: 'cc1' };
  if (line.cc2Id) return { kind: 'drop', reason: 'occupied' };
  if (centre.fnoId === undefined) return { kind: 'cc2' }; // a new assignment: derivation and its conflict check follow
  // A project whose chain reaches no FNO contradicts no CC1: it is placed, as derivation leaves such a pair alone.
  if (!centre.fnoId) return { kind: 'cc2' };
  if (!line.cc1Id) return { kind: 'cc2', cc1Id: centre.fnoId };
  return eq(line.cc1Id, centre.fnoId) ? { kind: 'cc2' } : { kind: 'drop', reason: 'conflict' };
}

const DROPPED: Record<DropReason, (code: string) => string> = {
  inactive: (code) => `cost centre ${code} is inactive and was not applied — the line posts without it.`,
  occupied: (code) => `cost centre ${code} was not applied — the line already carries its own CC1 or project.`,
  conflict: (code) => `project ${code} was not applied — it belongs to another FNO than the line's CC1.`,
};

export interface PlacedLines<T> {
  lines: Array<Omit<T, 'costCenterId'>>;
  /** One per dropped pick, for the caller's posting result; empty when every pick landed. */
  warnings: string[];
}

/**
 * Each line's `costCenterId` (the pick) moved into its slot by `costCentreSlot`
 * and removed. One read of this company's centres (plus the projects' chains
 * for a stored posting); none when nothing is picked. Throws the refusal
 * before anything is written.
 */
export async function placeCostCentres<T extends DimensionIds & { costCenterId?: string }>(
  companyId: string,
  lines: readonly T[],
  opts: { storedPosting?: boolean } = {},
): Promise<PlacedLines<T>> {
  const picked = [...new Set(lines.map((l) => l.costCenterId).filter((id): id is string => Boolean(id)))];
  // Not a string (a stored template or a request body can hold anything) or not a UUID: no centre of this company.
  const malformed = lines.findIndex((l) => l.costCenterId && (typeof l.costCenterId !== 'string' || !UUID_RE.test(l.costCenterId)));
  if (malformed >= 0) throw new CostCentrePickRefusal(COST_CENTRE_OUTSIDE_COMPANY, malformed);
  const centres = new Map<string, PickedCentre & { code: string }>();
  if (picked.length > 0) {
    const rows = (await sql`
      SELECT id::TEXT AS id, code, cc_type, is_active FROM cost_centres
      WHERE company_id = ${companyId}::UUID AND id = ANY(${picked}::UUID[])
    `) as Array<{ id: string; code: string; cc_type: string | null; is_active: boolean | null }>;
    for (const r of rows) centres.set(r.id.toLowerCase(), { code: String(r.code), ccType: r.cc_type, isActive: r.is_active === true });
    const projects = opts.storedPosting ? [...centres].filter(([, c]) => c.ccType === 'cc2').map(([id]) => id) : [];
    if (projects.length > 0) {
      const chains = await loadCostCentreChains(companyId, projects);
      for (const id of projects) centres.get(id)!.fnoId = deriveFnoId(id, chains);
    }
  }
  const warnings: string[] = [];
  const placed = lines.map((line, i) => {
    const { costCenterId, ...rest } = line;
    if (!costCenterId) return rest;
    const centre = centres.get(costCenterId.toLowerCase());
    const outcome = costCentreSlot(costCenterId, centre, rest);
    if (outcome.kind === 'refuse') throw new CostCentrePickRefusal(outcome.message, i);
    if (outcome.kind === 'same') return rest;
    if (outcome.kind === 'drop') {
      warnings.push(`Line ${i + 1}: ${DROPPED[outcome.reason](centre!.code)}`);
      log.warn(`Cost centre pick dropped from a journal line (${outcome.reason})`, { companyId, costCentreId: costCenterId }, 'accounting');
      return rest;
    }
    if (outcome.kind === 'cc1') return { ...rest, cc1Id: costCenterId };
    return { ...rest, cc2Id: costCenterId, ...(outcome.cc1Id ? { cc1Id: outcome.cc1Id } : {}) };
  });
  return { lines: placed, warnings };
}
