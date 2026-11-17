/**
 * The payslip-email routes' payloads, checked at run time (wave 6 PE; none is in the apiRoutes registry), and how the
 * card folds the answers of several send requests (the server sends at most a batch per request) into one outcome.
 */
export interface EmailState { platformEnabled: boolean; enabled: boolean }
export interface Who { employeeId: string; employeeNumber: string; employeeName: string }
export interface EmailOutcome {
  sent: Array<Who & { addressChanged: boolean }>;
  failed: Array<Who & { error: string }>;
  uncertain: Who[];
  skipped: Array<Who & { reason: string }>;
  remaining: number;
}
export interface Delivery extends Who { status: 'sent' | 'failed' | 'unknown'; recipient: string; at: string; attempts: number }

const text = (x: Record<string, unknown>, k: string) => (typeof x[k] === 'string' ? (x[k] as string) : null);

function who(x: unknown): Who | null {
  const r = x as Record<string, unknown> | null;
  if (!r) return null;
  const [employeeId, employeeNumber, employeeName] = [text(r, 'employeeId'), text(r, 'employeeNumber'), text(r, 'employeeName')];
  return employeeId && employeeNumber && employeeName !== null ? { employeeId, employeeNumber, employeeName } : null;
}
const list = (u: unknown): Array<Record<string, unknown>> => (Array.isArray(u) ? u.filter((x) => who(x) !== null) : []);

export function stateOf(d: unknown): EmailState {
  const s = d as Partial<EmailState> | null;
  if (typeof s?.platformEnabled !== 'boolean' || typeof s?.enabled !== 'boolean') throw new Error('Unexpected response');
  return { platformEnabled: s.platformEnabled, enabled: s.enabled };
}

export function outcomeOf(d: unknown): EmailOutcome {
  const o = (d ?? {}) as Record<string, unknown>;
  return {
    sent: list(o.sent).map((x) => ({ ...who(x)!, addressChanged: x.addressChanged === true })),
    failed: list(o.failed).map((x) => ({ ...who(x)!, error: text(x, 'error') ?? 'Not sent' })),
    uncertain: list(o.uncertain).map((x) => who(x)!),
    skipped: list(o.skipped).map((x) => ({ ...who(x)!, reason: text(x, 'reason') ?? 'UNKNOWN' })),
    remaining: typeof o.remaining === 'number' && o.remaining > 0 ? o.remaining : 0,
  };
}

/** Two answers as one: the lists added up; a later ALREADY_SENT for someone this loop just sent is not a skip. */
export function mergeOutcomes(a: EmailOutcome, b: EmailOutcome): EmailOutcome {
  const handled = new Set([...a.sent, ...a.failed, ...a.uncertain].map((w) => w.employeeId));
  const skipped = [...a.skipped];
  for (const s of b.skipped) {
    if (handled.has(s.employeeId) || skipped.some((k) => k.employeeId === s.employeeId)) continue;
    skipped.push(s);
  }
  return {
    sent: [...a.sent, ...b.sent], failed: [...a.failed, ...b.failed], uncertain: [...a.uncertain, ...b.uncertain],
    skipped, remaining: b.remaining,
  };
}

export function deliveriesOf(d: unknown): Delivery[] {
  return list(d).flatMap((x) => {
    const status = x.status;
    if (status !== 'sent' && status !== 'failed' && status !== 'unknown') return [];
    return [{ ...who(x)!, status, recipient: text(x, 'recipient') ?? '', at: text(x, 'at') ?? '', attempts: Number(x.attempts) || 1 }];
  });
}
