// Unit tests for the Asset Health Check agent (node:test, no DB required).
// Covers: successful check, failed check, timeout handling, UP->DOWN alert,
// DOWN->UP alert, no duplicate alert on unchanged status, and agent error isolation.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');

const { tcp, http: httpCheck } = require('../src/services/heartbeat/checkers');
const { evaluateTransition } = require('../src/services/heartbeat/heartbeatService');
const { HeartbeatAgent } = require('../src/services/heartbeat/heartbeatAgent');

const silentLogger = { info() {}, warning() {}, error() {}, debug() {} };

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

describe('checkers', () => {
  test('successful check: tcp connect to a listening port reports UP with latency', async () => {
    const server = net.createServer(() => {});
    const port = await listen(server);
    try {
      const r = await tcp('127.0.0.1', { port, timeoutMs: 2000 });
      assert.strictEqual(r.ok, true);
      assert.ok(r.latencyMs >= 0, 'latency captured');
      assert.strictEqual(r.error, null);
    } finally { server.close(); }
  });

  test('failed check: tcp connect to a closed port reports DOWN with an error', async () => {
    const server = net.createServer(() => {});
    const port = await listen(server);
    await new Promise(res => server.close(res)); // port now guaranteed closed
    const r = await tcp('127.0.0.1', { port, timeoutMs: 2000 });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /tcp:/);
    assert.strictEqual(r.latencyMs, null);
  });

  test('timeout handling: http server that never responds fails with a timeout error, not a crash', async () => {
    const server = http.createServer(() => { /* accept and never respond */ });
    const port = await listen(server);
    try {
      const r = await httpCheck('127.0.0.1', { healthUrl: `http://127.0.0.1:${port}/health`, timeoutMs: 250 });
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /timeout/i);
    } finally { server.closeAllConnections(); server.close(); }
  });

  test('http check: 2xx endpoint reports UP', async () => {
    const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
    const port = await listen(server);
    try {
      const r = await httpCheck('127.0.0.1', { healthUrl: `http://127.0.0.1:${port}/health`, timeoutMs: 2000 });
      assert.strictEqual(r.ok, true);
      assert.ok(r.latencyMs >= 0);
    } finally { server.close(); }
  });
});

describe('state transitions', () => {
  test('UP -> DOWN creates a down alert', () => {
    assert.deepStrictEqual(evaluateTransition('UP', 'DOWN'), { changed: true, alert: 'down' });
  });

  test('DOWN -> UP creates a recovered alert', () => {
    assert.deepStrictEqual(evaluateTransition('DOWN', 'UP'), { changed: true, alert: 'recovered' });
  });

  test('no duplicate alert when status remains the same', () => {
    assert.deepStrictEqual(evaluateTransition('UP', 'UP'), { changed: false, alert: null });
    assert.deepStrictEqual(evaluateTransition('DOWN', 'DOWN'), { changed: false, alert: null });
  });

  test('first check (UNKNOWN) changes state but does not alert', () => {
    assert.deepStrictEqual(evaluateTransition(null, 'UP'), { changed: true, alert: null });
    assert.deepStrictEqual(evaluateTransition('UNKNOWN', 'DOWN'), { changed: true, alert: null });
  });
});

describe('agent resilience', () => {
  test('one failing host does not crash the cycle; remaining assets still checked', async () => {
    const recorded = [];
    const fakeService = {
      loadMonitoredAssets: async () => [
        { asset_id: 1, ip_address: '10.0.0.1', check_method: 'boom' },   // checker throws
        { asset_id: 2, ip_address: '10.0.0.2', check_method: 'stub' },
        { asset_id: 3, hostname: null, ip_address: null, check_method: 'stub' } // unconfigured
      ],
      recordResult: async r => { recorded.push(r); return { status: r.ok ? 'UP' : 'DOWN', transition: { changed: false, alert: null } }; }
    };
    const fakeCheckers = {
      boom: async () => { throw new Error('checker exploded'); },
      stub: async () => ({ ok: true, latencyMs: 5, error: null }),
      icmp: async () => { throw new Error('checker exploded'); } // 'boom' falls back to icmp
    };
    const agent = new HeartbeatAgent({
      service: fakeService, checkers: fakeCheckers, logger: silentLogger,
      intervalSec: 3600, timeoutMs: 100, concurrency: 2
    });
    const summary = await agent.runCycle();
    assert.strictEqual(summary.assets, 3);
    // asset 1 exploded (isolated), asset 2 recorded UP, asset 3 recorded DOWN (unconfigured)
    assert.strictEqual(recorded.length, 2);
    assert.ok(recorded.find(r => r.assetId === 2 && r.ok === true));
    assert.ok(recorded.find(r => r.assetId === 3 && r.ok === false && /no hostname/.test(r.error)));
  });

  test('overlapping cycles are skipped, not stacked', async () => {
    let resolveLoad;
    const fakeService = {
      loadMonitoredAssets: () => new Promise(res => { resolveLoad = () => res([]); }),
      recordResult: async () => ({ status: 'UP', transition: { changed: false, alert: null } })
    };
    const agent = new HeartbeatAgent({ service: fakeService, checkers: {}, logger: silentLogger, intervalSec: 3600 });
    const first = agent.runCycle();          // hangs on loadMonitoredAssets
    const second = await agent.runCycle();   // must skip immediately
    assert.deepStrictEqual(second, { skipped: true });
    resolveLoad();
    await first;
  });
});
