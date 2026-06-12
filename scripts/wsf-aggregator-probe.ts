/* eslint-disable no-console -- CLI probe: console is the intended output channel. */
/**
 * WS-F aggregator coverage probe.
 *
 * Read-only. Given sandbox API keys in the environment, lists each aggregator's
 * South African institutions and reports YES/NO for the big-5 banks. No writes,
 * no account creation, no secrets logged.
 *
 *   SALTEDGE_APP_ID=... SALTEDGE_SECRET=... MONO_SECRET_KEY=... \
 *     bun run scripts/wsf-aggregator-probe.ts
 *
 * Endpoint paths follow each vendor's published docs as of 2026-06; if a vendor
 * has since revised them, adjust SALTEDGE_BASE / MONO_BASE / the path constants.
 */

const BIG5: Array<{ label: string; patterns: RegExp }> = [
  { label: 'FNB',           patterns: /\b(fnb|first national)\b/i },
  { label: 'Absa',          patterns: /\babsa\b/i },
  { label: 'Standard Bank', patterns: /\bstandard bank\b/i },
  { label: 'Nedbank',       patterns: /\bnedbank\b/i },
  { label: 'Capitec',       patterns: /\bcapitec\b/i },
];

function reportCoverage(vendor: string, institutionNames: string[]): void {
  console.log(`\n=== ${vendor}: ${institutionNames.length} SA institutions ===`);
  for (const { label, patterns } of BIG5) {
    const hit = institutionNames.find((n) => patterns.test(n));
    console.log(`  ${hit ? 'YES' : 'NO '} ${label}${hit ? `  (${hit})` : ''}`);
  }
  const others = institutionNames.filter((n) => !BIG5.some((b) => b.patterns.test(n)));
  if (others.length) console.log(`  other: ${others.slice(0, 20).join(', ')}${others.length > 20 ? ' …' : ''}`);
}

// ── Salt Edge ─────────────────────────────────────────────────────────────────
const SALTEDGE_BASE = process.env.SALTEDGE_BASE ?? 'https://www.saltedge.com/api/v5';

async function probeSaltEdge(appId: string, secret: string): Promise<void> {
  const names: string[] = [];
  let fromId: string | null = null;
  // Paginate /providers?country_code=ZA (next_id cursor).
  for (let page = 0; page < 50; page += 1) {
    const url = new URL(`${SALTEDGE_BASE}/providers`);
    url.searchParams.set('country_code', 'ZA');
    if (fromId) url.searchParams.set('from_id', fromId);
    const res = await fetch(url, { headers: { 'App-id': appId, Secret: secret, Accept: 'application/json' } });
    if (!res.ok) { console.error(`Salt Edge: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`); return; }
    const body = (await res.json()) as { data?: Array<{ name?: string; mode?: string }>; meta?: { next_id?: string | null } };
    for (const p of body.data ?? []) if (p.name) names.push(`${p.name}${p.mode ? ` [${p.mode}]` : ''}`);
    fromId = body.meta?.next_id ?? null;
    if (!fromId) break;
  }
  reportCoverage('Salt Edge', names);
}

// ── Mono ──────────────────────────────────────────────────────────────────────
const MONO_BASE = process.env.MONO_BASE ?? 'https://api.withmono.com';

async function probeMono(secretKey: string): Promise<void> {
  // Mono institutions endpoint; scope to South Africa where the API supports it.
  const url = new URL(`${MONO_BASE}/v3/institutions`);
  url.searchParams.set('country', 'ng_za'); // ZA scope; adjust to docs if rejected
  const res = await fetch(url, { headers: { 'mono-sec-key': secretKey, Accept: 'application/json' } });
  if (!res.ok) {
    console.error(`Mono: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
    console.error('  (If 4xx, check the current institutions endpoint + country param in https://docs.mono.co)');
    return;
  }
  const body = (await res.json()) as { data?: Array<{ name?: string; country?: string }> } | Array<{ name?: string; country?: string }>;
  const list = Array.isArray(body) ? body : body.data ?? [];
  const names = list
    .filter((i) => !i.country || /za|south africa/i.test(i.country))
    .map((i) => i.name)
    .filter((n): n is string => !!n);
  reportCoverage('Mono', names);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const { SALTEDGE_APP_ID, SALTEDGE_SECRET, MONO_SECRET_KEY } = process.env;
  let ran = false;

  if (SALTEDGE_APP_ID && SALTEDGE_SECRET) {
    ran = true;
    try { await probeSaltEdge(SALTEDGE_APP_ID, SALTEDGE_SECRET); }
    catch (err) { console.error('Salt Edge probe failed:', err instanceof Error ? err.message : err); }
  }
  if (MONO_SECRET_KEY) {
    ran = true;
    try { await probeMono(MONO_SECRET_KEY); }
    catch (err) { console.error('Mono probe failed:', err instanceof Error ? err.message : err); }
  }

  if (!ran) {
    console.log('No keys provided. Set SALTEDGE_APP_ID + SALTEDGE_SECRET and/or MONO_SECRET_KEY.');
    console.log('See docs/wsf-bank-feeds/aggregator-spike.md for sandbox signup steps.');
    process.exitCode = 1;
  }
}

void main();
