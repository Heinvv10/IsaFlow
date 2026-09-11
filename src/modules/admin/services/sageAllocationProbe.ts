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
 * and the key names / nesting / array lengths of the response. Values, ids,
 * names, amounts and data-shaped keys are never printed. A human runs it
 * (scripts/sage/probe-allocations.ts) because it reads a client's live Sage data.
 */

import { buildSageHeaders } from './sageSession';

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
const MAX_DEPTH = 8;
const DICTIONARY_KEYS = 100;
const SAMPLE_ITEMS = 5;

export type Shape = string | { object: Record<string, Shape>; redactedKeys?: number }
  | { array: number; items?: Shape } | { dictionary: number; values?: Shape };

// A DTO field name is an identifier. Anything else (spaces, @, dots, hyphens,
// leading digits — ids, emails, names used as keys) is data and is only counted.
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function mergeShapes(a: Shape | undefined, b: Shape): Shape {
  if (a === undefined) return b;
  if (typeof a === 'string' || typeof b === 'string') {
    const parts = new Set([...(typeof a === 'string' ? a.split('|') : ['object']), ...(typeof b === 'string' ? b.split('|') : ['object'])]);
    return [...parts].sort().join('|');
  }
  if ('object' in a && 'object' in b) {
    const object: Record<string, Shape> = { ...a.object };
    for (const [key, value] of Object.entries(b.object)) object[key] = mergeShapes(object[key], value);
    const redactedKeys = Math.max(a.redactedKeys ?? 0, b.redactedKeys ?? 0);
    return redactedKeys ? { object, redactedKeys } : { object };
  }
  if ('array' in a && 'array' in b) {
    const items = b.items === undefined ? a.items : mergeShapes(a.items, b.items);
    return items === undefined ? { array: Math.max(a.array, b.array) } : { array: Math.max(a.array, b.array), items };
  }
  return 'mixed';
}

function sampleShape(values: unknown[], depth: number): Shape | undefined {
  let merged: Shape | undefined;
  for (const value of values.slice(0, SAMPLE_ITEMS)) merged = mergeShapes(merged, describeShape(value, depth + 1));
  return merged;
}

/** Structure of a decoded JSON value with every value and data-shaped key removed. */
export function describeShape(value: unknown, depth = 0): Shape {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return { array: value.length };
    const items = sampleShape(value, depth);
    return items === undefined ? { array: value.length } : { array: value.length, items };
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (depth >= MAX_DEPTH) return 'object';
    if (entries.length > DICTIONARY_KEYS) {
      const values = sampleShape(entries.map(([, v]) => v), depth);
      return values === undefined ? { dictionary: entries.length } : { dictionary: entries.length, values };
    }
    const object: Record<string, Shape> = {};
    let redactedKeys = 0;
    for (const [key, child] of entries) {
      if (FIELD_NAME.test(key)) object[key] = describeShape(child, depth + 1);
      else redactedKeys += 1;
    }
    return redactedKeys ? { object, redactedKeys } : { object };
  }
  return typeof value;
}

export interface ProbeOptions {
  base: string;
  cookie: string;
  dryRun: boolean;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  write: (line: string) => void;
}
type Line = Record<string, unknown>;

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

async function probeOne(options: ProbeOptions, request: ProbeRequest, url: string): Promise<{ line: Line; body: unknown; stop: boolean }> {
  const line: Line = { endpoint: request.pathTemplate, method: request.method, label: request.label };
  let response: Response;
  try {
    response = await options.fetch(url, {
      method: request.method,
      headers: buildSageHeaders(options.cookie),
      ...(request.method === 'POST' ? { body: JSON.stringify(ONE_RECORD) } : {}),
    });
  } catch (error) {
    // The message can carry the URL (and so a captured id); only the class is safe.
    return { line: { ...line, result: 'network_error', errorType: error instanceof Error ? error.name : 'unknown' }, body: null, stop: false };
  }
  line.status = response.status;
  line.contentType = mediaType(response.headers.get('content-type'));
  // Sage answers an expired or wrong session with a redirect, 401/403, or a 200 HTML login page.
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
    return { line: { ...line, result: 'session_rejected' }, body: null, stop: true };
  }
  const text = await response.text();
  line.bytes = Buffer.byteLength(text);
  if (line.bytes as number > MAX_BODY_BYTES) return { line: { ...line, result: 'body_too_large' }, body: null, stop: false };
  if (/^\s*</.test(text)) return { line: { ...line, result: 'session_rejected', bodyKind: 'html' }, body: null, stop: true };
  if (!text.trim()) return { line: { ...line, bodyKind: 'empty' }, body: null, stop: false };
  let body: unknown;
  try { body = JSON.parse(text); } catch { return { line: { ...line, bodyKind: 'non-json' }, body: null, stop: false }; }
  // A failing status's JSON is shape-only too: Sage error bodies can quote the request.
  return { line: { ...line, bodyKind: 'json', shape: describeShape(body) }, body: response.ok ? body : null, stop: false };
}

/** Runs the fixed plan once: no retries, dependent requests skipped without an id, hard request cap. */
export async function runAllocationProbe(options: ProbeOptions): Promise<{ requests: number }> {
  const base = options.base.replace(/\/+$/, '');
  if (options.dryRun) {
    options.write(JSON.stringify({ dryRun: true, requestCap: PROBE_REQUEST_CAP, listBody: ONE_RECORD }));
    PROBE_PLAN.slice(0, PROBE_REQUEST_CAP).forEach((request, index) =>
      options.write(JSON.stringify({ step: index + 1, method: request.method, endpoint: request.pathTemplate, label: request.label, ...(request.needs ? { needs: request.needs } : {}) })));
    return { requests: 0 };
  }
  const ids = new Map<IdSlot, string>();
  let requests = 0;
  for (const [index, request] of PROBE_PLAN.entries()) {
    const step = index + 1;
    if (requests >= PROBE_REQUEST_CAP) { options.write(JSON.stringify({ step, result: 'request_cap_reached' })); break; }
    let path = request.pathTemplate;
    if (request.needs) {
      const id = ids.get(request.needs);
      if (!id) { options.write(JSON.stringify({ step, endpoint: request.pathTemplate, result: 'skipped_no_id' })); continue; }
      path = path.replace(`{${request.needs}}`, encodeURIComponent(id));
    }
    requests += 1;
    const { line, body, stop } = await probeOne(options, request, `${base}${path}`);
    if (request.captures) {
      const id = firstRecordId(body);
      if (id) ids.set(request.captures, id);
    }
    options.write(JSON.stringify({ step, ...line }));
    if (stop) { options.write(JSON.stringify({ result: 'aborted', reason: 'Sage rejected the session; no further requests were made' })); break; }
  }
  return { requests };
}
