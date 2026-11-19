/**
 * A small world of seven companies and four groups for the lock tests, so that a viewer's hold, a bulk leave and a send in another
 * group can be told apart: groups gAB {a, b}, K {b, c, d}, KQ {d, q}, G2 {f, c, d}, G3 {c, w}; connections a-b, b-c, c-d, d-q, f-c,
 * w-c. U.ab owns every company; U.va is a viewer of a and of q (the "stranger two hops away"). Torn down by `drop`.
 */
import type { Pool } from 'pg';
import { companies } from './intercompany.fixture';
import { U, plantConnection } from './intercompany.helpers';

export interface World {
  a: string; b: string; c: string; d: string; q: string; w: string; f: string;
  gAB: string; K: string; KQ: string; G2: string; G3: string;
  conn: { ab: string; bc: string; cd: string; dq: string; fc: string; wc: string };
  drop: () => Promise<void>;
}

export async function buildWorld(pool: Pool): Promise<World> {
  const company = async (name: string) => {
    const id = crypto.randomUUID();
    await pool.query('INSERT INTO companies(id, name) VALUES ($1, $2)', [id, `IC world ${name}`]);
    await pool.query("INSERT INTO company_users(company_id, user_id, role) VALUES ($1, $2, 'owner')", [id, U.ab]);
    companies.push(id);
    return id;
  };
  const [a, b, c, d, q, w, f] = [await company('a'), await company('b'), await company('c'), await company('d'), await company('q'), await company('w'), await company('f')];
  await pool.query("INSERT INTO company_users(company_id, user_id, role) VALUES ($1, $3, 'viewer'), ($2, $3, 'viewer')", [a, q, U.va]);
  const group = async (name: string, members: string[]) => {
    const id = crypto.randomUUID();
    await pool.query('INSERT INTO company_groups(id, name) VALUES ($1, $2)', [id, `IC world ${name}`]);
    await pool.query('INSERT INTO company_group_members(group_id, company_id) SELECT $1, m FROM unnest($2::uuid[]) m', [id, members]);
    return id;
  };
  const [gAB, K, KQ, G2, G3] = [await group('gAB', [a, b]), await group('K', [b, c, d]), await group('KQ', [d, q]), await group('G2', [f, c, d]), await group('G3', [c, w])];
  const connect = (x: string, y: string) => plantConnection(pool, x, y, U.ab);
  const conn = { ab: await connect(a, b), bc: await connect(b, c), cd: await connect(c, d), dq: await connect(d, q), fc: await connect(f, c), wc: await connect(w, c) };
  const all = [a, b, c, d, q, w, f];
  return {
    a, b, c, d, q, w, f, gAB, K, KQ, G2, G3, conn,
    drop: async () => {
      await pool.query('DELETE FROM intercompany_connections WHERE company_low_id = ANY($1) OR company_high_id = ANY($1)', [all]);
      await pool.query('DELETE FROM company_groups WHERE id = ANY($1)', [[gAB, K, KQ, G2, G3]]);
      await pool.query('DELETE FROM company_users WHERE company_id = ANY($1) AND user_id = $2', [[a, q], U.va]);
    },
  };
}
