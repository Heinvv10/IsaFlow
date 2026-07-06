/**
 * TDD (RED first): SARS eFiling ISV transport CONTRACT tests.
 *
 * Stands up an in-process HTTP mock implementing the PROVISIONAL SARS ISV
 * VAT201 contract (activation-key auth -> submit -> poll) and exercises the
 * real client against it over real fetch. This is the contract we code to
 * until Hein's SARS ISV spec access lets us reconcile field/endpoint names.
 * No live SARS is ever contacted.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  authenticate,
  submitVAT201,
  pollStatus,
  EfilingTransportError,
  type EfilingConfig,
} from '@/modules/accounting/services/reports/sarsEfilingClient';

interface CapturedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

const captured: CapturedRequest[] = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

let server: Server;
let baseUrl = '';

function cfg(overrides: Partial<EfilingConfig> = {}): EfilingConfig {
  return { baseUrl, isvLogin: 'isv-login-001', activationKey: 'good-key', ...overrides };
}

beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const raw = await readBody(req);
    let body: unknown = undefined;
    if (raw) { try { body = JSON.parse(raw); } catch { /* leave raw */ } }
    captured.push({
      method: req.method ?? '',
      url: req.url ?? '',
      authorization: req.headers.authorization,
      body,
    });

    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    const url = req.url ?? '';

    if (req.method === 'POST' && url.endsWith('/auth')) {
      const key = (body as { activationKey?: string })?.activationKey;
      if (key === 'bad-key') return send(401, { error: 'invalid activation key' });
      const login = (body as { isvLogin?: string })?.isvLogin ?? 'x';
      return send(200, { token: `tok-${login}`, expiresIn: 3600 });
    }

    if (req.method === 'POST' && url.endsWith('/vat201')) {
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer tok-')) return send(401, { error: 'unauthorized' });
      const vatNumber = (body as { vatNumber?: string })?.vatNumber;
      if (vatNumber === '4000000500') return send(500, { error: 'SARS gateway error' });
      return send(202, { correlationId: 'CORR-123', status: 'received' });
    }

    if (req.method === 'GET' && url.includes('/vat201/')) {
      const id = decodeURIComponent(url.split('/vat201/')[1] ?? '');
      if (id === 'CORR-REJECT') return send(200, { status: 'rejected', errors: ['VAT number mismatch'] });
      if (id === 'CORR-PROCESSING') return send(200, { status: 'processing' });
      return send(200, { status: 'accepted', sarsReference: 'SARS-REF-999' });
    }

    return send(404, { error: 'not found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('authenticate', () => {
  it('posts isvLogin + activationKey to /auth and returns a token', async () => {
    captured.length = 0;
    const auth = await authenticate(cfg());
    expect(auth.token).toBe('tok-isv-login-001');
    const call = captured.find((c) => c.url.endsWith('/auth'));
    expect(call?.method).toBe('POST');
    expect(call?.body).toMatchObject({ isvLogin: 'isv-login-001', activationKey: 'good-key' });
  });

  it('throws EfilingTransportError with the HTTP status on bad credentials', async () => {
    await expect(authenticate(cfg({ activationKey: 'bad-key' }))).rejects.toBeInstanceOf(EfilingTransportError);
    await expect(authenticate(cfg({ activationKey: 'bad-key' }))).rejects.toMatchObject({ httpStatus: 401 });
  });
});

describe('submitVAT201', () => {
  it('submits the payload with a Bearer token and returns correlationId + status', async () => {
    captured.length = 0;
    const result = await submitVAT201(cfg(), 'tok-isv-login-001', {
      vatNumber: '4123456789',
      taxPeriod: '202603',
      fields: { field5_outputVAT: 150000, field10_totalInputVAT: 100000, field11_vatPayableOrRefundable: 50000 },
    });
    expect(result.correlationId).toBe('CORR-123');
    expect(result.status).toBe('received');
    expect(result.httpStatus).toBe(202);
    const call = captured.find((c) => c.url.endsWith('/vat201'));
    expect(call?.authorization).toBe('Bearer tok-isv-login-001');
    expect(call?.body).toMatchObject({ vatNumber: '4123456789', taxPeriod: '202603' });
  });

  it('throws when the token is rejected (401)', async () => {
    await expect(
      submitVAT201(cfg(), 'not-a-token', { vatNumber: '4123456789', taxPeriod: '202603', fields: {} }),
    ).rejects.toMatchObject({ httpStatus: 401 });
  });

  it('throws EfilingTransportError on a 5xx from SARS', async () => {
    await expect(
      submitVAT201(cfg(), 'tok-isv-login-001', { vatNumber: '4000000500', taxPeriod: '202603', fields: {} }),
    ).rejects.toMatchObject({ httpStatus: 500 });
  });
});

describe('pollStatus', () => {
  it('returns accepted status with the SARS reference', async () => {
    const result = await pollStatus(cfg(), 'tok-isv-login-001', 'CORR-123');
    expect(result.status).toBe('accepted');
    expect(result.sarsReference).toBe('SARS-REF-999');
    expect(result.errors).toEqual([]);
  });

  it('returns a rejected business status with errors (not a transport throw)', async () => {
    const result = await pollStatus(cfg(), 'tok-isv-login-001', 'CORR-REJECT');
    expect(result.status).toBe('rejected');
    expect(result.errors).toContain('VAT number mismatch');
    expect(result.sarsReference).toBeNull();
  });

  it('returns processing while SARS is still assessing', async () => {
    const result = await pollStatus(cfg(), 'tok-isv-login-001', 'CORR-PROCESSING');
    expect(result.status).toBe('processing');
  });
});
