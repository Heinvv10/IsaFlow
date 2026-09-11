import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  describeShape, runAllocationProbe, PROBE_PLAN, PROBE_REQUEST_CAP,
} from '@/modules/admin/services/sageAllocationProbe';

// Synthetic values only. Every one of these must be absent from probe output.
const PII = {
  name: 'Thandiwe Probe-Nkosi', email: 'thandiwe.probe@synthetic.invalid', account: '62839104457',
  amount: 48213.77, id: 90417731, doc: 'RC-000913', uuidKey: randomUUID(),
  emailKey: 'owner@synthetic.invalid', spacedKey: 'Acme Holdings Pty', digitKey: '7788123',
};
const receiptList = {
  TotalResults: 1, ReturnedResults: 1,
  Results: [{
    ID: PII.id, DocumentNumber: PII.doc, Total: PII.amount, Discount: 0, TotalUnallocated: 12.5,
    Customer: { Name: PII.name, Email: PII.email },
    BankAccount: { BankAccountId: 4, Name: PII.name, AccountNumber: PII.account },
    Allocations: [{ AllocatedToDocumentId: PII.id + 1, Total: PII.amount }, { AllocatedToDocumentId: 5, Total: 1, Extra: null }],
    [PII.uuidKey]: { Amount: PII.amount }, [PII.emailKey]: PII.name, [PII.spacedKey]: 1, [PII.digitKey]: PII.account,
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
    // Union over array items: a key present in only one item still appears.
    expect(out).toContain('"Extra":"null"');
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

  it('stops at the hard cap and never retries a failing endpoint', async () => {
    const urls: string[] = [];
    await runAllocationProbe({
      base: 'https://accounting.sageone.co.za', cookie: 'session=synthetic-cookie-value', dryRun: false,
      fetch: async url => { urls.push(url); return json({ Message: PII.name }, 500); }, write: () => undefined,
    });
    expect(urls.length).toBeLessThanOrEqual(PROBE_REQUEST_CAP);
    expect(new Set(urls).size).toBe(urls.length);
    expect(PROBE_PLAN.length).toBeLessThanOrEqual(PROBE_REQUEST_CAP);
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
