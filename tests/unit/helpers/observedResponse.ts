/**
 * A Response whose body read can be awaited: `read` resolves once the page has read it (json() or text()). A test awaits it, then flushes
 * React (`await act(async () => {})`), before a NEGATIVE assertion, instead of a fixed sleep that passes vacuously when the box is slow.
 */
export function observedResponse(body: string, init: ResponseInit): { res: Response; read: Promise<void> } {
  const res = new Response(body, init);
  let done!: () => void;
  const read = new Promise<void>((resolve) => { done = resolve; });
  const json = res.json.bind(res);
  const text = res.text.bind(res);
  Object.assign(res, {
    json: async () => { try { return await json(); } finally { done(); } },
    text: async () => { try { return await text(); } finally { done(); } },
  });
  return { res, read };
}
