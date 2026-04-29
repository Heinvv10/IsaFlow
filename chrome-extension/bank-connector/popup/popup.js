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

const ABSA_MAX_DAYS = 180;

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function todayIso() { return new Date().toISOString().slice(0, 10); }

function row(c) {
  const div = el('div', { cls: 'conn' });
  const last = c.lastSyncAt ? new Date(c.lastSyncAt).toLocaleString() : 'never';
  const label = c.bankId.toUpperCase() + (c.bankAccountLabel ? ' — ' + c.bankAccountLabel : '');

  div.appendChild(el('div', { cls: 'conn-bank', text: label }));
  div.appendChild(el('div', { cls: 'conn-meta', text: 'Last sync: ' + last }));

  // Date-range picker. Defaults: from = 30d ago (or last sync date if any), to = today.
  // ABSA caps at 180 days server-side, so we clamp `from` accordingly.
  const minFrom = isoDaysAgo(ABSA_MAX_DAYS);
  const defaultFrom = c.lastSyncAt
    ? new Date(c.lastSyncAt).toISOString().slice(0, 10)
    : isoDaysAgo(30);
  const range = el('div', { cls: 'range' });
  range.appendChild(el('label', { text: 'From' }));
  const fromInput = el('input');
  fromInput.type = 'date'; fromInput.value = defaultFrom; fromInput.min = minFrom; fromInput.max = todayIso();
  fromInput.dataset.id = c.connectionId; fromInput.dataset.field = 'from';
  range.appendChild(fromInput);
  range.appendChild(el('label', { text: 'to' }));
  const toInput = el('input');
  toInput.type = 'date'; toInput.value = todayIso(); toInput.min = minFrom; toInput.max = todayIso();
  toInput.dataset.id = c.connectionId; toInput.dataset.field = 'to';
  range.appendChild(toInput);
  div.appendChild(range);

  const presets = el('div', { cls: 'range' });
  for (const days of [7, 30, 90, 180]) {
    const b = el('button', { cls: 'preset', text: days + 'd', data: { act: 'preset', id: c.connectionId, days: String(days) } });
    presets.appendChild(b);
  }
  div.appendChild(presets);

  const buttons = el('div', { cls: 'row' });
  buttons.appendChild(el('button', { text: 'Sync now', data: { act: 'sync', id: c.connectionId } }));
  const unpair = el('button', { text: 'Unpair', cls: 'secondary', data: { act: 'unpair', id: c.connectionId } });
  buttons.appendChild(unpair);
  div.appendChild(buttons);
  return div;
}

function getRange(connectionId) {
  const from = document.querySelector(`input[data-id="${connectionId}"][data-field="from"]`);
  const to = document.querySelector(`input[data-id="${connectionId}"][data-field="to"]`);
  return { fromDate: from?.value || isoDaysAgo(30), toDate: to?.value || todayIso() };
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

  if (act === 'preset') {
    const days = Number(btn.dataset.days);
    const fromInput = document.querySelector(`input[data-id="${id}"][data-field="from"]`);
    const toInput = document.querySelector(`input[data-id="${id}"][data-field="to"]`);
    if (fromInput) fromInput.value = isoDaysAgo(days);
    if (toInput) toInput.value = todayIso();
    return;
  }

  btn.disabled = true;
  setStatus('Working…');
  try {
    if (act === 'sync') {
      const { fromDate, toDate } = getRange(id);
      const out = await bg('sync', { connectionId: id, opts: { fromDate, toDate } });
      setStatus(`Synced ${fromDate}→${toDate} — found ${out.found}, imported ${out.imported}, duplicate ${out.duplicate}`, 'ok');
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
