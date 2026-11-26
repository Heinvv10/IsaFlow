/**
 * The MCP connector switch on /accounting/settings/integrations-mcp (migration 1058).
 *
 * A company owner or admin switches the connector on or off for the session company
 * (POST /api/accounting/mcp-connector-setting). Other roles see the state and why they cannot change it. A
 * platform admin's OFF is a lock: the switch is disabled and says so. Switching off revokes nothing; every MCP
 * call is checked, so connected assistants stop at once and work again if it is switched back on.
 */
import { useState } from 'react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { Toggle } from '@/components/accounting/settings/settingsTypes';

export interface McpConnectorState {
  /** The company this state was loaded for. The POST names it, so a page left open after the active company was
   * switched in another tab is refused (409) instead of changing the other company. */
  companyId: string;
  enabled: boolean;
  lockedByPlatform: boolean;
  canToggle: boolean;
}

export const MCP_SWITCH_COPY = {
  notOwner: 'Only a company owner or admin can change this.',
  locked: 'Switched off by IsaFlow. Contact IsaFlow support.',
  consent: 'Each person still approves access in the sign-in window. Write permissions start unticked.',
  offEffect:
    'Connected assistants stop working straight away. Switching it back on lets existing connections work again; remove them under Connected Apps if you do not want that.',
  failed: 'Could not change the MCP Connector setting. Try again.',
} as const;

export function McpConnectorSwitch({ state, onChange }: {
  state: McpConnectorState;
  onChange: (next: McpConnectorState) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const disabled = saving || !state.canToggle || (state.lockedByPlatform && !state.enabled);

  async function toggle(next: boolean) {
    setSaving(true);
    setError('');
    try {
      const r = await apiFetch('/api/accounting/mcp-connector-setting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next, companyId: state.companyId }),
      });
      await assertOk(r, MCP_SWITCH_COPY.failed);
      const body = (await r.json()) as { data?: McpConnectorState };
      if (!body.data) throw new Error('no data');
      onChange(body.data);
    } catch (err) {
      setError(apiErrorMessage(err, MCP_SWITCH_COPY.failed));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-slate-200">MCP Connector for this company</h2>
        <span className="text-sm text-slate-200" data-testid="mcp-connector-state">{state.enabled ? 'On' : 'Off'}</span>
      </div>
      <Toggle
        checked={state.enabled}
        disabled={disabled}
        onChange={(v) => { void toggle(v); }}
        label={state.enabled ? 'Switch the MCP Connector off' : 'Switch the MCP Connector on'}
      />
      {!state.canToggle && <p className="text-xs text-ink-muted">{MCP_SWITCH_COPY.notOwner}</p>}
      {state.lockedByPlatform && !state.enabled && (
        <p className="text-xs text-amber-300">{MCP_SWITCH_COPY.locked}</p>
      )}
      <p className="text-xs text-ink-muted">{MCP_SWITCH_COPY.consent}</p>
      {state.enabled && state.canToggle && <p className="text-xs text-ink-muted">{MCP_SWITCH_COPY.offEffect}</p>}
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
    </section>
  );
}
