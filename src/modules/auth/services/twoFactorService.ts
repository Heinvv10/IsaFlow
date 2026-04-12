/**
 * Two-Factor Authentication Service
 * Handles TOTP setup, verification, backup codes.
 * Trusted device operations split to trustedDeviceService.ts.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { encryptToken, decryptToken } from '@/lib/encryption';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { createHash, randomBytes } from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TrustedDevice {
  id: string;
  deviceName: string | null;
  deviceFingerprint: string;
  trustedUntil: string;
  lastUsedAt: string;
  createdAt: string;
}

export interface TwoFactorStatus {
  enabled: boolean;
  method: string | null;
  verifiedAt: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashBackupCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function generateBackupCodes(): string[] {
  return Array.from({ length: 10 }, () =>
    randomBytes(4).toString('hex').toUpperCase(),
  );
}

// ── TOTP Setup ────────────────────────────────────────────────────────────────

export async function generateTOTPSecret(
  userId: string,
  userEmail: string,
): Promise<{ secret: string; uri: string; qrCodeDataUrl: string }> {
  const totp = new OTPAuth.TOTP({
    issuer: 'ISAFlow',
    label: `ISAFlow:${userEmail}`,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromUTF8(randomBytes(20).toString('hex').slice(0, 32)),
  });

  const secret = totp.secret.base32;
  const uri = totp.toString();
  const encryptedSecret = encryptToken(secret);

  await sql`
    INSERT INTO user_2fa (user_id, method, secret_encrypted, is_enabled, is_verified, updated_at)
    VALUES (${userId}, 'totp', ${encryptedSecret}, false, false, NOW())
    ON CONFLICT (user_id, method)
    DO UPDATE SET
      secret_encrypted = EXCLUDED.secret_encrypted,
      is_enabled = false,
      is_verified = false,
      updated_at = NOW()
  `;

  const qrCodeDataUrl = await QRCode.toDataURL(uri, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 280,
    color: { dark: '#000000', light: '#ffffff' },
  });

  log.info('TOTP secret generated', { userId }, 'twoFactorService');

  return { secret, uri, qrCodeDataUrl };
}

// ── TOTP Verify Setup ─────────────────────────────────────────────────────────

export async function verifyTOTPSetup(
  userId: string,
  code: string,
): Promise<{ success: boolean; backupCodes?: string[] }> {
  const rows = await sql`
    SELECT secret_encrypted FROM user_2fa
    WHERE user_id = ${userId} AND method = 'totp'
    LIMIT 1
  `;

  const row = rows[0];
  if (!row?.secret_encrypted) {
    log.warn('TOTP setup verify: no pending setup found', { userId }, 'twoFactorService');
    return { success: false };
  }

  const plainSecret = decryptToken(row.secret_encrypted as string);
  const totp = new OTPAuth.TOTP({
    issuer: 'ISAFlow',
    label: `ISAFlow`,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(plainSecret),
  });

  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) {
    log.warn('TOTP setup verify: invalid code', { userId }, 'twoFactorService');
    return { success: false };
  }

  const plainCodes = generateBackupCodes();
  const hashedCodes = plainCodes.map(hashBackupCode);

  await sql`
    UPDATE user_2fa
    SET is_enabled = true,
        is_verified = true,
        backup_codes = ${hashedCodes},
        updated_at = NOW()
    WHERE user_id = ${userId} AND method = 'totp'
  `;

  log.info('TOTP setup verified and enabled', { userId }, 'twoFactorService');

  return { success: true, backupCodes: plainCodes };
}

// ── TOTP Verify (during login) ────────────────────────────────────────────────

export async function verifyTOTPCode(userId: string, code: string): Promise<boolean> {
  const rows = await sql`
    SELECT secret_encrypted, backup_codes FROM user_2fa
    WHERE user_id = ${userId} AND method = 'totp' AND is_enabled = true AND is_verified = true
    LIMIT 1
  `;

  const row = rows[0];
  if (!row?.secret_encrypted) return false;

  const plainSecret = decryptToken(row.secret_encrypted as string);
  const totp = new OTPAuth.TOTP({
    issuer: 'ISAFlow',
    label: 'ISAFlow',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(plainSecret),
  });

  const delta = totp.validate({ token: code, window: 1 });
  if (delta !== null) {
    log.info('TOTP code verified', { userId }, 'twoFactorService');
    return true;
  }

  const storedCodes = (row.backup_codes as string[]) || [];
  const codeHash = hashBackupCode(code.toUpperCase().trim());
  const matchIndex = storedCodes.indexOf(codeHash);

  if (matchIndex !== -1) {
    const updatedCodes = storedCodes.filter((_, i) => i !== matchIndex);
    await sql`
      UPDATE user_2fa SET backup_codes = ${updatedCodes}, updated_at = NOW()
      WHERE user_id = ${userId} AND method = 'totp'
    `;
    log.info('Backup code used', { userId, remaining: updatedCodes.length }, 'twoFactorService');
    return true;
  }

  log.warn('TOTP code invalid', { userId }, 'twoFactorService');
  return false;
}

// ── Disable 2FA ───────────────────────────────────────────────────────────────

export async function disable2FA(userId: string, code: string): Promise<boolean> {
  const valid = await verifyTOTPCode(userId, code);
  if (!valid) return false;

  await sql`
    DELETE FROM user_2fa WHERE user_id = ${userId} AND method = 'totp'
  `;

  log.info('2FA disabled', { userId }, 'twoFactorService');
  return true;
}

// ── Status ────────────────────────────────────────────────────────────────────

export async function get2FAStatus(userId: string): Promise<TwoFactorStatus> {
  const rows = await sql`
    SELECT method, is_enabled, updated_at FROM user_2fa
    WHERE user_id = ${userId} AND is_enabled = true AND is_verified = true
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) return { enabled: false, method: null, verifiedAt: null };

  const updatedAt = row.updated_at;
  const verifiedAt =
    updatedAt instanceof Date
      ? updatedAt.toISOString()
      : typeof updatedAt === 'string'
        ? updatedAt
        : null;

  return {
    enabled: true,
    method: row.method as string,
    verifiedAt,
  };
}

// Trusted device operations re-exported from trustedDeviceService.ts for backward compat
export {
  addTrustedDevice,
  isTrustedDevice,
  getTrustedDevices,
  removeTrustedDevice,
} from './trustedDeviceService';
