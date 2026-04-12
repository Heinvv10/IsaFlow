/**
 * Payment Gateway Core — shared config, signature, and IP validation.
 * Used by paymentGatewayService, paymentGatewayItnService, paymentGatewayPortalService.
 */

import crypto from 'crypto';

export const PAYFAST_SANDBOX_URL = 'https://sandbox.payfast.co.za/eng/process';
export const PAYFAST_LIVE_URL = 'https://www.payfast.co.za/eng/process';

const PAYFAST_IP_RANGES = [
  '197.97.145.144/28',
  '41.74.179.192/27',
  '196.12.62.128/27',
];

const PAYFAST_SANDBOX_IPS = ['127.0.0.1', '::1'];

export function getConfig() {
  return {
    merchantId: process.env.PAYFAST_MERCHANT_ID || '',
    merchantKey: process.env.PAYFAST_MERCHANT_KEY || '',
    passphrase: process.env.PAYFAST_PASSPHRASE || '',
    isSandbox: process.env.PAYFAST_SANDBOX === 'true',
  };
}

export function getPayFastUrl(): string {
  return getConfig().isSandbox ? PAYFAST_SANDBOX_URL : PAYFAST_LIVE_URL;
}

export function generateSignature(data: Record<string, string>, passphrase: string): string {
  const sortedKeys = Object.keys(data)
    .filter(k => k !== 'signature' && data[k] !== '' && data[k] !== undefined && data[k] !== null)
    .sort();

  const queryString = sortedKeys
    .map(k => `${k}=${encodeURIComponent(data[k]!).replace(/%20/g, '+')}`)
    .join('&');

  const toHash = passphrase
    ? `${queryString}&passphrase=${encodeURIComponent(passphrase).replace(/%20/g, '+')}`
    : queryString;

  return crypto.createHash('md5').update(toHash).digest('hex');
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  if (!range || !bitsStr) return false;
  const bits = parseInt(bitsStr, 10);

  const ipParts = ip.split('.').map(Number);
  const rangeParts = range.split('.').map(Number);

  const ipNum = ((ipParts[0]! << 24) | (ipParts[1]! << 16) | (ipParts[2]! << 8) | ipParts[3]!) >>> 0;
  const rangeNum = ((rangeParts[0]! << 24) | (rangeParts[1]! << 16) | (rangeParts[2]! << 8) | rangeParts[3]!) >>> 0;
  const mask = (~0 << (32 - bits)) >>> 0;

  return (ipNum & mask) === (rangeNum & mask);
}

export function isPayFastIp(ip: string): boolean {
  const config = getConfig();
  if (config.isSandbox) return true;

  const cleanIp = ip.startsWith('::ffff:') ? ip.slice(7) : ip;

  for (const cidr of PAYFAST_IP_RANGES) {
    if (ipInCidr(cleanIp, cidr)) return true;
  }
  return PAYFAST_SANDBOX_IPS.includes(cleanIp);
}
