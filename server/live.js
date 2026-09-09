// Computes a "right now" picture from normalized locations + sessions.
//
// OCPI has no dedicated "current power" endpoint. Two signals are combined:
//   1. EVSE status from the locations module (CHARGING / AVAILABLE / ...).
//   2. Active sessions from the sessions module. If the CPO reports a POWER
//      dimension in the latest charging period the number is measured; if it
//      only reports ENERGY the average power over the latest period is derived;
//      otherwise the connector's maximum power is used as an estimate.

const STATUS_BUCKET = {
  CHARGING: 'charging',
  AVAILABLE: 'available',
  BLOCKED: 'occupied',
  RESERVED: 'occupied',
  INOPERATIVE: 'unavailable',
  OUTOFORDER: 'unavailable',
  PLANNED: 'unavailable',
  REMOVED: 'unavailable',
  UNKNOWN: 'unknown',
};

function round1(n) {
  return Math.round(n * 10) / 10;
}

export function computeLive({ locations, sessions, todayKwh = null, now = new Date() }) {
  const evses = [];
  for (const location of locations) {
    for (const evse of location.evses) {
      evses.push({
        ...evse,
        location_id: location.id,
        location_name: location.name,
        session: null,
        bucket: STATUS_BUCKET[evse.status] || 'unknown',
      });
    }
  }

  const byUid = new Map(evses.map((e) => [e.uid, e]));
  const byEvseId = new Map(evses.filter((e) => e.evse_id).map((e) => [e.evse_id, e]));
  const active = sessions.filter((s) => s.status === 'ACTIVE' || s.status === 'PENDING');
  const orphanSessions = [];

  for (const session of active) {
    const evse = byUid.get(session.evse_uid) || byEvseId.get(session.evse_uid) || byEvseId.get(session.evse_id);
    if (!evse) {
      orphanSessions.push(session);
      continue;
    }
    const newer = !evse.session || Date.parse(session.last_updated || 0) > Date.parse(evse.session.last_updated || 0);
    if (newer) evse.session = session;
  }

  const summary = {
    evses_total: evses.length,
    evses_charging: 0,
    evses_available: 0,
    evses_occupied: 0,
    evses_unavailable: 0,
    evses_unknown: 0,
    capacity_kw: 0,
    in_use_kw: 0,
    in_use_measured_kw: 0,
    in_use_estimated_kw: 0,
    power_measured_count: 0,
    power_derived_count: 0,
    power_estimated_count: 0,
    active_sessions: active.length,
    energy_in_progress_kwh: 0,
    today_kwh: todayKwh,
  };

  for (const evse of evses) {
    summary.capacity_kw += evse.max_power_kw || 0;
    const hasSession = Boolean(evse.session);
    if (hasSession && evse.bucket !== 'charging') evse.bucket = evse.status === 'AVAILABLE' ? 'charging' : evse.bucket;
    if (evse.status === 'CHARGING') evse.bucket = 'charging';

    summary[`evses_${evse.bucket}`] += 1;

    if (evse.bucket === 'charging' || hasSession) {
      const power = evse.session?.power_kw;
      if (power !== null && power !== undefined) {
        evse.live_power_kw = power;
        evse.live_power_source = evse.session.power_source;
        summary.in_use_measured_kw += power;
        if (evse.session.power_source === 'measured') summary.power_measured_count += 1;
        else summary.power_derived_count += 1;
      } else {
        evse.live_power_kw = evse.max_power_kw || 0;
        evse.live_power_source = 'estimated';
        summary.in_use_estimated_kw += evse.live_power_kw;
        summary.power_estimated_count += 1;
      }
    } else {
      evse.live_power_kw = 0;
      evse.live_power_source = null;
    }
    if (hasSession) summary.energy_in_progress_kwh += evse.session.kwh || 0;
  }

  for (const session of orphanSessions) summary.energy_in_progress_kwh += session.kwh || 0;

  summary.in_use_kw = summary.in_use_measured_kw + summary.in_use_estimated_kw;
  summary.utilisation_pct = summary.capacity_kw > 0 ? Math.round((summary.in_use_kw / summary.capacity_kw) * 100) : 0;
  for (const key of ['capacity_kw', 'in_use_kw', 'in_use_measured_kw', 'in_use_estimated_kw', 'energy_in_progress_kwh']) {
    summary[key] = round1(summary[key]);
  }
  if (summary.today_kwh !== null) summary.today_kwh = round1(summary.today_kwh);

  return {
    generated_at: now.toISOString(),
    locations: locations.map((l) => ({ id: l.id, name: l.name, address: l.address, city: l.city, evse_count: l.evses.length })),
    summary,
    evses,
    orphan_sessions: orphanSessions,
  };
}
