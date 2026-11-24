// Dashboard front-end. Talks only to the local server's /api routes.
import {
  analyze,
  hourlyProfile,
  monthlyPeaks,
  rateFromRecords,
  isWinter,
  revenueByMonth,
  LIMIT_HISTORY,
  SEASON_PLAN,
  dayStart,
  limitAt,
  MAIN_FUSE_A,
  MAIN_FUSE_KW,
  DEFAULT_OPTIONS as ANALYSIS_DEFAULTS,
} from './analysis.js';
import { DEFAULT_TARIFF, expandSeries, hourPrices, hourlySpot, meterHours, splitHours, dailyPeaks, monthlyMeter, summarize, seasonalPicture, rateFromMeter, monthlyTopHours, typicalDay } from './meter.js';
import { FACILITY_LOADS, BASE_LOAD_KW, explainPeak, inHours, loadLabel } from './facility.js';
import { DEFAULT_COSTS, MARKET_BAND, account, limitSavings, priceAdvice, winterCeilingCheck, nightOffCheck } from './economics.js';
import { BILL, BILL_PARTS, BILL_SOURCE, FEEDER_CABLE, GRID_2027, ROOF_WORK, SOLAR_SIMULATION, billTotal } from './contracts.js';

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
    preset: 'ytd', // this year
    customFrom: null,
    customTo: null,
    sort: { key: 'start', dir: 'desc' },
    data: null,
  },
  analysis: {
    preset: 'ytd', // this year
    options: { ...ANALYSIS_DEFAULTS },
    tableView: false,
  },
  meter: {
    preset: 'ytd', // this year
    installation: 0,
    tariff: loadTariff(),
    tableView: false,
  },
  economics: {
    costs: loadCosts(),
  },
  rate: {
    auto: true, // charging power measured from the data; false when set by hand
    estimate: undefined, // { kw, n, source, low?, high? } or null, set on first load
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
  if (route === '/api/eon') return snapshot.eon ? { ...snapshot.eon, spot: snapshot.spot || null } : { configured: false, missing: true };
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
const views = { overview: renderOverview, live: renderLive, records: renderRecords, analysis: renderAnalysis, meter: renderMeter, economics: renderEconomics, solar: renderSolar, chargers: renderChargers, connection: renderConnection, guide: renderGuide };

// Live, Records and the charging points share the Chargers tab, with sub-tabs.
const CHARGING_TABS = ['live', 'records', 'chargers'];

function currentTab() {
  const hash = location.hash.replace('#', '');
  return views[hash] ? hash : 'overview';
}

function route() {
  const tab = currentTab();
  const top = CHARGING_TABS.includes(tab) ? 'charging' : tab;
  clearTimeout(state.liveTimer);
  for (const link of $$('.tabs a')) link.classList.toggle('active', link.dataset.tab === top);
  for (const link of $$('.subtabs a')) link.classList.toggle('active', link.dataset.tab === tab);
  $('#charging-subtabs').hidden = top !== 'charging';
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

// ------------------------------------------------------------------- overview
// The first page: the month's billed peak this year, how much of it the
// chargers caused, and the limit in force. Details live on the other tabs.
async function renderOverview() {
  const root = $('#view-overview');
  if (!root.dataset.rendered) root.innerHTML = '<div class="loading">Loading...</div>';
  let eon;
  let records;
  try {
    ({ eon, records } = await loadMeterInputs());
  } catch (err) {
    root.innerHTML = errorHtml(err);
    return;
  }
  root.dataset.rendered = '1';
  const inst = eon?.configured ? (eon.installations || []).find((i) => i.hourly) : null;
  const head = `<div class="view-head"><h2>Overview</h2><span class="subtle">The facility’s monthly power peak, which sets the effektavgift, and the chargers’ part of it</span></div>`;
  if (!inst) {
    root.innerHTML = `${head}${eonSetupHtml(eon)}<p>Meanwhile the <a href="#live">Chargers</a> tab shows the charging points and sessions.</p>${solarTeaserHtml()}`;
    fillSolarTeaser();
    return;
  }
  const o = state.analysis.options;
  const t = state.meter.tariff;
  const now = referenceTime();
  const rows = splitHours(meterHours(inst), hourlyProfile(records, o), null, o, spotFor(inst, eon));
  const all = monthlyMeter(rows, { tariff: t, revenue: revenueByMonth(records), now: now.getTime(), capOptions: o });
  const year = String(now.getFullYear());
  const months = all.filter((m) => m.month.startsWith(year));
  const current = all.at(-1);
  const effekt = months.reduce((s, m) => s + m.cost.effect, 0);
  const added = months.reduce((s, m) => s + m.chargers.effectCost, 0);
  const limit = limitAt(now.getTime(), o);
  const vat = 1 + t.vatPct / 100;
  const tiles = [
    {
      label: `Peak so far in ${monthLabel(current.month)}`,
      value: `${fmtNum(current.peakKw, 1)}<small>kW</small>`,
      hint: current.peakAt !== null ? `${fmtDateTime(current.peakAt)} · chargers about ${fmtNum(current.chargersAtPeakKw, 1)} kW of it · ${fmtMoney(current.cost.effect * vat, 'SEK')} at ${fmtNum(t.krPerKw, 1)} kr/kW` : '–',
    },
    {
      label: `Effektavgift ${year}`,
      value: fmtMoney(effekt * vat, 'SEK'),
      hint: `${months.length} month${months.length === 1 ? '' : 's'}, incl. VAT, from the measured monthly peaks`,
    },
    {
      label: 'Added by the chargers',
      value: fmtMoney(added * vat, 'SEK'),
      hint: `of the effektavgift ${year}: the peak with the chargers minus the peak without them (estimated)`,
    },
    {
      label: 'Limit now',
      value: limit ? `${fmtNum(limit.kw, 1)}<small>kW</small>` : '–',
      hint: limit ? `${limit.kind === 'facility' ? 'for the whole facility; the chargers get what is left' : 'for the chargers together'} · yearly plan: ${SEASON_PLAN.winter.amps} A for the whole facility from 26 Oct, ${SEASON_PLAN.season.amps} A for the chargers from 1 Mar` : '',
    },
  ];
  root.innerHTML = `${head}
    <div class="grid grid-tiles">
      ${tiles.map((x) => `<div class="card tile"><span class="label">${esc(x.label)}</span><span class="value">${x.value}</span><span class="hint">${esc(x.hint)}</span></div>`).join('')}
    </div>
    <div class="card">
      <div class="card-head"><h3>Billed peak per month (kW): the chargers’ part and everything else</h3><span class="subtle">${year} · the highest hour of the month · lighter bars are partial months · dashes mark the limit in force</span></div>
      ${seriesLegendHtml()}
      <div class="chart" id="overview-months"></div>
      <p class="subtle">E.ON bills the effektavgift on each month’s single highest hour (${fmtNum(t.krPerKw, 1)} kr/kW). Orange is the chargers’ estimated part of that hour. More on the <a href="#meter">Meter</a> tab (when the peaks happen and why), <a href="#economics">Economics</a> (what the chargers earn and cost) and in <a href="#guide">Så funkar det</a>.</p>
    </div>
    ${solarTeaserHtml()}`;
  drawMeterMonths($('#overview-months'), months);
  fillSolarTeaser();
}

// A pointer from the Overview to the Solar tab's proposal; the figures are
// filled in from data/solar-effekt.json once it has loaded.
function solarTeaserHtml() {
  return `
    <div class="card" id="overview-solar">
      <div class="card-head"><h3>Solar: a proposal to lower the bill</h3><span class="spacer"></span><a href="#solar">See the Solar tab →</a></div>
      <p data-solar-summary>Panels on the office building and the studio would pay for themselves, mostly through electricity the club no longer buys. The barn’s asbestos roof and the old office’s split roof must be fixed anyway; with panels on them, the repairs help lower the bill too. <a href="#solar">The 3D model, the numbers per roof and the roof work →</a></p>
    </div>`;
}

async function fillSolarTeaser() {
  const effekt = state.solar?.effekt ?? await fetch('data/solar-effekt.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const sug = effekt?.results?.find((r) => r.keys.length === SUGGESTED_ROOFS.length && SUGGESTED_ROOFS.every((k) => r.keys.includes(k)));
  const el = $('#overview-solar [data-solar-summary]');
  if (!sug || !el) return;
  const total = sug.effektKr + sug.energyKr;
  const payback = (SOLAR_SIMULATION.costPerKwp[1] * sug.kwp) / total;
  el.innerHTML = `About <strong>${fmtNum(sug.kwp, 0)} kWp on the office building and the studio</strong> would save about <strong>${fmtMoney(total, 'SEK')} a year</strong> (${fmtMoney(sug.energyKr, 'SEK')} electricity not bought, ${fmtMoney(sug.effektKr, 'SEK')} lower effektavgift) and pay back in about <strong>${fmtNum(payback, 0)} years</strong>, simulated per quarter hour on the club’s own consumption. The barn’s asbestos roof and the old office’s split roof must be fixed anyway; with panels on them, the repairs help lower the bill too. <a href="#solar">The 3D model, the numbers per roof and the roof work →</a>`;
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
    }).map((c) => (c.duration_h > 0 || !c.start || !c.end
      ? c
      : { ...c, duration_h: (Date.parse(c.end) - Date.parse(c.start)) / 3_600_000 })); // ChargeNode reports 0
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
  // Step by calendar days, not by 24 h, so the buckets stay on local midnight across DST changes.
  for (const d = new Date(bucketStart(range.from)); d.getTime() < range.to.getTime(); d.setDate(d.getDate() + (weekly ? 7 : 1))) {
    buckets.set(d.getTime(), { start: d.getTime(), kwh: 0, sessions: 0 });
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
  if (!root.dataset.rendered) root.innerHTML = '<div class="loading">Analysing charge records...</div>';
  await loadMeterInputs().catch(() => null); // the measured charging power
  root.dataset.rendered = '1';
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
        ${rateControlHtml('analysis', o)}
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
  bindRateControl('analysis');
  $('#analysis-filters').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-preset]');
    if (chip) {
      a.preset = chip.dataset.preset;
      renderAnalysis();
    }
    if (event.target.id === 'analysis-apply') {
      a.options = {
        ...o,
        ...readLimitControls('analysis'),
        rateKw: readRateControl('analysis'),
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
    : `each car charging at ${fmtNum(options.rateKw, 1)} kW (${rateSourceText()}) from plug-in until its energy is delivered, then idle`;
  const capLabel = options.limits === 'none'
    ? ', with no limit on the total'
    : options.limits === 'seasonal'
      ? `, with the total capped at ${fmtNum(options.capKw, 1)} kW in season (1 Mar – 25 Oct) and at most ${fmtNum(options.winterCapKw, 1)} kW (the whole facility’s ceiling) in winter`
      : ', with the total capped at the limit ChargeNode had set at the time, and after that the yearly plan (see “Limits” above)';

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
// v3: energy priced per quarter hour at SE4 spot + surcharge; grid energy fee
// from the bill. A v2 tariff keeps only its effektavgift settings.
const TARIFF_KEY = 'emgk.tariff.v3';
const OLD_TARIFF_KEY = 'emgk.tariff.v2';

function loadTariff() {
  try {
    const saved = JSON.parse(localStorage.getItem(TARIFF_KEY) || 'null');
    if (saved && typeof saved === 'object') return { ...DEFAULT_TARIFF, ...saved };
    const old = JSON.parse(localStorage.getItem(OLD_TARIFF_KEY) || 'null');
    if (old && typeof old === 'object') return { ...DEFAULT_TARIFF, krPerKw: old.krPerKw ?? DEFAULT_TARIFF.krPerKw, peakCount: old.peakCount ?? DEFAULT_TARIFF.peakCount };
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
    <label title="Which limit to apply to the chargers. Actual: what ChargeNode had configured at the time, then the yearly plan (26 Oct: whole facility ≤ 25 kW; 1 Mar: chargers ≤ 43.5 kW). What-if: other values on the same dates.">Limits
      <select id="${prefix}-limits">
        <option value="actual" ${o.limits === 'actual' ? 'selected' : ''}>Actual + yearly plan</option>
        <option value="seasonal" ${seasonal ? 'selected' : ''}>What-if: season / winter</option>
        <option value="none" ${o.limits === 'none' ? 'selected' : ''}>None</option>
      </select></label>
    <label class="seasonal-only" ${seasonal ? '' : 'hidden'} title="What-if, season (1 Mar – 25 Oct): the chargers together may draw at most this.">Season, chargers ≤ <input type="number" id="${prefix}-cap" value="${o.capKw}" min="0" step="0.5"> kW</label>
    <label class="seasonal-only" ${seasonal ? '' : 'hidden'} title="What-if, winter (26 Oct – 28 Feb): the whole facility may draw at most this; the chargers get what the rest of the club leaves. 36 A is about 25 kW.">Winter, whole facility ≤ <input type="number" id="${prefix}-winter" value="${o.winterCapKw}" min="0" step="0.5"> kW</label>`;
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
        `<span class="limit-chip chargers">Season (1 Mar – 25 Oct): chargers ≤ ${fmtNum(o.capKw, 1)} kW</span>`,
        `<span class="limit-chip facility">Winter (26 Oct – 28 Feb): whole facility ≤ ${fmtNum(o.winterCapKw, 1)} kW, chargers get what is left</span>`,
      ]
      : [
        ...LIMIT_HISTORY.map((l) => `<span class="limit-chip ${l.kind}" title="${esc(l.note)}">from ${esc(limitDate(l.from))}: ${esc(l.label)}</span>`),
        `<span class="limit-chip plan" title="The club asks ChargeNode to switch on these dates every year.">then every year: 1 Mar ${esc(SEASON_PLAN.season.label)} · 26 Oct ${esc(SEASON_PLAN.winter.label)}</span>`,
      ];
  return `<div class="limits-legend"><span class="subtle">Limits:</span> ${items.join(' ')} ${fuse} <span class="limit-chip tariff">Effektavgift ${fmtNum(o.krPerKw, 0)} kr/kW</span> <a href="#guide">what do these mean?</a></div>`;
}

// The limits of a month: every setting in force during it, with the date a
// change took effect when there was one.
function limitCellHtml(limits) {
  const list = (Array.isArray(limits) ? limits : [limits]).filter(Boolean);
  if (!list.length) return '<span class="subtle">none</span>';
  return list.map((l, i) => `<span class="limit-chip ${l.kind}"${l.note ? ` title="${esc(l.note)}"` : ''}>${list.length > 1 && i > 0 && l.from ? `from ${esc(limitDate(l.from))}: ` : ''}${esc(l.label)}${l.planned && dayStart(l.from) > Date.now() ? ' (planned)' : ''}</span>`).join(' ');
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

// The hours' quarter-hour spot prices for one installation (hourlySpot in
// meter.js), worked out once per installation and price series.
const spotCache = new WeakMap();
function spotFor(inst, eon) {
  const spot = eon?.spot;
  if (!inst || !spot?.values?.length) return null;
  const hit = spotCache.get(inst);
  if (hit?.spot === spot) return hit.result;
  const result = hourlySpot(inst, spot);
  spotCache.set(inst, { spot, result });
  return result;
}

// One sentence on how energy was priced in `months` (monthlyMeter rows) and
// what the timing of the club's use was worth against the plain average spot.
function spotNote(months, spot, t) {
  if (!spot?.values?.length) return 'No spot prices in the data yet, so energy is priced at the flat price.';
  const priced = months.filter((m) => m.spot);
  const hours = months.reduce((s, m) => s + m.hours, 0);
  const spotHours = priced.reduce((s, m) => s + m.spot.hours, 0);
  const kwh = priced.reduce((s, m) => s + m.kwh, 0);
  const paid = kwh > 0 ? priced.reduce((s, m) => s + (m.spot.paidOre ?? 0) * m.kwh, 0) / kwh : null;
  const plain = spotHours ? priced.reduce((s, m) => s + m.spot.averageOre * m.spot.hours, 0) / spotHours : null;
  const timing = priced.reduce((s, m) => s + m.spot.timingKr, 0) * (1 + t.vatPct / 100);
  const source = spot.source === 'demo' ? 'made-up demo prices' : `SE4 spot from ${esc(spot.source)}, one price per quarter since 1 Oct 2025 and per hour before`;
  const missing = hours - spotHours;
  return `Energy is priced per quarter hour: each quarter’s measured kWh at its spot price (${source}), plus the surcharge; the grid energy fee follows the quarter prices from 2027.${paid !== null ? ` In these months the club paid <strong>${fmtNum(paid, 1)} öre/kWh</strong> spot on average against a plain average of ${fmtNum(plain, 1)} öre, so the timing of its use ${timing >= 0 ? 'cost' : 'saved'} about <strong>${fmtMoney(Math.abs(timing), 'SEK')}</strong> incl. VAT compared with using the same energy evenly.` : ''}${missing > 0 ? ` ${fmtNum(missing, 0)} hour(s) without a spot price use the flat price.` : ''}`;
}

// Every charge record and the meter values, loaded once (refreshed every five
// minutes when running locally) and shared by the tabs. They also give the
// cars' charging power, which the model would otherwise have to assume.
let inputsCache = null;
async function loadMeterInputs() {
  if (!inputsCache || (!state.snapshotMode && Date.now() - inputsCache.at > 5 * 60_000)) {
    const promise = Promise.all([
      api('/api/eon'),
      api(`/api/cdrs?date_from=${encodeURIComponent(HISTORY_START.toISOString())}`).catch(() => ({ items: [] })),
    ]).then(([eon, cdrs]) => ({ eon, records: cdrs.items || [] }));
    inputsCache = { at: Date.now(), promise };
    promise.catch(() => {
      inputsCache = null;
    });
  }
  const inputs = await inputsCache.promise;
  applyRateEstimate(inputs);
  return inputs;
}

// Measured from the meter when there are enough clean plug-ins, otherwise
// from short charge records; null when neither has enough data.
function estimateRate({ eon, records }) {
  const fromRecords = rateFromRecords(records);
  const inst = eon?.configured ? (eon.installations || []).find((i) => i.hourly) : null;
  const fromMeter = inst ? rateFromMeter(meterHours(inst), records, { minRateKw: fromRecords?.kw ?? 7.4 }) : null;
  return fromMeter || fromRecords;
}

function applyRateEstimate(inputs) {
  if (state.rate.estimate === undefined) state.rate.estimate = estimateRate(inputs);
  if (state.rate.auto && state.rate.estimate) {
    state.analysis.options = { ...state.analysis.options, rateKw: Math.round(state.rate.estimate.kw * 10) / 10 };
  }
}

function rateSourceText() {
  const e = state.rate.estimate;
  if (!state.rate.auto) return 'set by hand';
  if (!e) return 'the default, since there is too little data to measure it';
  return e.source === 'meter'
    ? `measured: the median step in the facility meter when a car plugs in on its own (${e.n} sessions; the middle half ${fmtNum(e.low, 1)}–${fmtNum(e.high, 1)} kW)`
    : `estimated from ${e.n} short sessions that charged the whole time they were plugged in`;
}

function rateControlHtml(prefix, o) {
  return `<label title="Power one car draws while it is actually charging. ChargeNode only reports energy per session, so this decides how long each session's energy took to deliver. Auto: measured from the meter (or the charge records); untick to try another value.">Car charges at <input type="number" id="${prefix}-rate" value="${o.rateKw}" min="1" max="22" step="0.1" ${state.rate.auto ? 'disabled' : ''}> kW</label>
    <label title="${esc(rateSourceText())}"><input type="checkbox" id="${prefix}-rate-auto" ${state.rate.auto ? 'checked' : ''}> auto${state.rate.auto && state.rate.estimate ? ` (${state.rate.estimate.source === 'meter' ? 'from the meter' : 'from the records'})` : ''}</label>`;
}

function bindRateControl(prefix) {
  $(`#${prefix}-rate-auto`)?.addEventListener('change', (event) => {
    $(`#${prefix}-rate`).disabled = event.target.checked;
  });
}

function readRateControl(prefix) {
  state.rate.auto = $(`#${prefix}-rate-auto`).checked;
  const typed = Number($(`#${prefix}-rate`).value);
  if (state.rate.auto && state.rate.estimate) return Math.round(state.rate.estimate.kw * 10) / 10;
  return typed > 0 ? typed : ANALYSIS_DEFAULTS.rateKw;
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
  const rows = splitHours(meter, chargerProfile, rangeMs, o, spotFor(inst, eon));
  const allRows = splitHours(meter, chargerProfile, null, o, spotFor(inst, eon)); // the peak-timing card uses every year
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
      hint: `${months.length} month${months.length === 1 ? '' : 's'}, from the meter values, energy priced per quarter hour at SE4 spot${months.some((x) => x.partial) ? ' · includes partial months' : ''}`,
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
    ${peakTimingHtml(allRows)}
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
        <label title="Elhandel on top of the quarter-hour spot price: the retailer's surcharge, fees and certificates, excl. VAT. The default is fitted to E.ON's bill for Jul 2025 – Jun 2026.">Surcharge on spot <input type="number" name="surchargeOre" value="${t.surchargeOre}" step="0.1"> öre/kWh</label>
        <label title="Elhandel for hours without a spot price in the snapshot, excl. VAT">Flat energy <input type="number" name="retailOre" value="${t.retailOre}" step="0.1" min="0"> öre/kWh</label>
        <label title="E.ON Elnät energiavgift until 2026, excl. VAT. From 2027 it is 6.40 öre plus 12.1 % of the quarter-hour spot price, worked out per hour here.">Grid energy <input type="number" name="transferOre" value="${t.transferOre}" step="0.1" min="0"> öre/kWh</label>
        <label title="Energiskatt, excl. VAT">Energy tax <input type="number" name="energyTaxOre" value="${t.energyTaxOre}" step="0.1" min="0"> öre/kWh</label>
        <label title="E.ON Elnät fast avgift per month, excl. VAT">Fixed <input type="number" name="fixedKr" value="${t.fixedKr}" step="1" min="0"> kr/month</label>
        <label title="Effektavgift per kW of the month's billed peak, excl. VAT">Effekt <input type="number" name="krPerKw" value="${t.krPerKw}" step="1" min="0"> kr/kW</label>
        ${peakCountSelectHtml('meter-peaks', t.peakCount).replace('id="meter-peaks"', 'id="meter-peaks" name="peakCount"')}
        <label>VAT <input type="number" name="vatPct" value="${t.vatPct}" step="1" min="0"> %</label>
        <button type="submit" class="primary">Recalculate</button>
        <button type="button" id="meter-tariff-reset">Defaults</button>
      </form>
      <div class="subtle">${spotNote(months, eon.spot, t)} The defaults come from E.ON’s bill for Jul 2025 – Jun 2026; change them to match a new invoice (saved in this browser only). E.ON also sells this breakdown from the actual invoices (49 kr/month); this is the free estimate from the meter values.</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Month</th><th class="num" title="Spot price the club paid (each quarter weighted by its kWh) and the month's plain average spot, öre/kWh excl. VAT">Spot paid / average</th><th class="num">Energy</th><th class="num">Grid energy</th><th class="num">Energy tax</th><th class="num">Effektavgift</th><th class="num">Fixed</th><th class="num">Total</th><th class="num">Chargers’ share</th><th class="num">Charging revenue</th><th class="num">Chargers net</th></tr></thead>
        <tbody>${months.map((x) => {
          const vat = 1 + t.vatPct / 100;
          return `<tr>
            <td>${esc(monthLabel(x.month))}${x.partial ? ' <span class="subtle">(partial)</span>' : ''}</td>
            <td class="num" title="${x.spot ? `timing ${fmtSigned(x.spot.timingKr * vat, 'SEK')} against using the same energy evenly through the month` : 'no spot prices'}">${x.spot ? `${fmtNum(x.spot.paidOre, 1)} / ${fmtNum(x.spot.averageOre, 1)}` : '–'}</td>
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
        }).join('') || '<tr><td colspan="11" class="empty">No meter values in this range</td></tr>'}</tbody>
      </table></div>
      <div class="subtle">“Chargers’ share” is what the club would not have paid without the chargers: their energy at the per-kWh prices, plus the effektavgift they added (the billed peak with them minus the billed peak without them). ${sum.overEstimateHours ? `In ${sum.overEstimateHours} hour(s) the charger model estimated more than the meter measured, or more than a whole-facility ceiling left room for; the chargers’ part was cut to what was possible there.` : ''} “Hours over the ceiling” are hours where the whole facility averaged above the ceiling: the rest of the club alone, since the chargers get nothing then.</div>
    </div>`;

  drawPowerChart($('#meter-power'), points, { hourly });
  drawPeakTiming(allRows);
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

// ------------------------------------------------------- when are the peaks
// When in the day the facility's peaks happen, and which of the club's loads
// probably cause them. Only the total is measured; the chargers' part is
// estimated and the rest is inferred from timing (see facility.js).
const CONFIDENCE_TEXT = {
  measured: 'measured',
  estimated: 'estimated',
  likely: 'likely',
  possible: 'possible',
  unknown: 'unclear',
};

function confidenceChip(confidence) {
  return `<span class="conf conf-${esc(confidence)}">${esc(CONFIDENCE_TEXT[confidence] || confidence)}</span>`;
}

const hourRange = ([from, to]) => `${String(from).padStart(2, '0')}–${String(to).padStart(2, '0')}`;

function causeHtml(cause) {
  const kw = cause.key === 'chargers' ? ` ≈ ${fmtNum(cause.kw, 0)} kW` : cause.key === 'irrigation' ? ' ≈ 19 kW' : '';
  return `${esc(loadLabel(cause.key))}${kw} ${confidenceChip(cause.confidence)}`;
}

function peakTimingHtml(rows) {
  if (!rows.length) return '';
  const tops = monthlyTopHours(rows, 3).filter((t) => t.complete);
  if (!tops.length) return '';
  const explained = tops.map((t) => ({ ...t, why: explainPeak(t, { isWinter }) }));
  const share = (f) => Math.round((explained.filter(f).length / explained.length) * 100);
  const nightSeason = share((t) => !t.why.winter && inHours(t.why.hour, [22, 3]));
  const day = share((t) => inHours(t.why.hour, [9, 15]));
  const withChargers = share((t) => t.chargerKw >= 1);
  const firstMonth = explained[0].month;
  const lastMonth = explained.at(-1).month;
  const firsts = explained.filter((t) => t.rank === 1);
  return `
    <div class="card" id="peak-timing-card">
      <div class="card-head"><h3>When do the peaks happen, and what causes them?</h3><span class="subtle">every complete month with meter values, ${esc(monthLabel(firstMonth))} – ${esc(monthLabel(lastMonth))}</span></div>
      <div class="notice warn"><h3>How sure is this?</h3>Only the <strong>total</strong> is measured: E.ON’s meter sees the whole facility as one number per hour. The chargers’ part is <strong>estimated</strong> from their charge records. Everything else is <strong>inferred from the time of day and season</strong>, using the loads described in the club’s energy analysis (July 2026). No other load is metered separately, so a label means “fits the timing and size”, not “measured”. ${confidenceChip('likely')} timing and size both match the analysis · ${confidenceChip('possible')} the timing matches, but other loads run then too · ${confidenceChip('unknown')} no load in the analysis explains it.</div>
      <p>Of the three highest hours in each month, <strong>${nightSeason}%</strong> fell at night between 22 and 03 in the season, which is when the irrigation pumps run, and <strong>${day}%</strong> in the daytime between 09 and 15. The chargers were running in <strong>${withChargers}%</strong> of them.</p>
      <div class="grid typical-days">
        <div><div class="card-head"><h3>A typical day in the season</h3><span class="subtle">1 Mar – 25 Oct</span></div><div class="chart" id="typical-season"></div></div>
        <div><div class="card-head"><h3>A typical day in winter</h3><span class="subtle">26 Oct – 28 Feb</span></div><div class="chart" id="typical-winter"></div></div>
      </div>
      <div class="series-legend">
        <span><i class="swatch other"></i>Rest of the club, average kW</span>
        <span><i class="swatch chargers"></i>Chargers, average kW (estimated)</span>
        <span><i class="swatch p95"></i>Rest of the club on a busy day (95th percentile)</span>
        <span><i class="swatch base"></i>Base load ≈ ${fmtNum(BASE_LOAD_KW, 1)} kW</span>
        <span><i class="swatch band"></i>When a load probably runs</span>
      </div>
      <div class="card-head" style="margin-top:12px"><h3>At what time of day the monthly peaks happened</h3><span class="subtle">the 3 highest hours of every month, ${explained.length} hours</span></div>
      <div class="chart" id="peak-hours"></div>
      <div class="series-legend">
        <span><i class="swatch chargers"></i>Chargers were running</span>
        <span><i class="swatch other"></i>No charging</span>
        <span><i class="swatch band"></i>When a load probably runs</span>
      </div>
      <details><summary>The highest hour of each month and its likely cause (${firsts.length} months)</summary>
        <div class="table-wrap"><table>
          <thead><tr><th>Month</th><th>Hour</th><th class="num">Measured</th><th class="num">Above base load</th><th>Likely cause</th></tr></thead>
          <tbody>${firsts.slice().reverse().map((t) => `<tr>
            <td>${esc(monthLabel(t.month))}</td>
            <td>${esc(new Date(t.at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }))} ${esc(hourLabel(t.why.hour))}</td>
            <td class="num">${fmtNum(t.meterKw, 1)} kW</td>
            <td class="num">${fmtNum(t.why.aboveBaseKw, 1)} kW</td>
            <td>${t.why.causes.map(causeHtml).join('<br>')}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </details>
      <details><summary>The loads, as described in the energy analysis</summary>
        <div class="table-wrap"><table>
          <thead><tr><th>Load</th><th>When</th><th>What we know</th><th>Confidence</th></tr></thead>
          <tbody>${FACILITY_LOADS.map((l) => `<tr><td>${esc(l.label)}</td><td>${l.hours ? `${hourRange(l.hours)}${l.season === 'all' ? '' : `, ${l.season === 'winter' ? 'winter' : 'season'}`}` : 'around the clock'}</td><td>${esc(l.detail)}</td><td>${confidenceChip(l.confidence)}</td></tr>`).join('')}</tbody>
        </table></div>
      </details>
    </div>`;
}

function drawPeakTiming(rows) {
  if (!$('#peak-timing-card')) return;
  const season = typicalDay(rows, (r) => !isWinter(r.at));
  const winter = typicalDay(rows, (r) => isWinter(r.at));
  const maxKw = Math.max(...[...season, ...winter].map((h) => Math.max(h.otherP95, h.otherAvg + h.chargersAvg)));
  const bands = (s) => FACILITY_LOADS.filter((l) => l.hours && l.season === s);
  drawTypicalDay($('#typical-season'), season, bands('season'), maxKw);
  drawTypicalDay($('#typical-winter'), winter, bands('winter'), maxKw);
  drawPeakHours($('#peak-hours'), monthlyTopHours(rows, 3).filter((t) => t.complete));
}

// Background bands for the hours a load probably runs, with its label on top.
function loadBands(loads, x, pad, H, slot) {
  return loads.map((l, row) => {
    const [from, to] = l.hours;
    const spans = from <= to ? [[from, to]] : [[from, 24], [0, to]];
    const rects = spans.map(([a, b]) => `<rect class="load-band" x="${x(a)}" y="${pad.t}" width="${(b - a) * slot}" height="${H - pad.t - pad.b}"></rect>`).join('');
    const [a, b] = spans[0];
    const season = l.season === 'all' ? '' : l.season === 'winter' ? ' (winter)' : ' (season)';
    // A band near the right edge gets its label right-aligned so it is not cut off.
    const right = a >= 16;
    return `${rects}<text class="tick band-label" x="${right ? x(b) - 3 : x(a) + 3}" y="${pad.t - 6 - row * 13}" text-anchor="${right ? 'end' : 'start'}">${esc(l.label)}${season} · ${esc(CONFIDENCE_TEXT[l.confidence])}</text>`;
  }).join('');
}

function drawTypicalDay(container, day, bands, maxKw) {
  if (!container) return;
  const W = 480;
  const H = 250;
  const pad = { l: 34, r: 6, t: 32, b: 22 };
  const { y, grid, base } = kwFrame(maxKw, W, H, pad);
  const slot = (W - pad.l - pad.r) / 24;
  const x = (h) => pad.l + h * slot;
  const bars = day.map((h, i) => {
    const bx = x(i) + 1;
    const w = slot - 2;
    const p95 = `<line class="p95-mark" x1="${bx}" x2="${bx + w}" y1="${y(h.otherP95)}" y2="${y(h.otherP95)}"></line>`;
    const label = i % 3 === 0 ? `<text class="tick" x="${bx + w / 2}" y="${H - 6}" text-anchor="middle">${String(i).padStart(2, '0')}</text>` : '';
    return `<g data-index="${i}"><rect class="bar-hit" x="${x(i)}" y="${pad.t}" width="${slot}" height="${base - pad.t}"></rect>${stackedBar(bx, w, y, base, h.otherAvg, h.chargersAvg, false)}${p95}${label}</g>`;
  }).join('');
  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Average power per clock hour, rest of the club and chargers">
    ${loadBands(bands, x, pad, H, slot)}${grid}
    <line class="axis-line" x1="${pad.l}" x2="${W - pad.r}" y1="${base}" y2="${base}"></line>
    ${bars}
    <line class="base-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y(BASE_LOAD_KW)}" y2="${y(BASE_LOAD_KW)}"></line>
  </svg>`;
  attachTooltip(container, (i) => {
    const h = day[i];
    return `<strong>${hourLabel(i)}–${hourLabel((i + 1) % 24)}</strong>rest of the club ${fmtNum(h.otherAvg, 1)} kW on average, ${fmtNum(h.otherP95, 1)} kW on a busy day<br>chargers ${fmtNum(h.chargersAvg, 1)} kW on average (estimated)<br>${h.n} hours measured`;
  });
}

function drawPeakHours(container, tops) {
  if (!container) return;
  const counts = Array.from({ length: 24 }, () => ({ with: 0, without: 0, months: [] }));
  for (const t of tops) {
    const c = counts[new Date(t.at).getHours()];
    if (t.chargerKw >= 1) c.with += 1;
    else c.without += 1;
    c.months.push(t.month);
  }
  const W = 960;
  const H = 230;
  const bands = FACILITY_LOADS.filter((l) => l.hours);
  const pad = { l: 34, r: 10, t: 14 + bands.length * 13, b: 22 };
  const max = Math.max(1, ...counts.map((c) => c.with + c.without));
  const step = max > 10 ? 5 : max > 4 ? 2 : 1;
  const top = Math.ceil(max / step) * step;
  const y = (v) => H - pad.b - (v / top) * (H - pad.t - pad.b);
  const base = H - pad.b;
  const slot = (W - pad.l - pad.r) / 24;
  const x = (h) => pad.l + h * slot;
  const grid = Array.from({ length: top / step + 1 }, (_, i) => i * step).map((v) => `<line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"></line><text class="tick" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('');
  const bars = counts.map((c, i) => {
    const bx = x(i) + 3;
    const w = slot - 6;
    return `<g data-index="${i}"><rect class="bar-hit" x="${x(i)}" y="${pad.t}" width="${slot}" height="${base - pad.t}"></rect>${stackedBar(bx, w, y, base, c.without, c.with, false)}<text class="tick" x="${bx + w / 2}" y="${H - 6}" text-anchor="middle">${String(i).padStart(2, '0')}</text></g>`;
  }).join('');
  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Number of monthly peak hours per clock hour, with and without charging">
    ${loadBands(bands, x, pad, H, slot)}${grid}
    <line class="axis-line" x1="${pad.l}" x2="${W - pad.r}" y1="${base}" y2="${base}"></line>
    ${bars}
  </svg>`;
  attachTooltip(container, (i) => {
    const c = counts[i];
    const n = c.with + c.without;
    return `<strong>${hourLabel(i)}–${hourLabel((i + 1) % 24)}: ${n} peak hour${n === 1 ? '' : 's'}</strong>${c.with} with the chargers running, ${c.without} without${n ? `<br>${esc([...new Set(c.months)].map((m) => monthLabel(m, 'short')).join(', '))}` : ''}`;
  });
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

  // The limit: one continuous line per period with the same setting (so the
  // dash pattern shows; one short piece per bar looked solid), dashed for a
  // charger limit, dotted for a whole-facility ceiling, labelled at its end.
  const runs = [];
  points.forEach((p, i) => {
    if (!p.limitKw) return;
    const last = runs.at(-1);
    if (last && last.kw === p.limitKw && last.kind === p.limitKind && last.to === i) last.to = i + 1;
    else runs.push({ kw: p.limitKw, kind: p.limitKind, from: i, to: i + 1 });
  });
  let limitPath = '';
  let facilityPath = '';
  const limitLabels = runs.map((r) => {
    const x1 = pad.l + r.from * slot;
    const x2 = pad.l + r.to * slot;
    const seg = `M${x1},${y(r.kw)} H${x2}`;
    if (r.kind === 'facility') facilityPath += seg;
    else limitPath += seg;
    const text = r.kind === 'facility' ? `whole facility ≤ ${fmtNum(r.kw, 1)} kW` : `chargers ≤ ${fmtNum(r.kw, 1)} kW`;
    return x2 - x1 > 90 ? `<text class="tick limit-label" x="${x2 - 4}" y="${y(r.kw) - 5}" text-anchor="end">${esc(text)}</text>` : '';
  }).join('');

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
    ${limitLabels}
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

// ------------------------------------------------------------------ economics
// Is charging profitable, what does the system cost a year, did lowering the
// peaks pay, and is the price right. The maths lives in economics.js.
const COSTS_KEY = 'emgk.costs.v2'; // v2: ChargeNode's fee became known (60 kr/outlet/month)

function loadCosts() {
  try {
    const saved = JSON.parse(localStorage.getItem(COSTS_KEY) || 'null');
    if (saved && typeof saved === 'object') return { ...DEFAULT_COSTS, ...saved };
  } catch {
    // storage blocked: defaults
  }
  return { ...DEFAULT_COSTS };
}

function saveCosts(costs) {
  try {
    localStorage.setItem(COSTS_KEY, JSON.stringify(costs));
  } catch {
    // not saved; applies until reload
  }
}

function economicsPeriods(records) {
  const ref = referenceTime();
  const thisMonth = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const yearAgo = new Date(thisMonth);
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  const periods = [{ key: 'last12', label: `Last 12 full months (${monthLabel(dayKey(yearAgo).slice(0, 7))} – ${monthLabel(dayKey(thisMonth.getTime() - DAY_MS).slice(0, 7))})`, from: yearAgo.getTime(), to: thisMonth.getTime() }];
  const years = [...new Set(records.map((r) => new Date(r.start).getFullYear()))].sort((a, b) => b - a);
  for (const y of years) {
    const to = Math.min(new Date(y + 1, 0, 1).getTime(), new Date(ref.getFullYear(), ref.getMonth() + 1, 1).getTime());
    const first = y === years.at(-1) ? Math.max(new Date(y, 0, 1).getTime(), new Date(Math.min(...records.map((r) => Date.parse(r.start)))).setDate(1)) : new Date(y, 0, 1).getTime();
    periods.push({ key: String(y), label: `${y}${y === ref.getFullYear() ? ' so far' : ''}`, from: new Date(first).setHours(0, 0, 0, 0), to });
  }
  return periods;
}

async function renderEconomics() {
  const root = $('#view-economics');
  const o = state.analysis.options;
  const t = state.meter.tariff;
  const costs = state.economics.costs;
  root.innerHTML = `
    <div class="view-head"><h2>Economics</h2><span class="subtle">What the chargers earn and cost, what this system costs a year, whether lowering the peaks paid, and whether the price is right</span></div>
    <div id="economics-body"><div class="loading">Calculating...</div></div>`;
  const body = $('#economics-body');
  let eon;
  let records;
  try {
    ({ eon, records } = await loadMeterInputs());
    if (!state.chargerCount) await loadLocationLabels();
  } catch (err) {
    body.innerHTML = errorHtml(err);
    return;
  }
  const points = state.chargerCount || ANALYSIS_DEFAULTS.chargers;
  const profile = hourlyProfile(records, o);
  const chargerMonths = monthlyPeaks(profile, { ...o, krPerKw: t.krPerKw, peakCount: t.peakCount, now: referenceTime().getTime() });
  const inst = eon?.configured ? (eon.installations || []).find((i) => i.hourly) : null;
  let meterMonths = [];
  let savings = [];
  let meterRows = [];
  let unlimitedProfile = null;
  if (inst) {
    const rows = splitHours(meterHours(inst), profile, null, o, spotFor(inst, eon));
    meterMonths = monthlyMeter(rows, { tariff: t, revenue: revenueByMonth(records), now: referenceTime().getTime(), capOptions: o });
    unlimitedProfile = hourlyProfile(records, { ...o, limits: 'none' });
    meterRows = rows;
    savings = limitSavings(rows, unlimitedProfile, { krPerKw: t.krPerKw });
  }
  const periods = economicsPeriods(records);
  const accounts = periods.map((p) => ({ period: p, acc: account({ records, period: p, tariff: t, costs, points, chargerMonths, meterMonths }) }));
  const last12 = accounts[0].acc;
  const price = last12.avgPrice ? Math.round(last12.avgPrice * 100) / 100 : 5;
  const advice = priceAdvice(last12, { currentPrice: price, krPerKw: t.krPerKw });
  const cnUnknown = !costs.chargeNodePerPointMonth && !costs.chargeNodeSharePct && !costs.chargeNodeOrePerKwh;
  const maxChargerPeak = chargerMonths.reduce((best, m) => (m.peakKw > (best?.peakKw ?? -1) ? m : best), null);

  const money = (v) => fmtMoney(v, 'SEK');
  const row = (label, f, cls = '') => `<tr class="${cls}"><td>${label}</td>${accounts.map(({ acc }) => `<td class="num">${f(acc)}</td>`).join('')}</tr>`;
  const effektCell = (acc) => (acc.effekt.measured !== null
    ? `${money(acc.effekt.expected)}<div class="subtle">${acc.effekt.measuredMonths} of ${acc.months} months measured</div>`
    : `0 – ${money(acc.effekt.worst)}<div class="subtle">not measured yet</div>`);

  body.innerHTML = `
    ${cnUnknown ? '<div class="notice warn"><h3>ChargeNode’s fee is missing</h3>ChargeNode does not publish what it charges site owners. Enter the fee from the contract under <em>Costs</em> below (per charging point and month, a share of the revenue, or per kWh); until then the results leave it out.</div>' : ''}
    <div class="card">
      <div class="card-head"><h3>Is ${fmtNum(price, 1)} kr/kWh the right price?</h3><span class="subtle">last 12 full months · incl. VAT</span></div>
      <div class="notice ${advice.level === 'ok' ? '' : advice.level === 'bad' ? 'error' : 'warn'}"><h3>${advice.level === 'ok' ? '<span class="ok">✓ Covers the costs</span>' : advice.level === 'bad' ? '<span class="bad">✕ Does not cover the costs</span>' : '⚠️ Covers the costs unless the chargers add a lot to the peaks'}</h3>${esc(advice.text)} ${esc(advice.market)}</div>
      <div class="chart" id="economics-ladder"></div>
      <div class="subtle">Break-even: the price per kWh incl. VAT at which the charging revenue exactly pays for the electricity (last 12 months ${fmtNum(last12.kwh > 0 ? (last12.energyCost / last12.kwh) * 100 : t.retailOre + t.transferOre + t.energyTaxOre, 0)} öre/kWh excl. VAT: contract, grid energy fee and tax${meterMonths.some((x) => x.spot) ? ", priced at the quarter-hour spot prices of the hours the cars charged in" : ""}), ChargeNode, this system${costs.targetMarginOre ? ` and a margin of ${fmtNum(costs.targetMarginOre, 0)} öre/kWh` : ''}, with three assumptions for the effektavgift the chargers add. The market band is public AC charging in Sweden in 2026.</div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Accounts</h3><span class="subtle">kr excl. VAT unless stated · the club pays 1 kr of every 5 kr/kWh on to the state as VAT</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th></th>${accounts.map(({ period }) => `<th class="num">${esc(period.label)}</th>`).join('')}</tr></thead>
        <tbody>
          ${row('Charging sessions', (a) => fmtNum(a.sessions, 0))}
          ${row('Energy charged', (a) => `${fmtNum(a.kwh, 0)} kWh`)}
          ${row('Average price incl. VAT', (a) => (a.avgPrice ? `${fmtNum(a.avgPrice, 2)} kr/kWh` : '–'))}
          ${row('<strong>Revenue</strong> (excl. VAT)', (a) => `<strong>${money(a.revenue)}</strong>`)}
          ${row('− Electricity (energy, transfer, tax)', (a) => money(-a.energyCost))}
          ${row(`− ChargeNode${costs.chargeNodePerPointMonth ? ` (${fmtNum(costs.chargeNodePerPointMonth, 0)} kr/outlet/month × ${points})` : ''}`, (a) => (cnUnknown ? '<span class="subtle">fee missing</span>' : money(-a.chargeNode)))}
          ${row(`− This system (E.ON API ${fmtNum(costs.eonMeterKrMonth + costs.eonCostsKrMonth, 0)} kr/month from ${monthLabel(costs.systemSince || '2026-11')}${costs.otherKrYear ? ', other' : ''})`, (a) => money(-a.system))}
          ${row('= Before the effektavgift', (a) => `<strong>${money(a.net.none)}</strong>`, 'subtotal')}
          ${row('− Effektavgift the chargers added', (a) => effektCell(a))}
          ${row('<strong>= Result</strong>', (a) => (a.effekt.measured !== null
            ? `<strong class="${a.net.expected >= 0 ? 'ok' : 'bad'}">${money(a.net.expected)}</strong>`
            : `<strong>${money(a.net.worst)} … ${money(a.net.none)}</strong><div class="subtle">worst case … no effektavgift</div>`), 'total')}
          ${row('Break-even price incl. VAT', (a) => (a.breakEven.none !== null ? (a.effekt.measured !== null ? `${fmtNum(a.breakEven.expected, 2)} kr` : `${fmtNum(a.breakEven.none, 2)} – ${fmtNum(a.breakEven.worst, 2)} kr`) : '–'))}
        </tbody>
      </table></div>
      <div class="subtle">The effektavgift the chargers added is measured from E.ON’s meter values where they exist: the billed peak with the chargers minus the billed peak without them, × ${fmtNum(t.krPerKw, 0)} kr/kW. Without meter values it is shown as a range: from nothing (the chargers never ran in the club’s peak hour) to the worst case (their own monthly peak always landed on top of the club’s). Electricity prices come from the <a href="#meter">Meter</a> tab’s tariff.</div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Did lowering the peaks pay?</h3></div>
      ${savingsHtml(savings, chargerMonths, maxChargerPeak, t)}
    </div>

    <div class="card">
      <div class="card-head"><h3>Is the winter ceiling worth the e-mail?</h3><span class="subtle">26 Oct – 28 Feb, whole facility ≤ ${fmtNum(SEASON_PLAN.winter.kw, 1)} kW</span></div>
      ${winterCheckHtml(meterRows, unlimitedProfile, t, last12)}
    </div>

    <div class="card">
      <div class="card-head"><h3>Switch the chargers off at night?</h3><span class="subtle">so they never run with the irrigation pumps</span></div>
      ${nightOffHtml(meterRows, t, last12)}
    </div>

    <div class="card">
      <div class="card-head"><h3>What can be negotiated in the electricity contracts?</h3><span class="subtle">${esc(BILL_SOURCE)} · kr excl. VAT</span></div>
      ${contractsHtml(meterRows)}
    </div>

    <div class="card">
      <div class="card-head"><h3>Solar</h3></div>
      <p>The roofs have been modelled from Lantmäteriet’s laser scans: about 33 kWp fits on the office and the studio, used almost entirely by the club itself. The 3D model, the numbers per building and the payback are on the <a href="#solar">Solar</a> tab.</p>
    </div>

    <div class="card">
      <div class="card-head"><h3>Costs</h3><span class="subtle">kr excl. VAT · saved in this browser</span></div>
      <form class="filters tariff-form" id="economics-costs">
        <label title="ChargeNode's fixed fee per charging point and month, from the contract">ChargeNode <input type="number" name="chargeNodePerPointMonth" value="${costs.chargeNodePerPointMonth}" step="1" min="0"> kr/point/month</label>
        <label title="Share of the charging revenue (excl. VAT) ChargeNode keeps">+ <input type="number" name="chargeNodeSharePct" value="${costs.chargeNodeSharePct}" step="0.5" min="0"> % of revenue</label>
        <label title="ChargeNode fee per kWh, if the contract has one">+ <input type="number" name="chargeNodeOrePerKwh" value="${costs.chargeNodeOrePerKwh}" step="1" min="0"> öre/kWh</label>
        <label title="E.ON Energidata, mätvärden">E.ON meter values <input type="number" name="eonMeterKrMonth" value="${costs.eonMeterKrMonth}" step="1" min="0"> kr/month</label>
        <label title="E.ON Energidata, kostnadsuppdelning: 49 kr/month if bought">E.ON cost breakdown <input type="number" name="eonCostsKrMonth" value="${costs.eonCostsKrMonth}" step="1" min="0"> kr/month</label>
        <label title="Anything else a year. GitHub Actions and Pages are free within the current plan.">Other <input type="number" name="otherKrYear" value="${costs.otherKrYear}" step="10" min="0"> kr/year</label>
        <label title="Margin wanted on top of all costs, for the break-even price">Margin <input type="number" name="targetMarginOre" value="${costs.targetMarginOre}" step="5" min="0"> öre/kWh</label>
        <button type="submit" class="primary">Recalculate</button>
        <button type="button" id="economics-reset">Defaults</button>
      </form>
      <div class="subtle">This system: E.ON meter values ${fmtMoney(costs.eonMeterKrMonth * 12, 'SEK')}/year${costs.eonCostsKrMonth ? ` + cost breakdown ${fmtMoney(costs.eonCostsKrMonth * 12, 'SEK')}/year` : ''}; GitHub (hourly job and the published site) costs nothing: Actions is free for public repositories. Electricity prices and the effektavgift are set on the <a href="#meter">Meter</a> tab.</div>
    </div>`;

  drawPriceLadder($('#economics-ladder'), last12, price);
  $('#economics-costs').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const next = { ...state.economics.costs };
    for (const key of Object.keys(DEFAULT_COSTS)) {
      const value = Number(form.get(key));
      if (form.has(key) && Number.isFinite(value) && value >= 0) next[key] = value;
    }
    state.economics.costs = next;
    saveCosts(next);
    renderEconomics();
  });
  $('#economics-reset').addEventListener('click', () => {
    state.economics.costs = { ...DEFAULT_COSTS };
    saveCosts(state.economics.costs);
    renderEconomics();
  });
}

function savingsHtml(savings, chargerMonths, maxChargerPeak, t) {
  const modelNote = maxChargerPeak
    ? `<p>From the charge records alone: the chargers’ own highest hour was <strong>${fmtNum(maxChargerPeak.peakKw, 1)} kW</strong> (${esc(monthLabel(maxChargerPeak.month))}), so the charger limits of 57 and 43.5 kW never actually cut them. A saving can only come from where the chargers’ load lands relative to the rest of the club, which is what the whole-facility ceiling of 25 kW (from 2 Nov 2026) acts on, and that needs the E.ON meter values to measure.</p>`
    : '';
  if (!savings.length) return `${modelNote}<p class="subtle">No meter values from E.ON yet; this table fills in once the hourly job has read them.</p>`;
  const total = savings.reduce((s, m) => s + m.savedKr, 0);
  const added = savings.reduce((s, m) => s + m.addedKr, 0);
  return `${modelNote}
    <p>With the meter values: in the months below the chargers added <strong>${fmtMoney(added, 'SEK')}</strong> to the effektavgift; without any limit they would have added <strong>${fmtMoney(added + total, 'SEK')}</strong>. The limits saved <strong>${fmtMoney(total, 'SEK')}</strong> (excl. VAT, ${fmtNum(t.krPerKw, 0)} kr/kW, the highest hour per month).</p>
    <details><summary>Per month (${savings.length} months)</summary>
    <div class="table-wrap"><table>
      <thead><tr><th>Month</th><th>Limit</th><th class="num">Peak without chargers</th><th class="num">Actual peak</th><th class="num">Peak if unlimited</th><th class="num">Chargers added</th><th class="num">Saved by the limit</th></tr></thead>
      <tbody>${savings.map((m) => `<tr>
        <td>${esc(monthLabel(m.month))}</td>
        <td>${limitCellHtml(m.limits)}</td>
        <td class="num">${fmtNum(m.withoutChargersKw, 1)} kW</td>
        <td class="num">${fmtNum(m.actualKw, 1)} kW</td>
        <td class="num">${fmtNum(m.unlimitedKw, 1)} kW</td>
        <td class="num">${fmtMoney(m.addedKr, 'SEK')}</td>
        <td class="num">${m.savedKr > 0 ? `<span class="ok">${fmtMoney(m.savedKr, 'SEK')}</span>` : fmtMoney(0, 'SEK')}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    </details>
    <div class="subtle">“If unlimited” puts the chargers’ unlimited estimate on top of the measured rest of the club. The demo and the first months are estimates; the comparison gets better with every month of meter values.</div>`;
}

// Each past winter: the effektavgift the ceiling saved against the charging
// it held back, and how other ceiling levels would have done last winter.
function winterCheckHtml(rows, unlimited, t, last12) {
  if (!rows.length || !unlimited) return '<p class="subtle">Needs the E.ON meter values; fills in once the hourly job has read them.</p>';
  const marginPerKwh = last12.kwh > 0 ? (last12.revenue - last12.energyCost) / last12.kwh : 0;
  const options = { krPerKw: t.krPerKw, marginPerKwh, now: referenceTime().getTime() };
  // Winters before the chargers existed say nothing.
  const winters = winterCeilingCheck(rows, unlimited, { ...options, ceilingKw: SEASON_PLAN.winter.kw }).filter((w) => w.chargedKwh > 0);
  if (!winters.length) return '<p class="subtle">No winter months with meter values yet.</p>';
  const complete = winters.filter((w) => w.complete);
  const latest = complete.at(-1) || winters.at(-1);
  const levels = [20, SEASON_PLAN.winter.kw, 30, 35].map((kw) => ({ kw, ...winterCeilingCheck(rows, unlimited, { ...options, ceilingKw: kw }).find((w) => w.winter === latest.winter) }));
  const best = levels.reduce((b, l) => (l.netKr > b.netKr ? l : b), levels[0]);
  const worth = complete.length && complete.every((w) => w.netKr > 0);
  const verdict = complete.length
    ? `<div class="notice ${worth ? '' : 'warn'}"><h3>${worth ? '<span class="ok">✓ Worth it</span>' : '⚠️ Not clearly worth it'}</h3>${complete.map((w) => `Winter ${esc(w.winter)}: ${fmtSigned(w.netKr, 'SEK')}`).join(' · ')}. The e-mail takes five minutes; the ceiling saves the effektavgift the chargers would add on top of the club’s winter peak, and costs at most the margin on the charging it holds back.${best.kw !== SEASON_PLAN.winter.kw && best.netKr > levels[1].netKr + 200 ? ` Last winter ${fmtNum(best.kw, 0)} kW would have done better (${fmtSigned(best.netKr, 'SEK')}).` : ''}</div>`
    : '<p class="subtle">No complete winter with meter values yet.</p>';
  return `${verdict}
    <div class="table-wrap"><table>
      <thead><tr><th>Winter</th><th class="num">Charged</th><th class="num">Effektavgift added, no ceiling</th><th class="num">With the ceiling</th><th class="num">Saved</th><th class="num">Charging held back</th><th class="num">Margin on it (at most)</th><th class="num">Net</th></tr></thead>
      <tbody>${winters.map((w) => `<tr>
        <td>${esc(w.winter)}${w.complete ? '' : ' <span class="subtle">(so far)</span>'}</td>
        <td class="num">${fmtNum(w.chargedKwh, 0)} kWh</td>
        <td class="num">${fmtMoney(w.addedWithoutKr, 'SEK')}</td>
        <td class="num">${fmtMoney(w.addedWithKr, 'SEK')}</td>
        <td class="num">${fmtMoney(w.savedKr, 'SEK')}</td>
        <td class="num">${fmtNum(w.heldKwh, 0)} kWh (${w.chargedKwh ? Math.round((w.heldKwh / w.chargedKwh) * 100) : 0}%)</td>
        <td class="num">${fmtMoney(-w.lostMarginKr, 'SEK')}</td>
        <td class="num"><strong class="${w.netKr >= 0 ? 'ok' : 'bad'}">${fmtSigned(w.netKr, 'SEK')}</strong></td>
      </tr>`).join('')}</tbody>
    </table></div>
    <div class="subtle">Other ceilings in winter ${esc(latest.winter)}: ${levels.map((l) => `${fmtNum(l.kw, 0)} kW ${fmtSigned(l.netKr, 'SEK')}`).join(' · ')}. The chargers’ demand is their unlimited estimate from the charge records, on top of the measured rest of the club. Held-back charging is often only delayed (cars stay plugged in for hours), so its margin (${fmtNum(marginPerKwh, 2)} kr/kWh, revenue minus electricity) is the most the ceiling can cost.</div>`;
}

function nightOffHtml(rows, t, last12) {
  if (!rows.length) return '<p class="subtle">Needs the E.ON meter values.</p>';
  const marginPerKwh = last12.kwh > 0 ? (last12.revenue - last12.energyCost) / last12.kwh : 0;
  const windows = [[22, 6], [23, 6], [21, 7]].map(([from, to]) => nightOffCheck(rows, { from, to, krPerKw: t.krPerKw, marginPerKwh }));
  const main = windows[0];
  const worth = main.netPerYear > 0;
  return `
    <div class="notice ${worth ? '' : 'warn'}"><h3>${worth ? '<span class="ok">✓ Worth it</span>' : '✕ Not worth it on the data so far'}</h3>
      Off between 22 and 06 would have saved <strong>${fmtMoney(main.savedPerYear, 'SEK')} a year</strong> in effektavgift (${fmtMoney(main.savedKr, 'SEK')} over ${main.months} months${main.savingMonths.length ? `, all in ${esc(main.savingMonths.map((m) => monthLabel(m.month)).join(', '))}` : ''}), against up to <strong>${fmtMoney(main.lostPerYear, 'SEK')} a year</strong> of charging margin lost (${fmtNum(main.nightShare * 100, 1)}% of all charging happens then). The costly peaks with the chargers are in the <strong>daytime</strong>, when golfers are on the course: at night the chargers have almost never landed in the month’s peak hour, even in the irrigation season.</div>
    <div class="table-wrap"><table>
      <thead><tr><th>Chargers off</th><th class="num">Effektavgift saved / year</th><th class="num">Charging at night</th><th class="num">Margin lost / year (at most)</th><th class="num">Net / year</th></tr></thead>
      <tbody>${windows.map((w) => `<tr><td>${String(w.from).padStart(2, '0')}–${String(w.to).padStart(2, '0')}</td><td class="num">${fmtMoney(w.savedPerYear, 'SEK')}</td><td class="num">${fmtNum(w.nightKwh, 0)} kWh (${fmtNum(w.nightShare * 100, 1)}%)</td><td class="num">${fmtMoney(-w.lostPerYear, 'SEK')}</td><td class="num"><strong class="${w.netPerYear >= 0 ? 'ok' : 'bad'}">${fmtSigned(w.netPerYear, 'SEK')}</strong></td></tr>`).join('')}</tbody>
    </table></div>
    <p class="subtle">Night charging is mostly guests who leave the car overnight (camping, cabins). A night stop would turn them away for little gain; the measures that pay are aimed at the daytime peaks: the whole-facility ceiling in the season (issue #6) and the winter ceiling above.</p>
    <p><strong>Can we set the schedule ourselves in ChargeNode?</strong> ChargeNode has said in e-mails that a power schedule for the chargers can be set, with a lower limit at certain times of day (for example one ceiling in the daytime and another in the evening). So far they have set every change on request; whether the club can change the schedule itself in the ChargeNode portal is not confirmed. Ask ChargeNode for that access when sending the next limit e-mail.</p>`;
}

// The spot price the club paid over [from, to): each hour's quarter-weighted
// price weighted again by the hour's kWh. Null when under 90 % of the energy
// in the period has a price.
function paidSpot(rows, from, to) {
  const a = new Date(`${from}T00:00:00`).getTime();
  const b = new Date(`${to}T00:00:00`).getTime();
  let kwh = 0;
  let priced = 0;
  let ore = 0;
  for (const r of rows) {
    if (r.at < a || r.at >= b) continue;
    kwh += r.meterKw;
    if (r.spotOre === null || r.spotOre === undefined) continue;
    priced += r.meterKw;
    ore += r.spotOre * r.meterKw;
  }
  return kwh > 0 && priced / kwh >= 0.9 ? ore / priced : null;
}

function contractsHtml(rows = []) {
  const [now, before] = BILL;
  const total = billTotal(now);
  const ore = (kr) => (kr / now.kwh) * 100;
  const retailOre = ore(now.retail);
  const retailOreBefore = (before.retail / before.kwh) * 100;
  const spotOre = paidSpot(rows, now.from, now.to);
  const spotBefore = paidSpot(rows, before.from, before.to);
  const split = spotOre !== null
    ? ` Priced quarter by quarter on the meter values, the spot part of that was <strong>${fmtNum(spotOre, 1)} öre/kWh</strong>${spotBefore !== null ? ` (${fmtNum(spotBefore, 1)} the year before)` : ''}, so E.ON’s surcharge, fees and certificates came to about <strong>${fmtNum(retailOre - spotOre, 1)} öre/kWh</strong>${spotBefore !== null ? ` (${fmtNum(retailOreBefore - spotBefore, 1)} the year before)` : ''}: ${fmtMoney(((retailOre - spotOre) * now.kwh) / 100, 'SEK')} a year. That is the number to compare with other retailers’ offers.`
    : '';
  const sensitivity = [2, 5, 10].map((o) => `${o} öre/kWh less = <strong>${fmtMoney((now.kwh * o) / 100, 'SEK')}</strong> a year`);
  return `
    <p>Over ${esc(now.period)} the facility used <strong>${fmtNum(now.kwh, 0)} kWh</strong> and the bill came to <strong>${fmtMoney(total, 'SEK')}</strong> excl. VAT (${fmtNum(total / now.kwh, 2)} kr/kWh). Only the electricity contract is open to negotiation:</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Part</th><th class="num">kr</th><th class="num">Share</th><th class="num">öre/kWh</th><th>Negotiable?</th><th>How to lower it</th></tr></thead>
      <tbody>${BILL_PARTS.map((p) => `<tr><td>${esc(p.label)}</td><td class="num">${fmtMoney(now[p.key], 'SEK')}</td><td class="num">${Math.round((now[p.key] / total) * 100)}%</td><td class="num">${fmtNum(ore(now[p.key]), 1)}</td><td>${p.negotiable === 'yes' ? '<span class="ok">Yes</span>' : 'No'}</td><td class="subtle">${esc(p.how)}</td></tr>`).join('')}</tbody>
    </table></div>
    <p><strong>The grid (E.ON Elnät): no rebate to negotiate.</strong> The grid is a monopoly and its tariffs are regulated by Energimarknadsinspektionen; E.ON must charge every customer on the same tariff the same way, so a discount on the nätavgift is not possible. What the club controls is the monthly peak (${Math.round((now.effekt / total) * 100)}% of the bill), and whether the tariff and fuse size still fit, which is worth checking with E.ON Elnät if the peaks fall a lot.</p>
    <p><strong>The electricity contract: worth comparing.</strong> It is the largest part, ${Math.round((now.retail / total) * 100)}% of the bill, and averaged <strong>${fmtNum(retailOre, 1)} öre/kWh</strong> (${fmtNum(retailOreBefore, 1)} öre the year before). That covers the quarter-hour spot price plus E.ON’s surcharge, fees and certificates, and it follows the market, so it cannot be compared with a fixed price directly. What can be compared is the <strong>surcharge and the fixed fees</strong> on a spot-price contract.${split} Ask E.ON what they are on the current P15M contract, then get offers from a few other retailers for the same kind of contract. Every öre counts across the year: ${sensitivity.join(' · ')}.</p>
    <p class="subtle">A fixed price only pays if the market rises; with a spot price the club also benefits from the cheap hours, especially with a battery or solar later. The quarter-hour price means each 15 minutes is priced separately, so moving flexible loads (golf carts, the irrigation start) to cheap quarters also helps a little.</p>
    ${grid2027Html(now, spotOre)}`;
}

// The 2027 grid price list applied to the last 12 months' usage. The spot
// share of the energy fee uses the spot the club paid quarter by quarter
// (spotOre); without it, the contract's average price as an upper bound (it
// includes the retailer's surcharge).
function grid2027Html(now, spotOre = null) {
  const g = GRID_2027;
  const kwMonths = now.effekt / g.krPerKw2026;
  const effekt27 = kwMonths * g.krPerKw;
  const fixed27 = g.fixedKrMonth * 12;
  const retailOre = (now.retail / now.kwh) * 100;
  const energyOre27 = g.energyOre + (g.energySpotPct / 100) * (spotOre ?? retailOre);
  const energy27 = (now.kwh * energyOre27) / 100;
  const nowEnergyOre = (now.gridEnergy / now.kwh) * 100;
  const rows = [
    ['Effektavgift', `${fmtNum(g.krPerKw2026, 2)} kr/kW`, `${fmtNum(g.krPerKw, 2)} kr/kW`, now.effekt, effekt27],
    ['Grid energy fee', `${fmtNum(nowEnergyOre, 1)} öre/kWh (measured)`, `${fmtNum(g.energyOre, 2)} öre + ${fmtNum(g.energySpotPct, 1)} % of spot ≈ ${fmtNum(energyOre27, 1)} öre`, now.gridEnergy, energy27],
    ['Fixed fee', `${fmtNum(g.fixedKrMonth2026, 0)} kr/month`, `${fmtNum(g.fixedKrMonth, 0)} kr/month`, now.gridFixed, fixed27],
  ];
  const before = rows.reduce((s, r) => s + r[3], 0);
  const after = rows.reduce((s, r) => s + r[4], 0);
  return `
    <h3 style="margin-top:14px">From ${esc(limitDate(g.from))}: E.ON Elnät’s 2027 prices (${esc(g.tariff)})</h3>
    <ul>${g.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
    <div class="table-wrap"><table>
      <thead><tr><th>Grid part</th><th>Now</th><th>2027</th><th class="num">Last 12 months</th><th class="num">Same usage, 2027 prices</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td><td class="num">${fmtMoney(r[3], 'SEK')}</td><td class="num">${fmtMoney(r[4], 'SEK')}</td></tr>`).join('')}
        <tr><td><strong>Grid in total</strong></td><td></td><td></td><td class="num"><strong>${fmtMoney(before, 'SEK')}</strong></td><td class="num"><strong>${fmtMoney(after, 'SEK')}</strong> (${fmtSigned(after - before, 'SEK')})</td></tr>
      </tbody>
    </table></div>
    <p>At the same usage and peaks the grid would cost about <strong>${fmtSigned(after - before, 'SEK')} a year</strong>, mostly from the higher effektavgift, so every kW cut from the peak is worth ${fmtNum(g.krPerKw * 12, 0)} kr a year instead of ${fmtNum(g.krPerKw2026 * 12, 0)} kr. The energy fee stays about the same on average, but now follows the spot price: electricity used in cheap quarters (nights, windy and sunny hours) is cheaper in both the contract and the grid fee, and expensive winter mornings cost more in both. <span class="subtle">${spotOre !== null ? `The spot share uses the spot price the club paid over these 12 months, quarter by quarter on the meter values (${fmtNum(spotOre, 1)} öre/kWh).` : `The spot share is estimated with the contract’s average price (${fmtNum(retailOre, 1)} öre/kWh), which includes the retailer’s surcharge, so the real 2027 energy fee should be a little lower.`}</span></p>
    <p class="subtle"><strong>Reactive power:</strong> ${esc(g.reactive)} The club has a 125 A fuse, so it pays nothing for reactive power, even with the irrigation pumps. Production above 43.5 kW will pay a grid energy fee from 2027, which matters for solar (below).</p>`;
}


// A price ladder: the break-even prices, the market band and the current price on one kr/kWh axis.
function drawPriceLadder(container, acc, price) {
  if (!container || acc.breakEven.none === null) return;
  const W = 960;
  const H = 150;
  const pad = { l: 20, r: 20, t: 30, b: 34 };
  const measured = acc.effekt.measured !== null;
  const marks = [
    { kr: acc.breakEven.none, label: 'break-even, no effektavgift', cls: 'other' },
    ...(measured ? [{ kr: acc.breakEven.expected, label: 'break-even, measured', cls: 'chargers' }] : []),
    { kr: acc.breakEven.worst, label: 'break-even, worst case', cls: 'chargers' },
  ];
  const max = Math.max(8, Math.ceil(Math.max(price, MARKET_BAND.high, ...marks.map((m) => m.kr)) + 0.5));
  const x = (kr) => pad.l + (Math.min(kr, max) / max) * (W - pad.l - pad.r);
  const y0 = pad.t + 40;
  const ticks = Array.from({ length: max + 1 }, (_, i) => `<line class="grid-line" x1="${x(i)}" x2="${x(i)}" y1="${pad.t}" y2="${y0 + 14}"></line><text class="tick" x="${x(i)}" y="${H - 12}" text-anchor="middle">${i} kr</text>`).join('');
  const band = `<rect class="market-band" x="${x(MARKET_BAND.low)}" y="${pad.t}" width="${x(MARKET_BAND.high) - x(MARKET_BAND.low)}" height="${y0 + 14 - pad.t}" rx="4"></rect><text class="tick" x="${(x(MARKET_BAND.low) + x(MARKET_BAND.high)) / 2}" y="${pad.t - 8}" text-anchor="middle">public AC charging ${fmtNum(MARKET_BAND.low, 2)}–${fmtNum(MARKET_BAND.high, 2)} kr</text>`;
  const dots = marks.map((m, i) => `<circle class="dot ${m.cls}" cx="${x(m.kr)}" cy="${y0}" r="6"></circle><text class="tick" x="${x(m.kr)}" y="${y0 - 12 - (i % 2) * 12}" text-anchor="middle">${esc(m.label)} ${fmtNum(m.kr, 2)}</text>`).join('');
  const current = `<line class="limit-line" x1="${x(price)}" x2="${x(price)}" y1="${pad.t}" y2="${y0 + 14}" style="stroke-dasharray:none"></line><text class="bar-label" x="${x(price) + 6}" y="${y0 + 14}">our price ${fmtNum(price, 2)}</text>`;
  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Break-even prices, the public price band and our price per kWh">${ticks}${band}<line class="axis-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y0}" y2="${y0}"></line>${dots}${current}</svg>`;
}

// ---------------------------------------------------------------------- solar
// Would solar panels pay? The roofs modelled from Lantmäteriet's laser data
// (tools/roof-solar → data/solar-roofs.json), a 3D model of the panels that
// fit, and the value worked out on the club's own consumption.
const SUGGESTED_ROOFS = ['kansli', 'studio']; // at the kanslipunkt, with capacity back to the meter
// The days whose sun path the 3D model draws (colours as in solar3d.js's SUN_DAYS).
const SUN_DAY_CHOICES = [
  { key: 'summer', label: '21 Jun', month: 6, day: 21, color: '#f5b700' },
  { key: 'equinox', label: '20 Mar / 23 Sep', month: 3, day: 20, color: '#d97706' },
  { key: 'winter', label: '21 Dec', month: 12, day: 21, color: '#92400e' },
];

// Value a year of a system of kwp producing kwh: the energy it replaces on
// site (exported above the simulated on-site share earns spot only, roughly
// a third), plus the effektavgift saving from the simulation, scaled by how
// well these roofs face the sun compared with the simulated east/west roof.
function solarValue(kwp, kwh) {
  const sim = SOLAR_SIMULATION;
  const pick = (k) => {
    const s = sim.sizes;
    if (kwp <= s[0].kwp) return (s[0][k] * kwp) / s[0].kwp;
    for (let i = 1; i < s.length; i += 1) {
      if (kwp <= s[i].kwp) {
        const t = (kwp - s[i - 1].kwp) / (s[i].kwp - s[i - 1].kwp);
        return s[i - 1][k] + t * (s[i][k] - s[i - 1][k]);
      }
    }
    return (s.at(-1)[k] * kwp) / s.at(-1).kwp;
  };
  const yieldRatio = kwp > 0 ? kwh / kwp / sim.genericYield : 0;
  const onSite = Math.min(1, pick('onSite'));
  const energy = kwh * (onSite * sim.krPerKwhOnSite + (1 - onSite) * sim.krPerKwhOnSite * 0.35);
  const effekt = pick('effektKr') * yieldRatio;
  return { energy, effekt, total: energy + effekt, payback: sim.costPerKwp.map((c) => (energy + effekt > 0 ? (c * kwp) / (energy + effekt) : null)) };
}

// How much each roof, and the combinations, lower the monthly peak and the
// energy bill, from the per-roof simulation.
function solarEffektHtml(effekt, buildings, valueOf) {
  const name = (k) => (buildings.find((b) => b.key === k)?.name || k).replace(/ \(.*\)/, '');
  const label = (keys) => (keys.length === buildings.length ? 'All roofs' : keys.map(name).join(' + '));
  const rows = effekt.results.map((r) => ({ r, v: valueOf(r.keys) }));
  const sug = effekt.results.find((r) => r.keys.length === SUGGESTED_ROOFS.length && SUGGESTED_ROOFS.every((k) => r.keys.includes(k)));
  const singlesSum = SUGGESTED_ROOFS.reduce((t, k) => t + (effekt.results.find((r) => r.keys.length === 1 && r.keys[0] === k)?.effektKr || 0), 0);
  return `
    <div class="card">
      <div class="card-head"><h3>How much each roof lowers the peak</h3><span class="subtle">each roof face simulated with its own tilt and direction · weather ${esc(effekt.weatherYears)} · consumption ${esc(effekt.period)} · ${fmtNum(effekt.krPerKw, 2)} kr/kW</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Roofs</th><th class="num">kWp</th><th class="num">Summer peak lower by</th><th class="num">Effektavgift saved / yr</th><th class="num">Range (weather years)</th><th class="num">Energy saved / yr</th><th class="num">Used on site</th><th class="num">Total / yr</th>${effekt.actualWeather ? '<th class="num" title="The same roofs in the actual weather of the consumption year (SMHI STRÅNG), as a check on the typical-weather figures">In the actual weather</th>' : ''}<th class="num">Payback at 10k/kWp</th></tr></thead>
        <tbody>${rows.map(({ r, v }) => `<tr>
          <td>${r.keys.length > 1 ? '<strong>' : ''}${esc(label(r.keys))}${r.keys.length > 1 ? '</strong>' : ''}</td>
          <td class="num">${fmtNum(r.kwp, 1)}</td>
          <td class="num">${fmtNum(r.summerCutKw, 1)} kW</td>
          <td class="num">${fmtMoney(r.effektKr, 'SEK')}</td>
          <td class="num subtle">${fmtMoney(r.effektMin, 'SEK')}–${fmtMoney(r.effektMax, 'SEK')}</td>
          <td class="num">${fmtMoney(r.energyKr, 'SEK')}</td>
          <td class="num">${Math.round(r.onSite * 100)}%</td>
          <td class="num"><strong>${fmtMoney(v.total, 'SEK')}</strong></td>
          ${effekt.actualWeather ? `<td class="num subtle">${r.actual ? fmtMoney(r.actual.effektKr + r.actual.energyKr, 'SEK') : '–'}</td>` : ''}
          <td class="num">${fmtNum(v.payback[1], 1)} yrs</td>
        </tr>`).join('')}</tbody>
      </table></div>
      ${sug ? `<p>The effektavgift saving does not add up across roofs: the office and the studio alone would save ${fmtMoney(singlesSum, 'SEK')}, together ${fmtMoney(sug.effektKr, 'SEK')}. Once the panels cover the middle of the day, the month’s highest hour moves to the evening (chargers, the restaurant) or an irrigation night, where no roof helps. Month by month for the office and the studio:</p>
      <div class="table-wrap"><table>
        <thead><tr><th></th>${sug.months.map((m) => `<th class="num">${esc(monthLabel(m.month, 'short'))}</th>`).join('')}</tr></thead>
        <tbody>
          <tr><td>Peak lower by, kW</td>${sug.months.map((m) => `<td class="num">${fmtNum(m.cutKw, 1)}</td>`).join('')}</tr>
          <tr class="subtle"><td>range</td>${sug.months.map((m) => `<td class="num">${fmtNum(m.minKw, 1)}–${fmtNum(m.maxKw, 1)}</td>`).join('')}</tr>
        </tbody>
      </table></div>` : ''}
      <p class="subtle">The old office’s steep south roof does the most per kWp (it produces most around midday, when the peaks are), once its split roof is fixed and the new feeder cable is in (below). Ranges show the spread over the five weather years: whether the sun shines in the month’s peak hour decides most of it.${effekt.actualWeather ? ` “In the actual weather” runs the same roofs in the weather of the consumption year itself (${esc(effekt.actualWeather)}): it lands within about 10 % of the typical-year figures, so the verdict holds.` : ''} Everything is worked out per quarter hour: the measured quarter-hour consumption, the panels’ output per quarter, and the quarter-hour spot price; the effektavgift on the hourly mean bought, as E.ON bills it.</p>
    </div>`;
}

// The barn's asbestos roof and the old office's ridge beam: work the club has
// to pay for sooner or later, which panels on those roofs then help pay back.
function roofWorkHtml(buildings, valueOf) {
  const cost = SOLAR_SIMULATION.costPerKwp[1];
  const life = SOLAR_SIMULATION.lifeYears;
  // Years of full output over the life, with the panels slowly losing output.
  const keep = 1 - SOLAR_SIMULATION.degradationPct / 100;
  const lifeYearsOfOutput = (1 - keep ** life) / (1 - keep);
  const rows = Object.entries(ROOF_WORK.buildings).map(([key, w]) => {
    const b = buildings.find((x) => x.key === key);
    if (!b) return null;
    const area = b.faces.reduce((s, f) => s + (f.area_m2 || 0), 0);
    const roof = w.newRoofKrM2 ? [0, 1].map((i) => area * ((w.removalKrM2?.[i] || 0) + w.newRoofKrM2[i])) : null;
    const v = valueOf([key]);
    const panels = cost * b.kwp;
    const carries = v.total * lifeYearsOfOutput - panels; // roof work the savings repay within the panels' life
    return { b, w, area, roof, v, panels, carries, payback: panels / v.total, withRoof: roof ? roof.map((r) => (panels + r) / v.total) : null };
  }).filter(Boolean);
  if (!rows.length) return '';
  const barn = rows.find((r) => r.b.key === 'ladan');
  const old = rows.find((r) => r.b.key === 'gamla');
  // The feeder cable to the old office: the distance between the buildings
  // from the roof data, times the route factor, at the per-metre prices.
  const c = FEEDER_CABLE;
  const ends = [c.from, c.to].map((k) => buildings.find((x) => x.key === k));
  const straight = ends.every(Boolean) ? Math.hypot(ends[1].e - ends[0].e, ends[1].n - ends[0].n) : null;
  const cable = straight === null ? null : (() => {
    const route = c.routeFactor.map((f) => straight * f);
    const perM = [0, 1].map((i) => c.cableKrM[i] + c.ductKrM[i] + c.trenchKrM[i]);
    return { route, kr: [0, 1].map((i) => route[i] * perM[i] + c.fixedKr[i]) };
  })();
  const range = (a) => `${fmtMoney(a[0], 'SEK')}–${fmtMoney(a[1], 'SEK')}`;
  const name = (r) => esc(r.b.name.replace(/ \(.*\)/, ''));
  return `
    <div class="card">
      <div class="card-head"><h3>Roof work first: the barn and the old office</h3><span class="subtle">work the club has to pay for sooner or later · panels at ${fmtNum(cost / 1000, 0)}k kr/kWp · kr excl. VAT</span></div>
      <div class="notice"><h3>For the board</h3><ul>
        ${barn ? `<li><strong>The barn’s roof is eternit with asbestos</strong> and must be replaced whatever the club decides about solar; panels cannot be fixed to it without working on the asbestos, which needs a certified asbestos contractor. With panels on the new roof (${fmtNum(barn.b.kwp, 0)} kWp), the roof starts earning: about <strong>${fmtMoney(barn.v.total, 'SEK')} a year</strong> off the electricity bill.</li>` : ''}
        ${old ? `<li><strong>The old office’s roof is split</strong>: the ridge beam and the roof must be fixed. Once it is, and once the new aluminium feeder cable from the office building is in (the golf carts that charge at the old office need it anyway${cable ? `: about ${fmtNum(cable.route[0], 0)}–${fmtNum(cable.route[1], 0)} m, roughly ${range(cable.kr)}` : ''}), solar there is a cheap next step, right where the carts charge. The steep south roof does the most per kWp, and the carts’ lean-to on the north side takes a row more: ${fmtNum(old.b.kwp, 1)} kWp would save about <strong>${fmtMoney(old.v.total, 'SEK')} a year</strong>, pay back the panels in ${fmtNum(old.payback, 1)} years, and then carry about <strong>${fmtMoney(old.carries, 'SEK')}</strong> of the repair over ${life} years.</li>` : ''}
        <li>The repairs are costs the club takes sooner or later anyway. Done together with solar, they become <strong>investments that lower the bill</strong>: the money spent on the roofs comes back through cheaper electricity, and one job saves a second scaffold or lift.</li>
      </ul></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Building</th><th>Roof work</th><th class="num">Roof area</th><th class="num">Roof work, rough</th><th class="num">Panels</th><th class="num">Saved / yr</th><th class="num">Panels pay back</th><th class="num">Incl. the roof work</th><th class="num">Roof work the savings repay in ${life} yrs</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${name(r)}</td>
          <td class="subtle">${esc(r.w.work)}</td>
          <td class="num">${fmtNum(r.area, 0)} m²</td>
          <td class="num">${r.roof ? range(r.roof) : '<span class="subtle">quote needed</span>'}</td>
          <td class="num">${fmtNum(r.b.kwp, 1)} kWp, ${fmtMoney(r.panels, 'SEK')}</td>
          <td class="num"><strong>${fmtMoney(r.v.total, 'SEK')}</strong></td>
          <td class="num">${fmtNum(r.payback, 1)} yrs</td>
          <td class="num">${r.withRoof ? `${fmtNum(r.withRoof[0], 0)}–${fmtNum(r.withRoof[1], 0)} yrs` : '–'}</td>
          <td class="num">${fmtMoney(r.carries, 'SEK')}${r.roof ? ` <span class="subtle">(${r.carries >= r.roof[1] ? 'all of the roof work' : `${Math.round(Math.max(0, Math.min(1, r.carries / r.roof[1])) * 100)}–${Math.round(Math.max(0, Math.min(1, r.carries / r.roof[0])) * 100)} % of it`})</span>` : ''}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <p class="subtle">“Roof work the savings repay”: ${life} years of savings (the usual panel warranty), with the panels losing ${fmtNum(SOLAR_SIMULATION.degradationPct, 1)} % of their output a year, minus what the panels cost; today’s electricity prices, no interest. Barn roof prices from Swedish 2026 price guides, not quotes: asbestos removal and disposal ${ROOF_WORK.buildings.ladan.removalKrM2.join('–')} kr/m², a new metal roof with battens and underlay ${ROOF_WORK.buildings.ladan.newRoofKrM2.join('–')} kr/m² (${ROOF_WORK.sources.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)}</a>`).join(', ')}). ROT relief is for private persons, so not for the club. ${cable ? `Feeder cable: ${fmtNum(straight, 0)} m between the buildings × ${c.routeFactor.join('–')} for the route; aluminium cable 4×25–4×50 mm² ${c.cableKrM.join('–')} kr/m, duct ${c.ductKrM.join('–')} kr/m, the trench is already dug, and ${fmtMoney(c.fixedKr[0], 'SEK')}–${fmtMoney(c.fixedKr[1], 'SEK')} for terminations and a sub-panel (${c.sources.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)}</a>`).join(', ')}; the fixed part is an assumption). Ask the electrician to size it for the panels as well: a size up costs little, and the trench is open now. ` : ''}${barn ? `The barn’s panels would export about ${Math.round((1 - barn.v.sim?.onSite) * 100) || 20} % of their output at the spot price, so they pay best together with more daytime use or a battery.` : ''}</p>
    </div>`;
}

// ---- for installers: positions, roof faces, electrical facts, downloads ----
// SWEREF 99 TM (Lantmäteriet's national grid) -> WGS 84 latitude/longitude,
// Gauss–Krüger inverse with Lantmäteriet's published parameters (GRS 80,
// central meridian 15°, scale 0.9996, false easting 500 000 m).
function sweref99tmToWgs84(n, e) {
  const a = 6378137.0;
  const f = 1 / 298.257222101;
  const e2 = f * (2 - f);
  const nn = f / (2 - f);
  const aRoof = (a / (1 + nn)) * (1 + nn ** 2 / 4 + nn ** 4 / 64);
  const d1 = nn / 2 - (2 * nn ** 2) / 3 + (37 * nn ** 3) / 96 - nn ** 4 / 360;
  const d2 = nn ** 2 / 48 + nn ** 3 / 15 - (437 * nn ** 4) / 1440;
  const d3 = (17 * nn ** 3) / 480 - (37 * nn ** 4) / 840;
  const d4 = (4397 * nn ** 4) / 161280;
  const aStar = e2 + e2 ** 2 + e2 ** 3 + e2 ** 4;
  const bStar = -(7 * e2 ** 2 + 17 * e2 ** 3 + 30 * e2 ** 4) / 6;
  const cStar = (224 * e2 ** 3 + 889 * e2 ** 4) / 120;
  const dStar = -(4279 * e2 ** 4) / 1260;
  const xi = n / (0.9996 * aRoof);
  const eta = (e - 500000) / (0.9996 * aRoof);
  const xiP = xi - d1 * Math.sin(2 * xi) * Math.cosh(2 * eta) - d2 * Math.sin(4 * xi) * Math.cosh(4 * eta) - d3 * Math.sin(6 * xi) * Math.cosh(6 * eta) - d4 * Math.sin(8 * xi) * Math.cosh(8 * eta);
  const etaP = eta - d1 * Math.cos(2 * xi) * Math.sinh(2 * eta) - d2 * Math.cos(4 * xi) * Math.sinh(4 * eta) - d3 * Math.cos(6 * xi) * Math.sinh(6 * eta) - d4 * Math.cos(8 * xi) * Math.sinh(8 * eta);
  const phiStar = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
  const dLambda = Math.atan(Math.sinh(etaP) / Math.cos(xiP));
  const s = Math.sin(phiStar);
  const lat = phiStar + s * Math.cos(phiStar) * (aStar + bStar * s ** 2 + cStar * s ** 4 + dStar * s ** 6);
  return { lat: (lat * 180) / Math.PI, lon: 15 + (dLambda * 180) / Math.PI };
}

// A CSV file for Swedish Excel: semicolons, decimal commas, a byte-order mark.
function downloadCsv(filename, header, rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : typeof v === 'number' ? String(v).replace('.', ',') : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = `﻿${header.join(';')}\n${rows.map((r) => r.map(cell).join(';')).join('\n')}`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const faceNote = (f) => [
  f.described ? `described, not measured: ${f.described}` : '',
  // The tool reports 0 kWh/kWp where no panel fits at all.
  !f.panels && f.kwh_per_kwp > 0 ? `too little sun for panels${f.roof_tilt > 60 ? ' (almost vertical)' : /N/.test(f.direction) ? ' (north-facing)' : ''}` : '',
  !f.panels && !f.kwh_per_kwp ? 'too small or too steep for panels' : '',
  f.obstacle_m2 ? `${fmtNum(f.obstacle_m2, 1)} m² kept free (bulge or chimney)` : '',
].filter(Boolean).join('; ');

// Collapsed by default: the facts an installer needs for a quote.
function installerHtml(data, buildings) {
  const site = buildings.map((b) => ({ b, ...sweref99tmToWgs84(b.n, b.e) }));
  const faces = buildings.flatMap((b) => b.faces.filter((f) => f.area_m2 >= 4).map((f) => ({ b, f })));
  const bill = BILL[0];
  return `
    <div class="card" id="solar-installers">
      <details>
        <summary><strong>For installers: positions, roof faces and the grid connection</strong> <span class="subtle">for a quote; to be checked on a site visit</span></summary>
        <p>Emmaboda Golfklubb’s buildings, the roof faces measured from Lantmäteriet’s laser scans, and the facts about the grid connection. Use <strong>All roofs</strong> above to see every building in 3D.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Building</th><th>Position (WGS 84)</th><th>SWEREF 99 TM (N, E)</th><th class="num">Panels</th><th class="num">kWp</th><th>Roof</th></tr></thead>
          <tbody>${site.map(({ b, lat, lon }) => `<tr>
            <td>${SUGGESTED_ROOFS.includes(b.key) ? '<strong>' : ''}${esc(b.name)}${SUGGESTED_ROOFS.includes(b.key) ? '</strong>' : ''}</td>
            <td class="mono"><a href="https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&amp;mlon=${lon.toFixed(6)}#map=19/${lat.toFixed(6)}/${lon.toFixed(6)}" target="_blank" rel="noopener">${lat.toFixed(5)}, ${lon.toFixed(5)}</a></td>
            <td class="mono">${b.n}, ${b.e}</td>
            <td class="num">${b.panels}</td><td class="num">${fmtNum(b.kwp, 1)}</td>
            <td class="subtle">${esc(b.roof)}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Building</th><th>Roof face</th><th class="num">Faces (azimuth)</th><th class="num">Pitch</th><th class="num">Area</th><th class="num">Usable</th><th class="num">Panels</th><th class="num">kWp</th><th class="num">kWh per kWp</th><th>Note</th></tr></thead>
          <tbody>${faces.map(({ b, f }) => `<tr>
            <td>${esc(b.name.replace(/ \(.*\)/, ''))}</td>
            <td>${f.flat ? 'flat' : esc(f.direction)}${f.described ? ' (lean-to)' : ''}</td>
            <td class="num">${f.flat ? '–' : `${fmtNum(f.azimuth, 0)}°`}</td>
            <td class="num">${fmtNum(f.roof_tilt, 0)}°</td>
            <td class="num">${fmtNum(f.area_m2, 0)} m²</td>
            <td class="num">${fmtNum(f.usable_m2, 0)} m²</td>
            <td class="num">${f.panels || '–'}</td>
            <td class="num">${f.panels ? fmtNum(f.kwp, 1) : '–'}</td>
            <td class="num">${f.panels ? fmtNum(f.kwh_per_kwp, 0) : '–'}</td>
            <td class="subtle">${esc(faceNote(f))}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        <p class="subtle">Azimuth from north (90° east, 180° south). Area is the sloping roof area; usable is what is left 0.5 m from the edges and clear of bulges and the chimney. Panels in the model: ${fmtNum(data.panel.wp, 0)} Wp, ${fmtNum(data.panel.w, 2)} × ${fmtNum(data.panel.h, 2)} m. Edges are good to about ±0.5 m; vents, skylights and tree shade are not in the laser data.</p>
        <h3 style="margin-top:14px">The connection</h3>
        <ul>
          <li><strong>Grid:</strong> E.ON Elnät, tariff ${esc(GRID_2027.tariff)} (400 V, effect tariff), price area SE4; main fuse 125 A. Production above 43.5 kW pays a grid energy fee from 2027, so the export should stay below that.</li>
          <li><strong>Connection point:</strong> the office building’s distribution point (kanslipunkt), which feeds back to the meter. The office building and the studio are next to it; whether it can take about 30 kW must be confirmed with the club’s electrician.</li>
          <li><strong>Old office:</strong> a new aluminium cable from the office building is about to be laid (the trench is dug); it can be sized for panels on the old office.</li>
          <li><strong>Consumption:</strong> ${fmtNum(bill.kwh, 0)} kWh over ${esc(bill.period)}, most of it in the daytime in the golf season, so nearly all of an office + studio system would be used on site. The measured consumption per quarter hour can be downloaded below.</li>
        </ul>
        <h3 style="margin-top:14px">Please price</h3>
        <ul>
          <li>A turnkey system on the office building and the studio (about 30 kWp), as a price per kWp excl. VAT: panels, inverter, mounting, cabling, installation and grid notification, with scaffolding or lift stated separately.</li>
          <li>As options: the old office (about 12 kWp, once its roof is repaired) and the barn (about 90 kWp on a new roof after asbestos removal).</li>
          <li>The inverter’s warranty and expected life, and what a replacement would cost.</li>
        </ul>
        <div class="filters">
          <button id="solar-csv-faces">Download the roof faces (CSV)</button>
          <button id="solar-csv-consumption">Download consumption per quarter hour, last 12 months (CSV)</button>
          <span id="solar-csv-note" class="subtle"></span>
        </div>
      </details>
    </div>`;
}

function bindInstallerDownloads(data, buildings) {
  $('#solar-csv-faces')?.addEventListener('click', () => {
    const rows = buildings.flatMap((b) => {
      const p = sweref99tmToWgs84(b.n, b.e);
      return b.faces.filter((f) => f.area_m2 >= 4).map((f) => [
        b.name, Number(p.lat.toFixed(6)), Number(p.lon.toFixed(6)), b.n, b.e,
        f.flat ? 'flat' : f.direction, f.flat ? '' : f.azimuth, f.roof_tilt, f.area_m2, f.usable_m2,
        f.panels, f.kwp, f.panels ? f.kwh_per_kwp : '', f.kwh_year, faceNote(f),
      ]);
    });
    downloadCsv('emmaboda-gk-roof-faces.csv', ['building', 'lat_wgs84', 'lon_wgs84', 'n_sweref99tm', 'e_sweref99tm', 'faces', 'azimuth_deg', 'pitch_deg', 'area_m2', 'usable_m2', `panels_${data.panel.wp}wp`, 'kwp', 'kwh_per_kwp', 'kwh_year', 'note'], rows);
  });
  $('#solar-csv-consumption')?.addEventListener('click', async () => {
    const note = $('#solar-csv-note');
    note.textContent = 'Loading the meter values…';
    try {
      const { eon } = await loadMeterInputs();
      const inst = (eon?.installations || []).find((i) => i.quarter);
      if (!inst) throw new Error('no quarter-hour meter values');
      const quarters = [...expandSeries(inst.quarter).entries()].sort((x, y) => x[0] - y[0]);
      const from = quarters.at(-1)[0] - 365 * DAY_MS;
      const local = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const rows = quarters.filter(([t]) => t > from).map(([t, kwh]) => [local.format(t), new Date(t).toISOString(), Math.round(kwh * 1000) / 1000, Math.round(kwh * 4 * 100) / 100]);
      downloadCsv('emmaboda-gk-consumption-per-quarter-hour.csv', ['start_swedish_time', 'start_utc', 'kwh', 'average_kw'], rows);
      note.textContent = `${fmtNum(rows.length, 0)} quarter hours, the whole facility as E.ON measures it.`;
    } catch (err) {
      note.textContent = `Could not load the meter values (${err.message}).`;
    }
  });
}

async function renderSolar() {
  const root = $('#view-solar');
  state.solar ||= { show: 'suggested', data: null, view: null, sunDay: 'summer', sunHour: 13 };
  const s = state.solar;
  if (!s.data) {
    root.innerHTML = '<div class="loading">Loading the roof model...</div>';
    try {
      const res = await fetch('data/solar-roofs.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      s.data = await res.json();
    } catch (err) {
      root.innerHTML = `<div class="notice error"><h3>No roof model</h3>${esc(err.message)}</div>`;
      return;
    }
  }
  if (s.effekt === undefined) {
    // The per-roof simulation (tools/roof-solar → data/solar-effekt.json); optional.
    s.effekt = await fetch('data/solar-effekt.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }
  const buildings = s.data.buildings.filter((b) => !b.error);
  const pick = (keys) => buildings.filter((b) => keys.includes(b.key));
  const sum = (bs, k) => bs.reduce((t, b) => t + b[k], 0);
  // Simulated value of a set of roofs: from the per-roof simulation when it
  // has that set, otherwise estimated from the generic east/west simulation.
  const simOf = (keys) => s.effekt?.results.find((r) => r.keys.length === keys.length && keys.every((k) => r.keys.includes(k))) || null;
  const valueOf = (keys) => {
    const bs = pick(keys);
    const kwp = sum(bs, 'kwp');
    const sim = simOf(keys);
    if (!sim) return { ...solarValue(kwp, sum(bs, 'kwh_year')), kwp, kwh: sum(bs, 'kwh_year'), simulated: false };
    const total = sim.effektKr + sim.energyKr;
    return { energy: sim.energyKr, effekt: sim.effektKr, total, kwp, kwh: sim.kwh, sim, simulated: true, payback: SOLAR_SIMULATION.costPerKwp.map((c) => (c * kwp) / total) };
  };
  const suggested = pick(SUGGESTED_ROOFS);
  const sugVal = valueOf(SUGGESTED_ROOFS);
  const sugKwp = sugVal.kwp;
  const sugKwh = sugVal.kwh;
  const allKeys = buildings.map((b) => b.key);
  const allVal = valueOf(allKeys);
  const allKwp = allVal.kwp;
  const allKwh = sum(buildings, 'kwh_year');
  const yrs = (v) => v.payback.map((p) => (p ? fmtNum(p, 1) : '–')).join(' / ');
  const cost = SOLAR_SIMULATION.costPerKwp.map((c) => `${fmtNum(c / 1000, 0)}k`).join(' / ');
  const kind = (f) => (f.flat ? 'flat' : !f.worth_it ? 'too little sun' : f.direction);

  root.innerHTML = `
    <div class="view-head"><h2>Solar</h2><span class="subtle">Would solar panels pay? The club’s roofs modelled from Lantmäteriet’s laser scans, and the value worked out on the club’s own consumption</span></div>
    <div class="notice"><h3><span class="ok">✓ Yes, about ${fmtNum(sugKwp, 0)} kWp on the office and the studio</span></h3>
      ${suggested.map((b) => `${esc(b.name.replace(/ \(.*\)/, ''))} ${b.panels} panels (${fmtNum(b.kwp, 1)} kWp)`).join(' and ')}: about <strong>${fmtNum(sugKwh, 0)} kWh a year</strong>, practically all used by the club itself, worth about <strong>${fmtMoney(sugVal.total, 'SEK')} a year</strong> (${fmtMoney(sugVal.energy, 'SEK')} electricity not bought, ${fmtMoney(sugVal.effekt, 'SEK')} lower effektavgift). Payback <strong>${yrs(sugVal)} years</strong> at ${cost} kr per installed kWp. Both buildings are at the office’s distribution point, which has capacity back to the meter.</div>
    <div class="card">
      <div class="card-head"><h3>The roofs and the panels that fit</h3><span class="spacer"></span>
        <span class="filters" id="solar-show">
          <button class="chip ${s.show === 'suggested' ? 'active' : ''}" data-show="suggested">Suggested: office + studio</button>
          <button class="chip ${s.show === 'all' ? 'active' : ''}" data-show="all">All roofs</button>
        </span>
      </div>
      <div id="solar-3d" class="solar-3d"><div class="loading">Loading the 3D model...</div></div>
      <div class="series-legend">
        <span><i class="swatch" style="background:#eb6834"></i>South-facing</span>
        <span><i class="swatch" style="background:#2a78d6"></i>East</span>
        <span><i class="swatch" style="background:#1baf7a"></i>West</span>
        <span><i class="swatch" style="background:#eda100"></i>Flat</span>
        <span><i class="swatch" style="background:#8a6fd1"></i>North, low pitch</span>
        <span><i class="swatch" style="background:#b0aea6"></i>Too little sun</span>
        <span><i class="swatch" style="background:#0d2a52"></i>Panel</span>
        <span class="subtle">Drag to turn, scroll or pinch to zoom.</span>
      </div>
      <div class="filters solar-sun" id="solar-sun">
        <span class="subtle">Sun path:</span>
        ${SUN_DAY_CHOICES.map((d) => `<button class="chip ${s.sunDay === d.key ? 'active' : ''}" data-sun-day="${d.key}"><i class="swatch" style="background:${d.color}"></i>${esc(d.label)}</button>`).join('')}
        <label class="sun-time">Time <input type="range" id="solar-sun-time" min="3" max="23" step="0.25" value="${s.sunHour}"> <span id="solar-sun-clock" class="mono"></span></label>
        <button id="solar-sun-play" title="Run through the day">▶ Day</button>
        <span id="solar-sun-readout" class="subtle"></span>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Per building</h3><span class="subtle">${fmtNum(s.data.panel.wp, 0)} Wp panels, ${fmtNum(s.data.panel.w, 2)} × ${fmtNum(s.data.panel.h, 2)} m, ${fmtNum(s.data.panel.setback_m, 1)} m from the roof edges</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Building</th><th>Roof faces with panels</th><th class="num">Panels</th><th class="num">kWp</th><th class="num">kWh/yr</th><th class="num">kWh per kWp</th><th>Note</th></tr></thead>
        <tbody>${buildings.map((b) => `<tr>
          <td>${SUGGESTED_ROOFS.includes(b.key) ? '<strong>' : ''}${esc(b.name)}${SUGGESTED_ROOFS.includes(b.key) ? '</strong>' : ''}</td>
          <td>${b.faces.filter((f) => f.panels).map((f) => `${esc(kind(f))}${f.described ? ` <span title="${esc(f.described)}">lean-to*</span>` : ""} ${fmtNum(f.roof_tilt, 0)}° (${f.panels})`).join(', ') || '–'}</td>
          <td class="num">${b.panels}</td><td class="num">${fmtNum(b.kwp, 1)}</td><td class="num">${fmtNum(b.kwh_year, 0)}</td>
          <td class="num">${b.kwp ? fmtNum(b.kwh_year / b.kwp, 0) : '–'}</td>
          <td class="subtle">${esc(b.roof)}</td>
        </tr>`).join('')}
          <tr><td><strong>All roofs</strong></td><td></td><td class="num"><strong>${sum(buildings, 'panels')}</strong></td><td class="num"><strong>${fmtNum(allKwp, 1)}</strong></td><td class="num"><strong>${fmtNum(allKwh, 0)}</strong></td><td></td><td class="subtle">${fmtMoney(allVal.total, 'SEK')} a year, payback ${yrs(allVal)} years: much would be exported at the spot price</td></tr>
        </tbody>
      </table></div>
    </div>
    ${s.effekt ? solarEffektHtml(s.effekt, buildings, valueOf) : ''}
    ${roofWorkHtml(buildings, valueOf)}
    <div class="card">
      <div class="card-head"><h3>What size pays best</h3><span class="subtle">simulated on the club’s measured consumption, ${esc(SOLAR_SIMULATION.period)}</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th class="num">Size</th><th class="num">Summer peak lower by</th><th class="num">Effektavgift saved / yr</th><th class="num">Energy saved / yr</th><th class="num">Total / yr</th><th class="num">Used on site</th><th class="num">Payback (${cost} kr/kWp)</th></tr></thead>
        <tbody>${SOLAR_SIMULATION.sizes.map((r) => {
          const total = r.effektKr + r.energyKr;
          return `<tr><td class="num">${r.kwp} kWp</td><td class="num">${fmtNum(r.peakCutKw, 1)} kW</td><td class="num">${fmtMoney(r.effektKr, 'SEK')}</td><td class="num">${fmtMoney(r.energyKr, 'SEK')}</td><td class="num"><strong>${fmtMoney(total, 'SEK')}</strong></td><td class="num">${Math.round(r.onSite * 100)}%</td><td class="num">${SOLAR_SIMULATION.costPerKwp.map((c) => fmtNum((c * r.kwp) / total, 1)).join(' / ')} yrs</td></tr>`;
        }).join('')}</tbody>
      </table></div>
      <p class="subtle">Up to about 40 kWp nearly everything is used by the club itself; above that a growing share is exported and earns only the spot price, so the payback gets longer. From 2027 production above 43.5 kW also pays a grid energy fee.</p>
      <p class="subtle"><strong>What the price per kWp covers:</strong> a turnkey system excl. VAT: panels, inverter, mounting rails, cabling and installation. Not in it: a new inverter after about 12–15 years (after the payback, but it trims the savings later on), roof work, the feeder cable to the old office, service and insurance. The prices are assumptions until quotes from 2–3 installers arrive; ask them to price the same items.</p>
    </div>
    <div class="card">
      <h3>What solar does, and what it does not</h3>
      <ul>
        <li><strong>It lowers the energy bill.</strong> About 85 % of the value is electricity the club does not have to buy: a solar kWh used on site saves the contract price, the grid energy fee and the energy tax, about ${fmtNum(SOLAR_SIMULATION.krPerKwhOnSite, 2)} kr/kWh excl. VAT. The club uses the most power in the daytime in season, when the sun shines.</li>
        <li><strong>It barely lowers the peak.</strong> The effektavgift is set by the month’s single highest hour, and that hour moves to the evening, an irrigation night or a cloudy day once the panels cover the middle of the day: even 80 kWp lowers the summer peak by only about 9 kW. The peak needs the ceilings (Economics tab).</li>
        <li><strong>It goes well with the chargers.</strong> Golfers charge while they play, in the middle of the day: under a whole-facility ceiling, solar gives the chargers more room.</li>
        <li><strong>Check before buying:</strong> the studio roof (the laser data says it slopes 13° to the north, not flat), the office’s distribution point capacity with the electrician, quotes from 2–3 installers. The barn’s asbestos roof and the old office’s split roof come first (the card above).</li>
      </ul>
    </div>
    ${installerHtml(s.data, buildings)}
    <div class="subtle">Roofs: Lantmäteriet’s laser scans (2019 and 2026 merged, about 1.2 points/m²) and building outlines, processed by tools/roof-solar; tilts and directions are reliable, edges to about ±0.5 m, and chimneys, vents, skylights and tree shade are not in the data. Yield per roof face: PVGIS (EU JRC), checked against SMHI STRÅNG for the actual weather. Value: the club’s E.ON quarter-hour meter values with SE4 quarter-hour spot prices, the contract surcharge and E.ON Elnät’s 2027 prices (tools/roof-solar/simulate.mjs). Installed price per kWp is an assumption until quotes arrive.</div>`;

  bindInstallerDownloads(s.data, buildings);
  $('#solar-show').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-show]');
    if (!chip) return;
    s.show = chip.dataset.show;
    for (const c of $$('#solar-show .chip')) c.classList.toggle('active', c === chip);
    s.view?.select(new Set(s.show === 'all' ? buildings.map((b) => b.key) : SUGGESTED_ROOFS));
  });
  try {
    const { mountSolar3d } = await import('./solar3d.js');
    s.view?.dispose();
    s.view = mountSolar3d($('#solar-3d'), s.data, new Set(s.show === 'all' ? buildings.map((b) => b.key) : SUGGESTED_ROOFS));
    bindSunControls(s);
  } catch (err) {
    $('#solar-3d').innerHTML = `<div class="notice warn">The 3D model could not load (${esc(err.message)}). It needs an internet connection for three.js; the tables above have the same numbers.</div>`;
  }
}

// The sun controls under the 3D model: a day, a time (Swedish time) and a run
// through the day; the sun, its light and the shadows follow.
function bindSunControls(s) {
  const slider = $('#solar-sun-time');
  const clock = $('#solar-sun-clock');
  const readout = $('#solar-sun-readout');
  const play = $('#solar-sun-play');
  if (!slider || !s.view?.setSun) return;
  const compass = (az) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(az / 45) % 8];
  const paint = () => {
    const day = SUN_DAY_CHOICES.find((d) => d.key === s.sunDay) || SUN_DAY_CHOICES[0];
    const p = s.view.setSun(day.month, day.day, s.sunHour);
    const h = Math.floor(s.sunHour);
    clock.textContent = `${String(h).padStart(2, '0')}:${String(Math.round((s.sunHour - h) * 60)).padStart(2, '0')}`;
    readout.textContent = p.el > 0 ? `sun ${Math.round(p.el)}° up, from the ${compass(p.az)} (${Math.round(p.az)}°)` : 'the sun is below the horizon';
  };
  slider.addEventListener('input', () => {
    s.sunHour = Number(slider.value);
    paint();
  });
  $('#solar-sun').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-sun-day]');
    if (!chip) return;
    s.sunDay = chip.dataset.sunDay;
    for (const c of $$('#solar-sun [data-sun-day]')) c.classList.toggle('active', c === chip);
    paint();
  });
  let timer = null;
  play.addEventListener('click', () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
      play.textContent = '▶ Day';
      return;
    }
    play.textContent = '❚❚ Stop';
    timer = setInterval(() => {
      if (!slider.isConnected) return clearInterval(timer);
      s.sunHour = s.sunHour >= 23 ? 3 : s.sunHour + 0.25;
      slider.value = String(s.sunHour);
      paint();
    }, 120);
  });
  paint();
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
      const rows = splitHours(meterHours(inst), hourlyProfile(records, o), null, o, spotFor(inst, eon));
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
        <dt><a href="#overview">Overview</a></dt><dd>Startsidan: månadens högsta timme i år, hur mycket av den som var laddarna, och gränsen som gäller nu.</dd>
        <dt><a href="#meter">Meter</a></dt><dd>Det E.ON faktiskt mätt för hela anläggningen, när topparna kommer och vad som troligen orsakar dem, gränserna och vad elen kostar.</dd>
        <dt><a href="#analysis">Analysis</a></dt><dd>Hur många som laddar samtidigt, vilka timmar som är mest belastade och hur stor effekttopp <em>laddarna själva</em> skapar.</dd>
        <dt><a href="#economics">Economics</a></dt><dd>Vad laddarna drar in och kostar, om priset är rätt, vad nattstopp och vintertak ger, och vad som går att förhandla i elavtalen.</dd>
        <dt><a href="#solar">Solar</a></dt><dd>Om solceller lönar sig: en 3D-modell av taken med panelerna som får plats (från Lantmäteriets laserdata), och vad det ger på klubbens egen förbrukning.</dd>
        <dt><a href="#live">Chargers</a></dt><dd>Laddarna: <em>Live</em> (vilka som laddar just nu), <em>Records</em> (alla laddningar, kan laddas ner som Excel-fil) och <em>Charging points</em> (laddpunkterna och deras uttag).</dd>
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
      <div class="notice"><h3>Planen varje år</h3>
        <ul>
          <li><strong>26 oktober:</strong> vi ber ChargeNode sänka till ett tak på ${SEASON_PLAN.winter.amps} A (≈ ${fmtNum(SEASON_PLAN.winter.kw, 0)} kW) för hela anläggningen. Under vintern är klubbens egen förbrukning högre (värme) och laddningen liten, så laddarna ska inte kunna skapa nya effekttoppar.</li>
          <li><strong>1 mars:</strong> vi ber ChargeNode höja igen till ${SEASON_PLAN.season.amps} A (${fmtNum(SEASON_PLAN.season.kw, 1)} kW) för laddarna inför säsongen, när fler laddar och klubben vill erbjuda full fart.</li>
        </ul>
        <div class="subtle">Två veckor före varje datum öppnas automatiskt ett ärende på GitHub med ett färdigt mejl till ChargeNode. Diagrammen räknar med planen från och med nu; byter ChargeNode ett annat datum läggs det in som en ny rad.</div>
      </div>
      ${seasonDiagramSvg(seasons, usedExample, ceiling, chargerCap)}
      <p class="subtle">${source === 'mätt' ? 'Staplarna bygger på E.ON:s uppmätta värden: genomsnittet av månadernas debiterade topp, uppdelat på laddarna och allt annat.' : source === 'demo' ? 'Staplarna bygger på påhittade demovärden.' : ''}${usedExample.winter || usedExample.summer ? ' Där det står ”exempel” finns inga mätvärden ännu, och siffrorna är bara för att visa principen.' : ''} På vintern är resten av klubbens förbrukning högre (värme), så med ett tak för hela anläggningen blir det mindre plats över för laddarna. Under säsongen går mer el till laddning.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Gräns</th><th class="num">Ampere</th><th class="num">kW</th><th>Gäller</th><th>Vad den betyder</th></tr></thead>
        <tbody>
          <tr><td>Huvudsäkring</td><td class="num">${MAIN_FUSE_A} A</td><td class="num">${fmtNum(MAIN_FUSE_KW, 1)}</td><td>alltid</td><td>Det mesta anläggningen kan dra över huvud taget.</td></tr>
          ${LIMIT_HISTORY.map((l, i) => `<tr><td>${l.kind === 'facility' ? 'Tak för hela anläggningen' : 'Gräns för laddarna'}</td><td class="num">${l.amps ? `${l.amps} A` : '–'}</td><td class="num">${fmtNum(l.kw, 1)}</td><td>${i < LIMIT_HISTORY.length - 1 ? `${esc(limitDate(l.from))} – ${esc(limitDate(LIMIT_HISTORY[i + 1].from))}` : `från ${esc(limitDate(l.from))}`}</td><td>${l.kind === 'facility' ? 'Laddarna får bara det som resten av klubben lämnar under taket.' : 'Laddarna tillsammans; resten av klubben räknas inte.'} <span class="subtle">${esc(l.note)}</span></td></tr>`).join('')}
          <tr><td><strong>Plan, säsong</strong></td><td class="num">${SEASON_PLAN.season.amps} A</td><td class="num">${fmtNum(SEASON_PLAN.season.kw, 1)}</td><td>varje år från 1 mars</td><td>Gräns för laddarna, så att de kan ladda för fullt under golfsäsongen.</td></tr>
          <tr><td><strong>Plan, vinter</strong></td><td class="num">${SEASON_PLAN.winter.amps} A</td><td class="num">${fmtNum(SEASON_PLAN.winter.kw, 1)}</td><td>varje år från 26 oktober</td><td>Tak för hela anläggningen; laddarna får bara det som blir över.</td></tr>
          <tr><td>Effektavgift</td><td class="num">–</td><td class="num">–</td><td>varje månad</td><td>${fmtNum(kr, 0)} kr per kW av månadens högsta timme (E.ON Elnät).</td></tr>
        </tbody>
      </table></div>
      <p>Samma gränser ritas in i diagrammen på flikarna Analysis och Meter: streck för en gräns för laddarna, prickat för taket för hela anläggningen. Under <em>Limits</em> kan man också prova ”tänk om”: andra värden för säsongen och vintern på samma datum, och se vad det hade gjort med topparna.</p>
    </div>

    <div class="card">
      <h3>Varför siffrorna blir som de blir</h3>
      <ul>
        <li><strong>Laddarnas effekt är en uppskattning.</strong> ChargeNode berättar hur många kWh en bil fick, inte hur fort. ${state.rate.auto && state.rate.estimate?.source === 'meter' ? `Hur fort bilarna laddar är däremot uppmätt: när en bil kopplas in ökar hela anläggningens effekt i elmätaren, i mitten med ${fmtNum(state.rate.estimate.kw, 1)} kW (${state.rate.estimate.n} laddningar).` : `Vi räknar med att en bil laddar med ${fmtNum(o.rateKw, 1)} kW.`} Modellen låter varje bil ladda så fort tills den är klar och sedan stå still. Därför är ”laddarnas del” av en timme ungefärlig, medan totalen från E.ON är uppmätt.</li>
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
    { key: 'summer', label: 'Säsong (1 mars – 25 okt)', s: seasons.summer },
    { key: 'winter', label: 'Vinter (26 okt – 28 feb)', s: seasons.winter },
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
  return `<div class="diagram chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Månadens topp under säsong och vinter, uppdelad på laddarna och allt annat, med gränserna inritade">
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
