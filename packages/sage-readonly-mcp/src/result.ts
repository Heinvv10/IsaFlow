/** Tool result helpers shared by tools.ts and partyBalance.ts. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
export const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

/** OData datetime literal from a validated YYYY-MM-DD[THH:MM[:SS]]. */
export function odataDate(value: string): string {
  const [d, t = '00:00:00'] = value.split('T');
  return `datetime'${d}T${t.length === 5 ? `${t}:00` : t}'`;
}
