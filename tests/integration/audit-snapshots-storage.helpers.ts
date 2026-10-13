/**
 * A stand-in for the Supabase Storage API the audit pack writes to: the two
 * calls @supabase/storage-js makes (POST /storage/v1/object/<bucket>/<path>
 * to upload, GET the same path to download), kept in memory. The code under
 * test is the real storage client; only the far end is local.
 */
import { createServer, type Server } from 'node:http';

export interface FakeStorage { url: string; files: Map<string, Buffer>; close: () => Promise<void> }

export async function startFakeStorage(): Promise<FakeStorage> {
  const files = new Map<string, Buffer>();
  const server: Server = createServer((req, res) => {
    const key = decodeURIComponent((req.url ?? '').replace(/^\/storage\/v1\/object\//, '').split('?')[0]!);
    if (req.method === 'POST' || req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        files.set(key, Buffer.concat(chunks));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ Id: key, Key: key }));
      });
      return;
    }
    const body = files.get(key);
    if (req.method === 'GET' && body) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ statusCode: '404', error: 'not_found', message: 'Object not found' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, files, close: () => new Promise((r) => server.close(() => r())) };
}
