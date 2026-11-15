// api.js — service-worker helpers for talking to IsaFlow.
//
// Every connection has its own pairing JWT, stored under the key
// 'connection:<connectionId>' in chrome.storage.local. Posts of parsed
// transactions go to the connection-specific ingest URL minted by
// /api/accounting/bank-feeds/extension-pair.

self.IsaflowApi = {
  STORAGE_PREFIX: 'connection:',

  async listConnections() {
    const all = await chrome.storage.local.get(null);
    const out = [];
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith(this.STORAGE_PREFIX) && v && v.jwt && v.connectionId) {
        out.push(v);
      }
    }
    return out;
  },

  async getConnection(connectionId) {
    const key = this.STORAGE_PREFIX + connectionId;
    const out = await chrome.storage.local.get(key);
    return out[key] || null;
  },

  async saveConnection(record) {
    const key = this.STORAGE_PREFIX + record.connectionId;
    await chrome.storage.local.set({ [key]: record });
  },

  async deleteConnection(connectionId) {
    await chrome.storage.local.remove(this.STORAGE_PREFIX + connectionId);
  },

  // A 503 + Retry-After means another import into the same bank account held its ingest lock past 5 s; the server
  // rolled back and wrote nothing. Wait Retry-After seconds (default 2, at most 10) and send the batch ONCE more.
  RETRY_AFTER_DEFAULT_S: 2,
  RETRY_AFTER_MAX_S: 10,

  retryDelayMs(resp) {
    const raw = resp.headers && resp.headers.get ? resp.headers.get('Retry-After') : null;
    const secs = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
    return (Number.isFinite(secs) && secs >= 0 ? Math.min(secs, this.RETRY_AFTER_MAX_S) : this.RETRY_AFTER_DEFAULT_S) * 1000;
  },

  async ingest(connection, payload) {
    const url = (connection.host || 'https://app.isaflow.co.za') + connection.ingestUrl;
    const init = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + connection.jwt,
      },
      body: JSON.stringify(payload),
    };
    let resp = await fetch(url, init);
    if (resp.status === 503) {
      const delay = this.retryDelayMs(resp);
      await new Promise((resolve) => setTimeout(resolve, delay));
      resp = await fetch(url, init);
    }
    if (!resp.ok) {
      // A refusal: keep the server's error body (when it is JSON) for the caller's message.
      const refused = await resp.json().catch(() => null);
      return { status: resp.status, ok: false, body: refused };
    }
    const json = await resp.json().catch(() => null);
    return { status: resp.status, ok: true, body: json };
  },
};
