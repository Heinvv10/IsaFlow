import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { dkimSign } from 'mailauth';
import { isTrustedAbsaNotice } from '@/modules/accounting/services/capture/pop/absaPopTrust';

// A throwaway key pair stands in for ABSA's: the resolver below serves its public half for
// absa.co.za's selector, so every test runs offline and the signature checks are real.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const absaKey = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  .export({ type: 'pkcs1', format: 'pem' }).toString();
const publicB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const records: Record<string, string> = {
  'homebanking._domainkey.absa.co.za': `v=DKIM1; p=${publicB64}`,
  'mail._domainkey.evil.example': `v=DKIM1; p=${publicB64}`,
};
const resolver = async (name: string, rr: string): Promise<string[][]> => {
  const value = records[name];
  if (rr !== 'TXT' || !value) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return [[value]];
};

function message(from: string, body = 'Notice of payment attached.'): string {
  return [
    `From: ${from}`, 'To: pop@example.co.za', 'Subject: Notice of payment: JANE Q PUBLIC',
    'Date: Fri, 13 Nov 2026 12:52:05 +0200', 'Message-ID: <t1@example>', 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8', '', body, '',
  ].join('\r\n');
}

async function signed(raw: string, domain: string, selector: string, key: string, maxBodyLength?: number): Promise<Buffer> {
  const res = await dkimSign(raw, {
    canonicalization: 'relaxed/relaxed',
    signatureData: [{ signingDomain: domain, selector, privateKey: key, ...(maxBodyLength != null ? { maxBodyLength } : {}) }],
  });
  if (res.errors.length) throw new Error(JSON.stringify(res.errors));
  return Buffer.from(res.signatures + raw);
}

describe('isTrustedAbsaNotice', () => {
  it('trusts a message from ibreply@absa.co.za carrying a valid absa.co.za signature', async () => {
    const raw = await signed(message('ibreply@absa.co.za'), 'absa.co.za', 'homebanking', absaKey);
    expect(await isTrustedAbsaNotice(raw, { resolver })).toEqual({ trusted: true });
  });

  it('refuses an unsigned message, whatever its From says', async () => {
    expect(await isTrustedAbsaNotice(Buffer.from(message('ibreply@absa.co.za')), { resolver }))
      .toEqual({ trusted: false, reason: 'no_absa_signature' });
  });

  it('refuses a message whose body changed after ABSA signed it', async () => {
    const raw = (await signed(message('ibreply@absa.co.za'), 'absa.co.za', 'homebanking', absaKey)).toString()
      .replace('Notice of payment attached.', 'Notice of payment attached!');
    expect(await isTrustedAbsaNotice(Buffer.from(raw), { resolver })).toEqual({ trusted: false, reason: 'no_absa_signature' });
  });

  it('refuses a signature made with a key ABSA does not publish', async () => {
    const raw = await signed(message('ibreply@absa.co.za'), 'absa.co.za', 'homebanking', otherKey);
    expect(await isTrustedAbsaNotice(raw, { resolver })).toEqual({ trusted: false, reason: 'no_absa_signature' });
  });

  it('refuses a valid signature from another domain on a forged ABSA From', async () => {
    const raw = await signed(message('ibreply@absa.co.za'), 'evil.example', 'mail', absaKey);
    expect(await isTrustedAbsaNotice(raw, { resolver })).toEqual({ trusted: false, reason: 'no_absa_signature' });
  });

  it('refuses a genuinely ABSA-signed message from another ABSA address', async () => {
    const raw = await signed(message('marketing@absa.co.za'), 'absa.co.za', 'homebanking', absaKey);
    expect(await isTrustedAbsaNotice(raw, { resolver })).toEqual({ trusted: false, reason: 'not_absa_notice_sender' });
  });

  it('refuses a signature that covers only part of the body (l= tag)', async () => {
    const raw = await signed(message('ibreply@absa.co.za', 'Notice of payment attached.\r\nAppended by someone else.'),
      'absa.co.za', 'homebanking', absaKey, 10);
    expect(await isTrustedAbsaNotice(raw, { resolver })).toEqual({ trusted: false, reason: 'no_absa_signature' });
  });

  it('refuses a message naming more than one From address', async () => {
    const raw = await signed(message('ibreply@absa.co.za, other@example.com'), 'absa.co.za', 'homebanking', absaKey);
    expect(await isTrustedAbsaNotice(raw, { resolver })).toEqual({ trusted: false, reason: 'not_absa_notice_sender' });
  });

  it('reports a DNS failure on the key lookup as dns_unavailable (retried), not as a bad signature', async () => {
    const raw = await signed(message('ibreply@absa.co.za'), 'absa.co.za', 'homebanking', absaKey);
    const failing = async (): Promise<string[][]> => { throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }); };
    expect(await isTrustedAbsaNotice(raw, { resolver: failing })).toEqual({ trusted: false, reason: 'dns_unavailable' });
  });
});
