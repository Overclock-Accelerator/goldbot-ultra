/**
 * Backfills data/precious_metals.json with monthly prices from goldapi.io.
 *
 * The dataset behind the charting tools is a static monthly series (IMF-style
 * commodity codes PGOLD/PSILVER/PPALLA/PPLAT), so it silently goes stale: once
 * "the last 12 months" moves past the final row, charts render a single point.
 * This script tops the series up to the current month.
 *
 * Each month is the average of several sampled trading days rather than a single
 * day's spot price, to stay consistent with the monthly-average basis of the
 * existing rows. Re-running only fetches months that are missing.
 *
 *   GOLDAPI_KEY=... node scripts/backfill-historical-data.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const DATA_FILE = path.join(process.cwd(), 'data', 'precious_metals.json');
const API = 'https://www.goldapi.io/api';
const METALS = { Gold: 'XAU', Silver: 'XAG', Platinum: 'XPT', Palladium: 'XPD' };

// goldapi allows 10 req/sec; stay comfortably under it.
const REQUEST_SPACING_MS = 130;
// Days sampled per month to approximate the monthly average.
const SAMPLE_DAYS = [5, 12, 19, 26];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const monthKey = (y, m) => `${String(m).padStart(2, '0')}/${y}`;

const apiKey = process.env.GOLDAPI_KEY;
if (!apiKey) {
  console.error('GOLDAPI_KEY is not set.');
  process.exit(1);
}

/** Fetch one metal's price for a specific date, or null if unavailable. */
async function fetchPrice(symbol, year, month, day) {
  const stamp = `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
  const res = await fetch(`${API}/${symbol}/USD/${stamp}`, {
    headers: { 'x-access-token': apiKey },
  });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  return typeof json?.price === 'number' ? json.price : null;
}

/**
 * Average the sampled days for a month. Non-trading days return no price, so
 * they're simply skipped; a month with no usable samples yields null.
 */
async function monthlyAverage(symbol, year, month, maxDay) {
  const prices = [];
  for (const day of SAMPLE_DAYS.filter((d) => d <= maxDay)) {
    const price = await fetchPrice(symbol, year, month, day);
    if (price !== null) prices.push(price);
    await sleep(REQUEST_SPACING_MS);
  }
  if (prices.length === 0) return null;
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  return { price: Math.round(avg * 100) / 100, samples: prices.length };
}

/** Months strictly after the dataset's last row, through the current month. */
function missingMonths(lastDate) {
  const [lastMonth, lastYear] = lastDate.split('/').map(Number);
  const now = new Date();
  const endYear = now.getUTCFullYear();
  const endMonth = now.getUTCMonth() + 1;

  const months = [];
  let y = lastYear;
  let m = lastMonth + 1;
  if (m > 12) { m = 1; y += 1; }

  while (y < endYear || (y === endYear && m <= endMonth)) {
    const isCurrentMonth = y === endYear && m === endMonth;
    months.push({
      year: y,
      month: m,
      // Don't sample days that haven't happened yet.
      maxDay: isCurrentMonth ? now.getUTCDate() : 31,
    });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return months;
}

const dataset = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

for (const [name, symbol] of Object.entries(METALS)) {
  const series = dataset[name];
  if (!Array.isArray(series) || series.length === 0) {
    console.warn(`Skipping ${name}: no existing series.`);
    continue;
  }

  const existing = new Set(series.map((row) => row.date));
  const pending = missingMonths(series[series.length - 1].date)
    .filter(({ year, month }) => !existing.has(monthKey(year, month)));

  if (pending.length === 0) {
    console.log(`${name}: already current.`);
    continue;
  }

  for (const { year, month, maxDay } of pending) {
    const key = monthKey(year, month);
    const result = await monthlyAverage(symbol, year, month, maxDay);
    if (result === null) {
      console.warn(`${name} ${key}: no data available, stopping this metal.`);
      break;
    }
    series.push({ date: key, price: result.price });
    console.log(`${name} ${key}: ${result.price} (${result.samples} samples)`);
  }
}

fs.writeFileSync(DATA_FILE, `${JSON.stringify(dataset, null, 2)}\n`);
console.log(`\nWrote ${DATA_FILE}`);
