const app = require('./app');
const config = require('./config');
const logger = require('./core/logger');

app.listen(config.port, () => {
  console.log(`IT-HAMS running at ${config.appUrl} (env: ${config.appEnv})`);
  logger.info(`Server started on port ${config.port}`);
  if (config.heartbeat.enabled) {
    const { HeartbeatAgent } = require('./services/heartbeat/heartbeatAgent');
    new HeartbeatAgent().start();
    console.log(`Heartbeat agent enabled (interval ${config.heartbeat.intervalSec}s)`);
  }
});
