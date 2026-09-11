import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  parseProbeArgs, runAllocationProbe, PROBE_PLAN, PROBE_REQUEST_CAP, type ProbeRequest,
} from '@/modules/admin/services/sageAllocationProbe';
import { describeShape } from '@/modules/admin/services/sageProbeShape';

// Synthetic values only. Every one of these must be absent from probe output.
const PII = {
  name: 'Thandiwe Probe-Nkosi', email: 'thandiwe.probe@synthetic.invalid', account: '62839104457',
  amount: 48213.77, id: 90417731, doc: 'RC-000913', uuidKey: randomUUID(),
  emailKey: 'owner@synthetic.invalid', spacedKey: 'Acme Holdings Pty', digitKey: '7788123',
  surnameField: 'Thandiwe', codeField: 'NKOSI', snakeField: 'ACME_HOLDINGS', accountField: 'Cust62839104457',
};
const receiptList = {
  TotalResults: 1, ReturnedResults: 1,
  Results: [{
    ID: PII.id, DocumentNumber: PII.doc, Total: PII.amount, Discount: 0, TotalUnallocated: 12.5,
    Customer: { Name: PII.name, Email: PII.email },
    BankAccount: { BankAccountId: 4, Name: PII.name, AccountNumber: PII.account },
    Allocations: [{ AllocatedToDocumentId: PII.id + 1, Total: PII.amount }, { AllocatedToDocumentId: 5, Total: 1, Reference: null }],
    [PII.uuidKey]: { Amount: PII.amount }, [PII.emailKey]: PII.name, [PII.spacedKey]: 1, [PII.digitKey]: PII.account,
    Balance: { [PII.surnameField]: 1, [PII.codeField]: 2, [PII.snakeField]: 3, [PII.accountField]: 4, IsObfuscated: false },
  }],
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
function assertNoPii(output: string) {
  for (const value of Object.values(PII)) expect(output).not.toContain(String(value));
  expect(output).not.toContain('Thandiwe');
  expect(output).not.toContain('48213');
}

describe('describeShape', () => {
  it('keeps only key names, nesting and array lengths — never a value or a data-shaped key', () => {
    const shape = describeShape(receiptList);
    const out = JSON.stringify(shape);
    assertNoPii(out);
    expect(out).toContain('"DocumentNumber":"string"');
    expect(out).toContain('"AllocatedToDocumentId":"number"');
    expect(out).toContain('"array":2');
    expect(out).toContain('"redactedKeys":4');
    // Identifier-shaped keys that are client data are counted, never printed.
    expect(out).toContain('"Balance":{"object":{"IsObfuscated":"boolean"},"redactedKeys":4}');
    expect(out).toContain('"TotalUnallocated":"number"');
    expect(out).toContain('"ID":"number"');
    // Union over array items: a key present in only one item still appears.
    expect(out).toContain('"Reference":"null"');
  });
  it('summarises a large keyed dictionary instead of listing its keys', () => {
    const dict: Record<string, number> = {};
    for (let i = 0; i < 150; i++) dict[`Customer${i}Balance`] = i * 3.5;
    const out = JSON.stringify(describeShape(dict));
    expect(out).toContain('"dictionary":150');
    expect(out).not.toContain('Customer0Balance');
  });
});

describe('runAllocationProbe', () => {
  it('prints request templates in dry-run and makes no request', async () => {
    const lines: string[] = [];
    let calls = 0;
    const result = await runAllocationProbe({
      base: 'https://accounting.sageone.co.za', cookie: `session=${PII.account}`, dryRun: true,
      fetch: async () => { calls += 1; return json({}); }, write: line => lines.push(line),
    });
    expect(calls).toBe(0);
    expect(result.requests).toBe(0);
    expect(lines.join('\n')).toContain('/services/Allocation/');
    expect(lines.join('\n')).not.toContain(PII.account);
  });

  it('never prints a captured id, a value or the cookie, and templates dependent paths', async () => {
    const lines: string[] = [];
    const urls: string[] = [];
    const seenCookies = new Set<string>();
    await runAllocationProbe({
      base: 'https://accounting.sageone.co.za', cookie: `session=${PII.email}`, dryRun: false,
      fetch: async (url, init) => {
        urls.push(url);
        seenCookies.add(String((init.headers as Record<string, string>).Cookie));
        return json(url.includes('GetWithFilter') ? receiptList : receiptList.Results[0]);
      },
      write: line => lines.push(line),
    });
    const output = lines.join('\n');
    assertNoPii(output);
    // The id is really used on the wire, just never printed.
    expect(urls.some(url => url.includes(`/Get/${PII.id}`))).toBe(true);
    expect(output).toContain('/Get/{receiptId}');
    // Auth exactly as the server-side pull sends it.
    expect([...seenCookies]).toEqual([`session=${PII.email}`]);
  });

  it('never retries, and prints nothing from a failing endpoint body', async () => {
    for (const body of [() => json({ Message: `${PII.name} ${PII.email}` }, 500),
      () => new Response(`${PII.name} ${PII.account}`, { status: 500, headers: { 'content-type': 'text/plain' } })]) {
      const urls: string[] = [];
      const lines: string[] = [];
      await runAllocationProbe({
        base: 'https://accounting.sageone.co.za', cookie: 'session=synthetic-cookie-value', dryRun: false,
        fetch: async url => { urls.push(url); return body(); }, write: line => lines.push(line),
      });
      expect(new Set(urls).size).toBe(urls.length);
      expect(lines.some(line => line.includes('"status":500'))).toBe(true);
      assertNoPii(lines.join('\n'));
    }
  });

  it('makes exactly the cap of requests however long the plan is', async () => {
    const plan: ProbeRequest[] = Array.from({ length: 15 }, (_, i) => ({ label: `step ${i}`, method: 'GET', pathTemplate: `/services/Probe${i}/Get` }));
    const lines: string[] = [];
    let calls = 0;
    const result = await runAllocationProbe({
      base: 'https://accounting.sageone.co.za', cookie: 'session=synthetic-cookie-value', dryRun: false, plan,
      fetch: async () => { calls += 1; return json({ ok: true }); }, write: line => lines.push(line),
    });
    expect(calls).toBe(PROBE_REQUEST_CAP);
    expect(result.requests).toBe(PROBE_REQUEST_CAP);
    expect(lines.join('\n')).toContain('request_cap_reached');
    expect(PROBE_PLAN.length).toBeLessThanOrEqual(PROBE_REQUEST_CAP);
  });

  it.each([401, 403, 302])('aborts on a %s session refusal after one request', async status => {
    const lines: string[] = [];
    let calls = 0;
    await runAllocationProbe({
      base: 'https://accounting.sageone.co.za', cookie: 'session=synthetic-cookie-value', dryRun: false,
      fetch: async () => { calls += 1; return new Response(null, { status, headers: status === 302 ? { location: `https://accounting.sageone.co.za/login?u=${PII.email}` } : {} }); },
      write: line => lines.push(line),
    });
    expect(calls).toBe(1);
    expect(lines.join('\n')).toContain('session_rejected');
    assertNoPii(lines.join('\n'));
  });

  it('prints only the media type, never a content-type parameter', async () => {
    const lines: string[] = [];
    await runAllocationProbe({
      base: 'https://accounting.sageone.co.za', cookie: 'session=synthetic-cookie-value', dryRun: false,
      fetch: async () => new Response('{}', { status: 200, headers: { 'content-type': `application/json; owner=${PII.email}` } }),
      write: line => lines.push(line),
    });
    expect(lines.join('\n')).toContain('"contentType":"application/json"');
    assertNoPii(lines.join('\n'));
  });

  it('refuses a body over the size cap, declared or streamed, without parsing it', async () => {
    const big = JSON.stringify({ Results: [{ Name: PII.name }], pad: 'x'.repeat(6 * 1024 * 1024) });
    const headerSets: Record<string, string>[] = [{ 'content-type': 'application/json' }, { 'content-type': 'application/json', 'content-length': String(big.length) }];
    for (const headers of headerSets) {
      const lines: string[] = [];
      await runAllocationProbe({
        base: 'https://accounting.sageone.co.za', cookie: 'session=synthetic-cookie-value', dryRun: false, plan: [PROBE_PLAN[4]!],
        fetch: async () => new Response(big, { status: 200, headers }), write: line => lines.push(line),
      });
      expect(lines.join('\n')).toContain('body_too_large');
      assertNoPii(lines.join('\n'));
    }
  });

  it('aborts every remaining request once Sage rejects the session', async () => {
    const lines: string[] = [];
    let calls = 0;
    await runAllocationProbe({
      base: 'https://accounting.sageone.co.za', cookie: 'session=synthetic-cookie-value', dryRun: false,
      fetch: async () => { calls += 1; return new Response(`<!DOCTYPE html><p>${PII.name}</p>`, { status: 200, headers: { 'content-type': 'text/html' } }); },
      write: line => lines.push(line),
    });
    expect(calls).toBe(1);
    assertNoPii(lines.join('\n'));
    expect(lines.join('\n')).toContain('session_rejected');
  });

  it('does not echo an error body or message', async () => {
    const lines: string[] = [];
    await runAllocationProbe({
      base: 'https://accounting.sageone.co.za', cookie: 'session=synthetic-cookie-value', dryRun: false,
      fetch: async () => { throw new Error(`connect failed for ${PII.email}`); }, write: line => lines.push(line),
    });
    assertNoPii(lines.join('\n'));
    expect(lines.join('\n')).toContain('network_error');
  });
});

describe('runAllocationProbe body deadline', () => {
  it('gives up on a body that never finishes instead of hanging', async () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      const stalled = new ReadableStream<Uint8Array>({ start() { /* never enqueues, never closes */ } });
      const run = runAllocationProbe({
        base: 'https://accounting.sageone.co.za', cookie: 'session=synthetic-cookie-value', dryRun: false, plan: [PROBE_PLAN[4]!],
        fetch: async () => new Response(stalled, { status: 200, headers: { 'content-type': 'application/json' } }), write: line => lines.push(line),
      });
      await vi.advanceTimersByTimeAsync(31000);
      await run;
      expect(lines.join('\n')).toContain('body_timeout');
    } finally { vi.useRealTimers(); }
  });
});

describe('parseProbeArgs', () => {
  it('never echoes a mistyped flag that may carry the cookie', () => {
    for (const bad of [[`--cookie=${PII.account}`], [`--SAGE_COOKIE=${PII.account}`], [PII.account], ['--base']]) {
      let message = '';
      try { parseProbeArgs(bad); } catch (error) { message = error instanceof Error ? error.message : String(error); }
      expect(message).not.toBe('');
      expect(message).not.toContain(PII.account);
    }
  });
  it('accepts only a bare origin for --base', () => {
    expect(parseProbeArgs([])).toEqual({ dryRun: false, base: 'https://accounting.sageone.co.za' });
    expect(parseProbeArgs(['--dry-run', '--base', 'https://accounting.sageone.co.za/'])).toEqual({ dryRun: true, base: 'https://accounting.sageone.co.za' });
    for (const base of ['https://accounting.sageone.co.za/services/X/Delete?q=', 'https://accounting.sageone.co.za/?a=1', 'https://accounting.sageone.co.za/#x', 'https://u:p@accounting.sageone.co.za']) {
      expect(() => parseProbeArgs(['--base', base])).toThrow(/bare Sage origin/);
    }
  });
});
