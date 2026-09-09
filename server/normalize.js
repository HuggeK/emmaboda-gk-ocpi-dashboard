// Normalizes OCPI 2.1.1 / 2.2 / 2.2.1 payloads into one flat shape for the UI.

export function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function connectorMaxKw(connector) {
  if (!connector) return null;
  // OCPI 2.2+: max_electric_power in watts.
  const watts = num(connector.max_electric_power);
  if (watts !== null) return watts / 1000;
  // OCPI 2.1.1: voltage + amperage (2.2 also has max_voltage / max_amperage).
  const volts = num(connector.max_voltage ?? connector.voltage);
  const amps = num(connector.max_amperage ?? connector.amperage);
  if (volts === null || amps === null) return null;
  const phases = connector.power_type === 'AC_3_PHASE' ? 3 : 1;
  // For 3-phase, OCPI voltage is line-to-neutral (230 V) in 2.2.1; 400 V is line-to-line.
  const perPhaseVolts = phases === 3 && volts > 300 ? volts / Math.sqrt(3) : volts;
  return Math.round((perPhaseVolts * amps * phases) / 100) / 10;
}

export function normalizeConnector(connector) {
  return {
    id: connector.id,
    standard: connector.standard || null,
    format: connector.format || null,
    power_type: connector.power_type || null,
    max_power_kw: connectorMaxKw(connector),
    tariff_ids: connector.tariff_ids || (connector.tariff_id ? [connector.tariff_id] : []),
    last_updated: connector.last_updated || null,
  };
}

export function normalizeEvse(evse) {
  const connectors = (evse.connectors || []).map(normalizeConnector);
  const powers = connectors.map((c) => c.max_power_kw).filter((p) => p !== null);
  return {
    uid: evse.uid,
    evse_id: evse.evse_id || null,
    physical_reference: evse.physical_reference || null,
    status: evse.status || 'UNKNOWN',
    capabilities: evse.capabilities || [],
    floor_level: evse.floor_level || null,
    last_updated: evse.last_updated || null,
    connectors,
    // An EVSE with several connectors can normally serve one vehicle at a time.
    max_power_kw: powers.length ? Math.max(...powers) : null,
  };
}

export function normalizeLocation(location) {
  const coords = location.coordinates || {};
  return {
    id: location.id,
    name: location.name || location.id,
    address: location.address || null,
    city: location.city || null,
    postal_code: location.postal_code || null,
    country: location.country || null,
    coordinates: coords.latitude ? { lat: num(coords.latitude), lng: num(coords.longitude) } : null,
    time_zone: location.time_zone || null,
    operator: location.operator?.name || null,
    last_updated: location.last_updated || null,
    evses: (location.evses || []).map(normalizeEvse),
  };
}

// Instantaneous power from the latest charging period of a session.
export function sessionPower(session) {
  const periods = session.charging_periods || [];
  if (!periods.length) return { kw: null, source: null };
  const last = periods[periods.length - 1];
  const dims = last.dimensions || [];
  const power = dims.find((d) => d.type === 'POWER');
  if (power && num(power.volume) !== null) return { kw: num(power.volume), source: 'measured' };
  const energy = dims.find((d) => d.type === 'ENERGY');
  const start = Date.parse(last.start_date_time);
  const end = Date.parse(session.last_updated || session.end_date_time);
  if (energy && Number.isFinite(start) && Number.isFinite(end) && end - start >= 60_000) {
    const hours = (end - start) / 3_600_000;
    return { kw: Math.round((num(energy.volume) / hours) * 10) / 10, source: 'derived' };
  }
  return { kw: null, source: null };
}

function costParts(totalCost) {
  if (totalCost && typeof totalCost === 'object') {
    return { excl_vat: num(totalCost.excl_vat), incl_vat: num(totalCost.incl_vat) };
  }
  const n = num(totalCost);
  return n === null ? { excl_vat: null, incl_vat: null } : { excl_vat: n, incl_vat: null };
}

export function normalizeSession(session) {
  const legacyLocation = session.location || null; // OCPI 2.1.1 embeds a Location object
  const legacyEvse = legacyLocation?.evses?.[0] || null;
  const status = session.status || (session.end_date_time ? 'COMPLETED' : 'ACTIVE');
  const power = sessionPower(session);
  const cost = costParts(session.total_cost);
  return {
    id: session.id,
    start: session.start_date_time || null,
    end: session.end_date_time || null,
    status,
    kwh: num(session.kwh) ?? 0,
    location_id: session.location_id || legacyLocation?.id || null,
    location_name: legacyLocation?.name || null,
    evse_uid: session.evse_uid || legacyEvse?.uid || null,
    evse_id: legacyEvse?.evse_id || null,
    connector_id: session.connector_id || legacyEvse?.connectors?.[0]?.id || null,
    auth_method: session.auth_method || null,
    token_uid: session.cdr_token?.uid || session.auth_id || null,
    contract_id: session.cdr_token?.contract_id || null,
    currency: session.currency || null,
    cost_excl_vat: cost.excl_vat,
    cost_incl_vat: cost.incl_vat,
    power_kw: power.kw,
    power_source: power.source,
    charging_periods: (session.charging_periods || []).length,
    last_updated: session.last_updated || null,
  };
}

export function normalizeCdr(cdr) {
  const cdrLocation = cdr.cdr_location || null; // OCPI 2.2+
  const legacyLocation = cdr.location || null; // OCPI 2.1.1
  const legacyEvse = legacyLocation?.evses?.[0] || null;
  const cost = costParts(cdr.total_cost);
  const start = cdr.start_date_time || null;
  const end = cdr.end_date_time || cdr.stop_date_time || null;
  let durationHours = num(cdr.total_time);
  if (durationHours === null && start && end) {
    durationHours = (Date.parse(end) - Date.parse(start)) / 3_600_000;
  }
  return {
    id: cdr.id,
    start,
    end,
    session_id: cdr.session_id || null,
    location_id: cdrLocation?.id || legacyLocation?.id || null,
    location_name: cdrLocation?.name || legacyLocation?.name || null,
    evse_uid: cdrLocation?.evse_uid || legacyEvse?.uid || null,
    evse_id: cdrLocation?.evse_id || legacyEvse?.evse_id || null,
    connector_id: cdrLocation?.connector_id || legacyEvse?.connectors?.[0]?.id || null,
    connector_standard: cdrLocation?.connector_standard || legacyEvse?.connectors?.[0]?.standard || null,
    connector_power_type: cdrLocation?.connector_power_type || legacyEvse?.connectors?.[0]?.power_type || null,
    energy_kwh: num(cdr.total_energy) ?? 0,
    duration_h: durationHours,
    parking_h: num(cdr.total_parking_time),
    cost_excl_vat: cost.excl_vat,
    cost_incl_vat: cost.incl_vat,
    currency: cdr.currency || null,
    auth_method: cdr.auth_method || null,
    token_uid: cdr.cdr_token?.uid || cdr.auth_id || null,
    token_type: cdr.cdr_token?.type || null,
    contract_id: cdr.cdr_token?.contract_id || null,
    tariff_ids: (cdr.tariffs || []).map((t) => t.id).filter(Boolean),
    charging_periods: (cdr.charging_periods || []).length,
    last_updated: cdr.last_updated || null,
  };
}
