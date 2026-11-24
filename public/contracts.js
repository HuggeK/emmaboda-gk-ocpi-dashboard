// The club's electricity bill split into its parts, for the Economics tab's
// "what can be negotiated" card. Totals from E.ON's Navigator cost export
// (downloaded 11 Jul 2026), summed per 12 months; kr excl. VAT. Only the
// totals are kept here, not the export itself (it carries the meter id and
// organisation number). Update when a new export is downloaded.
export const BILL_SOURCE = 'E.ON Navigator cost export, 11 Jul 2026';

export const BILL = [
  {
    period: 'Jul 2025 – Jun 2026',
    kwh: 165686,
    retail: 146329, // elhandel: E.ON, quarter-hour spot price (P15M) with surcharge and fees
    effekt: 66003, // E.ON Elnät effektavgift, the month's highest hour × kr/kW
    gridEnergy: 28589, // E.ON Elnät energiavgift (överföring) per kWh
    gridFixed: 8298, // E.ON Elnät fast avgift
    tax: 65880, // energiskatt
  },
  {
    period: 'Jul 2024 – Jun 2025',
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

// Solar, as worked out in the club's energy analysis (v1.31, July 2026).
export const SOLAR = {
  yieldKwhPerKwp: 815, // east–west roofs
  options: [
    { roof: 'Clubhouse office (kansliet)', kwp: 20, krPerYear: 25000 },
    { roof: 'Barn (ladan)', kwp: 60, krPerYear: 68000 },
  ],
  exportCapKw: 43.5, // export limited at the meter
};

// Each part, whether it can be negotiated, and how the club can lower it.
export const BILL_PARTS = [
  { key: 'retail', label: 'Electricity contract (elhandel)', negotiable: 'yes', how: 'A free market: compare the surcharge (påslag) and fees on a spot-price contract with other retailers, or renegotiate with E.ON.' },
  { key: 'effekt', label: 'Effektavgift (grid)', negotiable: 'no', how: 'Regulated grid tariff, the same for every customer on it. Lowered only by a lower monthly peak: the season and winter ceilings, moving loads out of the peak hour, a battery.' },
  { key: 'gridEnergy', label: 'Grid energy fee (energiavgift)', negotiable: 'no', how: 'Regulated, per kWh. Lowered only by using less, e.g. solar on the roofs.' },
  { key: 'gridFixed', label: 'Grid fixed fee', negotiable: 'no', how: 'Regulated, per month for the fuse size and tariff.' },
  { key: 'tax', label: 'Energy tax (energiskatt)', negotiable: 'no', how: 'Set by the state per kWh. Lowered only by using less, or by solar power used on site.' },
];
