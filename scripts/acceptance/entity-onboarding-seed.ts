// Seeds the THROWAWAY database (isaflow_e2e) with the synthetic users and companies the acceptance run needs.
// Idempotent. Only ever points at the database named by PORT/PGDATABASE (see entity-onboarding-support.ts).
import { psql } from './entity-onboarding-support';

export const ONBOARDING_USERS = 8; // one per entity type: onb1 .. onb8
export const onbUserId = (n: number) => `dddddddd-0000-4000-8000-00000000000${n}`;
export const THANDI_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
export const ADMIN_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
export const DEMO_COMPANY = '00000000-0000-0000-0000-000000000001';
export const SOLO_COMPANY = 'eeeeeeee-0000-4000-8000-000000000001';

export function seedThrowawayDb(): void {
  const db = psql('select current_database()');
  if (db !== (process.env.PGDATABASE ?? 'isaflow_e2e')) throw new Error(`refusing to seed unexpected database ${db}`);
  for (let n = 1; n <= ONBOARDING_USERS; n++) {
    psql(`insert into users (id, email, first_name, last_name, role) values ('${onbUserId(n)}', 'onb${n}@example.test', 'Onboarding', 'User ${n}', 'viewer') on conflict (id) do nothing`);
  }
  psql(`insert into users (id, email, first_name, last_name, role) values ('${THANDI_ID}', 'thandi.synth@example.test', 'Thandi', 'Synth', 'viewer') on conflict (id) do nothing`);
  psql(`insert into users (id, email, first_name, last_name, role) values ('${ADMIN_ID}', 'synth.admin@example.test', 'Synth', 'Admin', 'super_admin') on conflict (id) do nothing`);
  psql(`insert into companies (id, name, is_active) values ('${DEMO_COMPANY}', 'ISAFlow Demo', true), ('${SOLO_COMPANY}', 'Synth Solo Owner', true) on conflict (id) do nothing`);
  psql(`insert into company_users (company_id, user_id, role, is_default) values ('${SOLO_COMPANY}', '${THANDI_ID}', 'owner', true) on conflict do nothing`);
}
