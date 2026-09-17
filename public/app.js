// Dashboard front-end. Talks only to the local server's /api routes.

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const LIVE_REFRESH_MS = 30_000;
const DAY_MS = 86_400_000;

const state = {
  status: null,
  liveTimer: null,
  snapshotMode: false, // true when served as a static site, see loadSnapshot()
  snapshot: null,
  snapshotError: null,
  locationLabels: new Map(), // evse uid / evse_id -> friendly label
  records: {
    preset: '30d',
    customFrom: null,
    customTo: null,
    sort: { key: 'start', dir: 'desc' },
    data: null,
  },
};

// ---------------------------------------------------------------- formatting
const numberFormats = new Map();
function nf(digits) {
  if (!numberFormats.has(digits)) {
    numberFormats.set(digits, new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }));
  }
  return numberFormats.get(digits);
}
function fmtNum(value, digits = 1) {
  return value === null || value === undefined || Number.isNaN(value) ? '–' : nf(digits).format(value);
}
function fmtMoney(value, currency) {
  if (value === null || value === undefined) return '–';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'SEK', maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${fmtNum(value, 2)} ${currency || ''}`.trim();
  }
}
function fmtDateTime(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtTime(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(date) {
  return new Date(date).toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
}
function fmtShortDate(date) {
  return new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmtDuration(hours) {
  if (hours === null || hours === undefined) return '–';
  const minutes = Math.round(hours * 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
}
function fmtRelative(iso) {
  if (!iso) return '–';
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function dayKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const STATUS_LABEL = {
  charging: 'Charging',
  available: 'Available',
  occupied: 'Occupied',
  unavailable: 'Out of service',
  unknown: 'Unknown',
};
const STATUS_ICON = { charging: '⚡', available: '○', occupied: '◐', unavailable: '✕', unknown: '?' };
function pill(bucket, rawStatus) {
  const label = STATUS_LABEL[bucket] || bucket;
  const title = rawStatus && rawStatus !== label.toUpperCase() ? ` title="OCPI status: ${esc(rawStatus)}"` : '';
  return `<span class="pill" data-bucket="${esc(bucket)}"${title}><span aria-hidden="true">${STATUS_ICON[bucket] || ''}</span>${esc(label)}</span>`;
}

// ------------------------------------------------------------------- network
async function api(path) {
  if (state.snapshotMode) return snapshotApi(path);
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error?.message || `HTTP ${res.status}`);
    err.details = body?.error || {};
    throw err;
  }
  return body;
}

function errorHtml(err) {
  const code = err.details?.code;
  const hint = code === 'UNAUTHORIZED'
    ? (state.snapshotMode
      ? 'ChargeNode accepted the OCPI key but refused the data modules when this snapshot was built. The <a href="#connection">Connection</a> tab explains what to ask ChargeNode.'
      : 'ChargeNode rejected the OCPI token. Open the <a href="#connection">Connection</a> tab for the exact responses and what to ask ChargeNode.')
    : code === 'MODULE_MISSING'
      ? 'This OCPI server does not offer the module needed for this view.'
      : code === 'SNAPSHOT_MISSING'
        ? 'This page is a static snapshot and its data file could not be loaded. Check the latest run of the publishing workflow.'
        : 'Check that the local server is running and see the <a href="#connection">Connection</a> tab.';
  return `<div class="notice error"><h3>Could not load data</h3><div>${esc(err.message)}</div><div class="subtle" style="margin-top:6px">${hint}</div></div>`;
}

// ------------------------------------------------------------------ snapshot
// Published as a static site (GitHub Pages) there is no local server. The
// build step adds <meta name="dashboard-snapshot"> to index.html, pointing at a
// JSON file holding everything the /api routes would have answered, and the
// same views render from that file instead.
async function loadSnapshot(url) {
  state.snapshotMode = true;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} loading ${url}`);
    state.snapshot = await res.json();
  } catch (err) {
    state.snapshotError = err;
  }
  $('.footer span').textContent = 'Data via OCPI from ChargeNode. Static snapshot published by GitHub Actions; the OCPI key stays in a repository secret and never reaches the browser.';
}

function snapshotApi(path) {
  const snapshot = state.snapshot;
  if (!snapshot) {
    const err = new Error(state.snapshotError?.message || 'Snapshot not loaded');
    err.details = { code: 'SNAPSHOT_MISSING' };
    throw err;
  }
  const [route, queryString] = path.split('?');
  const query = new URLSearchParams(queryString || '');
  if (route === '/api/status') return { ...snapshot.status, connected: true, lastError: snapshot.status.data_error || null };
  if (snapshot.status.data_error) {
    // Built while ChargeNode refused the data modules: every data view shows why.
    const err = new Error(snapshot.status.data_error.message || 'ChargeNode refused the data modules');
    err.details = snapshot.status.data_error;
    throw err;
  }
  switch (route) {
    case '/api/locations': return { items: snapshot.locations };
    case '/api/live': return snapshot.live;
    case '/api/cdrs': return { ...snapshot.cdrs, date_from: query.get('date_from') || snapshot.cdrs.date_from, date_to: query.get('date_to') || null };
    default: {
      const err = new Error(`No snapshot data for ${route}`);
      err.details = { code: 'NOT_FOUND' };
      throw err;
    }
  }
}

// "Now" for date ranges: the snapshot time when viewing a snapshot, so "Today"
// and "7 days" mean the days the data actually covers.
function referenceTime() {
  return state.snapshot ? new Date(state.snapshot.status.generated_at) : new Date();
}

// -------------------------------------------------------------------- router
const views = { live: renderLive, records: renderRecords, chargers: renderChargers, connection: renderConnection };

function currentTab() {
  const hash = location.hash.replace('#', '');
  return views[hash] ? hash : 'live';
}

function route() {
  const tab = currentTab();
  clearTimeout(state.liveTimer);
  for (const link of $$('.tabs a')) link.classList.toggle('active', link.dataset.tab === tab);
  for (const view of $$('.view')) view.hidden = view.id !== `view-${tab}`;
  views[tab]();
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------- connection indicator
function paintIndicator() {
  const dot = $('#conn-indicator .conn-dot');
  const text = $('#conn-indicator .conn-text');
  const s = state.status;
  if (!s) {
    dot.dataset.state = 'unknown';
    text.textContent = 'Checking...';
  } else if (s.mode === 'demo') {
    dot.dataset.state = 'demo';
    text.textContent = 'Demo data';
  } else if (s.mode === 'snapshot') {
    dot.dataset.state = s.data_error ? 'error' : 'snapshot';
    text.textContent = s.data_error ? 'Snapshot · data refused' : `Snapshot · ${fmtRelative(s.generated_at)}`;
  } else if (state.snapshotMode) {
    dot.dataset.state = 'error';
    text.textContent = 'Snapshot unavailable';
  } else if (s.connected) {
    dot.dataset.state = 'ok';
    text.textContent = `Connected · OCPI ${s.discovery?.version || ''}`;
  } else {
    dot.dataset.state = 'error';
    text.textContent = 'Not connected';
  }
}

async function refreshStatus(retry = false) {
  try {
    state.status = await api(`/api/status${retry ? '?retry=1' : ''}`);
  } catch (err) {
    state.status = { mode: 'unknown', connected: false, lastError: { message: err.message } };
  }
  paintIndicator();
  return state.status;
}

async function loadLocationLabels() {
  try {
    const { items } = await api('/api/locations');
    state.locationLabels.clear();
    for (const location of items) {
      for (const evse of location.evses) {
        const label = evse.physical_reference || evse.evse_id || evse.uid;
        state.locationLabels.set(evse.uid, label);
        if (evse.evse_id) state.locationLabels.set(evse.evse_id, label);
      }
    }
    if (items.length) $('#brand-sub').textContent = items.map((l) => l.name).join(', ');
  } catch {
    // Labels are cosmetic; the views fall back to raw ids.
  }
}
function evseLabel(uid, evseId) {
  return state.locationLabels.get(uid) || state.locationLabels.get(evseId) || evseId || uid || '–';
}

// ----------------------------------------------------------------------- live
async function renderLive() {
  const root = $('#view-live');
  if (!root.dataset.rendered) root.innerHTML = '<div class="loading">Loading live status...</div>';
  try {
    const live = await api('/api/live');
    root.innerHTML = liveHtml(live);
    root.dataset.rendered = '1';
  } catch (err) {
    root.innerHTML = errorHtml(err);
    root.dataset.rendered = '';
  }
  if (currentTab() === 'live' && !state.snapshotMode) state.liveTimer = setTimeout(renderLive, LIVE_REFRESH_MS);
}

function liveHtml(live) {
  const s = live.summary;
  const powerNote = s.evses_charging === 0
    ? 'Nothing is charging right now.'
    : s.power_estimated_count === 0
      ? `Reported by the chargers (${s.power_measured_count} measured, ${s.power_derived_count} derived from energy).`
      : `${s.power_estimated_count} of ${s.evses_charging} charging points do not report power; their maximum is used as an estimate.`;

  const tiles = [
    { label: 'Charging now', value: `${s.evses_charging}<small>of ${s.evses_total}</small>`, hint: `${s.evses_available} available · ${s.evses_occupied} occupied · ${s.evses_unavailable} out of service` },
    { label: 'Energy in ongoing sessions', value: `${fmtNum(s.energy_in_progress_kwh, 1)}<small>kWh</small>`, hint: `${s.active_sessions} active session${s.active_sessions === 1 ? '' : 's'}` },
    { label: 'Energy delivered today', value: `${s.today_kwh === null ? '–' : fmtNum(s.today_kwh, 1)}<small>kWh</small>`, hint: 'Completed sessions since midnight' },
    { label: 'Installed capacity', value: `${fmtNum(s.capacity_kw, 0)}<small>kW</small>`, hint: `${s.evses_total} charging points` },
  ];

  const cards = live.evses.map((evse) => {
    const session = evse.session;
    const name = evse.physical_reference || evse.evse_id || evse.uid;
    const connector = evse.connectors[0];
    const powerLine = evse.bucket === 'charging'
      ? `<div class="evse-power">${fmtNum(evse.live_power_kw, 1)}<small>kW ${evse.live_power_source === 'estimated' ? '(est.)' : ''}</small></div>`
      : `<div class="evse-power" style="color:var(--muted)">0<small>kW</small></div>`;
    const sessionRows = session
      ? `<dt>Started</dt><dd>${fmtTime(session.start)} (${fmtRelative(session.start)})</dd>
         <dt>Energy</dt><dd>${fmtNum(session.kwh, 1)} kWh</dd>
         ${session.cost_incl_vat !== null ? `<dt>Cost so far</dt><dd>${fmtMoney(session.cost_incl_vat, session.currency)}</dd>` : ''}
         <dt>Auth</dt><dd>${esc(session.auth_method || '–')}</dd>`
      : '';
    return `
      <div class="card evse" data-bucket="${esc(evse.bucket)}">
        <div class="evse-top">
          <div><div class="evse-name">${esc(name)}</div><div class="evse-id">${esc(evse.evse_id || evse.uid)}</div></div>
          ${pill(evse.bucket, evse.status)}
        </div>
        ${powerLine}
        <dl class="evse-meta">
          <dt>Max</dt><dd>${fmtNum(evse.max_power_kw, 0)} kW ${connector ? esc(connectorLabel(connector)) : ''}</dd>
          ${sessionRows}
          <dt>Updated</dt><dd>${fmtRelative(evse.last_updated)}</dd>
        </dl>
      </div>`;
  }).join('');

  const orphans = live.orphan_sessions.length
    ? `<div class="notice warn">${live.orphan_sessions.length} active session(s) reference a charging point that is not in the locations list.</div>`
    : '';

  return `
    <div class="view-head">
      <h2>${state.snapshotMode ? 'At last snapshot' : 'Right now'}</h2>
      <span class="subtle">${state.snapshotMode
        ? `Snapshot from ${fmtDateTime(live.generated_at)} (${fmtRelative(live.generated_at)})`
        : `Updated ${fmtTime(live.generated_at)} · auto-refreshes every ${LIVE_REFRESH_MS / 1000} s`}</span>
      <span class="spacer"></span>
      ${state.snapshotMode ? '' : '<button id="live-refresh">Refresh now</button>'}
    </div>
    <div class="hero">
      <div class="card">
        <div class="tile"><span class="label">Power in use</span></div>
        <div class="hero-figure">${fmtNum(s.in_use_kw, 1)}<small>kW</small></div>
        <div class="hero-sub">of ${fmtNum(s.capacity_kw, 0)} kW installed capacity (${s.utilisation_pct}%)</div>
        <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="${s.capacity_kw}" aria-valuenow="${s.in_use_kw}"><span style="width:${Math.min(100, s.utilisation_pct)}%"></span></div>
        <div class="meter-legend"><span>0 kW</span><span>${fmtNum(s.capacity_kw, 0)} kW</span></div>
        <div class="subtle" style="margin-top:10px">${esc(powerNote)}</div>
      </div>
      <div class="grid grid-tiles">
        ${tiles.map((t) => `<div class="card tile"><span class="label">${esc(t.label)}</span><span class="value">${t.value}</span><span class="hint">${esc(t.hint)}</span></div>`).join('')}
      </div>
    </div>
    ${orphans}
    <div>
      <div class="card-head"><h3>Charging points</h3><span class="subtle">${live.locations.map((l) => esc(l.name)).join(', ')}</span></div>
      <div class="grid grid-evses">${cards || '<div class="empty">No charging points reported.</div>'}</div>
    </div>`;
}

function connectorLabel(connector) {
  const standard = (connector.standard || '').replace('IEC_62196_T2', 'Type 2').replace('IEC_62196_T2_COMBO', 'CCS').replace('CHADEMO', 'CHAdeMO');
  const type = (connector.power_type || '').replace('AC_3_PHASE', '3-phase AC').replace('AC_1_PHASE', '1-phase AC');
  return [standard, type].filter(Boolean).join(' · ');
}

document.addEventListener('click', (event) => {
  if (event.target.id === 'live-refresh') {
    clearTimeout(state.liveTimer);
    renderLive();
  }
});

// -------------------------------------------------------------------- records
const PRESETS = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: 'mtd', label: 'This month' },
  { key: 'ytd', label: 'This year' },
  { key: 'custom', label: 'Custom' },
];

function presetRange(preset) {
  const now = referenceTime();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const to = new Date(startOfToday.getTime() + DAY_MS);
  switch (preset) {
    case 'today': return { from: startOfToday, to };
    case '7d': return { from: new Date(startOfToday.getTime() - 6 * DAY_MS), to };
    case '90d': return { from: new Date(startOfToday.getTime() - 89 * DAY_MS), to };
    case 'mtd': return { from: new Date(now.getFullYear(), now.getMonth(), 1), to };
    case 'ytd': return { from: new Date(now.getFullYear(), 0, 1), to };
    case 'custom': {
      const from = state.records.customFrom ? new Date(`${state.records.customFrom}T00:00:00`) : new Date(startOfToday.getTime() - 29 * DAY_MS);
      const end = state.records.customTo ? new Date(`${state.records.customTo}T00:00:00`) : startOfToday;
      return { from, to: new Date(end.getTime() + DAY_MS) };
    }
    default: return { from: new Date(startOfToday.getTime() - 29 * DAY_MS), to };
  }
}

async function renderRecords() {
  const root = $('#view-records');
  const r = state.records;
  const range = presetRange(r.preset);
  const fromInput = r.customFrom || dayKey(range.from);
  const toInput = r.customTo || dayKey(range.to.getTime() - DAY_MS);
  root.innerHTML = `
    <div class="view-head">
      <h2>Charging records</h2>
      <span class="subtle">Charge detail records (CDRs) from ChargeNode${state.snapshot ? ` · snapshot from ${fmtDateTime(state.snapshot.status.generated_at)}; ranges count back from that day` : ''}</span>
      <span class="spacer"></span>
      <button id="records-export" disabled>Export CSV</button>
    </div>
    <div class="filters" id="records-filters">
      ${PRESETS.map((p) => `<button class="chip ${p.key === r.preset ? 'active' : ''}" data-preset="${p.key}">${p.label}</button>`).join('')}
      <span class="custom" ${r.preset === 'custom' ? '' : 'hidden'}>
        <input type="date" id="records-from" value="${fromInput}"> <span class="subtle">to</span>
        <input type="date" id="records-to" value="${toInput}">
        <button id="records-apply" class="primary">Apply</button>
      </span>
    </div>
    <div id="records-body"><div class="loading">Loading records...</div></div>`;

  $('#records-filters').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-preset]');
    if (chip) {
      r.preset = chip.dataset.preset;
      renderRecords();
    }
    if (event.target.id === 'records-apply') {
      r.customFrom = $('#records-from').value;
      r.customTo = $('#records-to').value;
      r.preset = 'custom';
      renderRecords();
    }
  });

  const body = $('#records-body');
  try {
    const query = `date_from=${encodeURIComponent(range.from.toISOString())}&date_to=${encodeURIComponent(range.to.toISOString())}`;
    const [data] = await Promise.all([api(`/api/cdrs?${query}`), state.locationLabels.size ? null : loadLocationLabels()]);
    r.data = data;
    // The API filters on last_updated; keep records whose start falls in the chosen range.
    const items = data.items.filter((c) => {
      const t = Date.parse(c.start || c.end || 0);
      return t >= range.from.getTime() && t < range.to.getTime();
    });
    body.innerHTML = recordsHtml(items, range);
    drawEnergyChart($('#records-chart'), items, range);
    bindRecordsTable(items);
    const exportButton = $('#records-export');
    exportButton.disabled = items.length === 0;
    exportButton.onclick = () => exportCsv(items, range);
  } catch (err) {
    body.innerHTML = errorHtml(err);
  }
}

function recordsHtml(items, range) {
  const totalKwh = items.reduce((sum, c) => sum + (c.energy_kwh || 0), 0);
  const totalCost = items.reduce((sum, c) => sum + (c.cost_incl_vat ?? c.cost_excl_vat ?? 0), 0);
  const hasCost = items.some((c) => c.cost_incl_vat !== null || c.cost_excl_vat !== null);
  const currency = items.find((c) => c.currency)?.currency || 'SEK';
  const totalHours = items.reduce((sum, c) => sum + (c.duration_h || 0), 0);
  const days = Math.max(1, Math.round((range.to - range.from) / DAY_MS));

  const byEvse = new Map();
  for (const c of items) {
    const key = evseLabel(c.evse_uid, c.evse_id);
    const row = byEvse.get(key) || { label: key, sessions: 0, kwh: 0, cost: 0 };
    row.sessions += 1;
    row.kwh += c.energy_kwh || 0;
    row.cost += c.cost_incl_vat ?? c.cost_excl_vat ?? 0;
    byEvse.set(key, row);
  }
  const evseRows = Array.from(byEvse.values()).sort((a, b) => b.kwh - a.kwh);

  const tiles = [
    { label: 'Sessions', value: fmtNum(items.length, 0), hint: `${fmtNum(items.length / days, 1)} per day` },
    { label: 'Energy delivered', value: `${fmtNum(totalKwh, 1)}<small>kWh</small>`, hint: `${fmtNum(items.length ? totalKwh / items.length : 0, 1)} kWh per session` },
    { label: hasCost ? 'Charged amount (incl. VAT)' : 'Charged amount', value: hasCost ? fmtMoney(totalCost, currency) : '–', hint: hasCost ? `${fmtMoney(totalKwh ? totalCost / totalKwh : 0, currency)} per kWh` : 'No cost data in these records' },
    { label: 'Time plugged in', value: fmtDuration(totalHours), hint: `${fmtDuration(items.length ? totalHours / items.length : 0)} per session` },
  ];

  return `
    <div class="grid grid-tiles">
      ${tiles.map((t) => `<div class="card tile"><span class="label">${esc(t.label)}</span><span class="value">${t.value}</span><span class="hint">${esc(t.hint)}</span></div>`).join('')}
    </div>
    <div class="card">
      <div class="card-head"><h3>Energy per ${days > 120 ? 'week' : 'day'} (kWh)</h3><span class="subtle">${fmtDate(range.from)} – ${fmtDate(range.to.getTime() - DAY_MS)}</span></div>
      <div class="chart" id="records-chart"></div>
    </div>
    <div class="grid" style="grid-template-columns: minmax(280px, 1fr) minmax(0, 2.2fr)">
      <div class="card">
        <div class="card-head"><h3>Per charging point</h3></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Charger</th><th class="num">Sessions</th><th class="num">kWh</th><th class="num">Share</th></tr></thead>
          <tbody>${evseRows.map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${fmtNum(r.sessions, 0)}</td><td class="num">${fmtNum(r.kwh, 1)}</td><td class="num">${totalKwh ? Math.round((r.kwh / totalKwh) * 100) : 0}%</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No records</td></tr>'}</tbody>
        </table></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>All records</h3><span class="subtle">${fmtNum(items.length, 0)} records</span></div>
        <div class="table-wrap" id="records-table"></div>
      </div>
    </div>`;
}

const RECORD_COLUMNS = [
  { key: 'start', label: 'Start', render: (c) => fmtDateTime(c.start) },
  { key: 'end', label: 'End', render: (c) => fmtTime(c.end) },
  { key: 'duration_h', label: 'Duration', num: true, render: (c) => fmtDuration(c.duration_h) },
  { key: 'evse', label: 'Charger', render: (c) => esc(evseLabel(c.evse_uid, c.evse_id)), value: (c) => evseLabel(c.evse_uid, c.evse_id) },
  { key: 'energy_kwh', label: 'kWh', num: true, render: (c) => fmtNum(c.energy_kwh, 2) },
  { key: 'cost_incl_vat', label: 'Cost incl. VAT', num: true, render: (c) => fmtMoney(c.cost_incl_vat ?? c.cost_excl_vat, c.currency), value: (c) => c.cost_incl_vat ?? c.cost_excl_vat ?? 0 },
  { key: 'auth_method', label: 'Auth', render: (c) => esc(c.auth_method || '–') },
  { key: 'token_uid', label: 'Token', render: (c) => `<span class="mono">${esc(c.token_uid || '–')}</span>` },
];

function bindRecordsTable(items) {
  const container = $('#records-table');
  if (!container) return;
  // Published snapshots carry no token ids; drop the column rather than show dashes.
  const columns = items.some((c) => c.token_uid) ? RECORD_COLUMNS : RECORD_COLUMNS.filter((c) => c.key !== 'token_uid');
  const draw = () => {
    const { key, dir } = state.records.sort;
    const column = columns.find((c) => c.key === key) || columns[0];
    const valueOf = column.value || ((c) => c[key]);
    const sorted = [...items].sort((a, b) => {
      const va = valueOf(a);
      const vb = valueOf(b);
      let cmp;
      if (typeof va === 'number' || typeof vb === 'number') cmp = (va ?? -Infinity) - (vb ?? -Infinity);
      else if (key === 'start' || key === 'end') cmp = Date.parse(va || 0) - Date.parse(vb || 0);
      else cmp = String(va ?? '').localeCompare(String(vb ?? ''));
      return dir === 'asc' ? cmp : -cmp;
    });
    container.innerHTML = `<table>
      <thead><tr>${columns.map((c) => `<th class="sortable ${c.num ? 'num' : ''}" data-key="${c.key}">${c.label}<span class="sort-mark">${c.key === key ? (dir === 'asc' ? '▲' : '▼') : ''}</span></th>`).join('')}</tr></thead>
      <tbody>${sorted.map((c) => `<tr>${columns.map((col) => `<td class="${col.num ? 'num' : ''}">${col.render(c)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${columns.length}" class="empty">No charging records in this period</td></tr>`}</tbody>
    </table>`;
  };
  container.addEventListener('click', (event) => {
    const th = event.target.closest('th[data-key]');
    if (!th) return;
    const sort = state.records.sort;
    if (sort.key === th.dataset.key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
    else state.records.sort = { key: th.dataset.key, dir: th.dataset.key === 'start' || th.dataset.key === 'end' ? 'desc' : 'asc' };
    draw();
  });
  draw();
}

function exportCsv(items, range) {
  const columns = ['id', 'start', 'end', 'duration_h', 'charger', 'evse_id', 'evse_uid', 'connector_id', 'energy_kwh', 'cost_excl_vat', 'cost_incl_vat', 'currency', 'auth_method', 'token_uid', 'contract_id', 'session_id'];
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = items.map((c) => columns.map((k) => cell(k === 'charger' ? evseLabel(c.evse_uid, c.evse_id) : c[k])).join(';'));
  const csv = `﻿${columns.join(';')}\n${rows.join('\n')}`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `charging-records_${dayKey(range.from)}_${dayKey(range.to.getTime() - DAY_MS)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------------- chart
// Smallest "round" step >= value, so axis ticks land on clean numbers.
function niceStep(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => s >= normalized) || 10;
  return step * magnitude;
}

function drawEnergyChart(container, items, range) {
  if (!container) return;
  const days = Math.round((range.to - range.from) / DAY_MS);
  const weekly = days > 120;
  const buckets = new Map();
  const bucketStart = (date) => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    if (weekly) d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
    return d.getTime();
  };
  for (let t = bucketStart(range.from); t < range.to.getTime(); t += weekly ? 7 * DAY_MS : DAY_MS) {
    buckets.set(t, { start: t, kwh: 0, sessions: 0 });
  }
  for (const c of items) {
    const b = buckets.get(bucketStart(c.start || c.end));
    if (!b) continue;
    b.kwh += c.energy_kwh || 0;
    b.sessions += 1;
  }
  const points = Array.from(buckets.values());

  const W = 960;
  const H = 240;
  const padL = 46;
  const padR = 10;
  const padT = 14;
  const padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const tickCount = 4;
  const tickStep = niceStep((Math.max(0, ...points.map((p) => p.kwh)) || 1) / tickCount);
  const maxValue = tickStep * tickCount;
  const slot = innerW / Math.max(1, points.length);
  const barW = Math.min(24, Math.max(2, slot - 2));
  const y = (v) => padT + innerH - (v / maxValue) * innerH;
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => tickStep * i);
  const labelEvery = Math.max(1, Math.ceil(points.length / 12));
  const maxPoint = points.reduce((best, p) => (p.kwh > (best?.kwh ?? -1) ? p : best), null);

  const bars = points.map((p, i) => {
    const x = padL + i * slot + (slot - barW) / 2;
    const top = y(p.kwh);
    const h = padT + innerH - top;
    const r = Math.min(4, barW / 2, h);
    const path = h <= 0
      ? ''
      : `M${x},${padT + innerH} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${padT + innerH} Z`;
    const label = p === maxPoint && p.kwh > 0 && points.length <= 62
      ? `<text class="bar-label" x="${x + barW / 2}" y="${top - 5}" text-anchor="middle">${fmtNum(p.kwh, 0)}</text>`
      : '';
    const xLabel = i % labelEvery === 0
      ? `<text class="tick" x="${x + barW / 2}" y="${H - 8}" text-anchor="middle">${esc(fmtShortDate(p.start))}</text>`
      : '';
    return `<g data-index="${i}"><rect class="bar-hit" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${innerH}"></rect>${path ? `<path class="bar" d="${path}"></path>` : ''}${label}${xLabel}</g>`;
  }).join('');

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Energy per ${weekly ? 'week' : 'day'}">
    ${ticks.map((t) => `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"></line><text class="tick" x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${fmtNum(t, 0)}</text>`).join('')}
    <line class="axis-line" x1="${padL}" x2="${W - padR}" y1="${padT + innerH}" y2="${padT + innerH}"></line>
    ${bars}
  </svg>`;

  const tooltip = $('#tooltip');
  container.addEventListener('mousemove', (event) => {
    const g = event.target.closest('g[data-index]');
    if (!g) {
      tooltip.hidden = true;
      return;
    }
    const p = points[Number(g.dataset.index)];
    const endLabel = weekly ? ` – ${fmtDate(p.start + 6 * DAY_MS)}` : '';
    tooltip.innerHTML = `<strong>${esc(fmtDate(p.start))}${endLabel}</strong>${fmtNum(p.kwh, 1)} kWh · ${p.sessions} session${p.sessions === 1 ? '' : 's'}`;
    tooltip.hidden = false;
    tooltip.style.left = `${Math.min(event.clientX + 14, window.innerWidth - 240)}px`;
    tooltip.style.top = `${event.clientY + 14}px`;
  });
  container.addEventListener('mouseleave', () => {
    tooltip.hidden = true;
  });
}

// ------------------------------------------------------------------- chargers
async function renderChargers() {
  const root = $('#view-chargers');
  root.innerHTML = '<div class="loading">Loading chargers...</div>';
  try {
    const { items } = await api('/api/locations');
    if (!items.length) {
      root.innerHTML = '<div class="empty">The OCPI server returned no locations.</div>';
      return;
    }
    root.innerHTML = `<div class="view-head"><h2>Chargers</h2><span class="subtle">Locations, charging points (EVSEs) and connectors as published over OCPI</span></div>` + items.map((location) => `
      <div class="card">
        <div class="card-head">
          <h3>${esc(location.name)}</h3>
          <span class="subtle">${esc([location.address, location.postal_code, location.city].filter(Boolean).join(', '))}${location.operator ? ` · operator ${esc(location.operator)}` : ''}</span>
          <span class="spacer"></span>
          <span class="subtle mono">${esc(location.id)}</span>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Charger</th><th>EVSE ID</th><th>Status</th><th>Connector</th><th class="num">Max kW</th><th>Capabilities</th><th>Updated</th></tr></thead>
          <tbody>${location.evses.map((evse) => `<tr>
            <td>${esc(evse.physical_reference || '–')}</td>
            <td class="mono">${esc(evse.evse_id || evse.uid)}</td>
            <td>${pill(bucketOf(evse.status), evse.status)}</td>
            <td>${evse.connectors.map((c) => `${esc(connectorLabel(c))} <span class="subtle">(${esc(c.format || '')})</span>`).join('<br>') || '–'}</td>
            <td class="num">${fmtNum(evse.max_power_kw, 0)}</td>
            <td class="subtle">${esc((evse.capabilities || []).map((c) => c.toLowerCase().replace(/_/g, ' ')).join(', ') || '–')}</td>
            <td class="subtle">${fmtDateTime(evse.last_updated)}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>`).join('');
  } catch (err) {
    root.innerHTML = errorHtml(err);
  }
}

function bucketOf(status) {
  return { CHARGING: 'charging', AVAILABLE: 'available', BLOCKED: 'occupied', RESERVED: 'occupied', INOPERATIVE: 'unavailable', OUTOFORDER: 'unavailable', PLANNED: 'unavailable', REMOVED: 'unavailable' }[status] || 'unknown';
}

// ----------------------------------------------------------------- connection
async function renderConnection(retry = false) {
  const root = $('#view-connection');
  root.innerHTML = '<div class="loading">Checking connection...</div>';
  const s = await refreshStatus(retry);
  const d = s.discovery;
  const err = s.lastError;
  const attempts = (err?.attempts || d?.attempts || []);

  const generatorLabel = { 'github-actions': 'the scheduled GitHub Actions job', local: 'a local build' }[s.generator] || s.generator || 'an unknown builder';
  const verdict = s.mode === 'demo'
    ? '<div class="notice warn"><h3>Demo mode</h3>The server was started with <code>--demo</code> (or <code>OCPI_DEMO=1</code>). All numbers are generated, not from ChargeNode.</div>'
    : s.mode === 'snapshot' && s.generator === 'demo'
      ? `<div class="notice warn"><h3>Demo snapshot</h3>Generated ${fmtDateTime(s.generated_at)} with <code>npm run build:demo</code>. All numbers are invented, not from ChargeNode.</div>`
      : s.mode === 'snapshot' && s.data_error
        ? `<div class="notice error"><h3><span class="bad">Snapshot without data</span></h3>Built ${fmtDateTime(s.generated_at)} (${fmtRelative(s.generated_at)}) by ${esc(generatorLabel)}. ChargeNode accepted the OCPI key on the versions and credentials endpoints (OCPI ${esc(d.version)}) but answered HTTP ${esc(s.data_error.httpStatus || 401)} on <span class="mono">${esc(s.data_error.url || 'the data modules')}</span>. That is how an OCPI registration token ("token A") behaves before the credentials handshake: ask ChargeNode for a key with direct read access to the CPO modules, or to complete the registration.</div>`
        : s.mode === 'snapshot'
          ? `<div class="notice"><h3><span class="ok">Snapshot</span></h3>Generated ${fmtDateTime(s.generated_at)} (${fmtRelative(s.generated_at)}) by ${esc(generatorLabel)}. ChargeNode accepted the OCPI key; OCPI ${esc(d.version)}, modules: ${Object.keys(d.endpoints).map(esc).join(', ')}.</div>`
          : s.connected
            ? `<div class="notice"><h3><span class="ok">Connected</span></h3>ChargeNode accepted the token. OCPI ${esc(d.version)}, modules: ${Object.keys(d.endpoints).map(esc).join(', ')}.</div>`
            : `<div class="notice error"><h3><span class="bad">Not connected</span></h3>${esc(err?.message || 'Unknown error')}</div>`;

  const help = err?.code === 'UNAUTHORIZED' && !state.snapshotMode ? `
    <div class="card">
      <div class="card-head"><h3>What HTTP 401 means here</h3></div>
      <p>The versions endpoint is the first call in every OCPI integration and it is protected by the token ChargeNode issued. A 401 with an empty body means the server does not recognise the token, in any encoding. Things to ask ChargeNode:</p>
      <ol>
        <li>Is the token activated and linked to the right party and role (reading CPO data)?</li>
        <li>Is the token restricted to a whitelisted IP address? If so, give them the public IP of this network.</li>
        <li>Is it a one-time registration token (CREDENTIALS_TOKEN_A) that must be exchanged via <code>POST /credentials</code>? That handshake needs a public OCPI endpoint on our side, which this local app does not have, so ask for a permanent token instead.</li>
        <li>Has the token already been consumed by an earlier registration?</li>
      </ol>
    </div>` : '';

  root.innerHTML = `
    <div class="view-head">
      <h2>Connection</h2>
      <span class="spacer"></span>
      ${state.snapshotMode ? '' : '<button id="conn-retry" class="primary">Retry connection</button>'}
    </div>
    ${verdict}
    <div class="card">
      <div class="card-head"><h3>Configuration</h3></div>
      <dl class="kv">
        <dt>Mode</dt><dd>${esc(s.mode)}</dd>
        <dt>Versions URL</dt><dd class="mono">${esc(s.versionsUrl || '–')}</dd>
        <dt>Token</dt><dd class="mono">${esc(s.tokenPreview || (s.mode === 'snapshot' ? 'kept as a GitHub Actions secret; never sent to the browser' : '–'))}</dd>
        <dt>Token encoding</dt><dd>${esc(s.tokenEncoding || d?.encoding || '–')}${s.tokenEncoding && d?.encoding ? ` (using: ${esc(d.encoding)})` : ''}</dd>
        <dt>OCPI version</dt><dd>${d ? `${esc(d.version)} (offered: ${(d.availableVersions || []).map(esc).join(', ')})` : '–'}</dd>
        <dt>Discovered</dt><dd>${d?.discoveredAt ? fmtDateTime(d.discoveredAt) : '–'}</dd>
        ${s.mode === 'snapshot'
          ? `<dt>Records window</dt><dd>${s.data_error ? 'no data in this snapshot' : `${fmtDate(s.cdr_window.from)} – ${fmtDate(s.generated_at)} (${s.cdr_window.days} days, ${fmtNum(s.counts?.cdrs, 0)} records)`}</dd>`
          : `<dt>Local server</dt><dd>Node ${esc(s.server?.node || '')} on port ${esc(s.server?.port || '')}, started ${s.server?.startedAt ? fmtDateTime(s.server.startedAt) : '–'}</dd>`}
      </dl>
    </div>
    ${d?.endpoints ? `<div class="card"><div class="card-head"><h3>Module endpoints</h3></div><div class="table-wrap"><table><thead><tr><th>Module</th><th>URL</th></tr></thead><tbody>${Object.entries(d.endpoints).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    ${attempts.length ? `<div class="card"><div class="card-head"><h3>Requests made</h3></div><div class="table-wrap"><table><thead><tr><th>Step</th><th>Token encoding</th><th>URL</th><th class="num">HTTP</th></tr></thead><tbody>${attempts.map((a) => `<tr><td>${esc(a.step)}</td><td>${esc(a.encoding)}</td><td class="mono">${esc(a.url)}</td><td class="num ${a.httpStatus < 400 ? 'ok' : 'bad'}">${esc(a.httpStatus)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    ${err ? `<div class="card"><div class="card-head"><h3>Last error</h3></div><pre>${esc(JSON.stringify(err, null, 2))}</pre></div>` : ''}
    ${help}`;

  $('#conn-retry')?.addEventListener('click', () => renderConnection(true));
}

// ----------------------------------------------------------------------- boot
async function boot() {
  const snapshotUrl = document.querySelector('meta[name="dashboard-snapshot"]')?.content;
  if (snapshotUrl) await loadSnapshot(snapshotUrl);
  refreshStatus().then(loadLocationLabels);
  route();
}
boot();
