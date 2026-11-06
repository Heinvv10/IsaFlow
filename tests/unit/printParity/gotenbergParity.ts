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
import type { Browser } from 'playwright';
import { PAPER_A4_IN, PDF_MARGIN_MM, mmToIn } from '@/lib/pdf/pdfTransport';
import { PARITY_WIDTH_PX, type FontFile } from './parityPage';

/** `docker inspect gotenberg --format '{{.Image}}'` on velo: the image production's container runs (gotenberg/gotenberg:8). */
export const PRODUCTION_GOTENBERG_IMAGE = 'sha256:888f4f1e00ff01422a3f35d4a74edd9d705d1d4910d47039ac9c10db6763cd58';

const HOST = 'http://parity.print.local/';

/** Why the parity test cannot run on this machine, or null where it can. */
export function parityUnavailable(): string | null {
  try {
    execFileSync('docker', ['image', 'inspect', PRODUCTION_GOTENBERG_IMAGE], { stdio: 'ignore' });
  } catch {
    return `docker or the production Gotenberg image ${PRODUCTION_GOTENBERG_IMAGE.slice(0, 19)} is not on this machine (velo only)`;
  }
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
  } catch {
    return 'pdftotext (poppler-utils) is not installed';
  }
  return null;
}

export interface Gotenberg { url: string; stop: () => void }

export async function startGotenberg(): Promise<Gotenberg> {
  const name = `isaflow-print-parity-${process.pid}`;
  execFileSync('docker', ['run', '-d', '--name', name, '-p', '127.0.0.1::3000', PRODUCTION_GOTENBERG_IMAGE, 'gotenberg', '--api-timeout=600s'], { stdio: 'ignore' });
  const stop = (): void => { execFileSync('docker', ['rm', '-fv', name], { stdio: 'ignore' }); };
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

/** Gotenberg's report on `html`: the text of the PDF it prints. */
export async function gotenbergReport(gotenberg: Gotenberg, html: string, fonts: readonly FontFile[]): Promise<string> {
  const form = new FormData();
  form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
  for (const font of fonts) form.append('files', new Blob([readFileSync(font.file)], { type: 'font/woff2' }), font.name);
  const fields: Record<string, string> = {
    paperWidth: PAPER_A4_IN.width.toFixed(2), paperHeight: PAPER_A4_IN.height.toFixed(2),
    marginTop: mmToIn(PDF_MARGIN_MM.top), marginBottom: mmToIn(PDF_MARGIN_MM.bottom),
    marginLeft: mmToIn(PDF_MARGIN_MM.left), marginRight: mmToIn(PDF_MARGIN_MM.right),
    printBackground: 'true', emulatedMediaType: 'print', skipNetworkIdleEvent: 'true',
    waitForExpression: 'window.parityDone === true',
  };
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const res = await fetch(`${gotenberg.url}/forms/chromium/convert/html`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Gotenberg ${res.status}: ${await res.text()}`);
  const dir = mkdtempSync(path.join(tmpdir(), 'isaflow-parity-'));
  try {
    const pdf = path.join(dir, 'report.pdf');
    writeFileSync(pdf, Buffer.from(await res.arrayBuffer()));
    return execFileSync('pdftotext', ['-raw', pdf, '-'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The print tests' Chromium's report on `html`, laid out as Gotenberg lays it out: print media, the same width. */
export async function playwrightReport(browser: Browser, html: string, fonts: readonly FontFile[]): Promise<string> {
  const page = await browser.newPage({ viewport: { width: PARITY_WIDTH_PX, height: 1000 } });
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
    await page.waitForFunction(() => (window as unknown as { parityDone?: boolean }).parityDone === true, undefined, { timeout: 600_000 });
    return (await page.textContent('#parity-out')) ?? '';
  } finally {
    await page.close();
  }
}
