/** Shared scripting for the d2CensusH4* component tests: the real error envelope, an empty 500, a 200 envelope. */
export const MSG = 'D2 server says no: this request was refused';
export const bad400 = () => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 });
export const empty500 = () => new Response('', { status: 500 });
export const okRes = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

/** First route whose substring is in the url answers; anything else gets a 200 envelope of `fallback`. */
export function router(routes: Array<[string, () => Response]>, fallback: unknown = []) {
  return async (url: unknown): Promise<Response> => {
    const u = String(url);
    const hit = routes.find(([part]) => u.includes(part));
    return hit ? hit[1]() : okRes(fallback);
  };
}

/** What a user must never be shown for a failed request. */
export const rawJsonError = /JSON|Unexpected end/;
