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

  async ingest(connection, payload) {
    const url = (connection.host || 'https://app.isaflow.co.za') + connection.ingestUrl;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + connection.jwt,
      },
      body: JSON.stringify(payload),
    });
    let json = null;
    try { json = await resp.json(); } catch (_e) { /* non-JSON */ }
    return { status: resp.status, ok: resp.ok, body: json };
  },
};
