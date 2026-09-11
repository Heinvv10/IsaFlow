/**
 * sageAllocationProbe.ts
 *
 * A read-only, shape-only probe of the Sage endpoints most likely to say WHICH
 * invoice a customer receipt or supplier payment paid. The Sage list endpoints
 * the migration pulls today carry receipt headers but no allocation lines; this
 * probe answers whether Sage exposes allocations at all, without ever printing
 * client data.
 *
 * Output is SHAPE ONLY: endpoint template, HTTP status, media type, body size,
 * and the key names / nesting / array lengths of the response (sageProbeShape).
 * A human runs it (scripts/sage/probe-allocations.ts) because it reads a
 * client's live Sage data.
 */

import { DEFAULT_SAGE_BASE, buildSageHeaders } from './sageSession';
import { describeShape } from './sageProbeShape';

type IdSlot = 'receiptId' | 'invoiceId' | 'paymentId';
export interface ProbeRequest {
  label: string;
  method: 'GET' | 'POST';
  /** `{receiptId}`-style placeholders are filled from an earlier list response and printed verbatim. */
  pathTemplate: string;
  needs?: IdSlot;
  captures?: IdSlot;
}
/** Same list body the server-side pull sends, narrowed to one record. */
const ONE_RECORD = { FilterId: 0, Search: '', Skip: 0, Take: 1 };

// The /services/* names mirror Sage One SA's public API resources (the pull
// already uses TaxInvoice, CustomerReceipt-style names). Which of these carry
// allocations is exactly what is unknown; each is a guess by design.
export const PROBE_PLAN: readonly ProbeRequest[] = [
  { label: 'receipt list (one record)', method: 'POST', pathTemplate: '/services/CustomerReceipt/GetWithFilter', captures: 'receiptId' },
  { label: 'receipt single document', method: 'GET', pathTemplate: '/services/CustomerReceipt/Get/{receiptId}', needs: 'receiptId' },
  { label: 'invoice list (one record)', method: 'POST', pathTemplate: '/services/TaxInvoice/GetWithFilter', captures: 'invoiceId' },
  { label: 'invoice single document', method: 'GET', pathTemplate: '/services/TaxInvoice/Get/{invoiceId}', needs: 'invoiceId' },
  { label: 'allocation resource', method: 'GET', pathTemplate: '/services/Allocation/Get?$top=1' },
  { label: 'allocation list (one record)', method: 'POST', pathTemplate: '/services/Allocation/GetWithFilter' },
  { label: 'allocations of one receipt', method: 'GET', pathTemplate: '/services/Allocation/Get?$top=5&$filter=SourceDocumentId%20eq%20{receiptId}', needs: 'receiptId' },
  { label: 'supplier payment list (one record)', method: 'POST', pathTemplate: '/services/SupplierPayment/GetWithFilter', captures: 'paymentId' },
  { label: 'supplier payment single document', method: 'GET', pathTemplate: '/services/SupplierPayment/Get/{paymentId}', needs: 'paymentId' },
];
/** Hard ceiling on requests to the client's Sage company, whatever the plan says. */
export const PROBE_REQUEST_CAP = 10;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const BODY_DEADLINE_MS = 30000;

export interface ProbeOptions {
  base: string;
  cookie: string;
  dryRun: boolean;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  write: (line: string) => void;
  /** Defaults to PROBE_PLAN; the request cap applies to any plan. */
  plan?: readonly ProbeRequest[];
}
type Line = Record<string, unknown>;

/** Command-line arguments. Never echoes an argument: a mistyped flag may carry the cookie. */
export function parseProbeArgs(args: readonly string[]): { dryRun: boolean; base: string } {
  let dryRun = false;
  let base = DEFAULT_SAGE_BASE;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--base' && args[index + 1] !== undefined) base = args[++index]!;
    else throw new Error('Unknown or incomplete argument; the only flags are --dry-run and --base <url>, and the cookie is read from SAGE_COOKIE');
  }
  let url: URL;
  try { url = new URL(base); } catch { throw new Error('--base must be a URL'); }
  // Origin only: a path, query or fragment in --base would steer the plan's requests to other endpoints.
  if (url.pathname.replace(/\/+$/, '') !== '' || url.search || url.hash || url.username || url.password) {
    throw new Error('--base must be a bare Sage origin, e.g. https://accounting.sageone.co.za');
  }
  return { dryRun, base: url.origin };
}

function firstRecordId(body: unknown): string | null {
  const results = (body as { Results?: unknown } | null)?.Results;
  const id = Array.isArray(results) ? (results[0] as { ID?: unknown } | undefined)?.ID : undefined;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? String(id) : null;
}
/** Only the media type, and only when it looks like one; never a parameter or free text. */
function mediaType(header: string | null): string | null {
  const type = header?.split(';')[0]?.trim().toLowerCase() ?? '';
  return /^[a-z]+\/[a-z0-9.+-]{1,64}$/.test(type) ? type : null;
}

/** Reads at most MAX_BODY_BYTES within a deadline; safeFetch's own timeout ends at the headers. */
async function readBounded(response: Response): Promise<{ text: string; bytes: number } | 'too_large' | 'timeout'> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) { await response.body?.cancel(); return 'too_large'; }
  if (!response.body) return { text: '', bytes: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const deadline = Date.now() + BODY_DEADLINE_MS;
  for (;;) {
    const remaining = deadline - Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = await Promise.race([
      reader.read(),
      new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), Math.max(remaining, 0)); }),
    ]).finally(() => clearTimeout(timer));
    if (next === 'timeout') { await reader.cancel(); return 'timeout'; }
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > MAX_BODY_BYTES) { await reader.cancel(); return 'too_large'; }
    chunks.push(next.value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes };
}

async function probeOne(options: ProbeOptions, request: ProbeRequest, url: string, first: boolean): Promise<{ line: Line; body: unknown; stop: boolean }> {
  const line: Line = { endpoint: request.pathTemplate, method: request.method, label: request.label };
  try {
    const response = await options.fetch(url, {
      method: request.method,
      headers: buildSageHeaders(options.cookie),
      ...(request.method === 'POST' ? { body: JSON.stringify(ONE_RECORD) } : {}),
    });
    line.status = response.status;
    line.contentType = mediaType(response.headers.get('content-type'));
    // Sage answers an expired or wrong session with a redirect, a 401, or a 200 HTML login page. A 403
    // on a later endpoint is one resource this Sage user may not read, not a dead session.
    if (response.status === 401 || (response.status === 403 && first) || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      return { line: { ...line, result: 'session_rejected' }, body: null, stop: true };
    }
    const read = await readBounded(response);
    if (read === 'too_large') return { line: { ...line, result: 'body_too_large' }, body: null, stop: false };
    if (read === 'timeout') return { line: { ...line, result: 'body_timeout' }, body: null, stop: false };
    line.bytes = read.bytes;
    if (/^\s*</.test(read.text)) {
      // A 2xx HTML page is Sage's login screen; a 404/500 HTML page is just a wrong guess at an endpoint.
      return response.ok ? { line: { ...line, result: 'session_rejected', bodyKind: 'html' }, body: null, stop: true }
        : { line: { ...line, bodyKind: 'html' }, body: null, stop: false };
    }
    if (!read.text.trim()) return { line: { ...line, bodyKind: 'empty' }, body: null, stop: false };
    let body: unknown;
    try { body = JSON.parse(read.text); } catch { return { line: { ...line, bodyKind: 'non-json' }, body: null, stop: false }; }
    // A failing status's JSON is shape-only too: Sage error bodies can quote the request.
    return { line: { ...line, bodyKind: 'json', shape: describeShape(body) }, body: response.ok ? body : null, stop: false };
  } catch (error) {
    // The message can carry the URL (and so a captured id); only the class is safe.
    return { line: { ...line, result: 'network_error', errorType: error instanceof Error ? error.name : 'unknown' }, body: null, stop: false };
  }
}

/** Runs the plan once: no retries, dependent requests skipped without an id, hard request cap. */
export async function runAllocationProbe(options: ProbeOptions): Promise<{ requests: number }> {
  const base = options.base.replace(/\/+$/, '');
  const plan = options.plan ?? PROBE_PLAN;
  if (options.dryRun) {
    options.write(JSON.stringify({ dryRun: true, requestCap: PROBE_REQUEST_CAP, listBody: ONE_RECORD }));
    plan.slice(0, PROBE_REQUEST_CAP).forEach((request, index) =>
      options.write(JSON.stringify({ step: index + 1, method: request.method, endpoint: request.pathTemplate, label: request.label, ...(request.needs ? { needs: request.needs } : {}) })));
    return { requests: 0 };
  }
  const ids = new Map<IdSlot, string>();
  let requests = 0;
  for (const [index, request] of plan.entries()) {
    const step = index + 1;
    if (requests >= PROBE_REQUEST_CAP) { options.write(JSON.stringify({ step, result: 'request_cap_reached' })); break; }
    let path = request.pathTemplate;
    if (request.needs) {
      const id = ids.get(request.needs);
      if (!id) { options.write(JSON.stringify({ step, endpoint: request.pathTemplate, result: 'skipped_no_id' })); continue; }
      path = path.replace(`{${request.needs}}`, encodeURIComponent(id));
    }
    requests += 1;
    const { line, body, stop } = await probeOne(options, request, `${base}${path}`, requests === 1);
    if (request.captures) {
      const id = firstRecordId(body);
      if (id) ids.set(request.captures, id);
    }
    options.write(JSON.stringify({ step, ...line }));
    if (stop) { options.write(JSON.stringify({ result: 'aborted', reason: 'Sage rejected the session; no further requests were made' })); break; }
  }
  return { requests };
}
