/**
 * The rubric harness's evidence (master plan wave 4, MW): one JSON file per run plus screenshots, in RUBRIC_EVIDENCE_DIR.
 *
 * A step records what it measured, "not built" (its PR has not merged; never a failure), or the error that stopped it.
 * The file is written after every step, so a run that dies part-way still leaves what it measured.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';

const STEP_LIMIT_MS = 8 * 60_000;

export type StepRecord =
  | { status: 'measured'; [key: string]: unknown }
  | { status: 'not built'; reason: string; [key: string]: unknown }
  | { status: 'skipped'; reason: string; [key: string]: unknown }
  | { status: 'failed'; error: string; [key: string]: unknown };

export class Evidence {
  readonly file: string;
  private readonly data: { meta: Record<string, unknown>; seed: Record<string, unknown>; steps: Record<string, StepRecord> };

  constructor(readonly dir: string, meta: Record<string, unknown>) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'rubric.json');
    this.data = { meta, seed: {}, steps: {} };
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

  /** Runs one step. A thrown error is recorded and the run goes on; `failures()` decides the run's verdict at the end. */
  async step(name: string, run: () => Promise<StepRecord>, page?: Page): Promise<StepRecord> {
    let record: StepRecord;
    let timer: NodeJS.Timeout | undefined;
    try {
      // A wait Playwright does not bound (a response body, say) must not hold the run: each step gets 8 minutes.
      record = await Promise.race([run(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`step "${name}" took over ${STEP_LIMIT_MS / 60_000} minutes`)), STEP_LIMIT_MS);
      })]);
    } catch (err) {
      const error = err instanceof Error ? err.message.split('\n').filter(Boolean).slice(0, 4).join(' | ') : String(err);
      const screenshot = page && !page.isClosed()
        ? await this.shot(page, `failed-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`).catch((e: unknown) => `none: ${String(e)}`)
        : undefined;
      record = { status: 'failed', error, screenshot };
    } finally {
      clearTimeout(timer);
    }
    this.data.steps[name] = record;
    this.flush();
    return record;
  }

  failures(): string[] {
    return Object.entries(this.data.steps)
      .filter(([, r]) => r.status === 'failed')
      .map(([name, r]) => `${name}: ${(r as { error: string }).error}`);
  }

  async shot(page: Page, name: string): Promise<string> {
    const file = `${name}.png`;
    await page.screenshot({ path: join(this.dir, file) });
    return file;
  }

  private flush(): void {
    writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`);
  }
}

export const notBuilt = (reason: string, extra: Record<string, unknown> = {}): StepRecord => ({ status: 'not built', reason, ...extra });

/** Counts what a person would do: clicks, fields filled, keys pressed, and the wall time from the first action. */
export class Tally {
  clicks = 0;
  fields = 0;
  keys = 0;
  private readonly started = Date.now();

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

  summary(): { clicks: number; fields: number; keys: number; ms: number } {
    return { clicks: this.clicks, fields: this.fields, keys: this.keys, ms: Date.now() - this.started };
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
