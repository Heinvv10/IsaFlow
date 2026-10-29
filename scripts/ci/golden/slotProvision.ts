/**
 * The database and GoTrue steps of provisioning one Golden Paths slot (the CLI is provision-slots.ts). Each takes the
 * open connection, so provision-slots.ts decides the transaction and tests can drive them against a fake.
 */
import type { ClientBase } from 'pg';
import { adminCreateUser, adminUpdateUser } from '../../../src/lib/auth/gotrue';
import { cloneCompany } from './cloneCompany';
import { MAX_SLOT_GENERATION, SOURCE_COMPANY_ID, assertSlotCompanyId, slotCompanyId, slotCompanyName, slotEmail, slotRegistrationNumber } from './slotConfig';

/** What retireSlotCompany puts in front of a retired company's name. */
const RETIRED_PREFIX = 'RETIRED';
const say = (line: string): void => { process.stdout.write(`${line}\n`); };

/** @returns true when this run created the company */
export async function ensureCompany(db: ClientBase, n: number, id: string, generation: number): Promise<boolean> {
  assertSlotCompanyId(n, id);
  const name = slotCompanyName(n, generation);
  // A reset that crashed after its COMMIT and before the env file was written leaves GOLDEN_SLOT_n_COMPANY_ID on the
  // retired company; the rename below would quietly bring it back and the next reset would retire the new one.
  const held = await db.query<{ name: string }>('SELECT name FROM companies WHERE id = $1::uuid', [id]);
  if (held.rows[0]?.name.startsWith(RETIRED_PREFIX)) {
    throw new Error(`slot ${n}: company ${id} is retired ("${held.rows[0].name}"); a --reset-slot stopped before it wrote GOLDEN_SLOT_${n}_COMPANY_ID. `
      + `Set that key in the env file to the newest generation of slot ${n} that is not retired (601d000<g>-0000-4000-8000-00000000000${n}), then run again`);
  }
  const { created, copied, skippedChildren } = await cloneCompany(db, {
    sourceId: SOURCE_COMPANY_ID,
    targetId: id,
    // is_demo stays true (copied from Demo, and the suite's find-or-create fixtures and demo-only screens expect it).
    company: {
      name, registered_name: name, trading_name: name, registration_number: slotRegistrationNumber(n, generation),
      email: slotEmail(n), is_demo: true, onboarding_request_key: null,
    },
  });
  // A slot made under an earlier name keeps its id, so its name is re-asserted (the retired ones have other ids).
  await db.query('UPDATE companies SET name = $2, registered_name = $2, trading_name = $2 WHERE id = $1::uuid AND name <> $2', [id, name]);
  const rows = Object.entries(copied).map(([t, c]) => `${t}=${c}`).join(' ');
  say(`slot ${n}: company ${id} ${created ? 'created' : 'exists, kept'}${rows ? `; rows copied ${rows}` : ''}`);
  if (skippedChildren.length) say(`slot ${n}: not topped up, a parent table already held rows: ${skippedChildren.join(', ')} (use --reset-slot ${n} to rebuild)`);
  return created;
}

/** The golden user is a member of its slot company only (the suite's own sandbox companies are added by the specs). */
export async function ensureUser(db: ClientBase, n: number, id: string, userId: string): Promise<void> {
  assertSlotCompanyId(n, id);
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
  // The onboarding tour auto-starts for a user without this preference and its full-screen mask intercepts every click
  // (q-top-nav-hover, r-command-palette, s-shell-cls-mobile). The Demo user finished it long ago.
  await db.query(
    `INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES ($1, 'onboarding_tour_completed', 'true', NOW())
     ON CONFLICT (user_id, key) DO UPDATE SET value = 'true', updated_at = NOW() WHERE user_preferences.value IS DISTINCT FROM 'true'`,
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
 * name, and no longer a demo company) and the golden user is moved off it when ensureUser makes the new company the
 * default.
 * @returns the new generation and company id
 */
export async function retireSlotCompany(db: ClientBase, n: number, currentId: string): Promise<{ generation: number; id: string }> {
  assertSlotCompanyId(n, currentId);
  let generation = 1;
  for (; generation <= MAX_SLOT_GENERATION; generation++) {
    const taken = await db.query('SELECT 1 FROM companies WHERE id = $1::uuid', [slotCompanyId(n, generation)]);
    if (taken.rowCount === 0) break;
  }
  if (generation > MAX_SLOT_GENERATION) throw new Error(`slot ${n} has used all ${MAX_SLOT_GENERATION} generations; remove the retired companies by hand first`);
  const stamp = new Date().toISOString().slice(0, 10);
  // is_demo goes false so the demo-company lookups of the specs (v-empty-states: the golden user's first isDemo company)
  // can never pick the retired one. The golden user's membership stays: company_users_role_guard refuses removing a
  // company's only owner from any role that is not a superuser (RC011), and the retired company has no other owner.
  await db.query(
    `UPDATE companies SET name = $2, registered_name = $2, trading_name = $2, is_demo = false WHERE id = $1::uuid`,
    [currentId, `${RETIRED_PREFIX} ${stamp} slot ${n} (poisoned, replaced by generation ${generation})`]);
  return { generation, id: slotCompanyId(n, generation) };
}
