// Live USD/INR exchange rate for the Budget & Cost Forecast feature — never
// hardcoded. Fetches from a free, keyless FX API, cached in-process for a
// short TTL so repeated dashboard refreshes don't hammer the upstream service,
// and falls back to the app's static config default only if the network call
// fails (keeping the dashboard usable offline while staying transparent about
// which source is in effect).
const config = require('../config');

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const SOURCE_URL = 'https://open.er-api.com/v6/latest/USD';

let cache = null; // { rate, asOf, source, fetchedAt }

async function fetchLiveRate() {
  const res = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Rate API responded ${res.status}`);
  const body = await res.json();
  if (body.result !== 'success' || !body.rates || !body.rates.INR) {
    throw new Error('Rate API returned an unexpected payload');
  }
  return { rate: body.rates.INR, asOf: body.time_last_update_utc || new Date().toISOString() };
}

// Returns { rate, asOf, source } — source is 'live' (fresh fetch), 'cached'
// (still within TTL), or 'fallback' (upstream unreachable, using config default).
async function getUsdInrRate() {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) {
    return { rate: cache.rate, asOf: cache.asOf, source: 'cached' };
  }
  try {
    const { rate, asOf } = await fetchLiveRate();
    cache = { rate, asOf, fetchedAt: Date.now() };
    return { rate, asOf, source: 'live' };
  } catch (err) {
    if (cache) return { rate: cache.rate, asOf: cache.asOf, source: 'fallback' };
    return { rate: config.usdInrRate, asOf: null, source: 'fallback' };
  }
}

module.exports = { getUsdInrRate };
