#!/usr/bin/env node
// Standalone runner for the Asset Health Check agent (mirrors hams-cli style).
//   node bin/heartbeat-agent.js            run continuously on the configured interval
//   node bin/heartbeat-agent.js --once     run a single check cycle and exit
// Interval/timeout/concurrency come from .env (HEARTBEAT_INTERVAL etc.) — see config.js.
const { HeartbeatAgent } = require('../src/services/heartbeat/heartbeatAgent');
const { pool } = require('../src/core/db');
const config = require('../src/config');

(async () => {
  const agent = new HeartbeatAgent();
  if (process.argv.includes('--once')) {
    const summary = await agent.runCycle();
    console.log('Heartbeat cycle:', JSON.stringify(summary));
    await pool.end();
    process.exit(summary && summary.error ? 1 : 0);
  }
  console.log(`Heartbeat agent running (interval ${config.heartbeat.intervalSec}s, timeout ${config.heartbeat.timeoutMs}ms, concurrency ${config.heartbeat.concurrency}). Ctrl+C to stop.`);
  agent.start();
  const shutdown = async () => { agent.stop(); await pool.end(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch(err => { console.error(err); process.exit(1); });
