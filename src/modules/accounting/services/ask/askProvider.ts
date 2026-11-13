/**
 * Free-text "Ask IsaFlow" provider seam (wave 5 M11, decision 8). OFF: nothing is registered, so no value of
 * ASK_ISAFLOW_PROVIDER enables anything. There is no model client, no key and no outbound call here; a provider
 * is a later, separately approved PR that adds an entry to PROVIDERS (spend is Hein's gate). That PR MUST add its own meter: the
 * route deliberately never meters `mode=free`, so an unmetered provider would be free for every caller.
 */
import type { AskAnswer } from './askTypes';

export interface FreeTextProvider {
  /** Answers a question already scoped to `companyId`, in the shape the route's registered type promises. Must itself be read-only. */
  answer(companyId: string, question: string): Promise<AskAnswer>;
}

const PROVIDERS: Readonly<Record<string, FreeTextProvider>> = {};

/** The provider named by ASK_ISAFLOW_PROVIDER, or null: unset, empty and unknown names all mean off. */
export function resolveProvider(env: Record<string, string | undefined> = process.env): FreeTextProvider | null {
  const name = env.ASK_ISAFLOW_PROVIDER?.trim();
  return name && Object.prototype.hasOwnProperty.call(PROVIDERS, name) ? PROVIDERS[name] ?? null : null;
}
