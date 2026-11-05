import { createHash } from 'crypto';
import { trustedClientIpOf } from '@/lib/trustedClientIp';

const FALLBACK_SALT = 'isaflow-analytics-fallback-salt-v1';

function getDailySalt(date: Date = new Date()): string {
  const base = process.env.ANALYTICS_SALT || FALLBACK_SALT;
  const ymd = date.toISOString().slice(0, 10);
  return `${base}::${ymd}`;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

export function visitorHash(ip: string, userAgent: string): string {
  return sha256(`${getDailySalt()}::${ip}::${userAgent}::visitor`);
}

export function sessionHash(ip: string, userAgent: string, websiteId: string): string {
  return sha256(`${getDailySalt()}::${ip}::${userAgent}::${websiteId}::session`);
}

export function extractIp(headers: Record<string, string | string[] | undefined>): string {
  // The visitor behind Cloudflare and nginx (trustedClientIpOf peels one hop and trusts CF-Connecting-IP only from a
  // Cloudflare peer), not a header the client can set.
  const visitor = trustedClientIpOf(headers['x-forwarded-for'], undefined, headers['cf-connecting-ip']);
  if (visitor) return visitor;
  const real = headers['x-real-ip'];
  if (typeof real === 'string' && real) return real;
  return '0.0.0.0';
}

export function extractCountry(headers: Record<string, string | string[] | undefined>): string | null {
  const cc = headers['cf-ipcountry'];
  if (typeof cc === 'string' && cc && cc.length === 2 && cc !== 'XX') {
    return cc.toUpperCase();
  }
  return null;
}
