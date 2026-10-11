/**
 * The words for a cost-centre pick a posting did not apply — one module, with
 * no imports, read by both ends: the server builds the sentence it returns in
 * `warnings` (gl/dimensions/costCentrePick), and the screens read the centre
 * and the reason back out of it for a notice short enough to be seen whole
 * (components/accounting/postingWarningsNotice). Kept together so the sentence
 * and its reader cannot drift apart; costCentrePickWording.test.ts round-trips
 * every reason.
 */
export type PickDropReason = 'inactive' | 'occupied' | 'conflict';

export interface PickDrop {
  /** 1-based line of the document the pick was on. */
  line: number;
  reason: PickDropReason;
  /** The centre's code. */
  code: string;
}

const SENTENCE: Record<PickDropReason, (code: string) => string> = {
  inactive: (code) => `cost centre ${code} is inactive and was not applied — the line posts without it.`,
  occupied: (code) => `cost centre ${code} was not applied — the line already carries its own CC1 or project.`,
  conflict: (code) => `project ${code} was not applied — it belongs to another FNO than the line's CC1.`,
};

/** In a few words, for a title: what was not applied, and why. */
const FACT: Record<PickDropReason, (code: string) => string> = {
  inactive: (code) => `cost centre ${code} not applied (inactive)`,
  occupied: (code) => `cost centre ${code} not applied (the line has its own)`,
  conflict: (code) => `project ${code} not applied (another FNO)`,
};

/** The full sentence a posting returns for one dropped pick. */
export function pickDropSentence(drop: PickDrop): string {
  return `Line ${drop.line}: ${SENTENCE[drop.reason](drop.code)}`;
}

/** The dropped pick a sentence describes, or null when it is not one of ours. */
export function parsePickDropSentence(sentence: string): PickDrop | null {
  const m = /^Line (\d+): ([\s\S]*)$/.exec(sentence);
  if (!m) return null;
  for (const reason of Object.keys(SENTENCE) as PickDropReason[]) {
    const [before, after] = SENTENCE[reason]('\u0000').split('\u0000') as [string, string];
    const rest = m[2]!;
    if (rest.length > before.length + after.length && rest.startsWith(before) && rest.endsWith(after)) {
      return { line: Number(m[1]), reason, code: rest.slice(before.length, rest.length - after.length) };
    }
  }
  return null;
}

/** "cost centre OLD not applied (inactive)" — which centre and why, short enough for a notice's title. */
export function pickDropFact(drop: PickDrop): string {
  return FACT[drop.reason](drop.code);
}
