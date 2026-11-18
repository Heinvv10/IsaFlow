// A stateful fake of isaflow_dev (users, slot companies) and the shared GoTrue, for the slot-email migration's tests.
import type { Db, GoTrueOps } from '../../scripts/ci/golden/slotEmailApply';
import { slotCompanyId } from '../../scripts/ci/golden/slotConfig';

export interface World {
  dbName: string;
  gotrue: Map<string, string>; // id -> email
  users: Map<string, string>;
  companies: Array<{ id: string; email: string }>;
  log: string[];
  failGoTrue?: boolean;
  failGoTrueFor?: string;
  usersUpdateRows?: number;
  failCommit?: boolean;
}
export const newWorld = (): World => ({
  dbName: 'isaflow_dev', log: [],
  gotrue: new Map([['g1', 'golden-slot-1@isaflow.dev'], ['g2', 'golden-slot-2@isaflow.dev'], ['g3', 'golden-slot-3@isaflow.dev'], ['gw', 'golden-qa-w6@isaflow.dev'], ['gr', 'reporting-qa@isaflow.dev'], ['gp', 'reporting-qa-approver@isaflow.dev'], ['gx', 'stranger@isaflow.dev'], ['ga', 'admin@isaflow.co.za']]),
  users: new Map([['g1', 'golden-slot-1@isaflow.dev'], ['g2', 'golden-slot-2@isaflow.dev'], ['g3', 'golden-slot-3@isaflow.dev'], ['gw', 'golden-qa-w6@isaflow.dev'], ['gr', 'reporting-qa@isaflow.dev'], ['gp', 'reporting-qa-approver@isaflow.dev'], ['ux', 'orphan@isaflow.dev']]),
  companies: [{ id: slotCompanyId(1), email: 'golden-slot-1@isaflow.dev' }, { id: slotCompanyId(2), email: 'golden-slot-2@isaflow.dev' }, { id: '11111111-0000-4000-8000-000000000001', email: 'golden-slot-1@isaflow.dev' }, { id: slotCompanyId(3), email: 'golden-slot-3@isaflow.dev' }],
});

export function fakes(w: World): { db: Db & { end(): Promise<void> }; gt: GoTrueOps } {
  let snapshot: { users: Map<string, string>; companies: World['companies'] } | null = null;
  const db = {
    end: async () => { w.log.push('end'); },
    query: async (sql: string, p: unknown[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      const rows = (r: unknown[]) => ({ rows: r as never[], rowCount: r.length });
      if (/^SELECT current_database/.test(s)) return rows([{ db: w.dbName }]);
      if (s === 'BEGIN') { snapshot = { users: new Map(w.users), companies: w.companies.map((c) => ({ ...c })) }; w.log.push('BEGIN'); return rows([]); }
      if (s === 'COMMIT') { if (w.failCommit) throw new Error('commit failed'); snapshot = null; w.log.push('COMMIT'); return rows([]); }
      if (s === 'ROLLBACK') { if (snapshot) { w.users = snapshot.users; w.companies = snapshot.companies; } w.log.push('ROLLBACK'); return rows([]); }
      if (/^SELECT id::text AS id FROM users/.test(s)) return rows([...w.users].filter(([, e]) => e.toLowerCase() === String(p[0]).toLowerCase()).map(([id]) => ({ id })));
      // The id pattern is read from the statement itself, so a statement that drops it matches the stranger company too.
      const idRe = (): RegExp => { const m = /id::text ~ '([^']+)'/.exec(s); return m ? new RegExp(m[1]!) : /./; };
      if (/^SELECT count\(\*\)::int AS n FROM companies/.test(s)) return rows([{ n: w.companies.filter((c) => c.email.toLowerCase() === String(p[0]).toLowerCase() && idRe().test(c.id)).length }]);
      if (/^SELECT email FROM users/.test(s)) return rows([...w.users.values()].filter((e) => e.endsWith(String(p[0]))).map((email) => ({ email })));
      if (/^UPDATE users SET email/.test(s)) {
        w.log.push('UPDATE users'); let n = 0;
        for (const [id, e] of w.users) if (id === p[0] && e.toLowerCase() === String(p[2]).toLowerCase()) { w.users.set(id, String(p[1])); n++; }
        return { rows: [] as never[], rowCount: w.usersUpdateRows ?? n };
      }
      if (/^UPDATE companies SET email/.test(s)) { w.log.push('UPDATE companies'); for (const c of w.companies) if (c.email.toLowerCase() === String(p[1]).toLowerCase() && idRe().test(c.id)) c.email = String(p[0]); return rows([]); }
      throw new Error(`unexpected SQL: ${s}`);
    },
  };
  const gt: GoTrueOps = {
    find: async (email) => { const e = [...w.gotrue].find(([, v]) => v.toLowerCase() === email.toLowerCase()); return e ? { id: e[0], email: e[1] } : null; },
    list: async (f) => [...w.gotrue].filter(([, v]) => v.includes(f)).map(([id, email]) => ({ id, email })),
    setEmail: async (id, email) => { w.log.push('GOTRUE'); if (w.failGoTrue || w.failGoTrueFor === id) throw new Error('gotrue down'); w.gotrue.set(id, email); },
  };
  return { db, gt };
}
