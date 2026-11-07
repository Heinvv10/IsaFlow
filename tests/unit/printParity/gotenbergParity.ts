/**
 * THE TWO ENGINES OF THE PARITY TEST: a throwaway Gotenberg of the image production runs, and the Chromium the print
 * tests launch (`launchPrintChromium`).
 *
 * The container is started from the image by ID (never the production container, which is left alone), published
 * on a loopback port, and removed with its volumes (`docker rm -fv`) when the test ends. A parity document
 * (`parityPage.ts`) is sent to Gotenberg's HTML route with the font files beside it and the paper, margins and media
 * the production transport sends (`gotenbergForm.ts`); its report comes back as the PDF's text (`pdftotext`).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { PAPER_A4_IN, PDF_MARGIN_MM, mmToIn } from '@/lib/pdf/pdfTransport';
import { PARITY_WIDTH_PX, UNLOADED_FACES, type FontFile } from './parityPage';

/** `docker inspect gotenberg --format '{{.Image}}'` on velo: the image production's container runs (gotenberg/gotenberg:8). */
export const PRODUCTION_GOTENBERG_IMAGE = 'sha256:888f4f1e00ff01422a3f35d4a74edd9d705d1d4910d47039ac9c10db6763cd58';

const HOST = 'http://parity.print.local/';

/** What `cmd args` printed on failure (stderr), or null where it succeeded. */
function failure(cmd: string, args: string[]): string | null {
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    return null;
  } catch (err) {
    const e = err as { code?: string; stderr?: Buffer };
    return e.code === 'ENOENT' ? 'ENOENT' : (e.stderr?.toString() ?? String(err)).trim();
  }
}

/** Why the parity test cannot run on this machine, naming the actual cause, or null where it can. */
export function parityUnavailable(): string | null {
  const docker = failure('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (docker === 'ENOENT') return 'docker is not installed on this machine';
  if (docker !== null) {
    return /permission denied/i.test(docker)
      ? `this user (${process.env.USER ?? 'unknown'}) has no access to the docker daemon (not in the docker group)`
      : `the docker daemon cannot be reached: ${docker.split('\n')[0]}`;
  }
  if (failure('docker', ['image', 'inspect', PRODUCTION_GOTENBERG_IMAGE]) !== null) {
    return `the production Gotenberg image ${PRODUCTION_GOTENBERG_IMAGE.slice(0, 19)} is not on this machine`;
  }
  if (failure('pdftotext', ['-v']) === 'ENOENT') return 'pdftotext (poppler-utils) is not installed';
  return null;
}

export interface Gotenberg { url: string; stop: () => void }

const NAME_PREFIX = 'isaflow-print-parity-';

/** Is process `pid` alive on this host? */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The parity containers whose run is gone: named `isaflow-print-parity-<pid>` by `startGotenberg` and that pid is not
 * alive (a run killed before its afterAll). Only this exact pattern: nothing else on the host is touched.
 */
export function orphanedContainers(names: readonly string[], isAlive: (pid: number) => boolean = alive): string[] {
  return names.filter((name) => {
    const match = new RegExp(`^${NAME_PREFIX}(\\d+)$`).exec(name);
    return match !== null && !isAlive(Number(match[1]));
  });
}

function removeOrphans(): void {
  const names = execFileSync('docker', ['ps', '-a', '--filter', `name=^${NAME_PREFIX}`, '--format', '{{.Names}}'], { encoding: 'utf8' })
    .split('\n').filter((n) => n !== '');
  for (const name of orphanedContainers(names)) execFileSync('docker', ['rm', '-fv', name], { stdio: 'ignore' });
}

/**
 * A throwaway Gotenberg of the production image, removed with its volumes when `stop` is called (the tests' afterAll),
 * when this process exits or is interrupted, and, if it was killed outright, by the next run (`orphanedContainers`).
 */
export async function startGotenberg(): Promise<Gotenberg> {
  removeOrphans();
  const name = `${NAME_PREFIX}${process.pid}`;
  execFileSync('docker', ['run', '-d', '--name', name, '-p', '127.0.0.1::3000', PRODUCTION_GOTENBERG_IMAGE, 'gotenberg', '--api-timeout=600s'], { stdio: 'ignore' });
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    process.off('exit', stop);
    execFileSync('docker', ['rm', '-fv', name], { stdio: 'ignore' });
  };
  process.once('exit', stop);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stop(); process.exit(130); });
  try {
    const port = execFileSync('docker', ['port', name, '3000/tcp'], { encoding: 'utf8' }).trim().split('\n')[0]!;
    const url = `http://${port}`;
    for (let i = 0; i < 120; i += 1) {
      const ok = await fetch(`${url}/health`).then((r) => r.ok, () => false);
      if (ok) return { url, stop };
      await new Promise((resolve) => { setTimeout(resolve, 500); });
    }
    throw new Error(`Gotenberg in ${name} did not become healthy`);
  } catch (err) {
    stop();
    throw err;
  }
}

/** The PDF Gotenberg prints `html` as, with the production transport's paper, margins and media. */
export async function gotenbergPdf(gotenberg: Gotenberg, html: string, fonts: readonly FontFile[], waitForExpression?: string): Promise<Buffer> {
  const form = new FormData();
  form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
  for (const font of fonts) form.append('files', new Blob([readFileSync(font.file)], { type: 'font/woff2' }), font.name);
  const fields: Record<string, string> = {
    paperWidth: PAPER_A4_IN.width.toFixed(2), paperHeight: PAPER_A4_IN.height.toFixed(2),
    marginTop: mmToIn(PDF_MARGIN_MM.top), marginBottom: mmToIn(PDF_MARGIN_MM.bottom),
    marginLeft: mmToIn(PDF_MARGIN_MM.left), marginRight: mmToIn(PDF_MARGIN_MM.right),
    printBackground: 'true', emulatedMediaType: 'print', skipNetworkIdleEvent: 'true',
    ...(waitForExpression === undefined ? {} : { waitForExpression }),
  };
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const res = await fetch(`${gotenberg.url}/forms/chromium/convert/html`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Gotenberg ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Runs `read` on `pdf` written to a temporary file, and removes it. */
export function withPdfFile<T>(pdf: Buffer, read: (file: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'isaflow-parity-'));
  try {
    const file = path.join(dir, 'print.pdf');
    writeFileSync(file, pdf);
    return read(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Gotenberg's report on `html`: the text of the PDF it prints. */
export async function gotenbergReport(gotenberg: Gotenberg, html: string, fonts: readonly FontFile[]): Promise<string> {
  const pdf = await gotenbergPdf(gotenberg, html, fonts, 'window.parityDone === true');
  return withPdfFile(pdf, (file) => execFileSync('pdftotext', ['-raw', file, '-'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
}

/**
 * A page of the print tests' Chromium holding `html`, its font files served beside it as Gotenberg serves them, every
 * served face loaded (it throws where one is not: a probe set in a fallback face measures a different document).
 */
export async function servedPage(browser: Browser, html: string, fonts: readonly FontFile[], viewportWidth: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: viewportWidth, height: 1000 } });
  try {
    const files = new Map(fonts.map((f) => [`/${f.name}`, f.file]));
    await page.route(`${HOST}**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
      const file = files.get(url.pathname);
      return file === undefined ? route.abort() : route.fulfill({ contentType: 'font/woff2', body: readFileSync(file) });
    });
    await page.emulateMedia({ media: 'print' });
    await page.goto(HOST, { waitUntil: 'load' });
    const unloaded = await page.evaluate(`(async function () {
      await Promise.all(Array.from(document.fonts).map(function (f) { return f.load().catch(function () { return null; }); }));
      await document.fonts.ready;
      return ${UNLOADED_FACES};
    })()`) as string[];
    if (unloaded.length > 0) throw new Error(`served faces did not load: ${unloaded.join(', ')}`);
    return page;
  } catch (err) {
    await page.close();
    throw err;
  }
}

/** The print tests' Chromium's report on `html`, laid out as Gotenberg lays it out: print media, the same width. */
export async function playwrightReport(browser: Browser, html: string, fonts: readonly FontFile[]): Promise<string> {
  const page = await servedPage(browser, html, fonts, Math.ceil(PARITY_WIDTH_PX) + 1);
  try {
    await page.waitForFunction(() => (window as unknown as { parityDone?: boolean }).parityDone === true, undefined, { timeout: 600_000 });
    return (await page.textContent('#parity-out')) ?? '';
  } finally {
    await page.close();
  }
}
