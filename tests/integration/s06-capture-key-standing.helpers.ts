// tests/integration/s06-capture-key-standing.helpers.ts
//
// Request/response doubles for s06-capture-key-standing.int.test.ts: a real
// multipart/form-data body carrying one PDF, fed to the upload route as a
// readable request, and a response that records status and body.

import { Readable } from 'stream';
import { vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const BOUNDARY = 's06boundary';

export type Res = NextApiResponse & { statusCode: number; body: unknown };
export type Header = 'bearer' | 'x-api-key';
/** The request the route mutated in place: authAndHandle sets companyRole on it. */
export type UploadReq = NextApiRequest & { companyRole?: string };

export function mockRes(): Res {
  const res = { statusCode: 200, body: undefined, headersSent: false } as unknown as Res;
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; }) as unknown as Res['status'];
  res.json = vi.fn((body: unknown) => { res.body = body; return res; }) as unknown as Res['json'];
  res.setHeader = vi.fn(() => res) as unknown as Res['setHeader'];
  res.end = vi.fn(() => res) as unknown as Res['end'];
  return res;
}

function multipartBody(): Buffer {
  return Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="s06.pdf"\r\n`
      + 'Content-Type: application/pdf\r\n\r\n'),
    PDF,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

function asUploadReq(stream: Readable, rawKey: string, header: Header, length: number): UploadReq {
  const auth = header === 'bearer' ? { authorization: `Bearer ${rawKey}` } : { 'x-api-key': rawKey };
  return Object.assign(stream, {
    method: 'POST',
    url: '/api/accounting/capture/upload',
    query: {},
    cookies: {},
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, 'content-length': String(length), ...auth },
  }) as unknown as UploadReq;
}

export function uploadReq(rawKey: string, header: Header): UploadReq {
  const body = multipartBody();
  return asUploadReq(Readable.from([body]), rawKey, header, body.length);
}

/**
 * The same upload, but the body stalls after its first bytes until `release()`:
 * a client holding the request open after the key was checked.
 */
export function slowUploadReq(rawKey: string): { req: UploadReq; release: () => void } {
  const body = multipartBody();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  async function* stalled() { yield body.subarray(0, 10); await gate; yield body.subarray(10); }
  return { req: asUploadReq(Readable.from(stalled()), rawKey, 'bearer', body.length), release };
}
