// Health-check methods for the heartbeat agent. Pluggable registry: each checker
// is async (target, opts) -> { ok, latencyMs, error }. Adding a new method = add a
// function here and register it in CHECKERS; the agent picks it by
// asset_monitors.check_method. No external dependencies: ICMP shells out to the
// system ping binary, TCP uses node:net, HTTP uses global fetch + AbortController
// (same timeout pattern as notificationService.sendWebhook).
const net = require('net');
const { execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';

// ---- ICMP ping (system binary) ----
function icmp(target, { timeoutMs = 3000 } = {}) {
  return new Promise(resolve => {
    const args = IS_WIN
      ? ['-n', '1', '-w', String(timeoutMs), target]
      : ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), target];
    const started = Date.now();
    execFile('ping', args, { timeout: timeoutMs + 2000, windowsHide: true }, (err, stdout = '') => {
      const wall = Date.now() - started;
      // Windows ping can exit 0 on "Destination host unreachable"; require a TTL echo.
      const echoed = IS_WIN ? /TTL=/i.test(stdout) : !err;
      if (err || !echoed) {
        const reason = err && err.killed ? 'timeout'
          : (stdout.match(/(timed out|unreachable|could not find host|100% (packet )?loss)/i) || [])[0] || (err ? err.message.split('\n')[0] : 'no echo reply');
        return resolve({ ok: false, latencyMs: null, error: `icmp: ${reason}` });
      }
      const m = stdout.match(/time[=<]([\d.]+)\s*ms/i);
      resolve({ ok: true, latencyMs: m ? parseFloat(m[1]) : wall, error: null });
    });
  });
}

// ---- TCP port connect ----
function tcp(target, { port, timeoutMs = 3000 } = {}) {
  return new Promise(resolve => {
    if (!port) return resolve({ ok: false, latencyMs: null, error: 'tcp: no port configured' });
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const done = result => { if (!settled) { settled = true; socket.destroy(); resolve(result); } };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done({ ok: true, latencyMs: Date.now() - started, error: null }));
    socket.once('timeout', () => done({ ok: false, latencyMs: null, error: `tcp: connect timeout after ${timeoutMs}ms` }));
    socket.once('error', err => done({ ok: false, latencyMs: null, error: `tcp: ${err.code || err.message}` }));
    socket.connect(port, target);
  });
}

// ---- HTTP health endpoint ----
async function http(target, { healthUrl, timeoutMs = 3000 } = {}) {
  const url = healthUrl || `http://${target}/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    const latencyMs = Date.now() - started;
    if (res.status >= 200 && res.status < 400) return { ok: true, latencyMs, error: null };
    return { ok: false, latencyMs, error: `http: status ${res.status}` };
  } catch (err) {
    const reason = err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (err.cause && err.cause.code) || err.message;
    return { ok: false, latencyMs: null, error: `http: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

const CHECKERS = { icmp, tcp, http };

module.exports = { CHECKERS, icmp, tcp, http };
