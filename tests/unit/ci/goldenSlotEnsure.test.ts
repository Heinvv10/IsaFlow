// The steps that put a slot's company, golden user and GoTrue account in place, driven against a recording fake.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientBase } from 'pg';

const gotrue = vi.hoisted(() => ({ adminCreateUser: vi.fn(), adminUpdateUser: vi.fn() }));
const clone = vi.hoisted(() => ({ cloneCompany: vi.fn() }));
vi.mock('../../../src/lib/auth/gotrue', () => gotrue);
vi.mock('../../../scripts/ci/golden/cloneCompany', () => clone);

import { ensureCompany, ensureGoTrueUser, ensureUser, publishSlotLogin, setGoTrueUserPassword } from '../../../scripts/ci/golden/slotProvision';
import { SOURCE_COMPANY_ID, slotCompanyId, slotCompanyName, slotEmail, slotRegistrationNumber } from '../../../scripts/ci/golden/slotConfig';

interface Statement { text: string; params: unknown[] }
function recordingDb(answer: (text: string, params: unknown[]) => { rowCount?: number; rows?: unknown[] } | undefined = () => undefined) {
  const statements: Statement[] = [];
  const db = {
    query: async (text: string, params: unknown[] = []) => {
      statements.push({ text, params });
      const a = answer(text, params);
      return { rowCount: a?.rowCount ?? a?.rows?.length ?? 1, rows: a?.rows ?? [] };
    },
  } as unknown as ClientBase;
  return { db, statements };
}
const ID = slotCompanyId(2, 0);
const writes = (st: Statement[]) => st.filter((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s.text));

beforeEach(() => { vi.clearAllMocks(); });

describe('ensureUser', () => {
  it('refuses an email that public.users holds under another id, and writes nothing', async () => {
    const { db, statements } = recordingDb((text) => (text.startsWith('SELECT id FROM users') ? { rows: [{ id: 'someone-else' }] } : undefined));
    await expect(ensureUser(db, 2, ID, 'golden-user')).rejects.toThrow(/under another id \(someone-else\)/);
    expect(writes(statements)).toEqual([]);
  });

  it('demotes every other membership BEFORE it makes the slot company the default, and owns the slot company', async () => {
    const { db, statements } = recordingDb((text) => (text.startsWith('SELECT id FROM users') ? { rows: [], rowCount: 0 } : undefined));
    await ensureUser(db, 2, ID, 'golden-user');
    const demote = statements.findIndex((s) => /UPDATE company_users SET is_default = false/.test(s.text));
    const own = statements.findIndex((s) => /INSERT INTO company_users/.test(s.text));
    expect(demote).toBeGreaterThan(-1);
    expect(demote).toBeLessThan(own);
    expect(statements[demote]!.params).toEqual(['golden-user', ID]);
    expect(statements[demote]!.text).toMatch(/company_id <> \$2/);
    expect(statements[own]!.text).toMatch(/'owner', true/);
    expect(statements[own]!.params).toEqual([ID, 'golden-user']);
  });

  it('upserts the user with the slot email and the two preferences that keep the suite\'s overlays away', async () => {
    const { db, statements } = recordingDb((text) => (text.startsWith('SELECT id FROM users') ? { rows: [], rowCount: 0 } : undefined));
    await ensureUser(db, 2, ID, 'golden-user');
    const user = statements.find((s) => /INSERT INTO users/.test(s.text))!;
    expect(user.params).toEqual(['golden-user', slotEmail(2), 'Slot 2']);
    const prefs = statements.filter((s) => /INSERT INTO user_preferences/.test(s.text));
    expect(prefs.map((p) => /'(setup-guide-first-seen|onboarding_tour_completed)'/.exec(p.text)?.[1])).toEqual(['setup-guide-first-seen', 'onboarding_tour_completed']);
    expect(prefs.every((p) => p.params[0] === 'golden-user')).toBe(true);
    // The first-seen date only moves backwards, and the tour flag only changes when it is not already true.
    expect(prefs[0]!.text).toMatch(/WHERE user_preferences\.value > EXCLUDED\.value/);
    expect(prefs[1]!.text).toMatch(/IS DISTINCT FROM 'true'/);
  });
});

describe('ensureCompany', () => {
  const answerName = (name: string) => (text: string) => (text.startsWith('SELECT name FROM companies') ? { rows: [{ name }] } : undefined);

  it('clones Demo into the slot id as a demo company with the slot\'s own name, registration number and email', async () => {
    clone.cloneCompany.mockResolvedValue({ created: true, copied: { suppliers: 3 }, skippedChildren: [] });
    const { db } = recordingDb(answerName(slotCompanyName(2, 0)));
    await expect(ensureCompany(db, 2, ID, 0)).resolves.toBe(true);
    expect(clone.cloneCompany).toHaveBeenCalledWith(db, {
      sourceId: SOURCE_COMPANY_ID,
      targetId: ID,
      company: {
        name: slotCompanyName(2, 0), registered_name: slotCompanyName(2, 0), trading_name: slotCompanyName(2, 0),
        registration_number: slotRegistrationNumber(2, 0), email: slotEmail(2), is_demo: true, onboarding_request_key: null,
      },
    });
  });

  it('reports a company that already existed as not created, and re-asserts its name under its own id', async () => {
    clone.cloneCompany.mockResolvedValue({ created: false, copied: {}, skippedChildren: [] });
    const { db, statements } = recordingDb(answerName('Old Slot Name'));
    await expect(ensureCompany(db, 2, ID, 0)).resolves.toBe(false);
    const rename = statements.find((s) => /^UPDATE companies SET name = \$2/.test(s.text))!;
    expect(rename.params).toEqual([ID, slotCompanyName(2, 0)]);
    expect(rename.text.trim()).toMatch(/WHERE id = \$1::uuid AND name <> \$2$/);
  });

  it('names a later generation after its generation', async () => {
    clone.cloneCompany.mockResolvedValue({ created: true, copied: {}, skippedChildren: [] });
    const id = slotCompanyId(2, 3);
    const { db } = recordingDb(answerName(slotCompanyName(2, 3)));
    await ensureCompany(db, 2, id, 3);
    expect(clone.cloneCompany.mock.calls[0]![1].company).toMatchObject({ name: 'Golden Slot 2 g3', registration_number: 'GOLDEN/SLOT/2/3' });
  });
});

describe('GoTrue user', () => {
  it('ensureGoTrueUser creates the slot user and returns its id, without touching an existing user\'s password', async () => {
    gotrue.adminCreateUser.mockResolvedValue({ id: 'gt-1' });
    await expect(ensureGoTrueUser(3, 'pw-from-env')).resolves.toBe('gt-1');
    expect(gotrue.adminCreateUser).toHaveBeenCalledWith({
      email: 'golden-slot-3@isaflow.dev', password: 'pw-from-env', email_confirm: true, user_metadata: { purpose: 'golden-paths CI slot' },
    });
    // The password reset waits for the commit (setGoTrueUserPassword): a failed transaction must not have changed it.
    expect(gotrue.adminUpdateUser).not.toHaveBeenCalled();
  });

  it('setGoTrueUserPassword sets the env file\'s password and confirms the email', async () => {
    gotrue.adminUpdateUser.mockResolvedValue({});
    await setGoTrueUserPassword('gt-1', 'pw-from-env');
    expect(gotrue.adminUpdateUser).toHaveBeenCalledWith('gt-1', { password: 'pw-from-env', email_confirm: true });
  });
});

describe('publishSlotLogin', () => {
  const opts = { n: 2, email: 'golden-slot-2@isaflow.dev', userId: 'gt-2', password: 'pw', envFile: '/home/hein/isaflow-ci.env' };

  it('sets the GoTrue password first and then writes the env file', async () => {
    const order: string[] = [];
    gotrue.adminUpdateUser.mockImplementation(async () => { order.push('gotrue'); return {}; });
    await publishSlotLogin({ ...opts, write: () => { order.push('file'); } });
    expect(order).toEqual(['gotrue', 'file']);
  });

  it('says that GoTrue and the file now disagree, and that a re-run heals it, when the file write fails', async () => {
    gotrue.adminUpdateUser.mockResolvedValue({});
    const failing = () => { throw new Error('EACCES: permission denied'); };
    const err = await publishSlotLogin({ ...opts, write: failing }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('golden-slot-2@isaflow.dev');
    expect((err as Error).message).toContain('/home/hein/isaflow-ci.env');
    expect((err as Error).message).toContain('EACCES: permission denied');
    expect((err as Error).message).toMatch(/disagree until provision-slots\.ts is run again, which heals it/);
    expect(((err as Error).cause as Error).message).toBe('EACCES: permission denied');
  });

  it('writes nothing when GoTrue refuses the password', async () => {
    gotrue.adminUpdateUser.mockRejectedValue(new Error('gotrue down'));
    let wrote = false;
    await expect(publishSlotLogin({ ...opts, write: () => { wrote = true; } })).rejects.toThrow('gotrue down');
    expect(wrote).toBe(false);
  });
});
