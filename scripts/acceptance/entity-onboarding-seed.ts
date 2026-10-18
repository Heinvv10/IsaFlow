// Seeds the THROWAWAY database (isaflow_e2e) with the synthetic users and companies the acceptance run needs, and opens
// a seeded user's browser session. Idempotent.
// Guard (seedThrowawayDb, before any write): current_database() must be exactly 'isaflow_e2e' (hard-coded in
// entity-onboarding-support.ts together with the 127.0.0.1 host, not read from the environment), and the database must
// hold no company other than 'ISAFlow Demo' and names starting 'Synth', because a real database holds real companies.
import type { Browser, BrowserContext, Page } from 'playwright';
import { BASE, THROWAWAY_DB, newCtx, psql } from './entity-onboarding-support';

/** onb1..onb8: one per entity type; onb9: server refusal catalogue; onb10: server probes. */
export const SEEDED_USERS = 10;
export const onbUserId = (n: number) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const THANDI_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
export const ADMIN_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
export const DEMO_COMPANY = '00000000-0000-0000-0000-000000000001';
export const SOLO_COMPANY = 'eeeeeeee-0000-4000-8000-000000000001';

export function seedThrowawayDb(): void {
  const db = psql('select current_database()');
  if (db !== THROWAWAY_DB) throw new Error(`refusing to seed database ${db}: only ${THROWAWAY_DB} is a throwaway`);
  const foreign = psql(`select count(*) from companies where name <> 'ISAFlow Demo' and name not like 'Synth%'`);
  if (foreign !== '0') throw new Error(`refusing to seed: ${foreign} company(ies) here are not synthetic, so this is not a throwaway database`);
  for (let n = 1; n <= SEEDED_USERS; n++) {
    psql(`insert into users (id, email, first_name, last_name, role) values ('${onbUserId(n)}', 'onb${n}@example.test', 'Onboarding', 'User ${n}', 'viewer') on conflict (id) do nothing`);
  }
  psql(`insert into users (id, email, first_name, last_name, role) values ('${THANDI_ID}', 'thandi.synth@example.test', 'Thandi', 'Synth', 'viewer') on conflict (id) do nothing`);
  psql(`insert into users (id, email, first_name, last_name, role) values ('${ADMIN_ID}', 'synth.admin@example.test', 'Synth', 'Admin', 'super_admin') on conflict (id) do nothing`);
  psql(`insert into companies (id, name, is_active) values ('${DEMO_COMPANY}', 'ISAFlow Demo', true), ('${SOLO_COMPANY}', 'Synth Solo Owner', true) on conflict (id) do nothing`);
  psql(`insert into company_users (company_id, user_id, role, is_default) values ('${SOLO_COMPANY}', '${THANDI_ID}', 'owner', true) on conflict (company_id, user_id) do update set role = 'owner'`);
  // the onboarding rate limits live in the table: a re-run within the hour must start from zero
  psql(`delete from rate_limit_counters where key like 'onboarding-setup%'`);
}

export interface UserSession { ctx: BrowserContext; page: Page; uid: string; placeholder: string }

/** A user opening the app like a fresh signup (provisionTenant): placeholder company + owner membership + active_company_id cookie. */
export async function openUser(browser: Browser, n: number): Promise<UserSession> {
  const uid = onbUserId(n);
  const placeholder = crypto.randomUUID();
  // previous runs' companies stay (entity_changes is append-only); only the user's memberships are cleared
  psql(`delete from company_users where user_id='${uid}'; delete from companies where id='${placeholder}'`);
  psql(`insert into companies (id, name, is_active) values ('${placeholder}', 'Synth Signup ${n}', true); insert into company_users (company_id, user_id, role, is_default) values ('${placeholder}', '${uid}', 'owner', true); update users set onboarding_completed=false where id='${uid}'`);
  const ctx = await newCtx(browser, uid, `onb${n}@example.test`, 'aal2');
  await ctx.addCookies([{ name: 'active_company_id', value: placeholder, url: BASE }]);
  return { ctx, page: await ctx.newPage(), uid, placeholder };
}
