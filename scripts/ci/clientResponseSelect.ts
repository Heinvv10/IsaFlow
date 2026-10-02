/**
 * Which tracked files are CLIENT code for the client-response gate. By imports and identifiers, never by a word in
 * a comment: a page with getServerSideProps still has client code (its server-only functions are skipped inside the
 * analysis, see inServerOnlyFn), and a file is server code only when it imports a server module.
 */
const EXCLUDED = /^(pages\/api\/|tests\/|scripts\/|node_modules\/|\.next\/|\.claude\/|docs\/|e2e\/|playwright|.*\.(config|test|spec|typeproof)\.[mc]?[jt]sx?$)/;
const CLIENT_ROOT = /^(pages\/|src\/components\/|src\/hooks\/|src\/contexts\/|src\/modules\/[^/]+\/(hooks|utils|documents|components)\/|public\/|chrome-extension\/)/;
const SHARED_ROOT = /^src\/(lib|utils)\//;   // helpers any client may import: scanned when they touch a Response or the network
const API_IMPORT = /^\s*import\b[^;]*?from\s+['"]@\/lib\/apiFetch['"]/m;
const RAW_TRANSPORT = /\bfetch\s*\(|\baxios\b|\bXMLHttpRequest\b|\bsendBeacon\b/;
/** A server-only environment variable: a client bundle cannot read it, so a helper that does is server code. */
const SERVER_ENV = /\bprocess\.env(\.(?!NEXT_PUBLIC_|NODE_ENV\b)\w+|\[)/;
const RESPONSE_SIGNATURE = /[:<]\s*Response\b/;
const BROWSER = /from ['"]react['"]|['"]use client['"]|\bwindow\.(location|addEventListener|open|history)\b|\bdocument\.(cookie|addEventListener|getElementById|createElement|querySelector)\b|\b(localStorage|sessionStorage)\.|\bnavigator\.(sendBeacon|clipboard)/;
const SERVER_IMPORT = /^\s*import\b[^;]*?\b(NextApiRequest|NextApiResponse)\b[^;]*?from|^\s*import\b[^;]*?from\s+['"](@\/lib\/neon|pg|server-only)['"]|^\s*import\s+['"]server-only['"]/m;

export function isClientFile(path: string, text: string): boolean {
  if (EXCLUDED.test(path)) return false;
  const usesApi = API_IMPORT.test(text) || path === 'src/lib/apiFetch.ts';
  if (SERVER_IMPORT.test(text) && !usesApi) return false;
  if (CLIENT_ROOT.test(path) || usesApi) return true;   // a client root is scanned whether or not it imports apiFetch (it may call an imported helper)
  if (SHARED_ROOT.test(path)) return false;   // decided by the import graph, see selectClientFiles
  return RAW_TRANSPORT.test(text) && BROWSER.test(text);
}

const IMPORT_SPEC = /(?:^|\n)\s*(?:import|export)\b[^;'"]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx'];
function resolveImport(from: string, spec: string, known: Set<string>): string | undefined {
  let base: string;
  if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith('.')) { const parts = from.split('/'); parts.pop(); for (const seg of spec.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); } base = parts.join('/'); }
  else return undefined;
  return EXTS.map((e) => base + e).find((c) => known.has(c));
}

/**
 * The client files among `tracked`: those isClientFile accepts, plus the shared helpers (src/lib, src/utils) that a
 * client file imports (directly or through another helper) and that touch a Response or the network. A helper only
 * a server route imports is not client code, and is left out.
 */
export function selectClientFiles(tracked: string[], read: (f: string) => string): string[] {
  const known = new Set(tracked);
  const text = new Map<string, string>();
  const get = (f: string) => { let t = text.get(f); if (t === undefined) { t = read(f); text.set(f, t); } return t; };
  const chosen = new Set(tracked.filter((f) => isClientFile(f, get(f))));
  const queue = [...chosen];
  while (queue.length) {
    const f = queue.pop()!;
    for (const m of get(f).matchAll(IMPORT_SPEC)) {
      const target = resolveImport(f, (m[1] ?? m[2])!, known);
      if (!target || chosen.has(target) || !SHARED_ROOT.test(target) || EXCLUDED.test(target)) continue;
      const t = get(target);
      if (SERVER_IMPORT.test(t) || SERVER_ENV.test(t) || !(RAW_TRANSPORT.test(t) || RESPONSE_SIGNATURE.test(t))) continue;
      chosen.add(target); queue.push(target);
    }
  }
  return [...chosen].sort();
}
