// The club's electricity bill split into its parts, for the Economics tab's
// "what can be negotiated" card. Totals from E.ON's Navigator cost export
// (downloaded 11 Jul 2026), summed per 12 months; kr excl. VAT. Only the
// totals are kept here, not the export itself (it carries the meter id and
// organisation number). Update when a new export is downloaded.
export const BILL_SOURCE = 'E.ON Navigator cost export, 11 Jul 2026';

export const BILL = [
  {
    period: 'Jul 2025 – Jun 2026',
    from: '2025-07-01',
    to: '2026-07-01',
    kwh: 165686,
    retail: 146329, // elhandel: E.ON, quarter-hour spot price (P15M) with surcharge and fees
    effekt: 66003, // E.ON Elnät effektavgift, the month's highest hour × kr/kW
    gridEnergy: 28589, // E.ON Elnät energiavgift (överföring) per kWh
    gridFixed: 8298, // E.ON Elnät fast avgift
    tax: 65880, // energiskatt
  },
  {
    period: 'Jul 2024 – Jun 2025',
    from: '2024-07-01',
    to: '2025-07-01',
    kwh: 149763,
    retail: 99278,
    effekt: 58998,
    gridEnergy: 22773,
    gridFixed: 8088,
    tax: 64942,
  },
];

export const billTotal = (b) => b.retail + b.effekt + b.gridEnergy + b.gridFixed + b.tax;

// E.ON Elnät's 2027 price list for the club's tariff, E4N04L (SE4, 400 V,
// effect subscription in the local grid), valid from 1 Jan 2027, and the
// 2026 figures it replaces. kr and öre excl. VAT.
export const GRID_2027 = {
  from: '2027-01-01',
  tariff: 'E4N04L',
  krPerKw: 123.7, // every month (2026: 120.80); the month's highest hourly mean × this
  fixedKrMonth: 712, // abonnemangsavgift (2026: 709)
  energyOre: 6.4, // fixed part of the grid energy fee, öre/kWh
  energySpotPct: 12.1, // plus this share of the quarter-hour spot price in SE4
  reactive: 'Only above a 200 A fuse: 30 kr per kVar and month, October to April, for the reactive peak above 50 % of the active peak.',
  krPerKw2026: 120.8,
  fixedKrMonth2026: 709,
  notes: [
    'The effektavgift rises 2.4 %, to 123.70 kr/kW, the same in every month.',
    'The grid energy fee becomes 6.40 öre/kWh plus 12.1 % of the quarter-hour spot price, worked out for every 15 minutes.',
    'Production above 43.5 kW pays a spot-linked energy fee.',
  ],
};

// Solar simulated per quarter hour on the club's measured consumption (Nov
// 2025 – Oct 2026) by tools/roof-solar/simulate.mjs: five PVGIS weather years
// (2019–2023, east/west roofs at 25°) spread over quarters, SE4 quarter-hour
// spot prices with the contract surcharge, 2027 grid prices; the effektavgift
// on the hourly mean bought. Per size: how much the summer months' peak drops
// (Apr–Sep average), the effektavgift and energy saved a year (kr excl. VAT),
// and the share of the production used on site.
export const SOLAR_SIMULATION = {
  period: 'Nov 2025 – Oct 2026',
  genericYield: 796, // kWh per kWp a year, east/west at 25°, PVGIS mean of the five years
  krPerKwhOnSite: 1.27, // average value of a solar kWh used on site (spot + surcharge + 2027 grid energy fee + tax), weighted by production
  sizes: [
    { kwp: 10, peakCutKw: 2.5, effektKr: 2371, energyKr: 10102, onSite: 1 },
    { kwp: 20, peakCutKw: 4.5, effektKr: 4283, energyKr: 20201, onSite: 1 },
    { kwp: 30, peakCutKw: 6.0, effektKr: 5653, energyKr: 30224, onSite: 0.994 },
    { kwp: 40, peakCutKw: 7.2, effektKr: 6731, energyKr: 39956, onSite: 0.975 },
    { kwp: 60, peakCutKw: 8.6, effektKr: 8218, energyKr: 57626, onSite: 0.89 },
    { kwp: 80, peakCutKw: 9.3, effektKr: 9096, energyKr: 73019, onSite: 0.786 },
  ],
  costPerKwp: [8000, 10000, 12000], // installed, kr excl. VAT: an assumption until quotes arrive
  lifeYears: 25, // years counted for "what the savings carry": the usual panel warranty (panels often last 30)
  degradationPct: 0.5, // output lost per year, typical for crystalline panels
};

// Roof work that must be done before panels can go on two of the roofs: work
// the club has to pay for sooner or later anyway. The barn's roof is eternit
// with asbestos: it has to be replaced (panels cannot be fixed to it without
// working on the asbestos), by a certified asbestos contractor. Prices per m²
// of roof from Swedish 2026 price guides (contractor sites, not quotes):
// asbestos removal and disposal 200–700 kr/m², a new metal roof with battens
// and underlay about 1,000–1,300 kr/m². ROT relief is for private persons
// only, so it does not apply to the club. The old office's roof is split: the
// ridge beam and the roof must be fixed anyway; no price until a carpenter has
// looked at it, so it is shown as how much repair the panels' savings would
// carry. Panels there need the new aluminium feeder cable from the office
// building (FEEDER_CABLE), which the golf carts charging at the old office
// need anyway. Areas: the roof faces measured from the laser data. kr excl. VAT.
export const ROOF_WORK = {
  sources: [
    { label: 'husklimat.se: byta eternittak, pris 2026', url: 'https://husklimat.se/pris/vad-kostar-byta-eternittak' },
    { label: 'kalkylio.se: byta eternittak 2026', url: 'https://kalkylio.se/guider/eternittak-byte-pris-guide' },
    { label: 'sonochfar.se: asbestsanering pris per kvm', url: 'https://sonochfar.se/blog/asbestsanering-pris-per-kvm/' },
  ],
  buildings: {
    ladan: { work: 'Replace the eternit roof: asbestos removal, then a new metal roof', removalKrM2: [200, 700], newRoofKrM2: [1000, 1300] },
    gamla: { work: 'The roof is split: fix the ridge beam and the roof. Price after a carpenter has looked', removalKrM2: null, newRoofKrM2: null },
  },
};

// A new aluminium feeder cable from the office building (kanslibyggnaden,
// where the distribution point has capacity back to the meter) to the old
// office, for the golf carts that charge there; sized for the old office's
// panels too, it lets them feed back the same way. Rough estimate until an
// electrician quotes: the route is the measured distance between the
// buildings × routeFactor (around paths and obstacles, up into the panels);
// aluminium ground cable 4×25–4×50 mm² (N1XE-AR / AXQJ), a cable duct, a
// trench dug and reinstated at 0.35–0.55 m depth, and the electrician's
// terminations and a sub-panel in the old office. Prices: forum quotes for
// 5×50 Al cable (83 kr/m) and 50 mm duct (23 kr/m), widened for 2026; the
// trench and fixed parts are assumptions. kr excl. VAT.
export const FEEDER_CABLE = {
  from: 'kansli',
  to: 'gamla',
  routeFactor: [1.25, 1.5],
  cableKrM: [80, 120],
  ductKrM: [25, 50],
  trenchKrM: [200, 500],
  fixedKr: [15000, 30000],
  sources: [
    { label: 'byggahus.se: offert på elkabel', url: 'https://www.byggahus.se/forum/threads/offert-pa-elkabel.515660/' },
    { label: 'byggahus.se: gräva ner kabel 120 m', url: 'https://www.byggahus.se/forum/threads/grava-ner-kabel-120-m.415871/' },
    { label: 'Vattenfall Eldistribution: installationsregler', url: 'https://www.vattenfalleldistribution.se/globalassets/3.-partners/installator/supporten/filer//eldistributions-installationsregler112024.pdf' },
  ],
};

// Each part, whether it can be negotiated, and how the club can lower it.
export const BILL_PARTS = [
  { key: 'retail', label: 'Electricity contract (elhandel)', negotiable: 'yes', how: 'A free market: compare the surcharge (påslag) and fees on a spot-price contract with other retailers, or renegotiate with E.ON.' },
  { key: 'effekt', label: 'Effektavgift (grid)', negotiable: 'no', how: 'Regulated grid tariff, the same for every customer on it. Lowered only by a lower monthly peak: the season and winter ceilings, moving loads out of the peak hour, a battery.' },
  { key: 'gridEnergy', label: 'Grid energy fee (energiavgift)', negotiable: 'no', how: 'Regulated, per kWh. Lowered only by using less, e.g. solar on the roofs.' },
  { key: 'gridFixed', label: 'Grid fixed fee', negotiable: 'no', how: 'Regulated, per month for the fuse size and tariff.' },
  { key: 'tax', label: 'Energy tax (energiskatt)', negotiable: 'no', how: 'Set by the state per kWh. Lowered only by using less, or by solar power used on site.' },
];
