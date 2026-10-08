/**
 * Coarse location for the Global Room.
 *
 * The ONLY location input is the two-letter country code Cloudflare adds to the request
 * (`CF-IPCountry`). The server never sees or stores GPS, a street, a city, or the IP-derived
 * position. Each participant gets one random point near a country anchor, chosen once per
 * connection and kept only in memory for the life of that connection.
 *
 * Anchors are approximate population-weighted centres (not exact centroids), so dots land on
 * inhabited land. `spread` is the jitter radius in degrees; large countries use a larger one.
 */

/** Jitter radius (degrees) for countries not listed in SPREAD_DEG. */
const DEFAULT_SPREAD_DEG = 1;

/** Very small places: keep the dot tight so it does not drift into a neighbour. */
const TINY_SPREAD_DEG = 0.2;
const TINY_COUNTRIES = new Set([
  'AD', 'AG', 'AI', 'AS', 'AW', 'AX', 'BB', 'BH', 'BL', 'BM', 'BQ', 'CC', 'CK', 'CV', 'CW',
  'CX', 'DM', 'FK', 'FM', 'FO', 'GD', 'GG', 'GI', 'GP', 'GU', 'HK', 'IM', 'IO', 'JE', 'KI',
  'KM', 'KN', 'KY', 'LC', 'LI', 'MC', 'MF', 'MH', 'MO', 'MP', 'MQ', 'MS', 'MT', 'MV', 'NF',
  'NR', 'NU', 'PM', 'PN', 'PW', 'RE', 'SC', 'SG', 'SH', 'SM', 'SX', 'TC', 'TK', 'TO', 'TV',
  'UM', 'VA', 'VC', 'VG', 'VI', 'WF', 'WS', 'YT',
]);

/** Countries that need a wider jitter than the default. */
const SPREAD_DEG = {
  US: 9, CA: 9, RU: 11, CN: 8, BR: 7, AU: 7, IN: 6, AR: 5, KZ: 6, MX: 5, ID: 6, DZ: 4,
  LY: 4, IR: 4, SA: 3, EG: 3, CD: 3, SD: 3, ML: 4, NE: 3, TD: 3, AO: 3, ZA: 4, PE: 3, CL: 4,
  CO: 3, MN: 4, TR: 3, NG: 2.5, ET: 3, TZ: 3, MZ: 3, MG: 2.5, PK: 3, FR: 2, ES: 2, DE: 2,
  SE: 3, NO: 3, FI: 3, JP: 3, NZ: 3, GL: 4, VN: 3, TH: 2, MM: 3, BO: 3, VE: 2.5, MR: 3,
  GB: 2, IT: 2, PL: 2, UA: 3, UZ: 2.5, TM: 2.5, AF: 2.5, YE: 2, IQ: 2, ZM: 2.5, NA: 3,
  BW: 2.5, PG: 3, PY: 2, UY: 1.5, MA: 2, SO: 2.5, KE: 2, CM: 2, CF: 2.5, GA: 1.5, SS: 2.5,
};

/** ISO 3166-1 alpha-2 → [lat, lon] anchor. */
const COUNTRY_ANCHORS = {
  AD: [42.5, 1.5], AE: [24.5, 54.4], AF: [34.0, 67.7], AG: [17.1, -61.8], AI: [18.2, -63.1],
  AL: [41.2, 20.2], AM: [40.1, 45.0], AO: [-11.2, 17.9], AR: [-34.0, -63.5], AS: [-14.3, -170.7],
  AT: [47.5, 14.6], AU: [-30.5, 145.0], AW: [12.5, -70.0], AX: [60.2, 20.0], AZ: [40.3, 47.6],
  BA: [43.9, 17.7], BB: [13.2, -59.5], BD: [23.7, 90.4], BE: [50.6, 4.7], BF: [12.2, -1.6],
  BG: [42.7, 25.5], BH: [26.0, 50.5], BI: [-3.4, 29.9], BJ: [9.3, 2.3], BL: [17.9, -62.8],
  BM: [32.3, -64.8], BN: [4.5, 114.7], BO: [-16.5, -64.7], BQ: [12.2, -68.3], BR: [-14.0, -50.0],
  BS: [24.3, -76.0], BT: [27.5, 90.4], BW: [-22.3, 24.7], BY: [53.7, 28.0], BZ: [17.2, -88.5],
  CA: [51.0, -95.0], CC: [-12.2, 96.8], CD: [-3.0, 23.7], CF: [6.6, 20.9], CG: [-0.7, 15.2],
  CH: [46.8, 8.2], CI: [7.5, -5.5], CK: [-21.2, -159.8], CL: [-35.5, -71.3], CM: [5.7, 12.7],
  CN: [34.5, 108.0], CO: [4.6, -74.3], CR: [9.7, -83.8], CU: [21.5, -79.5], CV: [16.0, -24.0],
  CW: [12.2, -69.0], CX: [-10.5, 105.7], CY: [35.1, 33.4], CZ: [49.8, 15.5], DE: [51.2, 10.4],
  DJ: [11.8, 42.6], DK: [56.0, 9.5], DM: [15.4, -61.4], DO: [18.7, -70.2], DZ: [32.0, 3.0],
  EC: [-1.8, -78.2], EE: [58.6, 25.0], EG: [27.5, 31.0], EH: [24.2, -12.9], ER: [15.2, 39.8],
  ES: [40.2, -3.7], ET: [9.1, 40.5], FI: [62.0, 26.0], FJ: [-17.7, 178.1], FK: [-51.8, -59.5],
  FM: [6.9, 158.2], FO: [62.0, -6.8], FR: [46.6, 2.2], GA: [-0.8, 11.6], GB: [53.0, -1.8],
  GD: [12.1, -61.7], GE: [42.3, 43.4], GF: [4.0, -53.0], GG: [49.5, -2.6], GH: [7.9, -1.0],
  GI: [36.1, -5.35], GL: [64.2, -51.7], GM: [13.4, -15.4], GN: [9.9, -11.4], GP: [16.2, -61.6],
  GQ: [1.6, 10.3], GR: [39.1, 22.0], GT: [15.7, -90.2], GU: [13.4, 144.8], GW: [12.0, -15.2],
  GY: [4.9, -58.9], HK: [22.3, 114.2], HN: [14.8, -86.6], HR: [45.1, 15.2], HT: [19.0, -72.7],
  HU: [47.2, 19.5], ID: [-6.5, 110.0], IE: [53.2, -8.0], IL: [31.5, 34.9], IM: [54.2, -4.5],
  IN: [22.5, 79.0], IO: [-6.3, 71.9], IQ: [33.0, 43.7], IR: [33.0, 53.7], IS: [64.9, -18.5],
  IT: [42.8, 12.5], JE: [49.2, -2.1], JM: [18.1, -77.3], JO: [31.2, 36.5], JP: [36.2, 138.3],
  KE: [0.2, 37.9], KG: [41.2, 74.8], KH: [12.6, 104.9], KI: [1.4, 173.0], KM: [-11.9, 43.9],
  KN: [17.3, -62.7], KP: [40.3, 127.5], KR: [36.5, 127.9], KW: [29.3, 47.5], KY: [19.3, -81.3],
  KZ: [48.0, 67.0], LA: [19.9, 102.5], LB: [33.9, 35.9], LC: [13.9, -61.0], LI: [47.2, 9.55],
  LK: [7.9, 80.8], LR: [6.4, -9.4], LS: [-29.6, 28.2], LT: [55.2, 23.9], LU: [49.8, 6.1],
  LV: [56.9, 24.6], LY: [31.0, 16.0], MA: [32.0, -6.5], MC: [43.7, 7.4], MD: [47.4, 28.4],
  ME: [42.7, 19.4], MF: [18.1, -63.05], MG: [-19.4, 46.7], MH: [7.1, 171.2], MK: [41.6, 21.7],
  ML: [14.5, -4.0], MM: [21.0, 96.0], MN: [47.0, 104.0], MO: [22.2, 113.5], MP: [15.2, 145.7],
  MQ: [14.6, -61.0], MR: [20.0, -10.9], MS: [16.7, -62.2], MT: [35.9, 14.4], MU: [-20.3, 57.6],
  MV: [3.2, 73.2], MW: [-13.3, 34.3], MX: [21.0, -101.0], MY: [4.2, 102.0], MZ: [-17.5, 35.5],
  NA: [-22.6, 17.1], NC: [-21.3, 165.5], NE: [14.0, 8.0], NF: [-29.0, 167.95], NG: [9.1, 7.5],
  NI: [12.9, -85.2], NL: [52.1, 5.3], NO: [61.0, 9.0], NP: [28.4, 84.1], NR: [-0.5, 166.9],
  NU: [-19.05, -169.9], NZ: [-41.5, 173.0], OM: [21.5, 55.9], PA: [8.5, -80.8], PE: [-9.2, -75.0],
  PF: [-17.7, -149.4], PG: [-6.3, 143.9], PH: [12.9, 121.8], PK: [30.4, 69.3], PL: [52.0, 19.1],
  PM: [46.9, -56.3], PN: [-24.4, -128.3], PR: [18.2, -66.5], PS: [31.9, 35.2], PT: [39.6, -8.0],
  PW: [7.5, 134.6], PY: [-23.4, -58.4], QA: [25.3, 51.2], RE: [-21.1, 55.5], RO: [45.9, 25.0],
  RS: [44.0, 21.0], RU: [57.0, 48.0], RW: [-1.9, 29.9], SA: [24.0, 45.0], SB: [-9.6, 160.2],
  SC: [-4.7, 55.5], SD: [15.5, 32.5], SE: [60.0, 15.0], SG: [1.35, 103.8], SH: [-15.95, -5.7],
  SI: [46.15, 14.8], SJ: [78.0, 16.0], SK: [48.7, 19.7], SL: [8.5, -11.8], SM: [43.9, 12.5],
  SN: [14.5, -14.5], SO: [5.15, 46.2], SR: [4.0, -56.0], SS: [7.0, 30.0], ST: [0.2, 6.6],
  SV: [13.8, -88.9], SX: [18.04, -63.07], SY: [34.8, 38.9], SZ: [-26.5, 31.5], TC: [21.7, -71.8],
  TD: [13.5, 18.7], TF: [-49.3, 69.3], TG: [8.6, 0.8], TH: [15.0, 101.0], TJ: [38.9, 71.3],
  TK: [-9.2, -171.8], TL: [-8.9, 125.7], TM: [38.0, 59.6], TN: [34.0, 9.5], TO: [-21.2, -175.2],
  TR: [39.0, 35.2], TT: [10.7, -61.2], TV: [-7.1, 177.6], TW: [23.7, 121.0], TZ: [-6.4, 34.9],
  UA: [49.0, 31.4], UG: [1.4, 32.3], UM: [19.3, 166.6], US: [39.0, -96.0], UY: [-32.5, -55.8],
  UZ: [41.4, 64.6], VA: [41.9, 12.45], VC: [13.25, -61.2], VE: [8.0, -66.0], VG: [18.4, -64.6],
  VI: [18.3, -64.9], VN: [16.0, 106.0], VU: [-15.4, 166.96], WF: [-13.8, -177.2], WS: [-13.8, -172.1],
  XK: [42.6, 20.9], YE: [15.55, 48.5], YT: [-12.8, 45.2], ZA: [-29.0, 25.0], ZM: [-13.1, 27.8],
  ZW: [-19.0, 29.2],
};

/**
 * Used when the country is unknown (`XX`), Tor (`T1`), or the header is absent (local dev,
 * direct-to-origin). Open-ocean anchors with a wide jitter: "somewhere on Earth", never a
 * claim about a real place. One is picked at random per connection.
 */
const UNKNOWN_ANCHORS = [
  [-12, -20],
  [2, -140],
  [-28, 78],
];
const UNKNOWN_SPREAD_DEG = 9;

const MAX_LAT = 80;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function wrapLon(lon) {
  let l = lon;
  while (l > 180) l -= 360;
  while (l < -180) l += 360;
  return l;
}

/** Normalise a raw header value to an uppercase ISO alpha-2 code, or null. */
function normalizeCountryCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

function spreadFor(code) {
  if (SPREAD_DEG[code] != null) return SPREAD_DEG[code];
  if (TINY_COUNTRIES.has(code)) return TINY_SPREAD_DEG;
  return DEFAULT_SPREAD_DEG;
}

/**
 * Pick a coarse point for a country code.
 *
 * @param {unknown} rawCode  Value of `CF-IPCountry` (any case) or anything else.
 * @param {() => number} random  Uniform [0,1). Injected so tests are deterministic.
 * @returns {{ lat: number, lon: number, known: boolean }} lat/lon rounded to 2 decimals.
 */
function pointForCountry(rawCode, random = Math.random) {
  const code = normalizeCountryCode(rawCode);
  const anchor = code ? COUNTRY_ANCHORS[code] : undefined;

  let lat;
  let lon;
  let spread;
  let known;
  if (anchor) {
    [lat, lon] = anchor;
    spread = spreadFor(code);
    known = true;
  } else {
    const pick = UNKNOWN_ANCHORS[Math.floor(random() * UNKNOWN_ANCHORS.length) % UNKNOWN_ANCHORS.length];
    [lat, lon] = pick;
    spread = UNKNOWN_SPREAD_DEG;
    known = false;
  }

  const angle = random() * 2 * Math.PI;
  const radius = spread * Math.sqrt(random());
  const dLat = radius * Math.sin(angle);
  const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const dLon = (radius * Math.cos(angle)) / cosLat;

  return {
    lat: round2(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat + dLat))),
    lon: round2(wrapLon(lon + dLon)),
    known,
  };
}

module.exports = {
  COUNTRY_ANCHORS,
  UNKNOWN_SPREAD_DEG,
  normalizeCountryCode,
  pointForCountry,
  spreadFor,
};
