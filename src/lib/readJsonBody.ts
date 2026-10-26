/**
 * Reads a JSON request body inside the handler, for a route that sets
 * `export const config = { api: { bodyParser: false } }`, with a hard byte cap.
 *
 * Why a route reads its own body: with Next's body parser on, a large body is
 * buffered and parsed BEFORE withAuth runs (any caller, signed in or not), and
 * withErrorHandler then logs the parsed `req.body`. Read here, after the auth
 * wrappers, the body is never on `req.body`, so the request log carries none.
 *
 * The cap holds while reading: a declared Content-Length over it is refused
 * before a byte is read, and a stream that passes it is refused at the chunk
 * that crosses it; the rest is drained and discarded, never buffered.
 */
import type { IncomingMessage } from 'http';

/** The body is over the cap (answer 413) or is not JSON (answer 400). */
export class JsonBodyError extends Error {
  constructor(readonly status: 400 | 413, message: string) {
    super(message);
    this.name = 'JsonBodyError';
  }
}

export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const tooLarge = () => new JsonBodyError(413, `The request body is larger than ${Math.floor(maxBytes / 1048576)} MB`);
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    throw tooLarge();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  // destroyOnReturn: false, so leaving the loop early does not destroy the socket the 413 is sent on.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > maxBytes) {
      // Leaving the loop stops this reader; resume() lets the rest of the upload drain, unbuffered.
      req.resume();
      throw tooLarge();
    }
    chunks.push(buf);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown;
  } catch {
    throw new JsonBodyError(400, 'The request body is not valid JSON');
  }
}
