/**
 * The `payroll_net_pay` Default Accounts setting, as ONE module every reader and writer shares: the key names, the
 * account-id pattern, and the parser of the stored row. It lives in `gl/` (with the rules, `netPayTargetRules`) so
 * the Default Accounts save, the account-merge guard and the payroll resolver all depend on `gl/`, never the reverse.
 *
 * The setting is a key inside the JSON row `app_settings.accounting_default_accounts` and holds a gl_accounts.id or
 * nothing. `app_settings.value` is TEXT (the view over accounting_settings), so the row reaches TypeScript as an
 * object (a JSONB driver), as JSON text, or, when something wrote it twice, as JSON text OF a JSON string.
 */

/** The `app_settings` row that holds the Default Accounts mappings. The generic settings PUT refuses it. */
export const DEFAULT_ACCOUNTS_SETTINGS_KEY = 'accounting_default_accounts';

/** The UI / app_settings key inside that row. */
export const PAYROLL_NET_PAY_KEY = 'payroll_net_pay';

/** A gl_accounts.id. Tested before an id reaches a `::UUID` cast. */
export const ACCOUNT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NetPaySettingRead =
  | { ok: true; accountId: string | null }
  | { ok: false; reason: string };

const MAX_UNWRAP = 2;

/**
 * The account id the stored row names for payroll net pay: `{ok:true, accountId}` (null = not set, net pay goes to
 * the bank), or `{ok:false}` when the row cannot be read. A row that cannot be read is NEVER "not set": the company
 * may have chosen a clearing account, and reading its row as empty would credit the bank and count net pay twice.
 *
 * Unreadable: text that is not JSON; JSON that is not an object (a number, an array, a string that does not unwrap
 * to an object after two decodes); a `payroll_net_pay` that is not a string.
 */
export function parseNetPayAccountId(raw: unknown): NetPaySettingRead {
  let value: unknown = raw;
  for (let i = 0; i < MAX_UNWRAP && typeof value === 'string' && value !== ''; i++) {
    try {
      value = JSON.parse(value);
    } catch (err) {
      return { ok: false, reason: `the stored value is not valid JSON (${err instanceof Error ? err.message : 'parse error'})` };
    }
  }
  if (value === null || value === undefined || value === '') return { ok: true, accountId: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: `the stored value is a ${Array.isArray(value) ? 'list' : typeof value}, not an object of settings` };
  }
  const id = (value as Record<string, unknown>)[PAYROLL_NET_PAY_KEY];
  if (id === undefined || id === null || id === '') return { ok: true, accountId: null };
  if (typeof id !== 'string') return { ok: false, reason: `'${PAYROLL_NET_PAY_KEY}' is a ${typeof id}, not an account id` };
  return { ok: true, accountId: id };
}
