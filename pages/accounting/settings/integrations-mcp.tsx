/**
 * /accounting/settings/integrations-mcp — MCP Connector (AI agents) panel.
 *
 * Flag-gated on `mcp_connector` (dark by default; only pilot companies see it).
 * Shows the endpoint URL and per-client connect instructions, links to the PAT
 * mint page (no-OAuth fallback) and the connected-apps revoke page. Static
 * content + client-side feature check — no tenant data is fetched here.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Plug, Copy, Check, KeyRound, ShieldOff, Bot, Loader2 } from 'lucide-react';
import { MCP_PROD_ENDPOINT, CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-1 text-xs text-teal-400 hover:text-teal-300"
      aria-label="Copy to clipboard"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function CodeLine({ children }: { children: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-950 border border-slate-800 px-3 py-2">
      <code className="text-xs text-slate-200 break-all font-mono">{children}</code>
      <CopyButton text={children} />
    </div>
  );
}

export default function IntegrationsMcpPage() {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/features/check?code=mcp_connector')
      .then((r) => r.json())
      .then((d: { data?: { enabled?: boolean }; enabled?: boolean }) => {
        // apiResponse wraps in { data }, but tolerate a flat shape too.
        if (!cancelled) setEnabled(d.data?.enabled ?? d.enabled ?? false);
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <AppLayout>
      <div className="max-w-3xl mx-auto p-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-teal-900/40 border border-teal-800/50 flex items-center justify-center">
            <Bot className="h-5 w-5 text-teal-300" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-slate-100">MCP Connector (AI agents)</h1>
            <p className="text-sm text-slate-400">
              Connect Claude or Codex to operate this company&apos;s accounting over the Model Context Protocol.
            </p>
          </div>
        </div>

        {enabled === null && (
          <div className="flex items-center gap-2 text-slate-400 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking availability…
          </div>
        )}

        {enabled === false && (
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 text-sm text-slate-300">
            The MCP Connector is not enabled for this company yet. Contact your IsaFlow administrator
            to join the pilot.
          </div>
        )}

        {enabled === true && (
          <>
            <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-3">
              <h2 className="text-sm font-medium text-slate-200 flex items-center gap-2">
                <Plug className="h-4 w-4 text-teal-400" /> Endpoint
              </h2>
              <CodeLine>{MCP_PROD_ENDPOINT}</CodeLine>
              <p className="text-xs text-slate-500">
                Authenticate with the browser OAuth flow (recommended) or a personal access token.
              </p>
            </section>

            <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
              <h2 className="text-sm font-medium text-slate-200">Connect a client</h2>

              <div className="space-y-2">
                <p className="text-xs font-medium text-slate-400">Claude Code (CLI)</p>
                <CodeLine>{`claude mcp add --transport http isaflow ${MCP_PROD_ENDPOINT}`}</CodeLine>
              </div>

              <div className="space-y-1">
                <p className="text-xs font-medium text-slate-400">claude.ai</p>
                <p className="text-xs text-slate-400">
                  Settings → Connectors → Add custom connector → paste{' '}
                  <span className="font-mono text-slate-300">{MCP_PROD_ENDPOINT}</span> and complete the
                  browser login.
                </p>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-medium text-slate-400">Codex (PAT bearer)</p>
                <CodeLine>{`Authorization: Bearer pat_… → ${MCP_PROD_ENDPOINT}`}</CodeLine>
              </div>
            </section>

            <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-3">
              <h2 className="text-sm font-medium text-slate-200">Manage access</h2>
              <div className="flex flex-col sm:flex-row gap-3">
                <Link
                  href="/developer/personal-tokens"
                  className="flex-1 inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
                >
                  <KeyRound className="h-4 w-4 text-teal-400" />
                  Create a personal access token (no-OAuth fallback)
                </Link>
                <Link
                  href="/accounting/settings/connected-apps"
                  className="flex-1 inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
                >
                  <ShieldOff className="h-4 w-4 text-amber-400" />
                  Review &amp; revoke connected apps
                </Link>
              </div>
            </section>

            <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
              <h2 className="text-sm font-medium text-slate-200 mb-2">
                Available tools ({CLIENT_MCP_TOOL_NAMES.length})
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {CLIENT_MCP_TOOL_NAMES.map((name) => (
                  <span
                    key={name}
                    className="font-mono text-[11px] text-slate-300 bg-slate-950 border border-slate-800 rounded px-1.5 py-0.5"
                  >
                    {name}
                  </span>
                ))}
              </div>
              <p className="text-xs text-slate-500 mt-3">
                Reads and draft writes work with standard scopes. Posting journals and finalizing invoices
                additionally require the <span className="font-mono text-amber-300">write:post</span>{' '}
                permission, which you grant explicitly at connect time.
              </p>
            </section>
          </>
        )}
      </div>
    </AppLayout>
  );
}
