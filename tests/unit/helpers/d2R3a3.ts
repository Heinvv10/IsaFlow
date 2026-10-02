// d2 round 3 (a3): one site = three outcomes. A 400 shows the server's message, an empty-body 500 shows the
// page's plain sentence (never a JSON parse error), a 200 runs `succeeds` (the action's consequence).
import { it } from 'vitest';
import { screen } from '@testing-library/react';
import { MSG, expectNoRawJsonError, script, type Site } from './d2CensusG4';

export type Site3 = Omit<Site, 'success'> & {
  /** Asserts the success consequence (called after a 200). */
  succeeds: () => Promise<void> | void;
  /** Asserts that a refused write did not claim success / close / redirect. */
  stays?: () => Promise<void> | void;
};

const esc = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

export function trio3(site: Site3) {
  const base = { ...site, success: '' } as Site;
  it(`${site.name}: shows the server's message on a 400`, async () => {
    script(base, 'bad'); site.render(); await site.drive?.();
    await screen.findAllByText(esc(MSG));
    await site.stays?.();
  });
  it(`${site.name}: an empty 500 shows a plain sentence, not a JSON parse error`, async () => {
    script(base, 'boom'); site.render(); await site.drive?.();
    await screen.findAllByText(esc(site.plain));
    expectNoRawJsonError();
    await site.stays?.();
  });
  it(`${site.name}: a 200 takes effect`, async () => {
    script(base, 'ok'); site.render(); await site.drive?.();
    await site.succeeds();
  });
}
