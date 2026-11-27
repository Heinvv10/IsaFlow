/**
 * Round 34: the one final word about --report (runConsole.ts), through sageCliEndHarness.ts. For every way the file can end up (the
 * placeholder, the note, a whole stop report, the finished run's report, a torn body, a failed fsync) x every state of the streams (stderr
 * gone, stdout gone, both live) x every end (a natural end, terminate, a second signal, the exit's ceiling): the LAST line written on a
 * stream still alive is the final word, and it says what the file's final bytes hold. Mid-run notices never claim what it holds.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ReportFault } from './sageCliEndHarness';
import { atExit, fire, h, settle, start, streams, useCliEndHarness } from './sageCliEndHarness';

vi.mock('@/modules/accounting/services/sage-migration/sageMigrationRunner', async () => (await import('./sageCliEndHarness')).runnerMock());
vi.mock('@/modules/accounting/services/sage-migration/sageReportSummary', async () => (await import('./sageCliEndHarness')).summaryMock());
vi.mock('node:fs', async (orig) => (await import('./sageCliEndFsMock')).fsMock(await orig()));
vi.mock('pg', async () => (await import('./sageCliEndHarness')).pgMock());
vi.mock('../../../../scripts/sage-migration/runConsole', async (orig) => (await import('./sageCliConsoleSpy')).spied(await orig()));
useCliEndHarness();

type State = 'placeholder' | 'note' | 'report' | 'torn' | 'fsync';
const NONE = 'no report of this run was written: check the books';
/** What the final word must say, read from the file's final bytes (a failed fsync: the file is not trusted, the stated limit). */
function expected(text: string, fsyncFailed: boolean): { state: State; line: RegExp } {
  const torn = new RegExp(`r\\.json may hold a torn or partial body now \\(a failing disk\\): ${NONE}$`);
  if (fsyncFailed) return { state: 'fsync', line: torn };
  let status: unknown;
  try { status = (JSON.parse(text) as { status?: unknown }).status; } catch { return { state: 'torn', line: torn }; }
  if (status === 'running') return { state: 'placeholder', line: new RegExp(`r\\.json still holds only the "running" placeholder: ${NONE}$`) };
  if (typeof status === 'string' && status.endsWith('_not_written')) return { state: 'note', line: new RegExp(`r\\.json holds only a "${status}" note: ${NONE}$`) };
  return { state: 'report', line: /r\.json holds the run's report$/ };
}

type Fault = { name: string; write: (n: number) => ReportFault; fsync?: (n: number) => boolean };
const faults: Fault[] = [
  { name: 'no fault', write: () => null },
  { name: 'the 2nd body refused', write: (n) => (n === 2 ? 'EIO' : null) },
  { name: 'every body from the 2nd refused', write: (n) => (n >= 2 ? 'EIO' : null) },
  { name: 'the 2nd body torn, the rest refused', write: (n) => (n === 2 ? 'half' : n > 2 ? 'EIO' : null) },
  { name: 'the 3rd body torn over a whole one, the rest refused', write: (n) => (n === 3 ? 'half' : n > 3 ? 'EIO' : null) },
  { name: 'every fsync from the 2nd refused', write: () => null, fsync: (n) => n >= 2 },
];
type Streams = { name: string; stdout: boolean | 'EPIPE'; stderr: boolean | 'EPIPE' };
const live: Streams[] = [
  { name: 'both live', stdout: false, stderr: false },
  { name: 'stderr gone', stdout: false, stderr: 'EPIPE' },
  { name: 'stdout gone', stdout: 'EPIPE', stderr: false },
];
const ceilingStreams: Streams[] = [ // the ceiling needs a stalled stderr; with stdout gone too nothing is alive at the exit
  { name: 'stderr stalled', stdout: false, stderr: true },
  { name: 'stderr stalled, stdout gone', stdout: 'EPIPE', stderr: true },
];
type End = 'natural end' | 'terminate' | 'second signal' | 'ceiling';
const ends: Array<[End, Streams[]]> = [['natural end', live], ['terminate', live], ['second signal', live], ['ceiling', ceilingStreams]];

async function end(kind: End): Promise<void> {
  if (kind === 'natural end') { const { done } = await start(); await settle(); await done; return; }
  if (kind === 'terminate') { h.crashAt = 3; h.crash = () => fire('uncaughtException', new Error('injected')); const { done } = await start(); await settle(); await done; return; }
  if (kind === 'second signal') {
    h.inFlightGate = new Promise(() => undefined); h.crashAt = 3; h.crash = () => { fire('SIGINT'); fire('SIGINT'); };
    await start(); await settle(); return;
  }
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    h.throwAtEnd = 'the books refused it';
    const { done } = await start();
    await settle();
    const { CONSOLE_EXIT_CEILING_MS } = await import('../../../../scripts/sage-migration/runConsole');
    await vi.advanceTimersByTimeAsync(CONSOLE_EXIT_CEILING_MS);
    await done;
  } finally { vi.useRealTimers(); }
}

const lines = (chunks: string[]) => chunks.join('').split('\n').filter((l) => l !== '' && !l.startsWith('{"level"'));
const seen = new Set<State>();
describe('round 34: the last line on a stream still alive is the final word, and it says what the file finally holds', () => {
  for (const [kind, streamSets] of ends) {
    for (const s of streamSets) {
      for (const f of faults) {
        it(`${kind}, ${s.name}, ${f.name}`, async () => {
          h.reportFault = f.write;
          if (f.fsync) h.fsyncFault = f.fsync;
          streams({ stdout: s.stdout, stderr: s.stderr });
          await end(kind);
          await atExit(); // the process's 'exit' listeners run after process.exit too: the final word is still said once
          const want = expected(readFileSync(join(h.dir, 'r.json'), 'utf8'), f.fsync !== undefined);
          seen.add(want.state);
          const alive = kind === 'ceiling' ? (s.stdout === false ? h.out : null) : s.stderr === false ? h.err : h.out;
          const all = [...lines(h.err), ...lines(h.out)];
          expect(all.filter((l) => /^--report \S+ (holds|still holds|may hold)/.test(l))).toHaveLength(alive === null ? 0 : 1); // said once
          if (alive === null) return; // both gone: nowhere to say it
          expect(lines(alive).at(-1)).toMatch(want.line);
          for (const l of all) if (l !== lines(alive).at(-1)) expect(l).not.toMatch(/holds the run's report|still holds only|holds only a "/); // no notice claims it
        });
      }
    }
  }
  it('the table reached every state the file can end in', () => {
    expect([...seen].sort()).toEqual(['fsync', 'note', 'placeholder', 'report', 'torn']);
  });
});
