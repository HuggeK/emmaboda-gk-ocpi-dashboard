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
  // Turnkey price per installed kWp, kr excl. VAT: panels, inverter, mounting
  // rails, cabling and installation. An assumption until quotes arrive. Not
  // in it: a new inverter after about 12–15 years, roof work, the feeder
  // cable to the old office, service and insurance.
  costPerKwp: [8000, 10000, 12000],
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
// aluminium ground cable 4×25–4×50 mm² (N1XE-AR / AXQJ), a cable duct, and
// the electrician's terminations and a sub-panel in the old office. The
// trench between the buildings is already dug, so it costs nothing here.
// Prices: forum quotes for 5×50 Al cable (83 kr/m) and 50 mm duct (23 kr/m),
// widened for 2026; the fixed part is an assumption. kr excl. VAT.
export const FEEDER_CABLE = {
  from: 'kansli',
  to: 'gamla',
  routeFactor: [1.25, 1.5],
  cableKrM: [80, 120],
  ductKrM: [25, 50],
  trenchKrM: [0, 0], // the trench between the buildings is already dug (Nov 2026)
  fixedKr: [15000, 30000],
  sources: [
    { label: 'byggahus.se: offert på elkabel', url: 'https://www.byggahus.se/forum/threads/offert-pa-elkabel.515660/' },
    { label: 'byggahus.se: gräva ner kabel 120 m', url: 'https://www.byggahus.se/forum/threads/grava-ner-kabel-120-m.415871/' },
    { label: 'Vattenfall Eldistribution: installationsregler', url: 'https://www.vattenfalleldistribution.se/globalassets/3.-partners/installator/supporten/filer//eldistributions-installationsregler112024.pdf' },
  ],
};

// The feeder cables from the ground-mounted meter cabinet at the water
// treatment plant, where the facility's single E.ON meter sits, as in the
// club's energy analysis (v1.31, July 2026, §2: the single-line diagram by
// Emmaboda Elteknik, 2021-04-15). Currents are guide values for buried
// 0.6/1 kV cable; the real limit is the fuse and the installation method.
// Materials marked ? are to be confirmed on the cable marking by the electrician.
export const FEEDERS = {
  source: 'Emmaboda GK energy analysis v1.31 (July 2026), §2 and §11; single-line diagram, Emmaboda Elteknik 2021-04-15',
  mainFuseA: 125,
  links: [
    { key: 'incoming', label: 'Incoming feed (metered: Trafo-SD 630 / SEKI OB 400)', cable: 'N1XV 4×240', material: 'Al? (Cu: ~400 A)', amps: '~290 A', kw: '~200–277 kW' },
    { key: 'clubhouse', label: 'Clubhouse distribution (office building, studio, restaurant)', cable: '4G240', material: 'Al?', amps: '~250 A (cable ~300 A)', kw: '~175–210 kW', lengthM: 160, ohm: 0.02 },
    { key: 'camping', label: 'Central Camping (scout cabin, cabins, pitches, laundry)', cable: 'N1XV 4×240', material: 'Al?', amps: '~290 A (fused lower)', kw: '~200 kW', lengthM: 800, ohm: 0.1 },
    { key: 'technical', label: 'Central Technical room (UV treatment, pumps)', cable: 'N1XV-AR 4G50', material: 'Al', amps: '~100 A (fuse)', kw: '~69 kW', lengthM: 250, ohm: 0.16 },
    { key: 'irrigation', label: 'Irrigation', cable: 'AKKJ 3×150/41', material: 'Al', amps: '~200–250 A', kw: '~140–175 kW' },
    { key: 'reserve', label: 'Clubhouse, reserve (marked “reserv”)', cable: 'FKKJ 3×25/16', material: 'Cu', amps: '50–63 A', kw: '~35–44 kW' },
  ],
  // The old office's cable from the office building: judged too weak by the
  // electrician (it has tripped); a new aluminium cable is about to be laid (FEEDER_CABLE).
  notes: [
    'The bottleneck is the 125 A main fuse (~87 kW), not the cables: the incoming cable and the cabinet carry ~290–400 A.',
    'The barn’s feed is not in the diagram (likely a sub-distribution from the clubhouse): confirm it before panels there.',
    'The old office’s feed from the office building is too weak and has tripped: a new aluminium cable is being laid.',
  ],
};

// The electricity contract with E.ON (elhandel) as the club has it: quarter-hour
// spot price plus this surcharge, no annual fee; E.ON says it is the lowest
// they offer (club's information, Nov 2026). The meter model's surchargeOre
// (meter.js, ~8 öre) is fitted to the bills and so also holds the other
// per-kWh items on the bill (certificates, E.ON's variable costs).
export const RETAIL_CONTRACT = { surchargeOre: 3, annualFeeKr: 0, asOf: '2026-11' };

// What to buy, in order: each step adds roofs to the ones before (cumulative
// keys). tools/roof-solar/simulate.mjs simulates each step; the Solar tab shows
// them as choices in the 3D model. glare: the glare runs (data/solar-site.json)
// for the roofs the step adds. before: what has to happen first. weaker: why
// the step pays less, or may not be worth it.
export const SOLAR_STEPS = [
  {
    key: 'step1', label: '1. Office + studio', keys: ['kansli', 'studio'], glare: ['kansli-se', 'kansli-w', 'studio'],
    before: 'The studio roof’s load capacity; the office’s distribution point checked by the electrician.',
    weaker: 'The office’s west roof dazzles golfers on hole 9 at midday in the high season: leave it out, or use anti-glare glass there.',
  },
  {
    key: 'step2', label: '2. + Old office', keys: ['kansli', 'studio', 'gamla'], glare: ['gamla'],
    before: 'The split roof fixed (ridge beam and roof), and the new aluminium cable from the office building laid.',
    weaker: 'The roof work comes first; its steep south roof is otherwise the best per kWp. Its glare reaches nearby holes in the high season too.',
  },
  {
    key: 'step3', label: '3. + Scout cabin', keys: ['kansli', 'studio', 'gamla', 'scout'], glare: ['scout'],
    before: 'A look at the roof on site: the laser data there is blurred by the trees around the clearing.',
    weaker: 'Small (a few kWp) and in a forest clearing: shade in the morning and evening. Its surplus travels the 800 m camping feeder. The sheet-metal roof itself is easy to mount on.',
  },
  {
    key: 'step4', label: '4. + The cabins', keys: ['kansli', 'studio', 'gamla', 'scout', 'cabin1', 'cabin2', 'cabin3'], glare: ['cabins'],
    before: 'The tile roofs inspected (built 2010: mid-life, no new roof needed, but tiles crack when walked on); hooks through the tiles.',
    weaker: 'By now the club uses less of what the panels make in the middle of the day, so more is exported at the spot price; mounting on tiles costs more than on sheet metal; behind the 800 m camping feeder.',
  },
];

// Hole numbers for the OSM hole lines (golfTiles keeps the way id, not the
// number). Hole 5: the club's website puts the scout cabin "along hole 5", and
// this is the hole line passing it.
export const HOLE_NAMES = { 910875400: 'Hole 9', 910875396: 'Hole 5' };

// Each part, whether it can be negotiated, and how the club can lower it.
export const BILL_PARTS = [
  { key: 'retail', label: 'Electricity contract (elhandel)', negotiable: 'yes', how: 'A free market: compare the surcharge (påslag) and fees on a spot-price contract with other retailers, or renegotiate with E.ON.' },
  { key: 'effekt', label: 'Effektavgift (grid)', negotiable: 'no', how: 'Regulated grid tariff, the same for every customer on it. Lowered only by a lower monthly peak: the season and winter ceilings, moving loads out of the peak hour, a battery.' },
  { key: 'gridEnergy', label: 'Grid energy fee (energiavgift)', negotiable: 'no', how: 'Regulated, per kWh. Lowered only by using less, e.g. solar on the roofs.' },
  { key: 'gridFixed', label: 'Grid fixed fee', negotiable: 'no', how: 'Regulated, per month for the fuse size and tariff.' },
  { key: 'tax', label: 'Energy tax (energiskatt)', negotiable: 'no', how: 'Set by the state per kWh. Lowered only by using less, or by solar power used on site.' },
];
