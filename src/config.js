const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

module.exports = {
  appName: process.env.APP_NAME || 'HAMS',
  appEnv: process.env.APP_ENV || 'local',
  appUrl: (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  port: parseInt(process.env.APP_PORT || process.env.PORT || '3000', 10),
  sessionSecret: process.env.SESSION_SECRET || 'it-hams-secret',
  databaseUrl: process.env.DATABASE_URL || null,
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'it_hams',
    user: process.env.DB_USER || 'hams',
    password: process.env.DB_PASS || 'hams',
    ssl: process.env.DB_SSL === '1' || !!process.env.DATABASE_URL
  },
  rootDir: path.join(__dirname, '..'),
  storageDir: path.join(__dirname, '..', 'storage'),
  publicDir: path.join(__dirname, '..', 'public'),
  // INR -> USD conversion for the Software tab pricing toggle (dataset amounts
  // are INR). Override without a code change: USD_INR_RATE in .env.
  usdInrRate: parseFloat(process.env.USD_INR_RATE || '83.5'),
  heartbeat: {
    enabled: process.env.HEARTBEAT_ENABLED === '1',
    intervalSec: parseInt(process.env.HEARTBEAT_INTERVAL || '60', 10),
    timeoutMs: parseInt(process.env.HEARTBEAT_TIMEOUT_MS || '3000', 10),
    concurrency: parseInt(process.env.HEARTBEAT_CONCURRENCY || '10', 10)
  }
};
