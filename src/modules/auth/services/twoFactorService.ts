/**
 * Two-Factor Authentication Service
 * Handles TOTP setup, verification, backup codes, and trusted devices.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
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
    randomBytes(4).toString('hex').toUpperCase()
  );
}

// ── TOTP Setup ────────────────────────────────────────────────────────────────

export async function generateTOTPSecret(
  userId: string,
  userEmail: string
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

  // Upsert — replace any unverified pending setup
  await sql`
    INSERT INTO user_2fa (user_id, method, secret_encrypted, is_enabled, is_verified, updated_at)
    VALUES (${userId}, 'totp', ${secret}, false, false, NOW())
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
  code: string
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

  const totp = new OTPAuth.TOTP({
    issuer: 'ISAFlow',
    label: `ISAFlow`,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(row.secret_encrypted as string),
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

  // Check TOTP
  const totp = new OTPAuth.TOTP({
    issuer: 'ISAFlow',
    label: 'ISAFlow',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(row.secret_encrypted as string),
  });

  const delta = totp.validate({ token: code, window: 1 });
  if (delta !== null) {
    log.info('TOTP code verified', { userId }, 'twoFactorService');
    return true;
  }

  // Check backup codes (one-time use)
  const storedCodes = (row.backup_codes as string[]) || [];
  const codeHash = hashBackupCode(code.toUpperCase().trim());
  const matchIndex = storedCodes.indexOf(codeHash);

  if (matchIndex !== -1) {
    // Remove used backup code
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

// ── Trusted Devices ───────────────────────────────────────────────────────────

export async function addTrustedDevice(
  userId: string,
  fingerprint: string,
  deviceName: string
): Promise<void> {
  const trustedUntil = new Date();
  trustedUntil.setDate(trustedUntil.getDate() + 30);

  await sql`
    INSERT INTO user_trusted_devices (user_id, device_fingerprint, device_name, trusted_until, last_used_at)
    VALUES (${userId}, ${fingerprint}, ${deviceName}, ${trustedUntil.toISOString()}, NOW())
    ON CONFLICT (user_id, device_fingerprint)
    DO UPDATE SET
      trusted_until = EXCLUDED.trusted_until,
      device_name = EXCLUDED.device_name,
      last_used_at = NOW()
  `;

  log.info('Device trusted', { userId, deviceName }, 'twoFactorService');
}

export async function isTrustedDevice(
  userId: string,
  fingerprint: string
): Promise<boolean> {
  const rows = await sql`
    SELECT id FROM user_trusted_devices
    WHERE user_id = ${userId}
      AND device_fingerprint = ${fingerprint}
      AND trusted_until > NOW()
    LIMIT 1
  `;

  return rows.length > 0;
}

export async function getTrustedDevices(userId: string): Promise<TrustedDevice[]> {
  const rows = await sql`
    SELECT id, device_name, device_fingerprint, trusted_until, last_used_at, created_at
    FROM user_trusted_devices
    WHERE user_id = ${userId} AND trusted_until > NOW()
    ORDER BY last_used_at DESC
  `;

  return rows.map(r => {
    const trustedUntil = r.trusted_until instanceof Date
      ? r.trusted_until.toISOString() : r.trusted_until as string;
    const lastUsedAt = r.last_used_at instanceof Date
      ? r.last_used_at.toISOString() : r.last_used_at as string;
    const createdAt = r.created_at instanceof Date
      ? r.created_at.toISOString() : r.created_at as string;

    return {
      id: r.id as string,
      deviceName: (r.device_name as string | null),
      deviceFingerprint: r.device_fingerprint as string,
      trustedUntil,
      lastUsedAt,
      createdAt,
    };
  });
}

export async function removeTrustedDevice(
  userId: string,
  deviceId: string
): Promise<void> {
  await sql`
    DELETE FROM user_trusted_devices
    WHERE id = ${deviceId}::UUID AND user_id = ${userId}
  `;

  log.info('Trusted device removed', { userId, deviceId }, 'twoFactorService');
}
