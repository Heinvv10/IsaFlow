/**
 * Small UI and probe helpers the rubric steps share (master plan wave 4, MW).
 */
import { expect, type Locator, type Page, type Response } from '@playwright/test';
import type { Api } from '../golden-paths/_api';

/**
 * A route the server does not have: Next answers an unknown API path with its HTML 404 page, while a route that exists
 * answers JSON (or a PDF), even when it refuses. This is how a step whose PR has not merged says "not built".
 */
export async function routeMissing(api: Api, path: string): Promise<boolean> {
  const res = await api.ctx.get(path);
  return res.status() === 404 && !(res.headers()['content-type'] ?? '').includes('application/json');
}

/** Chooses an option by its label on a native <select> or on a kit Select (NS1 and PS convert some of them). */
export async function chooseOption(page: Page, trigger: Locator, label: RegExp): Promise<'native' | 'kit'> {
  if (await trigger.evaluate((el) => el.tagName === 'SELECT')) {
    const text = await trigger.locator('option').evaluateAll(
      (opts, source) => opts.map((o) => o.textContent?.trim() ?? '').find((t) => new RegExp(source).test(t)), label.source);
    if (!text) throw new Error(`no option matching ${label} in ${await trigger.getAttribute('aria-label')}`);
    await trigger.selectOption({ label: text });
    return 'native';
  }
  await trigger.click();
  await page.getByRole('option', { name: label }).first().click();
  return 'kit';
}

export const isFocused = (target: Locator): Promise<boolean> => target.evaluate((el) => el === document.activeElement);

/** Text of a PDF, through pdf-parse (the server's own PDF reader). */
export async function pdfText(pdf: Buffer): Promise<string> {
  const { PDFParse } = (await import('pdf-parse')) as unknown as {
    PDFParse: new (o: { data: Buffer }) => { getText(): Promise<{ text: string }> };
  };
  return (await new PDFParse({ data: pdf }).getText()).text;
}

/** A payslip as the API serves it: is it a PDF, and does it say DRAFT. */
export async function payslip(api: Api, runId: string, employeeId: string): Promise<{ pdf: boolean; draft: boolean }> {
  const res = await api.ctx.get(`/api/payroll/runs/${runId}/payslips?employeeId=${employeeId}&disposition=inline`);
  expect(res.status(), `payslip for ${employeeId}`).toBe(200);
  const body = await res.body();
  const pdf = body.subarray(0, 4).toString('latin1') === '%PDF';
  return { pdf, draft: pdf && /DRAFT/.test(await pdfText(body)) };
}

/**
 * The next POST to `path`. Started before the action that sends it; when that action throws first, nobody awaits this
 * promise, so a no-op handler is attached to keep its later rejection from being unhandled (the caller still sees it).
 */
export function waitForPost(page: Page, path: string): Promise<Response> {
  const response = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === path, { timeout: 60_000 });
  response.catch(() => undefined);
  return response;
}

/**
 * Waits for `ready`; when the page shows its own "Could not load" instead (a client fetch that gave up, seen under box
 * load on a dev server), reloads once. Returns the reloads it took, which the step records.
 */
export async function loadedOrReload(page: Page, ready: Locator, failure: RegExp = /^Could not load/): Promise<number> {
  const failed = page.getByText(failure).first();
  for (let reloads = 0; reloads < 2; reloads++) {
    await expect(ready.or(failed).first()).toBeVisible({ timeout: 60_000 });
    if (!(await failed.isVisible())) return reloads;
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
  throw new Error(`still "${await failed.textContent()}" after a reload`);
}
