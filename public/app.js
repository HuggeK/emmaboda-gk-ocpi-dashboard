// Dashboard front-end. Talks only to the local server's /api routes.
import {
  analyze,
  hourlyProfile,
  revenueByMonth,
  LIMIT_HISTORY,
  MAIN_FUSE_A,
  MAIN_FUSE_KW,
  DEFAULT_OPTIONS as ANALYSIS_DEFAULTS,
} from './analysis.js';
import { DEFAULT_TARIFF, meterHours, splitHours, dailyPeaks, monthlyMeter, summarize, seasonalPicture } from './meter.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const LIVE_REFRESH_MS = 30_000;
const DAY_MS = 86_400_000;
// The chargers went live in June 2024; "All" ranges start here.
const HISTORY_START = new Date(2024, 5, 1);

const state = {
  status: null,
  liveTimer: null,
  currentTab: null,
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
  analysis: {
    preset: '12m',
    options: { ...ANALYSIS_DEFAULTS },
    tableView: false,
  },
  meter: {
    preset: '30d',
    installation: 0,
    tariff: loadTariff(),
    tableView: false,
  },
  chargerCount: 0,
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
function fmtSigned(value, currency) {
  return `${value < 0 ? '−' : '+'}${fmtMoney(Math.abs(value), currency)}`;
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
  $('.footer span').textContent = 'Data via OCPI from ChargeNode and meter values from E.ON. Static snapshot published by GitHub Actions; the keys stay in repository secrets and never reach the browser.';
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
  // Meter values come from E.ON, so they are there even when ChargeNode refused its data.
  if (route === '/api/eon') return snapshot.eon || { configured: false, missing: true };
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
const views = { live: renderLive, records: renderRecords, analysis: renderAnalysis, meter: renderMeter, chargers: renderChargers, connection: renderConnection, guide: renderGuide };

function currentTab() {
  const hash = location.hash.replace('#', '');
  return views[hash] ? hash : 'live';
}

function route() {
  const tab = currentTab();
  clearTimeout(state.liveTimer);
  for (const link of $$('.tabs a')) link.classList.toggle('active', link.dataset.tab === tab);
  for (const view of $$('.view')) view.hidden = view.id !== `view-${tab}`;
  // A newly chosen tab starts at the top, even if the previous one was scrolled far down.
  if (state.currentTab && state.currentTab !== tab) window.scrollTo({ top: 0 });
  state.currentTab = tab;
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
    state.chargerCount = items.reduce((n, l) => n + l.evses.length, 0);
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
  { key: 'all', label: 'All' },
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
    case 'all': return { from: HISTORY_START, to };
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
    <div class="grid grid-records">
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

// ------------------------------------------------------------------- analysis
// Simultaneous charging, busy hours and the effektavgift the chargers alone
// would cause. The maths lives in analysis.js; this file only draws it.
const ANALYSIS_PRESETS = [
  { key: '90d', label: '90 days' },
  { key: 'ytd', label: 'This year' },
  { key: '12m', label: '12 months' },
  { key: 'all', label: 'All' },
];

function analysisRange(preset) {
  const now = referenceTime();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const to = new Date(startOfToday.getTime() + DAY_MS);
  switch (preset) {
    case '90d': return { from: new Date(startOfToday.getTime() - 89 * DAY_MS), to };
    case 'ytd': return { from: new Date(now.getFullYear(), 0, 1), to };
    case 'all': return { from: HISTORY_START, to };
    default: {
      const from = new Date(startOfToday);
      from.setFullYear(from.getFullYear() - 1);
      return { from, to };
    }
  }
}

function monthLabel(key, style = 'long') {
  const [year, month] = key.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, style === 'long' ? { month: 'short', year: 'numeric' } : { month: 'short', year: '2-digit' });
}

function weekdayLabels() {
  const monday = new Date(2024, 0, 1); // a Monday
  return Array.from({ length: 7 }, (_, i) => new Date(monday.getTime() + i * DAY_MS).toLocaleDateString(undefined, { weekday: 'short' }));
}

const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;

async function renderAnalysis() {
  const root = $('#view-analysis');
  const a = state.analysis;
  const o = a.options;
  const range = analysisRange(a.preset);
  root.innerHTML = `
    <div class="view-head">
      <h2>Analysis</h2>
      <span class="subtle">Simultaneous charging, busy hours and the effektavgift the chargers alone would cause</span>
    </div>
    <div class="filters" id="analysis-filters">
      ${ANALYSIS_PRESETS.map((p) => `<button class="chip ${p.key === a.preset ? 'active' : ''}" data-preset="${p.key}">${p.label}</button>`).join('')}
      <span class="custom">
        <label title="Power one car is assumed to draw while it is actually charging. 11 kW is a three-phase 16 A car, 7.4 kW single-phase, 22 kW three-phase 32 A. ChargeNode only reports energy totals, so this decides how long each session's energy took to deliver.">Car charges at <input type="number" id="analysis-rate" value="${o.rateKw}" min="1" max="22" step="0.1"> kW</label>
        ${limitControlsHtml('analysis', o)}
        <label title="What the grid company charges per kW of the month's billed peak.">Tariff <input type="number" id="analysis-kr" value="${o.krPerKw}" min="0" step="1"> kr/kW</label>
        ${peakCountSelectHtml('analysis-peaks', o.peakCount)}
        <label><input type="checkbox" id="analysis-even" ${o.model === 'even' ? 'checked' : ''}> Spread evenly (floor)</label>
        <button id="analysis-apply" class="primary">Apply</button>
      </span>
    </div>
    ${limitsLegendHtml(o)}
    <div id="analysis-body"><div class="loading">Analysing charge records...</div></div>`;

  bindLimitControls('analysis');
  $('#analysis-filters').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-preset]');
    if (chip) {
      a.preset = chip.dataset.preset;
      renderAnalysis();
    }
    if (event.target.id === 'analysis-apply') {
      const rate = Number($('#analysis-rate').value);
      a.options = {
        ...o,
        ...readLimitControls('analysis'),
        rateKw: rate > 0 ? rate : ANALYSIS_DEFAULTS.rateKw,
        krPerKw: Math.max(0, Number($('#analysis-kr').value) || 0),
        peakCount: Number($('#analysis-peaks').value) || 1,
        model: $('#analysis-even').checked ? 'even' : 'front',
      };
      shareLimits(a.options);
      renderAnalysis();
    }
  });

  const body = $('#analysis-body');
  try {
    const query = `date_from=${encodeURIComponent(range.from.toISOString())}&date_to=${encodeURIComponent(range.to.toISOString())}`;
    const [data] = await Promise.all([api(`/api/cdrs?${query}`), state.chargerCount ? null : loadLocationLabels()]);
    const chargers = state.chargerCount || ANALYSIS_DEFAULTS.chargers;
    const result = analyze(data.items, { from: range.from.getTime(), to: range.to.getTime() }, { ...o, chargers, now: referenceTime().getTime() });
    body.innerHTML = analysisHtml(result, range, o, chargers);
    drawHeatmap($('#analysis-heatmap'), result.matrix);
    drawMonthlyChart($('#analysis-months'), result.months, o);
    const card = $('#analysis-heatmap-card');
    const toggle = $('#analysis-heatmap-toggle');
    const paintToggle = () => {
      card.dataset.view = a.tableView ? 'table' : 'chart';
      toggle.textContent = a.tableView ? 'Show chart' : 'Show table';
    };
    toggle.addEventListener('click', () => {
      a.tableView = !a.tableView;
      paintToggle();
    });
    paintToggle();
  } catch (err) {
    body.innerHTML = errorHtml(err);
  }
}

function analysisHtml(result, range, options, chargers) {
  const { plugged, charging, peakHour, floorPeakHour, months, floorMonths, top } = result;
  const floorByMonth = new Map(floorMonths.map((m) => [m.month, m]));
  const fullMonths = months.filter((m) => !m.partial);
  const billing = fullMonths.at(-1) || months.at(-1) || null;
  const averageCost = fullMonths.length ? fullMonths.reduce((sum, m) => sum + m.cost, 0) / fullMonths.length : null;
  const when = (peak) => (peak.count ? `${fmtDateTime(peak.start)} – ${fmtTime(peak.end)}` : 'never in this range');
  const modelLabel = options.model === 'even'
    ? 'each session’s energy spread evenly over its plugged-in time (a floor)'
    : `each car charging at ${fmtNum(options.rateKw, 1)} kW from plug-in until its energy is delivered, then idle`;
  const capLabel = options.limits === 'none'
    ? ', with no limit on the total'
    : options.limits === 'seasonal'
      ? `, with the total capped at ${fmtNum(options.capKw, 1)} kW in summer and at most ${fmtNum(options.winterCapKw, 1)} kW (the whole facility’s ceiling) in winter`
      : ', with the total capped at the limit ChargeNode had set at the time (see “Limits” above)';

  const tiles = [
    { label: 'Most plugged in at once', value: `${plugged.peak.count}<small>of ${chargers}</small>`, hint: when(plugged.peak) },
    { label: 'Most charging at once (estimated)', value: `${charging.peak.count}<small>of ${chargers}</small>`, hint: when(charging.peak) },
    {
      label: 'Highest hourly average',
      value: peakHour ? `${fmtNum(peakHour.kw, 1)}<small>kW</small>` : '–',
      hint: peakHour ? `${fmtDateTime(peakHour.at)} · ${peakHour.sessions} car${peakHour.sessions === 1 ? '' : 's'} · floor ${fmtNum(floorPeakHour?.kw ?? 0, 1)} kW` : 'No charging in this range',
    },
    {
      label: 'Effektavgift, chargers alone',
      value: billing ? `${fmtMoney(billing.cost, 'SEK')}<small>per month</small>` : '–',
      hint: billing
        ? `${monthLabel(billing.month)}${billing.partial ? ' (partial month)' : ''}: ${fmtNum(billing.peakKw, 1)} kW × ${fmtNum(options.krPerKw, 0)} kr/kW · charging revenue ${fmtMoney(billing.monthRevenue, 'SEK')}, ${billing.covered ? 'covered' : 'not covered'} (${fmtSigned(billing.net, 'SEK')})${averageCost !== null ? ` · full months average ${fmtMoney(averageCost, 'SEK')}` : ''}`
        : 'No months in this range',
    },
  ];

  const pluggedTotal = plugged.hours.slice(1).reduce((sum, h) => sum + h, 0);
  const chargingTotal = charging.hours.slice(1).reduce((sum, h) => sum + h, 0);
  const concurrencyRows = Array.from({ length: chargers }, (_, i) => i + 1).map((n) => `<tr>
    <td>${n === chargers ? `All ${chargers}` : n} ${n === 1 ? 'charger' : 'chargers'}</td>
    <td class="num">${fmtNum(plugged.hours[n] || 0, 0)}</td>
    <td class="num">${fmtNum(charging.hours[n] || 0, 0)}</td>
    <td class="num">${chargingTotal ? Math.round(((charging.hours[n] || 0) / chargingTotal) * 100) : 0}%</td>
  </tr>`).join('');

  return `
    <div class="notice warn"><h3>Chargers only</h3>Everything on this tab comes from ChargeNode’s charge records, so it covers the ${chargers} chargers and nothing else. The effektavgift is billed on the whole facility’s highest hourly average, and the club’s other loads in the same hours are not included here. The <a href="#meter">Meter</a> tab has the measured hourly values for the whole facility from E.ON, and shows how much of each peak was the chargers. <a href="#guide">How this works</a>.</div>
    <div class="grid grid-tiles">
      ${tiles.map((t) => `<div class="card tile"><span class="label">${esc(t.label)}</span><span class="value">${t.value}</span><span class="hint">${esc(t.hint)}</span></div>`).join('')}
    </div>
    <div class="subtle">Model: ChargeNode reports one energy total per session, not a power curve. Figures assume ${modelLabel}${capLabel}. Hours are clock hours, as the tariff counts them. Plugged-in time comes straight from the records; “charging” is the estimate. Revenue is the charged amount incl. VAT from the records, before any ChargeNode fee; an hour’s share follows the energy delivered in it. ${result.records} sessions, ${fmtNum(pluggedTotal, 0)} h plugged in, ${fmtMoney(result.revenue, 'SEK')} charged in total.</div>
    <div class="card" id="analysis-heatmap-card" data-view="chart">
      <div class="card-head"><h3>Busy hours: average charger power by weekday and hour (kW)</h3><span class="subtle">${fmtDate(range.from)} – ${fmtDate(range.to.getTime() - DAY_MS)}</span><span class="spacer"></span><button id="analysis-heatmap-toggle">Show table</button></div>
      <div class="heatmap" id="analysis-heatmap"></div>
      <div class="table-wrap heatmap-table">${heatmapTable(result.matrix)}</div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Highest hourly average per month (kW)</h3><span class="subtle">lighter bars are partial months · dashes mark the limit in force · the table compares each peak with the charging revenue it earned</span></div>
      <div class="chart" id="analysis-months"></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Month</th><th>Limit in force</th><th class="num">${options.peakCount > 1 ? `Avg of ${options.peakCount} peak hours` : 'Peak hour'} kW</th><th>When</th><th class="num">Effektavgift at ${fmtNum(options.krPerKw, 0)} kr/kW</th><th class="num">Revenue that hour</th><th class="num">Revenue that month</th><th class="num">Covered?</th></tr></thead>
        <tbody>${months.map((m) => `<tr>
          <td>${esc(monthLabel(m.month))}${m.partial ? ' <span class="subtle">(partial)</span>' : ''}</td>
          <td>${limitCellHtml(m.limits)}</td>
          <td class="num">${fmtNum(m.peakKw, 1)} <span class="subtle">floor ${fmtNum(floorByMonth.get(m.month)?.peakKw ?? 0, 1)}</span></td>
          <td>${m.at !== null ? `${fmtDateTime(m.at)} · ${m.sessions} car${m.sessions === 1 ? '' : 's'}` : '–'}</td>
          <td class="num">${fmtMoney(m.cost, 'SEK')}</td>
          <td class="num">${fmtMoney(m.spikeRevenue, 'SEK')}</td>
          <td class="num">${fmtMoney(m.monthRevenue, 'SEK')}</td>
          <td class="num"><span class="${m.covered ? 'ok' : 'bad'}">${m.covered ? 'covered' : 'not covered'}</span> ${fmtSigned(m.net, 'SEK')}</td>
        </tr>`).join('') || '<tr><td colspan="8" class="empty">No charging in this range</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="grid grid-analysis">
      <div class="card">
        <div class="card-head"><h3>Simultaneous sessions</h3><span class="subtle">hours in the range</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>At the same time</th><th class="num">Plugged in, h</th><th class="num">Charging (est.), h</th><th class="num">Share</th></tr></thead>
          <tbody>${concurrencyRows}</tbody>
        </table></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Top hours</h3><span class="subtle">highest estimated charger power</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Hour</th><th class="num">kW</th><th class="num">Cars</th><th class="num">Revenue that hour</th><th class="num">Cost if it sets the month’s peak</th></tr></thead>
          <tbody>${top.map((h) => `<tr><td>${fmtDateTime(h.at)}</td><td class="num">${fmtNum(h.kw, 1)}</td><td class="num">${h.sessions}</td><td class="num">${fmtMoney(h.revenue, 'SEK')}</td><td class="num">${fmtMoney(h.kw * options.krPerKw, 'SEK')}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No charging in this range</td></tr>'}</tbody>
        </table></div>
      </div>
    </div>`;
}

function heatmapTable(matrix) {
  const weekdays = weekdayLabels();
  return `<table>
    <thead><tr><th></th>${Array.from({ length: 24 }, (_, h) => `<th class="num">${String(h).padStart(2, '0')}</th>`).join('')}</tr></thead>
    <tbody>${matrix.cells.map((row, wd) => `<tr><td>${esc(weekdays[wd])}</td>${row.map((v) => `<td class="num">${v > 0 ? fmtNum(v, 1) : '–'}</td>`).join('')}</tr>`).join('')}</tbody>
  </table>`;
}

function drawHeatmap(container, matrix) {
  if (!container) return;
  const W = 960;
  const padL = 44;
  const padR = 8;
  const padT = 18;
  const padB = 6;
  const cellW = (W - padL - padR) / 24;
  const cellH = 26;
  const H = padT + 7 * cellH + padB;
  const weekdays = weekdayLabels();
  const max = matrix.max || 0;
  const binOf = (v) => (v <= 0 || max <= 0 ? 0 : Math.min(5, Math.max(1, Math.ceil((v / max) * 5))));

  const cells = [];
  for (let wd = 0; wd < 7; wd += 1) {
    for (let h = 0; h < 24; h += 1) {
      const bin = binOf(matrix.cells[wd][h]);
      const x = padL + h * cellW;
      const y = padT + wd * cellH;
      cells.push(`<rect class="cell" data-wd="${wd}" data-h="${h}" x="${x + 1}" y="${y + 1}" width="${cellW - 2}" height="${cellH - 2}" rx="3" fill="${bin ? `var(--heat-${bin})` : 'var(--surface-2)'}"></rect>`);
    }
  }
  const hourTicks = [0, 3, 6, 9, 12, 15, 18, 21].map((h) => `<text class="tick" x="${padL + h * cellW + 2}" y="${padT - 6}">${String(h).padStart(2, '0')}</text>`).join('');
  const weekdayTicks = weekdays.map((name, wd) => `<text class="tick" x="${padL - 6}" y="${padT + wd * cellH + cellH / 2 + 4}" text-anchor="end">${esc(name)}</text>`).join('');
  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Average charger power by weekday and hour">${hourTicks}${weekdayTicks}${cells.join('')}</svg>
    <div class="ramp-legend"><span>0 kW</span>${[1, 2, 3, 4, 5].map((b) => `<i style="background:var(--heat-${b})"></i>`).join('')}<span>${fmtNum(max, 1)} kW</span><span class="spacer"></span><span>average over the days in the range</span></div>`;

  const tooltip = $('#tooltip');
  container.addEventListener('mousemove', (event) => {
    const cell = event.target.closest('rect.cell');
    if (!cell) {
      tooltip.hidden = true;
      return;
    }
    const wd = Number(cell.dataset.wd);
    const h = Number(cell.dataset.h);
    tooltip.innerHTML = `<strong>${fmtNum(matrix.cells[wd][h], 1)} kW</strong>${esc(weekdays[wd])} ${hourLabel(h)}–${hourLabel((h + 1) % 24)} · average over ${matrix.days[wd]} day${matrix.days[wd] === 1 ? '' : 's'}`;
    tooltip.hidden = false;
    tooltip.style.left = `${Math.min(event.clientX + 14, window.innerWidth - 240)}px`;
    tooltip.style.top = `${event.clientY + 14}px`;
  });
  container.addEventListener('mouseleave', () => {
    tooltip.hidden = true;
  });
}

function drawMonthlyChart(container, months, options) {
  if (!container) return;
  const points = months;
  const W = 960;
  const H = 240;
  const padL = 46;
  const padR = 10;
  const padT = 14;
  const padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const tickCount = 4;
  const tickStep = niceStep((Math.max(0, ...points.map((p) => Math.max(p.peakKw, p.capKw || 0))) || 1) / tickCount);
  const maxValue = tickStep * tickCount;
  const slot = innerW / Math.max(1, points.length);
  const barW = Math.min(24, Math.max(2, slot - 2));
  const y = (v) => padT + innerH - (v / maxValue) * innerH;
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => tickStep * i);
  const maxPoint = points.reduce((best, p) => (p.peakKw > (best?.peakKw ?? -1) ? p : best), null);

  const bars = points.map((p, i) => {
    const x = padL + i * slot + (slot - barW) / 2;
    const top = y(p.peakKw);
    const h = padT + innerH - top;
    const r = Math.min(4, barW / 2, h);
    const path = h <= 0
      ? ''
      : `M${x},${padT + innerH} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${padT + innerH} Z`;
    const label = p === maxPoint && p.peakKw > 0
      ? `<text class="bar-label" x="${x + barW / 2}" y="${top - 5}" text-anchor="middle">${fmtNum(p.peakKw, 1)}</text>`
      : '';
    // The limit in force that month: a dash across the slot, dotted for a whole-facility ceiling.
    const limitMark = p.capKw > 0
      ? `<line class="limit-mark${p.limit?.kind === 'facility' ? ' facility' : ''}" x1="${padL + i * slot + 1}" x2="${padL + (i + 1) * slot - 1}" y1="${y(p.capKw)}" y2="${y(p.capKw)}"></line>`
      : '';
    return `<g data-index="${i}"><rect class="bar-hit" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${innerH}"></rect>${path ? `<path class="bar${p.partial ? ' partial' : ''}" d="${path}"></path>` : ''}${limitMark}${label}<text class="tick" x="${x + barW / 2}" y="${H - 8}" text-anchor="middle">${esc(monthLabel(p.month, 'short'))}</text></g>`;
  }).join('');
  const capLine = '';

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Highest hourly average per month">
    ${ticks.map((t) => `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"></line><text class="tick" x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${fmtNum(t, 0)}</text>`).join('')}
    <line class="axis-line" x1="${padL}" x2="${W - padR}" y1="${padT + innerH}" y2="${padT + innerH}"></line>
    ${capLine}
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
    tooltip.innerHTML = `<strong>${fmtNum(p.peakKw, 1)} kW</strong>${esc(monthLabel(p.month))}${p.partial ? ' (partial)' : ''} · ${p.at !== null ? fmtDateTime(p.at) : '–'} · ${p.sessions} car${p.sessions === 1 ? '' : 's'} · effektavgift ${fmtMoney(p.cost, 'SEK')} · revenue ${fmtMoney(p.monthRevenue, 'SEK')} (${p.covered ? 'covered' : 'not covered'})${p.limit ? `<br>Limit: ${esc(p.limit.label)}` : ''}`;
    tooltip.hidden = false;
    tooltip.style.left = `${Math.min(event.clientX + 14, window.innerWidth - 240)}px`;
    tooltip.style.top = `${event.clientY + 14}px`;
  });
  container.addEventListener('mouseleave', () => {
    tooltip.hidden = true;
  });
}

// --------------------------------------------------------------------- limits
// The limits on the chargers and the facility, shared by the Analysis, Meter
// and guide tabs. 'actual' is what ChargeNode had configured at the time.
const TARIFF_KEY = 'emgk.tariff.v1';

function loadTariff() {
  try {
    const saved = JSON.parse(localStorage.getItem(TARIFF_KEY) || 'null');
    if (saved && typeof saved === 'object') return { ...DEFAULT_TARIFF, ...saved };
  } catch {
    // storage blocked or corrupt: defaults
  }
  return { ...DEFAULT_TARIFF };
}

function saveTariff(tariff) {
  try {
    localStorage.setItem(TARIFF_KEY, JSON.stringify(tariff));
  } catch {
    // not saved; it still applies until the page is reloaded
  }
}

// The effektavgift settings live in both places; keep them the same.
function shareLimits(options) {
  state.meter.tariff = { ...state.meter.tariff, krPerKw: options.krPerKw, peakCount: options.peakCount };
  saveTariff(state.meter.tariff);
}

function limitControlsHtml(prefix, o) {
  const seasonal = o.limits === 'seasonal';
  return `
    <label title="Which limit to apply to the chargers. Actual: what ChargeNode had configured at the time (see the list below). What-if: one limit for the chargers in summer and a ceiling for the whole facility in winter.">Limits
      <select id="${prefix}-limits">
        <option value="actual" ${o.limits === 'actual' ? 'selected' : ''}>Actual (ChargeNode)</option>
        <option value="seasonal" ${seasonal ? 'selected' : ''}>What-if: summer / winter</option>
        <option value="none" ${o.limits === 'none' ? 'selected' : ''}>None</option>
      </select></label>
    <label class="seasonal-only" ${seasonal ? '' : 'hidden'} title="What-if, summer: the chargers together may draw at most this.">Summer, chargers ≤ <input type="number" id="${prefix}-cap" value="${o.capKw}" min="0" step="0.5"> kW</label>
    <label class="seasonal-only" ${seasonal ? '' : 'hidden'} title="What-if, winter (Nov–Mar): the whole facility may draw at most this; the chargers get what the rest of the club leaves. 36 A is about 25 kW.">Winter, whole facility ≤ <input type="number" id="${prefix}-winter" value="${o.winterCapKw}" min="0" step="0.5"> kW</label>`;
}

function bindLimitControls(prefix) {
  const select = $(`#${prefix}-limits`);
  select?.addEventListener('change', () => {
    for (const el of $$(`#${prefix}-filters .seasonal-only`)) el.hidden = select.value !== 'seasonal';
  });
}

function readLimitControls(prefix) {
  return {
    limits: $(`#${prefix}-limits`).value,
    capKw: Math.max(0, Number($(`#${prefix}-cap`).value) || 0),
    winterCapKw: Math.max(0, Number($(`#${prefix}-winter`).value) || 0),
  };
}

function peakCountSelectHtml(id, value) {
  return `<label title="How the grid company sets the month's effekt: from the single highest hour, or the average of the 2, 3 or 5 highest hours on different days. Check the tariff on the E.ON Elnät invoice.">Billed on
    <select id="${id}">${[1, 2, 3, 5].map((n) => `<option value="${n}" ${Number(value) === n ? 'selected' : ''}>${n === 1 ? 'the highest hour' : `avg of ${n} highest hours`}</option>`).join('')}</select></label>`;
}

function limitDate(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// One line under the filters listing every limit the numbers depend on.
function limitsLegendHtml(o) {
  const fuse = `<span class="limit-chip fuse" title="The facility's main fuse; nothing can draw more than this.">Main fuse ${MAIN_FUSE_A} A ≈ ${fmtNum(MAIN_FUSE_KW, 1)} kW (whole facility)</span>`;
  const items = o.limits === 'none'
    ? ['<span class="limit-chip">No charger limit applied (what-if)</span>']
    : o.limits === 'seasonal'
      ? [
        `<span class="limit-chip chargers">Summer: chargers ≤ ${fmtNum(o.capKw, 1)} kW</span>`,
        `<span class="limit-chip facility">Winter (Nov–Mar): whole facility ≤ ${fmtNum(o.winterCapKw, 1)} kW, chargers get what is left</span>`,
      ]
      : LIMIT_HISTORY.map((l) => `<span class="limit-chip ${l.kind}" title="${esc(l.note)}">from ${esc(limitDate(l.from))}: ${esc(l.label)}</span>`);
  return `<div class="limits-legend"><span class="subtle">Limits:</span> ${items.join(' ')} ${fuse} <span class="limit-chip tariff">Effektavgift ${fmtNum(o.krPerKw, 0)} kr/kW</span> <a href="#guide">what do these mean?</a></div>`;
}

// The limits of a month: every setting in force during it, with the date a
// change took effect when there was one.
function limitCellHtml(limits) {
  const list = (Array.isArray(limits) ? limits : [limits]).filter(Boolean);
  if (!list.length) return '<span class="subtle">none</span>';
  return list.map((l, i) => `<span class="limit-chip ${l.kind}">${list.length > 1 && i > 0 && l.from ? `from ${esc(limitDate(l.from))}: ` : ''}${esc(l.label)}</span>`).join(' ');
}

// ---------------------------------------------------------------------- meter
// Measured values for the whole facility from E.ON, split into the chargers
// (estimated from the charge records) and everything else.
const METER_PRESETS = [
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: 'ytd', label: 'This year' },
  { key: '12m', label: '12 months' },
  { key: 'all', label: 'All' },
];

function meterRange(preset) {
  const now = referenceTime();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const to = new Date(startOfToday.getTime() + DAY_MS);
  switch (preset) {
    case '7d': return { from: new Date(startOfToday.getTime() - 6 * DAY_MS), to };
    case '30d': return { from: new Date(startOfToday.getTime() - 29 * DAY_MS), to };
    case '90d': return { from: new Date(startOfToday.getTime() - 89 * DAY_MS), to };
    case 'ytd': return { from: new Date(now.getFullYear(), 0, 1), to };
    case 'all': return { from: new Date(2000, 0, 1), to };
    default: {
      const from = new Date(startOfToday);
      from.setFullYear(from.getFullYear() - 1);
      return { from, to };
    }
  }
}

function eonSetupHtml(eon) {
  const local = state.snapshotMode ? '' : `<p>For the local app, pass them through the environment (not <code>.env</code>):</p><pre>$env:EON_CLIENT_ID = '&lt;client id&gt;'; $env:EON_CLIENT_SECRET = '&lt;client secret&gt;'; npm start</pre>`;
  return `<div class="notice warn"><h3>No meter values from E.ON${eon?.missing ? ' in this snapshot' : ''}</h3>
    <p>The Meter tab reads the facility’s hourly values from E.ON’s Energidata API (navigator-api.eon.se). It needs the API’s client id and secret, stored as the repository secrets <code>CLIENTID</code> and <code>CLIENTSECRET</code>; the hourly publishing job passes them on. After setting them, run the workflow once (Actions → <em>Snapshot to GitHub Pages</em> → <em>Run workflow</em>).</p>${local}</div>`;
}

async function loadMeterInputs() {
  const [eon, cdrs] = await Promise.all([
    api('/api/eon'),
    api(`/api/cdrs?date_from=${encodeURIComponent(HISTORY_START.toISOString())}`).catch(() => ({ items: [] })),
  ]);
  return { eon, records: cdrs.items || [] };
}

async function renderMeter() {
  const root = $('#view-meter');
  const m = state.meter;
  const o = state.analysis.options;
  const range = meterRange(m.preset);
  root.innerHTML = `
    <div class="view-head">
      <h2>Grid meter</h2>
      <span class="subtle">The whole facility’s measured hourly power from E.ON, the chargers’ part of it, the limits and what it costs</span>
    </div>
    <div id="meter-body"><div class="loading">Loading meter values...</div></div>`;
  const body = $('#meter-body');

  let eon;
  let records;
  try {
    ({ eon, records } = await loadMeterInputs());
  } catch (err) {
    body.innerHTML = errorHtml(err);
    return;
  }
  if (!eon?.configured) {
    body.innerHTML = eonSetupHtml(eon);
    return;
  }
  const installations = (eon.installations || []).filter((i) => i.hourly || i.quarter);
  if (!installations.length) {
    body.innerHTML = `<div class="notice error"><h3>No meter values</h3>${esc(eon.error?.message || 'E.ON answered, but returned no measured values for any installation.')}<div class="subtle" style="margin-top:6px">The <a href="#connection">Connection</a> tab lists what E.ON answered.</div></div>`;
    return;
  }
  if (m.installation >= installations.length) m.installation = 0;
  const inst = installations[m.installation];

  const chargerProfile = hourlyProfile(records, o);
  const meter = meterHours(inst);
  const rangeMs = { from: range.from.getTime(), to: range.to.getTime() };
  const rows = splitHours(meter, chargerProfile, rangeMs, o);
  const inRange = records.filter((r) => {
    const t = Date.parse(r.start || r.end || '');
    return t >= rangeMs.from && t < rangeMs.to;
  });
  const months = monthlyMeter(rows, { tariff: m.tariff, revenue: revenueByMonth(inRange), range: rangeMs, now: referenceTime().getTime(), capOptions: o });
  const sum = summarize(rows, months);
  const lastEnd = inst.last_value_end;
  const t = m.tariff;

  const stale = eon.error
    ? `<div class="notice error"><h3>E.ON could not be read${eon.attempted_at ? ` at ${fmtDateTime(eon.attempted_at)}` : ''}</h3>${esc(eon.error.message)}<div class="subtle" style="margin-top:6px">Showing the values from ${eon.generated_at ? fmtDateTime(eon.generated_at) : 'the previous run'}.</div></div>`
    : '';
  const problems = (inst.errors || []).filter((e) => e.resolution !== 'quarter' || !inst.quarter);
  const problemNote = problems.length && !eon.error
    ? `<div class="notice warn">${problems.map((e) => `${esc(e.resolution ? `${e.resolution} values` : 'Series')}: ${esc(e.message)}`).join('<br>')}</div>`
    : '';
  const demoNote = eon.source === 'demo' ? '<div class="notice warn"><h3>Demo meter</h3>These meter values are invented (base load plus the demo chargers), not from E.ON.</div>' : '';

  const top = sum.top;
  const tiles = [
    {
      label: 'Energy used, whole facility',
      value: `${fmtNum(sum.kwh, 0)}<small>kWh</small>`,
      hint: `chargers about ${fmtNum(sum.chargerKwh, 0)} kWh (${Math.round(sum.chargerShare * 100)}%) · ${fmtNum(sum.hours, 0)} measured hours`,
    },
    {
      label: 'Highest hourly average',
      value: top ? `${fmtNum(top.meterKw, 1)}<small>kW</small>` : '–',
      hint: top ? `${fmtDateTime(top.at)} · chargers about ${fmtNum(top.chargerKw, 1)} kW of it · limit then: ${top.limitKw ? `${fmtNum(top.limitKw, 1)} kW${top.limitKind === 'facility' ? ' (whole facility)' : ' (chargers)'}` : 'none'}` : 'No values in this range',
    },
    {
      label: 'Estimated electricity cost (incl. VAT)',
      value: fmtMoney(sum.costInclVat, 'SEK'),
      hint: `${months.length} month${months.length === 1 ? '' : 's'}, from the meter values and the tariff below${months.some((x) => x.partial) ? ' · includes partial months' : ''}`,
    },
    {
      label: 'Chargers: cost vs. revenue',
      value: `${fmtSigned(sum.revenue - sum.chargerCostInclVat, 'SEK')}`,
      hint: `they cost about ${fmtMoney(sum.chargerCostInclVat, 'SEK')} (energy + the effektavgift they added) and took in ${fmtMoney(sum.revenue, 'SEK')}`,
    },
  ];

  const hourly = (range.to - range.from) <= 35 * DAY_MS;
  const points = hourly
    ? rows.map((r) => ({ ...r, start: r.at }))
    : dailyPeaks(rows).map((d) => ({ ...d.peak, start: d.day, kwh: d.kwh, chargerKwh: d.chargerKwh }));

  body.innerHTML = `
    <div class="filters" id="meter-filters">
      ${METER_PRESETS.map((p) => `<button class="chip ${p.key === m.preset ? 'active' : ''}" data-preset="${p.key}">${p.label}</button>`).join('')}
      ${installations.length > 1 ? `<select id="meter-installation">${installations.map((i, n) => `<option value="${n}" ${n === m.installation ? 'selected' : ''}>${esc(i.name || i.ref)}</option>`).join('')}</select>` : ''}
      <span class="custom">${limitControlsHtml('meter', o)}<button id="meter-apply" class="primary">Apply</button></span>
    </div>
    ${limitsLegendHtml(o)}
    ${demoNote}${stale}${problemNote}
    <div class="grid grid-tiles">
      ${tiles.map((x) => `<div class="card tile"><span class="label">${esc(x.label)}</span><span class="value">${x.value}</span><span class="hint">${esc(x.hint)}</span></div>`).join('')}
    </div>
    <div class="subtle">${esc(inst.name || 'Installation')}${inst.city ? `, ${esc(inst.city)}` : ''}${inst.price_area ? ` · price area ${esc(inst.price_area)}` : ''}${inst.fuse_a ? ` · fuse ${esc(inst.fuse_a)} A` : ''} · values up to ${lastEnd ? fmtDateTime(lastEnd) : '–'} (E.ON publishes them about a day late) · chargers’ part estimated from the charge records with the model on the <a href="#analysis">Analysis</a> tab.</div>
    <div class="card" id="meter-power-card" data-view="chart">
      <div class="card-head"><h3>${hourly ? 'Average power per hour (kW)' : 'Highest hour of each day (kW)'}</h3><span class="subtle">${fmtDate(range.from)} – ${fmtDate(range.to.getTime() - DAY_MS)}</span><span class="spacer"></span><button id="meter-power-toggle">Show table</button></div>
      ${seriesLegendHtml()}
      <div class="chart" id="meter-power"></div>
      <div class="table-wrap power-table">${powerTableHtml(points, hourly)}</div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Billed peak per month (kW): the chargers’ part and everything else</h3><span class="subtle">${t.peakCount > 1 ? `average of the ${t.peakCount} highest hours on different days` : 'the highest hour of the month'} · lighter bars are partial months · dashes mark the limit in force</span></div>
      ${seriesLegendHtml()}
      <div class="chart" id="meter-months"></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Month</th><th>Limit in force</th><th class="num">kWh</th><th class="num">Billed peak kW</th><th>When</th><th class="num">Chargers in it</th><th class="num">Peak without chargers</th><th class="num">Hours over the ceiling</th></tr></thead>
        <tbody>${months.map((x) => `<tr>
          <td>${esc(monthLabel(x.month))}${x.partial ? ' <span class="subtle">(partial)</span>' : ''}</td>
          <td>${limitCellHtml(x.limits)}</td>
          <td class="num">${fmtNum(x.kwh, 0)}</td>
          <td class="num">${fmtNum(x.peakKw, 1)}</td>
          <td>${x.peakAt !== null ? fmtDateTime(x.peakAt) : '–'}</td>
          <td class="num">${fmtNum(x.chargersAtPeakKw, 1)} kW</td>
          <td class="num">${fmtNum(x.peakWithoutChargersKw, 1)} kW</td>
          <td class="num">${x.limits.some((l) => l.kind === 'facility') ? fmtNum(x.overLimitHours, 0) : '–'}</td>
        </tr>`).join('') || '<tr><td colspan="8" class="empty">No meter values in this range</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Cost per month, worked out from the meter values</h3><span class="subtle">an estimate: the invoice is the truth · kr incl. ${fmtNum(t.vatPct, 0)}% VAT</span></div>
      <form class="filters tariff-form" id="meter-tariff">
        <label title="Elhandel: average spot price plus the retailer's surcharge, excl. VAT">Energy <input type="number" name="retailOre" value="${t.retailOre}" step="0.1" min="0"> öre/kWh</label>
        <label title="E.ON Elnät överföringsavgift, excl. VAT">Transfer <input type="number" name="transferOre" value="${t.transferOre}" step="0.1" min="0"> öre/kWh</label>
        <label title="Energiskatt, excl. VAT">Energy tax <input type="number" name="energyTaxOre" value="${t.energyTaxOre}" step="0.1" min="0"> öre/kWh</label>
        <label title="E.ON Elnät fast avgift per month, excl. VAT">Fixed <input type="number" name="fixedKr" value="${t.fixedKr}" step="1" min="0"> kr/month</label>
        <label title="Effektavgift per kW of the month's billed peak, excl. VAT">Effekt <input type="number" name="krPerKw" value="${t.krPerKw}" step="1" min="0"> kr/kW</label>
        ${peakCountSelectHtml('meter-peaks', t.peakCount).replace('id="meter-peaks"', 'id="meter-peaks" name="peakCount"')}
        <label>VAT <input type="number" name="vatPct" value="${t.vatPct}" step="1" min="0"> %</label>
        <button type="submit" class="primary">Recalculate</button>
        <button type="button" id="meter-tariff-reset">Defaults</button>
      </form>
      <div class="subtle">The prices start as placeholders. Copy them from the E.ON Elnät and electricity invoices; they are saved in this browser only. E.ON also sells this breakdown from the actual invoices (49 kr/month); this is the free estimate from the meter values.</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Month</th><th class="num">Energy</th><th class="num">Transfer</th><th class="num">Energy tax</th><th class="num">Effektavgift</th><th class="num">Fixed</th><th class="num">Total</th><th class="num">Chargers’ share</th><th class="num">Charging revenue</th><th class="num">Chargers net</th></tr></thead>
        <tbody>${months.map((x) => {
          const vat = 1 + t.vatPct / 100;
          return `<tr>
            <td>${esc(monthLabel(x.month))}${x.partial ? ' <span class="subtle">(partial)</span>' : ''}</td>
            <td class="num">${fmtMoney(x.cost.energy * vat, 'SEK')}</td>
            <td class="num">${fmtMoney(x.cost.transfer * vat, 'SEK')}</td>
            <td class="num">${fmtMoney(x.cost.energyTax * vat, 'SEK')}</td>
            <td class="num" title="${fmtNum(x.peakKw, 1)} kW × ${fmtNum(t.krPerKw, 0)} kr/kW">${fmtMoney(x.cost.effect * vat, 'SEK')}</td>
            <td class="num">${fmtMoney(x.cost.fixed * vat, 'SEK')}</td>
            <td class="num"><strong>${fmtMoney(x.cost.inclVat, 'SEK')}</strong></td>
            <td class="num" title="energy ${fmtMoney(x.chargers.energyCost * vat, 'SEK')} + effektavgift they added ${fmtMoney(x.chargers.effectCost * vat, 'SEK')}">${fmtMoney(x.chargers.costInclVat, 'SEK')}</td>
            <td class="num">${fmtMoney(x.chargers.revenue, 'SEK')}</td>
            <td class="num"><span class="${x.chargers.net >= 0 ? 'ok' : 'bad'}">${x.chargers.net >= 0 ? '▲' : '▼'}</span> ${fmtSigned(x.chargers.net, 'SEK')}</td>
          </tr>`;
        }).join('') || '<tr><td colspan="10" class="empty">No meter values in this range</td></tr>'}</tbody>
      </table></div>
      <div class="subtle">“Chargers’ share” is what the club would not have paid without the chargers: their energy at the per-kWh prices, plus the effektavgift they added (the billed peak with them minus the billed peak without them). ${sum.overEstimateHours ? `In ${sum.overEstimateHours} hour(s) the charger model estimated more than the meter measured, or more than a whole-facility ceiling left room for; the chargers’ part was cut to what was possible there.` : ''} “Hours over the ceiling” are hours where the whole facility averaged above the ceiling: the rest of the club alone, since the chargers get nothing then.</div>
    </div>`;

  drawPowerChart($('#meter-power'), points, { hourly });
  drawMeterMonths($('#meter-months'), months);

  bindLimitControls('meter');
  $('#meter-filters').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-preset]');
    if (chip) {
      m.preset = chip.dataset.preset;
      renderMeter();
    }
    if (event.target.id === 'meter-apply') {
      state.analysis.options = { ...state.analysis.options, ...readLimitControls('meter') };
      renderMeter();
    }
  });
  $('#meter-installation')?.addEventListener('change', (event) => {
    m.installation = Number(event.target.value) || 0;
    renderMeter();
  });
  $('#meter-tariff').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const next = { ...m.tariff };
    for (const key of Object.keys(DEFAULT_TARIFF)) {
      const value = Number(form.get(key));
      if (form.has(key) && Number.isFinite(value) && value >= 0) next[key] = value;
    }
    m.tariff = next;
    saveTariff(next);
    state.analysis.options = { ...state.analysis.options, krPerKw: next.krPerKw, peakCount: next.peakCount };
    renderMeter();
  });
  $('#meter-tariff-reset').addEventListener('click', () => {
    m.tariff = { ...DEFAULT_TARIFF };
    saveTariff(m.tariff);
    state.analysis.options = { ...state.analysis.options, krPerKw: m.tariff.krPerKw, peakCount: m.tariff.peakCount };
    renderMeter();
  });
  const card = $('#meter-power-card');
  const toggle = $('#meter-power-toggle');
  const paint = () => {
    card.dataset.view = m.tableView ? 'table' : 'chart';
    toggle.textContent = m.tableView ? 'Show chart' : 'Show table';
  };
  toggle.addEventListener('click', () => {
    m.tableView = !m.tableView;
    paint();
  });
  paint();
}

function seriesLegendHtml(lang = 'en') {
  const t = lang === 'sv'
    ? ['Allt annat (uppmätt − laddarna)', 'Laddarna (uppskattat)', 'Gräns för laddarna', 'Tak för hela anläggningen']
    : ['Everything else (measured − chargers)', 'Chargers (estimated)', 'Charger limit', 'Whole-facility ceiling'];
  return `<div class="series-legend">
    <span><i class="swatch other"></i>${t[0]}</span>
    <span><i class="swatch chargers"></i>${t[1]}</span>
    <span><i class="swatch limit"></i>${t[2]}</span>
    <span><i class="swatch limit facility"></i>${t[3]}</span>
  </div>`;
}

function powerTableHtml(points, hourly) {
  const rows = [...points].reverse();
  return `<table>
    <thead><tr><th>${hourly ? 'Hour' : 'Day (its highest hour)'}</th><th class="num">Measured kW</th><th class="num">Chargers kW</th><th class="num">Everything else kW</th><th>Limit</th><th class="num">Room left for chargers</th></tr></thead>
    <tbody>${rows.map((p) => `<tr>
      <td>${hourly ? fmtDateTime(p.at) : `${fmtDate(p.start)} · ${fmtTime(p.at)}`}</td>
      <td class="num">${fmtNum(p.meterKw, 1)}</td>
      <td class="num">${fmtNum(p.chargerKw, 1)}</td>
      <td class="num">${fmtNum(p.otherKw, 1)}</td>
      <td>${p.limitKw ? `${fmtNum(p.limitKw, 1)} kW ${p.limitKind === 'facility' ? 'whole facility' : 'chargers'}` : '–'}</td>
      <td class="num">${p.roomKw === null ? '–' : `${fmtNum(p.roomKw, 1)} kW`}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">No meter values in this range</td></tr>'}</tbody>
  </table>`;
}

// Shared axis frame for the meter charts: one kW axis, recessive grid.
function kwFrame(maxKw, W, H, pad) {
  const tickCount = 4;
  const tickStep = niceStep((maxKw || 1) / tickCount);
  const maxValue = tickStep * tickCount;
  const innerH = H - pad.t - pad.b;
  const y = (v) => pad.t + innerH - (Math.min(v, maxValue) / maxValue) * innerH;
  const grid = Array.from({ length: tickCount + 1 }, (_, i) => tickStep * i)
    .map((v) => `<line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"></line><text class="tick" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${fmtNum(v, 0)}</text>`).join('');
  return { y, grid, innerH, maxValue, base: pad.t + innerH };
}

function stackedBar(x, w, y, base, otherKw, chargerKw, partial) {
  // Everything else at the bottom, the chargers on top: they are what pushes the peak up.
  const otherTop = y(otherKw);
  const totalTop = y(otherKw + chargerKw);
  const r = Math.min(3, w / 2);
  const other = base - otherTop > 0 ? `<rect class="seg other${partial ? ' partial' : ''}" x="${x}" y="${otherTop}" width="${w}" height="${base - otherTop}"></rect>` : '';
  const gap = w >= 6 ? 1 : 0; // a surface gap between the stacked parts where there is room
  const h = otherTop - totalTop - gap;
  const chargers = h > 0.3 ? `<rect class="seg chargers${partial ? ' partial' : ''}" x="${x}" y="${totalTop}" width="${w}" height="${h}" rx="${Math.min(r, h / 2)}"></rect>` : '';
  return other + chargers;
}

function attachTooltip(container, render) {
  const tooltip = $('#tooltip');
  container.addEventListener('mousemove', (event) => {
    const g = event.target.closest('g[data-index]');
    if (!g) {
      tooltip.hidden = true;
      return;
    }
    tooltip.innerHTML = render(Number(g.dataset.index));
    tooltip.hidden = false;
    tooltip.style.left = `${Math.min(event.clientX + 14, window.innerWidth - 260)}px`;
    tooltip.style.top = `${event.clientY + 14}px`;
  });
  container.addEventListener('mouseleave', () => {
    tooltip.hidden = true;
  });
}

function drawPowerChart(container, points, { hourly }) {
  if (!container) return;
  if (!points.length) {
    container.innerHTML = '<div class="empty">No meter values in this range.</div>';
    return;
  }
  const W = 960;
  const H = 260;
  const pad = { l: 46, r: 10, t: 14, b: 26 };
  const maxKw = Math.max(...points.map((p) => Math.max(p.meterKw, p.limitKw || 0)));
  const { y, grid, base } = kwFrame(maxKw, W, H, pad);
  const slot = (W - pad.l - pad.r) / points.length;
  const barW = Math.max(1, Math.min(18, slot - (slot > 4 ? 1 : 0)));
  const labelEvery = Math.max(1, Math.ceil(points.length / 10));

  // The limit as a step line, dotted where it is a whole-facility ceiling.
  let limitPath = '';
  let facilityPath = '';
  points.forEach((p, i) => {
    if (!p.limitKw) return;
    const seg = `M${pad.l + i * slot},${y(p.limitKw)} H${pad.l + (i + 1) * slot}`;
    if (p.limitKind === 'facility') facilityPath += seg;
    else limitPath += seg;
  });

  const bars = points.map((p, i) => {
    const x = pad.l + i * slot + (slot - barW) / 2;
    const xLabel = i % labelEvery === 0
      ? `<text class="tick" x="${x + barW / 2}" y="${H - 8}" text-anchor="middle">${esc(hourly && points.length <= 48 ? fmtTime(p.at) : fmtShortDate(p.start))}</text>`
      : '';
    return `<g data-index="${i}"><rect class="bar-hit" x="${pad.l + i * slot}" y="${pad.t}" width="${slot}" height="${base - pad.t}"></rect>${stackedBar(x, barW, y, base, p.otherKw, p.chargerKw, false)}${xLabel}</g>`;
  }).join('');

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${hourly ? 'Average power per hour' : 'Highest hour of each day'}, chargers and everything else">
    ${grid}
    <line class="axis-line" x1="${pad.l}" x2="${W - pad.r}" y1="${base}" y2="${base}"></line>
    ${bars}
    ${limitPath ? `<path class="limit-line" d="${limitPath}"></path>` : ''}
    ${facilityPath ? `<path class="limit-line facility" d="${facilityPath}"></path>` : ''}
  </svg>`;

  attachTooltip(container, (i) => {
    const p = points[i];
    const when = hourly ? `${fmtDateTime(p.at)}–${fmtTime(p.at + 3_600_000)}` : `${fmtDate(p.start)}, highest hour ${fmtTime(p.at)}`;
    const limit = p.limitKw
      ? `<br>Limit: ${fmtNum(p.limitKw, 1)} kW ${p.limitKind === 'facility' ? `for the whole facility → room for the chargers ${fmtNum(p.roomKw, 1)} kW` : 'for the chargers'}`
      : '';
    const day = hourly ? '' : `<br>Day total ${fmtNum(p.kwh, 0)} kWh, chargers ${fmtNum(p.chargerKwh, 0)} kWh`;
    return `<strong>${fmtNum(p.meterKw, 1)} kW measured</strong>${esc(when)}<br>chargers ${fmtNum(p.chargerKw, 1)} kW · everything else ${fmtNum(p.otherKw, 1)} kW${limit}${day}`;
  });
}

function drawMeterMonths(container, months) {
  if (!container) return;
  if (!months.length) {
    container.innerHTML = '<div class="empty">No meter values in this range.</div>';
    return;
  }
  const W = 960;
  const H = 240;
  const pad = { l: 46, r: 10, t: 14, b: 26 };
  const maxKw = Math.max(...months.map((m) => Math.max(m.peakKw, m.capKw || 0)));
  const { y, grid, base } = kwFrame(maxKw, W, H, pad);
  const slot = (W - pad.l - pad.r) / months.length;
  const barW = Math.min(28, Math.max(3, slot - 4));
  const bars = months.map((m, i) => {
    const x = pad.l + i * slot + (slot - barW) / 2;
    const limitMark = m.capKw ? `<line class="limit-mark${m.limit?.kind === 'facility' ? ' facility' : ''}" x1="${pad.l + i * slot + 1}" x2="${pad.l + (i + 1) * slot - 1}" y1="${y(m.capKw)}" y2="${y(m.capKw)}"></line>` : '';
    const label = `<text class="bar-label" x="${x + barW / 2}" y="${y(m.peakKw) - 5}" text-anchor="middle">${fmtNum(m.peakKw, 0)}</text>`;
    return `<g data-index="${i}"><rect class="bar-hit" x="${pad.l + i * slot}" y="${pad.t}" width="${slot}" height="${base - pad.t}"></rect>${stackedBar(x, barW, y, base, m.otherAtPeakKw, m.chargersAtPeakKw, m.partial)}${limitMark}${months.length <= 18 ? label : ''}<text class="tick" x="${x + barW / 2}" y="${H - 8}" text-anchor="middle">${esc(monthLabel(m.month, 'short'))}</text></g>`;
  }).join('');
  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Billed peak per month, chargers and everything else">
    ${grid}
    <line class="axis-line" x1="${pad.l}" x2="${W - pad.r}" y1="${base}" y2="${base}"></line>
    ${bars}
  </svg>`;
  attachTooltip(container, (i) => {
    const m = months[i];
    return `<strong>${fmtNum(m.peakKw, 1)} kW billed peak</strong>${esc(monthLabel(m.month))}${m.partial ? ' (partial)' : ''} · ${m.peakAt !== null ? fmtDateTime(m.peakAt) : '–'}<br>chargers ${fmtNum(m.chargersAtPeakKw, 1)} kW · everything else ${fmtNum(m.otherAtPeakKw, 1)} kW<br>without the chargers the peak would have been ${fmtNum(m.peakWithoutChargersKw, 1)} kW → they added ${fmtMoney(m.chargers.effectCost, 'SEK')} effektavgift (excl. VAT)${m.limit ? `<br>Limit: ${esc(m.limit.label)}` : ''}`;
  });
}

// ---------------------------------------------------------------------- guide
// Plain-language explanation for club members (in Swedish): what the
// dashboard shows, where the numbers come from, why the effektavgift is what
// it is, and the limits. The season picture uses the real meter values when
// they are there, otherwise clearly marked example values.
async function renderGuide() {
  const root = $('#view-guide');
  root.innerHTML = '<div class="loading">Laddar...</div>';
  const o = state.analysis.options;
  let picture = null;
  let source = 'exempel';
  try {
    const { eon, records } = await loadMeterInputs();
    const inst = (eon?.installations || []).find((i) => i.hourly);
    if (eon?.configured && inst) {
      const rows = splitHours(meterHours(inst), hourlyProfile(records, o), null, o);
      const months = monthlyMeter(rows, { tariff: state.meter.tariff, now: referenceTime().getTime(), capOptions: o });
      const p = seasonalPicture(months);
      if (p.winter || p.summer) {
        picture = p;
        source = eon.source === 'demo' ? 'demo' : 'mätt';
      }
    }
  } catch {
    // the guide works without data
  }
  const example = { winter: { peakKw: 58, otherKw: 40, chargerKw: 18, months: 0 }, summer: { peakKw: 62, otherKw: 25, chargerKw: 37, months: 0 } };
  const seasons = { winter: picture?.winter || example.winter, summer: picture?.summer || example.summer };
  const usedExample = { winter: !picture?.winter, summer: !picture?.summer };
  const kr = o.krPerKw;
  const ceiling = LIMIT_HISTORY.at(-1);
  const chargerCap = LIMIT_HISTORY.find((l) => l.amps === 63);

  root.innerHTML = `
    <div class="view-head"><h2>Så funkar det</h2><span class="subtle">Förklaringen bakom siffrorna, utan facktermer</span></div>
    <div class="guide">

    <div class="card">
      <h3>Vad är det här?</h3>
      <p>Den här sidan visar vad klubbens elbilsladdare gör och vad elen kostar oss. Den hämtar uppgifter från två ställen, en gång i timmen, och ritar upp dem här:</p>
      ${flowDiagramSvg()}
      <ul>
        <li><strong>ChargeNode</strong> driver laddarna. Via ett standardgränssnitt (OCPI) får vi veta vilka laddare som används just nu och ett kvitto per laddning: när bilen kopplades in och ur, hur många kWh den fick och vad föraren betalade.</li>
        <li><strong>E.ON</strong> äger elnätet och elmätaren. Mätaren registrerar hur mycket el <em>hela anläggningen</em> drar, timme för timme (klubbhus, restaurang, värme, bevattning och laddare tillsammans). E.ON lämnar ut värdena ungefär ett dygn i efterhand.</li>
        <li>Ett automatiskt jobb på GitHub hämtar båda en gång i timmen och publicerar sidan. Nycklarna till ChargeNode och E.ON ligger i GitHub och syns aldrig på sidan. Uppgifter om vem som laddat tas bort innan något publiceras.</li>
      </ul>
    </div>

    <div class="card">
      <h3>Flikarna</h3>
      <dl class="kv">
        <dt><a href="#live">Live</a></dt><dd>Vilka laddare som laddar, är lediga eller ur funktion vid senaste hämtningen.</dd>
        <dt><a href="#records">Records</a></dt><dd>Alla laddningar: antal, kWh, intäkt, tid inkopplad. Kan laddas ner som Excel-fil (CSV).</dd>
        <dt><a href="#analysis">Analysis</a></dt><dd>Hur många som laddar samtidigt, vilka timmar som är mest belastade och hur stor effekttopp <em>laddarna själva</em> skapar.</dd>
        <dt><a href="#meter">Meter</a></dt><dd>Det E.ON faktiskt mätt för hela anläggningen, hur mycket av varje topp som var laddarna, gränserna och vad elen kostar.</dd>
        <dt><a href="#chargers">Chargers</a></dt><dd>Laddarna och deras uttag.</dd>
        <dt><a href="#connection">Connection</a></dt><dd>Teknisk felsökning: vad ChargeNode och E.ON svarade.</dd>
      </dl>
    </div>

    <div class="card">
      <h3>Effektavgiften: varför en enda timme kan bli dyr</h3>
      <p>Elräkningen har två sorters kostnader. Den ena är för <strong>mängden el</strong> (kWh), som en vattenmätare. Den andra, <strong>effektavgiften</strong>, är för hur mycket el vi drar <em>på en gång</em>. E.ON tittar på varje timme under månaden, räknar ut medeleffekten den timmen (kW) och tar den högsta. Den timmen kostar ${fmtNum(kr, 0)} kr per kW, för hela månaden.</p>
      ${peakDiagramSvg(kr)}
      <p>Det betyder att en enda olycklig timme sätter priset för hela månaden, även om resten av månaden är lugn. Om fyra bilar laddar samtidigt med 11 kW var blir det 44 kW, och om det sker samtidigt som köket och bevattningen går blir toppen hög. ${fmtNum(44, 0)} kW extra × ${fmtNum(kr, 0)} kr = <strong>${fmtMoney(44 * kr, 'SEK')}</strong> den månaden, för en enda timme.</p>
      <p>Därför spelar det roll <em>när</em> laddarna drar ström, inte bara hur mycket. Mitt i säsongen, när många laddar på dagen samtidigt som resten av klubben är igång, är risken störst. Utan en gräns kan laddarna själva lägga till tiotals kW ovanpå allt annat.</p>
    </div>

    <div class="card">
      <h3>Gränserna</h3>
      <p>ChargeNode styr laddarna med så kallad lastbalansering: laddarna sänker farten när det behövs. Det finns två sorters gränser, och skillnaden är viktig:</p>
      <ul>
        <li><strong>Gräns för laddarna</strong> (t.ex. 63 A ≈ 43,5 kW): laddarna tillsammans får aldrig ta mer än så. Men de bryr sig inte om vad resten av klubben drar, så toppen kan bli <em>resten + 43,5 kW</em>.</li>
        <li><strong>Tak för hela anläggningen</strong> (sedan ${esc(limitDate(ceiling.from))}: ${ceiling.amps} A ≈ ${fmtNum(ceiling.kw, 1)} kW): ChargeNode mäter hela anläggningens ström och låter laddarna använda bara det som blir över under taket. Drar klubben redan ${fmtNum(ceiling.kw, 0)} kW får laddarna ingenting. Då kan laddarna aldrig vara orsaken till att vi passerar taket. Om ChargeNodes strömmätare slutar fungera går det inte att ladda alls (det är ett skydd, inte ett fel).</li>
      </ul>
      ${seasonDiagramSvg(seasons, usedExample, ceiling, chargerCap)}
      <p class="subtle">${source === 'mätt' ? 'Staplarna bygger på E.ON:s uppmätta värden: genomsnittet av månadernas debiterade topp, uppdelat på laddarna och allt annat.' : source === 'demo' ? 'Staplarna bygger på påhittade demovärden.' : ''}${usedExample.winter || usedExample.summer ? ' Där det står ”exempel” finns inga mätvärden ännu, och siffrorna är bara för att visa principen.' : ''} På vintern är resten av klubbens förbrukning högre (värme), så med ett tak för hela anläggningen blir det mindre plats över för laddarna. På sommaren går mer el till laddning.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Gräns</th><th class="num">Ampere</th><th class="num">kW</th><th>Gäller</th><th>Vad den betyder</th></tr></thead>
        <tbody>
          <tr><td>Huvudsäkring</td><td class="num">${MAIN_FUSE_A} A</td><td class="num">${fmtNum(MAIN_FUSE_KW, 1)}</td><td>alltid</td><td>Det mesta anläggningen kan dra över huvud taget.</td></tr>
          ${LIMIT_HISTORY.map((l, i) => `<tr><td>${l.kind === 'facility' ? 'Tak för hela anläggningen' : 'Gräns för laddarna'}</td><td class="num">${l.amps ? `${l.amps} A` : '–'}</td><td class="num">${fmtNum(l.kw, 1)}</td><td>${i < LIMIT_HISTORY.length - 1 ? `${esc(limitDate(l.from))} – ${esc(limitDate(LIMIT_HISTORY[i + 1].from))}` : `från ${esc(limitDate(l.from))}`}</td><td>${l.kind === 'facility' ? 'Laddarna får bara det som resten av klubben lämnar under taket.' : 'Laddarna tillsammans; resten av klubben räknas inte.'} <span class="subtle">${esc(l.note)}</span></td></tr>`).join('')}
          <tr><td>Effektavgift</td><td class="num">–</td><td class="num">–</td><td>varje månad</td><td>${fmtNum(kr, 0)} kr per kW av månadens högsta timme (E.ON Elnät).</td></tr>
        </tbody>
      </table></div>
      <p>Samma gränser ritas in i diagrammen på flikarna Analysis och Meter: streck för en gräns för laddarna, prickat för taket för hela anläggningen. Under <em>Limits</em> kan man också prova ”tänk om”: en gräns för laddarna på sommaren och ett tak för hela anläggningen på vintern, och se vad det hade gjort med topparna.</p>
    </div>

    <div class="card">
      <h3>Varför siffrorna blir som de blir</h3>
      <ul>
        <li><strong>Laddarnas effekt är en uppskattning.</strong> ChargeNode berättar hur många kWh en bil fick, inte hur fort. Vi antar att bilen laddar med ${fmtNum(o.rateKw, 1)} kW tills den är klar och sedan står still (kan ändras på Analysis-fliken). Därför är ”laddarnas del” av en timme ungefärlig, medan totalen från E.ON är uppmätt.</li>
        <li><strong>”Allt annat”</strong> är E.ON:s uppmätta värde minus laddarnas uppskattade del: klubbhus, restaurang, värme, ventilation, bevattning och pumpar.</li>
        <li><strong>Vad laddarna kostar</strong> räknas som det klubben inte hade betalat utan dem: deras kWh gånger elpriset, plus skillnaden i effektavgift mellan månadens topp med och utan laddarna. Det jämförs med vad förarna betalade.</li>
        <li><strong>Kostnaderna är en uppskattning.</strong> Priserna på Meter-fliken (elpris, överföring, energiskatt, fast avgift) är platshållare tills någon skriver in siffrorna från fakturan. Fakturan gäller alltid.</li>
        <li><strong>Hur E.ON räknar toppen</strong> ska kontrolleras mot avtalet: ibland är det den högsta timmen, ibland snittet av de 2–3 högsta timmarna på olika dagar, ibland bara vardagar dagtid på vintern. Valet <em>Billed on</em> på flikarna ändrar detta.</li>
        <li><strong>E.ON:s värden kommer ett dygn sent</strong>, så de senaste timmarna saknas alltid.</li>
      </ul>
    </div>

    <div class="card">
      <h3>Ordlista</h3>
      <dl class="kv">
        <dt>kWh</dt><dd>Mängd energi. 1 kWh är ungefär vad en bil behöver för 5–6 km.</dd>
        <dt>kW</dt><dd>Effekt, alltså hur fort energin används. 11 kW i en timme blir 11 kWh.</dd>
        <dt>Timmedeleffekt</dt><dd>Energin under en hel klocktimme uttryckt i kW. Det är den E.ON tar betalt för, inte korta toppar.</dd>
        <dt>A (ampere)</dt><dd>Ström. Med vår trefas 400 V är 1 A ≈ 0,69 kW, så 36 A ≈ 25 kW och 63 A ≈ 43,5 kW.</dd>
        <dt>Lastbalansering</dt><dd>Att laddarna automatiskt sänker farten så att en gräns inte passeras.</dd>
        <dt>OCPI</dt><dd>Standarden laddoperatörer använder för att dela data om laddare och laddningar.</dd>
      </dl>
    </div>
    </div>`;
}

function flowDiagramSvg() {
  const box = (x, y, w, title, sub, cls = '') => `<g class="flow-box ${cls}"><rect x="${x}" y="${y}" width="${w}" height="56" rx="8"></rect><text x="${x + w / 2}" y="${y + 24}" text-anchor="middle" class="flow-title">${esc(title)}</text><text x="${x + w / 2}" y="${y + 42}" text-anchor="middle" class="flow-sub">${esc(sub)}</text></g>`;
  const arrow = (x1, y1, x2, y2) => `<path class="flow-arrow" d="M${x1},${y1} L${x2},${y2}" marker-end="url(#arrowhead)"></path>`;
  return `<div class="diagram"><svg viewBox="0 0 760 200" role="img" aria-label="Dataflöde: laddarna via ChargeNode och elmätaren via E.ON till GitHub och den här sidan">
    <defs><marker id="arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="flow-head"></path></marker></defs>
    ${box(10, 20, 150, 'Laddarna', '6 laddpunkter', 'chargers')}
    ${box(200, 20, 150, 'ChargeNode', 'laddningar (OCPI)')}
    ${box(10, 124, 150, 'Elmätaren', 'hela anläggningen', 'meter')}
    ${box(200, 124, 150, 'E.ON', 'timvärden, dygnet efter')}
    ${box(400, 72, 160, 'GitHub', 'hämtar varje timme')}
    ${box(600, 72, 150, 'Den här sidan', 'diagram och tabeller')}
    ${arrow(160, 48, 198, 48)}${arrow(160, 152, 198, 152)}
    ${arrow(350, 48, 398, 92)}${arrow(350, 152, 398, 112)}
    ${arrow(560, 100, 598, 100)}
  </svg></div>`;
}

function peakDiagramSvg(kr) {
  // An invented day: base load plus one hour where several cars charge during lunch.
  const hours = [8, 8, 7, 7, 7, 8, 12, 18, 24, 27, 30, 34, 58, 36, 30, 28, 26, 24, 22, 18, 14, 11, 9, 8];
  const W = 760;
  const H = 210;
  const pad = { l: 40, r: 10, t: 20, b: 26 };
  const { y, grid, base } = kwFrame(60, W, H, pad);
  const slot = (W - pad.l - pad.r) / 24;
  const peak = Math.max(...hours);
  const bars = hours.map((kw, h) => {
    const x = pad.l + h * slot + 2;
    const w = slot - 4;
    const isPeak = kw === peak;
    return `<rect class="${isPeak ? 'seg chargers' : 'seg other'}" x="${x}" y="${y(kw)}" width="${w}" height="${base - y(kw)}" rx="3"></rect>${h % 3 === 0 ? `<text class="tick" x="${x + w / 2}" y="${H - 8}" text-anchor="middle">${String(h).padStart(2, '0')}</text>` : ''}`;
  }).join('');
  const px = pad.l + 12 * slot + slot / 2;
  return `<div class="diagram chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Exempel: ett dygns timmedeleffekt där en timme sticker ut och sätter månadens effektavgift">
    ${grid}<line class="axis-line" x1="${pad.l}" x2="${W - pad.r}" y1="${base}" y2="${base}"></line>${bars}
    <text class="bar-label" x="${px + 14}" y="${y(peak) + 4}">← månadens högsta timme: ${peak} kW × ${fmtNum(kr, 0)} kr = ${esc(fmtMoney(peak * kr, 'SEK'))}</text>
  </svg><div class="subtle">Exempel på ett dygn, kW per timme. Den orange timmen bestämmer hela månadens effektavgift.</div></div>`;
}

function seasonDiagramSvg(seasons, usedExample, ceiling, chargerCap) {
  const W = 760;
  const H = 250;
  const pad = { l: 40, r: 230, t: 16, b: 30 };
  const maxKw = Math.max(MAIN_FUSE_KW, seasons.winter.peakKw, seasons.summer.peakKw);
  const { y, grid, base } = kwFrame(maxKw, W, H, pad);
  const cols = [
    { key: 'summer', label: 'Sommar (apr–okt)', s: seasons.summer },
    { key: 'winter', label: 'Vinter (nov–mar)', s: seasons.winter },
  ];
  const slot = (W - pad.l - pad.r) / cols.length;
  const barW = 90;
  const bars = cols.map((c, i) => {
    const x = pad.l + i * slot + (slot - barW) / 2;
    const total = c.s.otherKw + c.s.chargerKw;
    return `${stackedBar(x, barW, y, base, c.s.otherKw, c.s.chargerKw, false)}
      <text class="bar-label" x="${x + barW / 2}" y="${y(total) - 6}" text-anchor="middle">${fmtNum(total, 0)} kW${usedExample[c.key] ? ' (exempel)' : ''}</text>
      <text class="tick" x="${x + barW / 2}" y="${H - 10}" text-anchor="middle">${esc(c.label)}</text>`;
  }).join('');
  const lineAt = (kw, cls, text) => `<line class="${cls}" x1="${pad.l}" x2="${W - pad.r}" y1="${y(kw)}" y2="${y(kw)}"></line><text class="tick" x="${W - pad.r + 6}" y="${y(kw) + 4}">${esc(text)}</text>`;
  return `<div class="diagram chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Månadens topp sommar och vinter, uppdelad på laddarna och allt annat, med gränserna inritade">
    ${grid}<line class="axis-line" x1="${pad.l}" x2="${W - pad.r}" y1="${base}" y2="${base}"></line>
    ${lineAt(MAIN_FUSE_KW, 'limit-line fuse', `Huvudsäkring ${MAIN_FUSE_A} A ≈ ${fmtNum(MAIN_FUSE_KW, 0)} kW`)}
    ${chargerCap ? lineAt(chargerCap.kw, 'limit-line', `Laddarna ≤ 63 A ≈ ${fmtNum(chargerCap.kw, 1)} kW`) : ''}
    ${lineAt(ceiling.kw, 'limit-line facility', `Hela anläggningen ≤ ${ceiling.amps} A ≈ ${fmtNum(ceiling.kw, 0)} kW`)}
    ${bars}
  </svg>${seriesLegendHtml('sv')}<div class="subtle">Månadens debiterade topp i snitt: orange är laddarnas del, blått allt annat. Med taket på ${fmtNum(ceiling.kw, 0)} kW för hela anläggningen ska laddarna inte kunna lägga sig ovanför den prickade linjen; när resten av klubben redan ligger där får laddarna inget utrymme.</div></div>`;
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
          ? `<dt>Records</dt><dd>${s.data_error ? 'no data in this snapshot' : `${fmtNum(s.counts?.cdrs, 0)} records since ${fmtDate(s.cdr_window.from)}${s.cdr_window.incremental ? `; this build fetched the ${fmtNum(s.cdr_window.fetched, 0)} changed since the previous snapshot` : '; full fetch'}`}</dd>`
          : `<dt>Local server</dt><dd>Node ${esc(s.server?.node || '')} on port ${esc(s.server?.port || '')}, started ${s.server?.startedAt ? fmtDateTime(s.server.startedAt) : '–'}</dd>`}
      </dl>
    </div>
    ${d?.endpoints ? `<div class="card"><div class="card-head"><h3>Module endpoints</h3></div><div class="table-wrap"><table><thead><tr><th>Module</th><th>URL</th></tr></thead><tbody>${Object.entries(d.endpoints).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    ${attempts.length ? `<div class="card"><div class="card-head"><h3>Requests made</h3></div><div class="table-wrap"><table><thead><tr><th>Step</th><th>Token encoding</th><th>URL</th><th class="num">HTTP</th></tr></thead><tbody>${attempts.map((a) => `<tr><td>${esc(a.step)}</td><td>${esc(a.encoding)}</td><td class="mono">${esc(a.url)}</td><td class="num ${a.httpStatus < 400 ? 'ok' : 'bad'}">${esc(a.httpStatus)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    ${err ? `<div class="card"><div class="card-head"><h3>Last error</h3></div><pre>${esc(JSON.stringify(err, null, 2))}</pre></div>` : ''}
    ${help}
    <div id="conn-eon"><div class="loading">Checking E.ON...</div></div>`;

  api('/api/eon').then((eon) => {
    $('#conn-eon').innerHTML = eonConnectionHtml(eon);
  }, (e) => {
    $('#conn-eon').innerHTML = errorHtml(e);
  });

  $('#conn-retry')?.addEventListener('click', () => renderConnection(true));
}

function eonConnectionHtml(eon) {
  if (!eon?.configured) return `<div class="card"><div class="card-head"><h3>Grid meter (E.ON Energidata API)</h3></div>${eonSetupHtml(eon)}</div>`;
  const verdict = eon.error
    ? `<div class="notice error"><h3><span class="bad">E.ON failed</span></h3>${esc(eon.error.message)}${eon.error.code === 'UNAUTHORIZED' ? '<div class="subtle" style="margin-top:6px">Check the <code>CLIENTID</code> and <code>CLIENTSECRET</code> secrets against the key and secret in E.ON’s Navigator portal.</div>' : ''}</div>`
    : `<div class="notice"><h3><span class="ok">E.ON connected</span></h3>${eon.source === 'demo' ? 'Demo meter (invented values).' : `Read ${fmtDateTime(eon.generated_at)} (${fmtRelative(eon.generated_at)}).`}</div>`;
  const installations = (eon.installations || []).map((i) => `<tr>
    <td>${esc(i.name || '–')}<div class="subtle mono">ref ${esc(i.ref)}</div></td>
    <td>${esc([i.city, i.grid_area && `grid area ${i.grid_area}`, i.price_area].filter(Boolean).join(' · ') || '–')}</td>
    <td>${esc(i.resolution || '–')}${i.fuse_a ? ` · ${esc(i.fuse_a)} A` : ''}</td>
    <td>${(i.series || []).map((s) => `<div class="${i.selected_series && s.id === i.selected_series.id ? '' : 'subtle'}">${esc(s.id)} ${esc(s.type || '?')} (${esc(s.unit || '?')})${i.selected_series && s.id === i.selected_series.id ? ' ✓ used' : ''}</div>`).join('') || '–'}</td>
    <td class="num">${i.hourly ? fmtNum(i.hourly.values.filter((v) => v !== null).length, 0) : '–'} h · ${i.quarter ? fmtNum(i.quarter.values.filter((v) => v !== null).length, 0) : '–'} q</td>
    <td>${i.last_value_end ? fmtDateTime(i.last_value_end) : '–'}${(i.errors || []).map((e) => `<div class="bad">${esc(e.resolution || '')} ${esc(e.message)}</div>`).join('')}</td>
  </tr>`).join('');
  const requests = (eon.requests || []).map((r) => `<tr><td>${esc(r.step)}</td><td class="mono">${esc(r.url)}</td><td class="num ${r.httpStatus < 400 ? 'ok' : 'bad'}">${esc(r.httpStatus)}</td></tr>`).join('');
  return `<div class="card">
    <div class="card-head"><h3>Grid meter (E.ON Energidata API)</h3><span class="subtle mono">navigator-api.eon.se</span></div>
    ${verdict}
    <div class="table-wrap"><table><thead><tr><th>Installation</th><th>Area</th><th>Metering</th><th>Series</th><th class="num">Values</th><th>Up to</th></tr></thead><tbody>${installations || '<tr><td colspan="6" class="empty">No installations</td></tr>'}</tbody></table></div>
    ${requests ? `<h3 style="margin-top:12px">Requests made</h3><div class="table-wrap"><table><thead><tr><th>Step</th><th>URL</th><th class="num">HTTP</th></tr></thead><tbody>${requests}</tbody></table></div>` : ''}
  </div>`;
}

// ----------------------------------------------------------------------- boot
async function boot() {
  // The effektavgift settings saved with the Meter tab's tariff apply everywhere.
  state.analysis.options = { ...state.analysis.options, krPerKw: state.meter.tariff.krPerKw, peakCount: state.meter.tariff.peakCount };
  const snapshotUrl = document.querySelector('meta[name="dashboard-snapshot"]')?.content;
  if (snapshotUrl) await loadSnapshot(snapshotUrl);
  refreshStatus().then(loadLocationLabels);
  route();
}
boot();
