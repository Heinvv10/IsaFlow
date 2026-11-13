/** Tool result helpers shared by tools.ts and partyBalance.ts. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
export const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

/** True for a real calendar date / time in YYYY-MM-DD[THH:MM[:SS]] (2026-02-30 is false). */
export function isRealDateTime(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value);
  if (!m) return false;
  const [y, mo, d, h = '0', mi = '0', s = '0'] = m.slice(1);
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return dt.getUTCFullYear() === Number(y) && dt.getUTCMonth() === Number(mo) - 1 && dt.getUTCDate() === Number(d)
    && Number(h) < 24 && Number(mi) < 60 && Number(s) < 60;
}

/** Today's date where the server runs (Sage ZA documents are dated in SAST), as YYYY-MM-DD. */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** OData datetime literal from a validated YYYY-MM-DD[THH:MM[:SS]]. Sage stores local (SAST) times without a zone. */
export function odataDate(value: string): string {
  const [d, t = '00:00:00'] = value.split('T');
  return `datetime'${d}T${t.length === 5 ? `${t}:00` : t}'`;
}
