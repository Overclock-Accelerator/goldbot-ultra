// Monthly historical prices from goldapi.io.
//
// The charting/history tools used to read a checked-in monthly dataset, which
// silently went stale: once "the last 12 months" moved past the file's final
// row, charts collapsed to a single point. goldapi serves history back to at
// least 1990, so the API is the source of truth instead.
//
// Each month is sampled on the 1st. goldapi returns a price for the 1st even
// when it falls on a weekend or holiday, so no trading-day walk-back is needed.
// Callers ask only for the months they actually plot (charts downsample to ~12
// points), so a 30-year range costs the same number of requests as a 1-year one.

const API = 'https://www.goldapi.io/api';

// goldapi allows 10 requests/second and returns 429 for anything over it, so
// request *starts* are paced globally rather than fired in concurrent batches.
// Bursting 12 at once yields ~7 rejections, which would silently degrade every
// affected point to the fallback dataset.
const MIN_REQUEST_SPACING_MS = 130;
const MAX_RETRIES = 3;

// Next timestamp a request may start, shared across all in-flight callers.
let nextSlot = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reserve the next paced slot, waiting if requests are already queued. */
async function acquireSlot(): Promise<void> {
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + MIN_REQUEST_SPACING_MS;
  if (start > now) await sleep(start - now);
}

// A past month's price never changes, so cache entries never expire. This is a
// module-level cache, so it lives for the life of a warm serverless instance.
const priceCache = new Map<string, number>();

const cacheKey = (symbol: string, currency: string, month: string) =>
  `${symbol}:${currency}:${month}`;

/** `YYYY-MM` -> `YYYYMM01`, the request format goldapi expects. */
const toApiDate = (month: string) => `${month.replace('-', '')}01`;

async function fetchOne(
  symbol: string,
  currency: string,
  month: string
): Promise<number | null> {
  const apiKey = process.env.GOLDAPI_KEY;
  if (!apiKey) throw new Error('GOLDAPI_KEY environment variable is not set');

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await acquireSlot();

    try {
      const res = await fetch(`${API}/${symbol}/${currency}/${toApiDate(month)}`, {
        headers: { 'x-access-token': apiKey },
      });

      // Rate limited: back off and retry rather than degrading to stale data.
      if (res.status === 429) {
        await sleep(400 * 2 ** attempt);
        continue;
      }

      // A future or unsupported date returns an error payload, not a price.
      if (!res.ok) return null;

      const json = await res.json();
      return typeof json?.price === 'number' ? json.price : null;
    } catch {
      if (attempt === MAX_RETRIES) return null;
      await sleep(400 * 2 ** attempt);
    }
  }

  console.warn(`goldapi rate limit exhausted for ${symbol} ${month}`);
  return null;
}

/**
 * Resolve prices for every (symbol, month) pair, hitting the API only for
 * uncached pairs. Returns a map keyed `SYMBOL:YYYY-MM`; pairs the API has no
 * data for are simply absent, so callers can fall back per-point.
 */
export async function fetchMonthlyPrices(
  symbols: string[],
  months: string[],
  currency = 'USD'
): Promise<Map<string, number>> {
  const resolved = new Map<string, number>();
  const pending: Array<{ symbol: string; month: string }> = [];

  for (const symbol of symbols) {
    for (const month of months) {
      const cached = priceCache.get(cacheKey(symbol, currency, month));
      if (cached !== undefined) {
        resolved.set(`${symbol}:${month}`, cached);
      } else {
        pending.push({ symbol, month });
      }
    }
  }

  // Every request awaits its own paced slot, so these can all be kicked off at
  // once without exceeding the rate limit.
  const results = await Promise.all(
    pending.map(async ({ symbol, month }) => ({
      symbol,
      month,
      price: await fetchOne(symbol, currency, month),
    }))
  );

  for (const { symbol, month, price } of results) {
    if (price === null) continue;
    priceCache.set(cacheKey(symbol, currency, month), price);
    resolved.set(`${symbol}:${month}`, price);
  }

  return resolved;
}

/** Current month as `YYYY-MM`, for defaulting open-ended ranges to today. */
export function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}
