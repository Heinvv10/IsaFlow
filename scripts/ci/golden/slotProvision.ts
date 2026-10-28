/**
 * The database and GoTrue steps of provisioning one Golden Paths slot (the CLI is provision-slots.ts). Each takes the
 * open connection, so provision-slots.ts decides the transaction and tests can drive them against a fake.
 */
import type { ClientBase } from 'pg';
import { adminCreateUser, adminUpdateUser } from '../../../src/lib/auth/gotrue';
import { cloneCompany } from './cloneCompany';
import { MAX_SLOT_GENERATION, SOURCE_COMPANY_ID, slotCompanyId, slotCompanyName, slotEmail, slotRegistrationNumber } from './slotConfig';

const say = (line: string): void => { process.stdout.write(`${line}\n`); };

/** @returns true when this run created the company */
export async function ensureCompany(db: ClientBase, n: number, id: string, generation: number): Promise<boolean> {
  const name = slotCompanyName(n, generation);
  const { created, copied, skippedChildren } = await cloneCompany(db, {
    sourceId: SOURCE_COMPANY_ID,
    targetId: id,
    // is_demo stays true (copied from Demo, and the suite's find-or-create fixtures and demo-only screens expect it).
    company: {
      name, registered_name: name, trading_name: name, registration_number: slotRegistrationNumber(n, generation),
      email: slotEmail(n), is_demo: true, onboarding_request_key: null,
    },
  });
  const rows = Object.entries(copied).map(([t, c]) => `${t}=${c}`).join(' ');
  say(`slot ${n}: company ${id} ${created ? 'created' : 'exists, kept'}${rows ? `; rows copied ${rows}` : ''}`);
  if (skippedChildren.length) say(`slot ${n}: not topped up, a parent table already held rows: ${skippedChildren.join(', ')} (use --reset-slot ${n} to rebuild)`);
  return created;
}

/** The golden user is a member of its slot company only (the suite's own sandbox companies are added by the specs). */
export async function ensureUser(db: ClientBase, n: number, id: string, userId: string): Promise<void> {
  const email = slotEmail(n);
  const clash = await db.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower($1) AND id <> $2', [email, userId]);
  if (clash.rowCount) throw new Error(`users already has ${email} under another id (${clash.rows[0]!.id}); the GoTrue user and public.users must agree`);
  await db.query(
    `INSERT INTO users (id, email, first_name, last_name, role, is_active, onboarding_completed, status, account_type)
     VALUES ($1, $2, 'Golden', $3, 'accountant', true, true, 'active', 'direct')
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, is_active = true, onboarding_completed = true, status = 'active'`,
    [userId, email, `Slot ${n}`]);
  // Login opens the user's default company, so every other membership (a retired generation, the suite's sandbox
  // companies) is demoted BEFORE this one becomes the default.
  await db.query('UPDATE company_users SET is_default = false WHERE user_id = $1 AND company_id <> $2::uuid', [userId, id]);
  await db.query(
    `INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1::uuid, $2, 'owner', true)
     ON CONFLICT (user_id, company_id) DO UPDATE SET role = 'owner', is_default = true`,
    [id, userId]);
  // The setup-guide button pulses for a user's first three days and the a11y specs wait for every pulse to stop, so the
  // golden user has "first seen" long ago, as the Demo user does. The app writes its own on the first visit, so an
  // ISO date later than ours is moved back; an earlier one is kept (ISO strings order as text).
  await db.query(
    `INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES ($1, 'setup-guide-first-seen', '2026-01-01T00:00:00.000Z', NOW())
     ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW() WHERE user_preferences.value > EXCLUDED.value`,
    [userId]);
}

export async function ensureGoTrueUser(n: number, password: string): Promise<string> {
  const user = await adminCreateUser({ email: slotEmail(n), password, email_confirm: true, user_metadata: { purpose: 'golden-paths CI slot' } });
  // adminCreateUser answers an existing user as is, so the password is set explicitly to the one in the env file.
  await adminUpdateUser(user.id, { password, email_confirm: true });
  return user.id;
}

/**
 * Retires a slot's company and picks the id of the next generation for its replacement. Nothing is deleted: the 111
 * foreign keys into companies are NO ACTION, the ledger tables refuse deletes of posted rows, and the retired company
 * keeps whatever state poisoned it for a human to read. The retired company is renamed (never matched again by
 * name) and the golden user is moved off it when ensureUser makes the new company the default.
 * @returns the new generation and company id
 */
export async function retireSlotCompany(db: ClientBase, n: number, currentId: string): Promise<{ generation: number; id: string }> {
  let generation = 1;
  for (; generation <= MAX_SLOT_GENERATION; generation++) {
    const taken = await db.query('SELECT 1 FROM companies WHERE id = $1::uuid', [slotCompanyId(n, generation)]);
    if (taken.rowCount === 0) break;
  }
  if (generation > MAX_SLOT_GENERATION) throw new Error(`slot ${n} has used all ${MAX_SLOT_GENERATION} generations; remove the retired companies by hand first`);
  const stamp = new Date().toISOString().slice(0, 10);
  await db.query(
    `UPDATE companies SET name = $2, registered_name = $2, trading_name = $2 WHERE id = $1::uuid`,
    [currentId, `RETIRED ${stamp} slot ${n} (poisoned, replaced by generation ${generation})`]);
  return { generation, id: slotCompanyId(n, generation) };
}
