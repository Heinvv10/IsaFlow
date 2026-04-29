// popup.js — extension toolbar popup. Lists paired connections + sync button.

const $conn = document.getElementById('connections');
const $status = document.getElementById('status');

function setStatus(msg, kind) {
  $status.textContent = msg || '';
  $status.className = kind || '';
}

function bg(type, extra) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ source: 'isaflow-bank', type, ...(extra || {}) }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (!resp || resp.ok === false) return reject(new Error(resp && resp.error ? resp.error : 'Unknown error'));
      resolve(resp.value);
    });
  });
}

function el(tag, opts) {
  const e = document.createElement(tag);
  if (opts) {
    if (opts.text != null) e.textContent = String(opts.text);
    if (opts.cls) e.className = opts.cls;
    if (opts.data) for (const [k, v] of Object.entries(opts.data)) e.dataset[k] = String(v);
  }
  return e;
}

function row(c) {
  const div = el('div', { cls: 'conn' });
  const last = c.lastSyncAt ? new Date(c.lastSyncAt).toLocaleString() : 'never';
  const label = c.bankId.toUpperCase() + (c.bankAccountLabel ? ' — ' + c.bankAccountLabel : '');

  div.appendChild(el('div', { cls: 'conn-bank', text: label }));
  div.appendChild(el('div', { cls: 'conn-meta', text: 'Last sync: ' + last }));

  const buttons = el('div', { cls: 'row' });
  buttons.appendChild(el('button', { text: 'Sync now', data: { act: 'sync', id: c.connectionId } }));
  const unpair = el('button', { text: 'Unpair', cls: 'secondary', data: { act: 'unpair', id: c.connectionId } });
  buttons.appendChild(unpair);
  div.appendChild(buttons);
  return div;
}

async function refresh() {
  setStatus('');
  $conn.replaceChildren();
  try {
    const list = await bg('list-connections');
    if (!list || list.length === 0) {
      const empty = el('div', { cls: 'empty' });
      empty.appendChild(document.createTextNode('No connections yet. Open '));
      const a = el('a', { text: 'ISAFlow → Bank Feeds' });
      a.href = 'https://app.isaflow.co.za/accounting/bank-feeds';
      a.target = '_blank';
      empty.appendChild(a);
      empty.appendChild(document.createTextNode(' to pair a bank.'));
      $conn.appendChild(empty);
      return;
    }
    for (const c of list) $conn.appendChild(row(c));
  } catch (err) {
    setStatus('Failed to load: ' + err.message, 'err');
  }
}

$conn.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  btn.disabled = true;
  setStatus('Working…');
  try {
    if (act === 'sync') {
      const out = await bg('sync', { connectionId: id, opts: { daysBack: 30 } });
      setStatus(`Synced — found ${out.found}, imported ${out.imported}, duplicate ${out.duplicate}`, 'ok');
    } else if (act === 'unpair') {
      await bg('unpair', { connectionId: id });
      setStatus('Unpaired', 'ok');
    }
  } catch (err) {
    setStatus(err.message, 'err');
  } finally {
    btn.disabled = false;
    refresh();
  }
});

refresh();
