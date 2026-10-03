// Asset Health Check agent: periodically checks every monitoring-enabled asset
// (concurrently, via a small worker pool) and persists results through
// heartbeatService. One failing host can never crash the agent: every asset check
// is individually try/caught, and an unexpected error is itself recorded as DOWN.
const config = require('../../config');
const realLogger = require('../../core/logger');
const { CHECKERS } = require('./checkers');
const defaultService = require('./heartbeatService');

class HeartbeatAgent {
  constructor(opts = {}) {
    this.service = opts.service || defaultService;
    this.checkers = opts.checkers || CHECKERS;
    this.logger = opts.logger || realLogger;
    this.intervalMs = (opts.intervalSec || config.heartbeat.intervalSec) * 1000;
    this.timeoutMs = opts.timeoutMs || config.heartbeat.timeoutMs;
    this.concurrency = opts.concurrency || config.heartbeat.concurrency;
    this.timer = null;
    this.cycleRunning = false;
  }

  start() {
    this.logger.info('Heartbeat agent started', {
      interval_sec: this.intervalMs / 1000, timeout_ms: this.timeoutMs, concurrency: this.concurrency
    });
    this.runCycle(); // immediate first pass, then on the interval
    this.timer = setInterval(() => this.runCycle(), this.intervalMs);
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.logger.info('Heartbeat agent stopped');
  }

  // One full pass over all monitored assets with bounded concurrency.
  // Skips (does not queue) if the previous cycle is still running.
  async runCycle() {
    if (this.cycleRunning) {
      this.logger.warning('Heartbeat cycle skipped: previous cycle still running');
      return { skipped: true };
    }
    this.cycleRunning = true;
    const started = Date.now();
    try {
      const assets = await this.service.loadMonitoredAssets();
      const queue = [...assets];
      let up = 0, down = 0, changes = 0;
      const worker = async () => {
        while (queue.length) {
          const asset = queue.shift();
          const outcome = await this.checkAsset(asset);
          if (outcome) {
            outcome.status === 'UP' ? up++ : down++;
            if (outcome.transition && outcome.transition.changed) changes++;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length || 1) }, worker));
      this.logger.info('Heartbeat cycle complete', {
        assets: assets.length, up, down, state_changes: changes, duration_ms: Date.now() - started
      });
      return { assets: assets.length, up, down, changes };
    } catch (err) {
      // e.g. DB unavailable — log and let the next interval retry
      this.logger.error('Heartbeat cycle failed: ' + err.message, { trace: err.stack });
      return { error: err.message };
    } finally {
      this.cycleRunning = false;
    }
  }

  // Check a single asset. Never throws.
  async checkAsset(asset) {
    const target = asset.ip_address || asset.hostname;
    const method = this.checkers[asset.check_method] ? asset.check_method : 'icmp';
    try {
      let result;
      if (!target) {
        result = { ok: false, latencyMs: null, error: 'no hostname or ip_address configured' };
      } else {
        result = await this.checkers[method](target, {
          timeoutMs: this.timeoutMs, port: asset.port, healthUrl: asset.health_url
        });
      }
      const saved = await this.service.recordResult({
        assetId: asset.asset_id, ok: result.ok, latencyMs: result.latencyMs,
        error: result.error, checkMethod: method, target: target || '(unconfigured)'
      });
      if (saved.transition.changed && saved.transition.alert) {
        this.logger.warning(`Heartbeat state change: asset ${asset.asset_id} ${saved.transition.alert === 'down' ? 'UP -> DOWN' : 'DOWN -> UP'}`, {
          asset_id: asset.asset_id, asset: asset.asset_name, target, method, error: result.error
        });
      } else if (result.ok) {
        this.logger.debug(`Heartbeat OK: asset ${asset.asset_id} (${target}) ${result.latencyMs}ms`, { asset_id: asset.asset_id, method });
      } else {
        this.logger.warning(`Heartbeat FAIL: asset ${asset.asset_id} (${target}): ${result.error}`, { asset_id: asset.asset_id, method });
      }
      return { status: saved.status, transition: saved.transition };
    } catch (err) {
      // Unexpected error (bad config, DB hiccup on this row, checker bug) —
      // isolate it so the rest of the cycle continues.
      this.logger.error(`Heartbeat unexpected error for asset ${asset.asset_id}: ${err.message}`, {
        asset_id: asset.asset_id, trace: err.stack
      });
      return null;
    }
  }
}

module.exports = { HeartbeatAgent };
