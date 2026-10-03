// NDJSON file logger (port of App\Core\Logger) -> storage/logs/hams.log
const fs = require('fs');
const path = require('path');
const config = require('../config');

const logDir = path.join(config.storageDir, 'logs');
const logFile = path.join(logDir, 'hams.log');
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB rotate

function ensureDir() {
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
}

function write(level, message, context = {}) {
  try {
    ensureDir();
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_SIZE) {
      fs.renameSync(logFile, logFile + '.1');
    }
    const entry = {
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
      level: level.toUpperCase(),
      message: String(message),
      ...(context.user_id ? { user_id: context.user_id } : {}),
      context
    };
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  } catch (_) { /* logging must never crash the app */ }
}

module.exports = {
  logDir,
  logFile,
  info: (msg, ctx) => write('INFO', msg, ctx),
  warning: (msg, ctx) => write('WARNING', msg, ctx),
  error: (msg, ctx) => write('ERROR', msg, ctx),
  debug: (msg, ctx) => write('DEBUG', msg, ctx)
};
