/**
 * The rubric harness's evidence (master plan wave 4, MW): one JSON file per run plus screenshots, in RUBRIC_EVIDENCE_DIR.
 *
 * A step records what it measured, "not built" (its PR has not merged; never a failure), "skipped (re-run)" (a re-run of
 * a run id whose pay run is already approved), or the error that stopped it. The file is written after every step, so a
 * run that dies part-way still leaves what it measured; its `summary` lists the steps by status.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';

/** A step's wall-time limit, and how long a step that overran may take to stop once its pages are closed. */
export interface StepLimits { stepMs: number; settleMs: number }
const LIMITS: StepLimits = { stepMs: 8 * 60_000, settleMs: 60_000 };
const RERUN = 'skipped (re-run)';

export type StepRecord =
  | { status: 'measured'; [key: string]: unknown }
  | { status: 'not built'; reason: string; [key: string]: unknown }
  | { status: 'skipped'; reason: string; [key: string]: unknown }
  | { status: 'failed'; error: string; [key: string]: unknown };

export class Evidence {
  readonly file: string;
  private readonly data: {
    meta: Record<string, unknown>; seed: Record<string, unknown>; steps: Record<string, StepRecord>; summary: Record<string, string[]>;
  };

  constructor(readonly dir: string, meta: Record<string, unknown>, private readonly limits: StepLimits = LIMITS) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'rubric.json');
    this.data = { meta, seed: {}, steps: {}, summary: {} };
    this.flush();
  }

  meta(key: string, value: unknown): void {
    this.data.meta[key] = value;
    this.flush();
  }

  seed(key: string, value: unknown): void {
    this.data.seed[key] = value;
    this.flush();
  }

  /**
   * Runs one step on `pages()` (the pages it drives). A thrown error is recorded and the run goes on; `failures()`
   * decides the run's verdict at the end. A step over its limit is stopped before the next one starts: its pages are
   * closed (every pending Playwright action on them rejects) and it is given `settleMs` to unwind. One that still has
   * not stopped aborts the run (throws), since it could still write while the next step measures.
   */
  async step(name: string, run: () => Promise<StepRecord>, pages: () => Page[] = () => []): Promise<StepRecord> {
    let record: StepRecord;
    let timer: NodeJS.Timeout | undefined;
    let overran = false;
    const running = run();
    try {
      // A wait Playwright does not bound (a response body, say) must not hold the run.
      record = await Promise.race([running, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { overran = true; reject(new Error(`step "${name}" took over ${this.limits.stepMs / 1000} s`)); }, this.limits.stepMs);
      })]);
    } catch (err) {
      const error = err instanceof Error ? err.message.split('\n').filter(Boolean).slice(0, 4).join(' | ') : String(err);
      const page = pages().find((p) => !p.isClosed());
      const screenshot = page
        ? await this.shot(page, `failed-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`).catch((e: unknown) => `none: ${String(e)}`)
        : undefined;
      record = { status: 'failed', error, screenshot };
    } finally {
      clearTimeout(timer);
    }
    if (overran) await this.stop(name, running, pages(), record);
    this.data.steps[name] = record;
    this.flush();
    return record;
  }

  /** Closes an overrun step's pages and waits for it to unwind; throws (after recording) if it does not. */
  private async stop(name: string, running: Promise<StepRecord>, pages: Page[], record: StepRecord): Promise<void> {
    await Promise.all(pages.map((p) => p.close().catch(() => undefined)));
    let settleTimer: NodeJS.Timeout | undefined;
    const stopped = await Promise.race([
      running.then(() => true, () => true),
      new Promise<false>((resolve) => { settleTimer = setTimeout(() => resolve(false), this.limits.settleMs); }),
    ]);
    clearTimeout(settleTimer);
    if (stopped) return;
    const error = `${(record as { error: string }).error}; it did not stop within ${this.limits.settleMs / 1000} s of its pages closing`;
    this.data.steps[name] = { ...record, status: 'failed', error };
    this.flush();
    throw new Error(`step "${name}" did not stop: the run is aborted`);
  }

  failures(): string[] {
    const steps = Object.entries(this.data.steps);
    const failed = steps.filter(([, r]) => r.status === 'failed').map(([name, r]) => `${name}: ${(r as { error: string }).error}`);
    if (steps.length > 0 && steps.every(([, r]) => r.status === 'skipped')) {
      failed.push('every step was skipped (a re-run of a finished run id measures nothing)');
    }
    return failed;
  }

  async shot(page: Page, name: string): Promise<string> {
    const file = `${name}.png`;
    await page.screenshot({ path: join(this.dir, file) });
    return file;
  }

  private flush(): void {
    const by = (status: StepRecord['status']) => Object.entries(this.data.steps).filter(([, r]) => r.status === status).map(([n]) => n);
    this.data.summary = { measured: by('measured'), 'not built': by('not built'), [RERUN]: by('skipped'), failed: by('failed') };
    writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`);
  }
}

export const notBuilt = (reason: string, extra: Record<string, unknown> = {}): StepRecord => ({ status: 'not built', reason, ...extra });

/** A step a re-run of the same run id cannot repeat (its pay run is already approved). Said explicitly in the record. */
export const skippedRerun = (reason: string): StepRecord => ({ status: 'skipped', reason: `${RERUN}: ${reason}` });

/** Counts what a person would do: clicks, fields filled, keys pressed, and the wall time from the first action. */
export class Tally {
  clicks = 0;
  fields = 0;
  keys = 0;
  private readonly started = Date.now();
  private offClockMs = 0;

  constructor(private readonly page: Page) {}

  async click(target: Locator): Promise<void> {
    this.clicks++;
    await target.click();
  }

  async fill(target: Locator, text: string): Promise<void> {
    this.fields++;
    await target.fill(text);
  }

  async press(key: string, times = 1): Promise<void> {
    for (let i = 0; i < times; i++) {
      this.keys++;
      await this.page.keyboard.press(key);
    }
  }

  /** Typing a value counts one field and one key per character. */
  async type(text: string): Promise<void> {
    this.fields++;
    this.keys += text.length;
    await this.page.keyboard.type(text);
  }

  /** Runs `work` off this tally's clock: its time is not in `ms` (its actions, on another tally, are not counted here). */
  async offClock<T>(work: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      return await work();
    } finally {
      this.offClockMs += Date.now() - t0;
    }
  }

  summary(): { clicks: number; fields: number; keys: number; ms: number } {
    return { clicks: this.clicks, fields: this.fields, keys: this.keys, ms: Date.now() - this.started - this.offClockMs };
  }
}

/** Milliseconds until `until` resolves. */
export async function timed(until: () => Promise<unknown>): Promise<number> {
  const t0 = Date.now();
  await until();
  return Date.now() - t0;
}

/** A computed `transition-duration` ("0.15s, 200ms") as its longest value in ms. */
export function longestDurationMs(css: string): number {
  return Math.max(0, ...css.split(',').map((part) => {
    const v = part.trim();
    const n = parseFloat(v);
    if (Number.isNaN(n)) return 0;
    return v.endsWith('ms') ? n : n * 1000;
  }));
}
