const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

const config = require('./config');
const { pool } = require('./core/db');
const logger = require('./core/logger');
const { HttpError, hamsUrl } = require('./core/helpers');
const securityHeaders = require('./middleware/security');
const viewLocals = require('./middleware/viewLocals');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(securityHeaders);
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(config.publicDir));

app.use(session({
  store: new PgSession({ pool, tableName: 'sessions' }),
  secret: config.sessionSecret,
  name: 'hams_session',
  resave: false,
  saveUninitialized: true,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 }
}));

app.use(viewLocals);

app.use('/', require('./routes/web'));
app.use('/', require('./routes/api'));
app.use('/', require('./routes/agent-api'));
app.use('/', require('./routes/heartbeat'));
app.use('/', require('./routes/heartbeat-ui'));
app.use('/', require('./routes/agents-ui'));
app.use('/', require('./routes/software'));
app.use('/', require('./routes/licenseAllocation'));
app.use('/', require('./routes/newJoinees'));
app.use('/', require('./routes/assistant'));

// 404
app.use((req, res, next) => next(new HttpError('Route not found', 404)));

// Error handler (port of ExceptionHandler)
app.use((err, req, res, next) => {
  const status = err.status && err.status >= 100 && err.status < 600 ? err.status : 500;
  logger.error(err.message, {
    file: err.stack ? err.stack.split('\n')[1] : '',
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    user_id: req.session ? req.session.user_id : null,
    trace: err.stack || ''
  });
  let message = err.message;
  if (status === 500 && config.appEnv !== 'local') {
    message = 'An unexpected error occurred. Please try again later.';
  }
  const wantsJson = req.path.startsWith('/api') || (req.headers.accept || '').includes('application/json');
  if (wantsJson) {
    return res.status(status).json({ success: false, error: { code: status, message } });
  }
  if (res.renderPage) {
    return res.renderPage('_error', { message, statusCode: status });
  }
  res.status(status).send(message);
});

module.exports = app;
