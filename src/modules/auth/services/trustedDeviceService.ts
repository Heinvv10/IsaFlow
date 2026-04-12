/**
 * Trusted Device Service
 * Trusted device management — split from twoFactorService.ts.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { TrustedDevice } from './twoFactorService';

export async function addTrustedDevice(
  userId: string,
  fingerprint: string,
  deviceName: string,
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
  fingerprint: string,
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
  deviceId: string,
): Promise<void> {
  await sql`
    DELETE FROM user_trusted_devices
    WHERE id = ${deviceId}::UUID AND user_id = ${userId}
  `;

  log.info('Trusted device removed', { userId, deviceId }, 'twoFactorService');
}
