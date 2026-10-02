/** Shared response builders for the d2R3a4* component tests (real envelope shapes). */
export const MSG = 'D2 server says no: this was refused';
export const PLAIN_BAD = /Unexpected end|JSON input|JSON at|HTTP \d|^Failed$/;

export const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
export const envelope = (m: string = MSG, status = 400) =>
  new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: m } }), { status });
export const empty500 = () => new Response('', { status: 500 });
