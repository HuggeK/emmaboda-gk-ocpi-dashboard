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

// Solar simulated on the club's measured hourly consumption (Nov 2025 – Oct
// 2026): five PVGIS weather years (2019–2023, east/west roofs at 25°), SE4
// hourly spot prices for the same months, 2027 grid prices. Per size: how much
// the summer months' peak drops (Apr–Sep average), the effektavgift and energy
// saved a year (kr excl. VAT), and the share of the production used on site.
export const SOLAR_SIMULATION = {
  period: 'Nov 2025 – Oct 2026',
  genericYield: 797, // kWh per kWp a year, east/west at 25°, PVGIS mean of the five years
  krPerKwhOnSite: 1.25, // average value of a solar kWh used on site (spot + surcharge + 2027 grid energy fee + tax)
  sizes: [
    { kwp: 10, peakCutKw: 2.5, effektKr: 2371, energyKr: 9912, onSite: 1.0 },
    { kwp: 20, peakCutKw: 4.5, effektKr: 4283, energyKr: 19824, onSite: 1.0 },
    { kwp: 30, peakCutKw: 6.0, effektKr: 5653, energyKr: 29681, onSite: 0.996 },
    { kwp: 40, peakCutKw: 7.2, effektKr: 6731, energyKr: 39297, onSite: 0.98 },
    { kwp: 60, peakCutKw: 8.6, effektKr: 8218, energyKr: 56838, onSite: 0.90 },
    { kwp: 80, peakCutKw: 9.3, effektKr: 9096, energyKr: 72146, onSite: 0.79 },
  ],
  costPerKwp: [8000, 10000, 12000], // installed, kr excl. VAT: an assumption until quotes arrive
};

// Each part, whether it can be negotiated, and how the club can lower it.
export const BILL_PARTS = [
  { key: 'retail', label: 'Electricity contract (elhandel)', negotiable: 'yes', how: 'A free market: compare the surcharge (påslag) and fees on a spot-price contract with other retailers, or renegotiate with E.ON.' },
  { key: 'effekt', label: 'Effektavgift (grid)', negotiable: 'no', how: 'Regulated grid tariff, the same for every customer on it. Lowered only by a lower monthly peak: the season and winter ceilings, moving loads out of the peak hour, a battery.' },
  { key: 'gridEnergy', label: 'Grid energy fee (energiavgift)', negotiable: 'no', how: 'Regulated, per kWh. Lowered only by using less, e.g. solar on the roofs.' },
  { key: 'gridFixed', label: 'Grid fixed fee', negotiable: 'no', how: 'Regulated, per month for the fuse size and tariff.' },
  { key: 'tax', label: 'Energy tax (energiskatt)', negotiable: 'no', how: 'Set by the state per kWh. Lowered only by using less, or by solar power used on site.' },
];
