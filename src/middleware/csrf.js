// Port of CsrfMiddleware: validates _csrf on POST against session token.
const crypto = require('crypto');
const { HttpError } = require('../core/helpers');

function csrfToken(req) {
  if (!req.session._csrf_token) {
    req.session._csrf_token = crypto.randomBytes(32).toString('hex');
  }
  return req.session._csrf_token;
}

function csrfProtect(req, res, next) {
  if (req.method === 'POST') {
    const token = (req.body && req.body._csrf) || '';
    const sessionToken = req.session._csrf_token || '';
    const valid = token && sessionToken &&
      token.length === sessionToken.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(sessionToken));
    if (!valid) {
      return next(new HttpError('Invalid security token. Please refresh the page and try again.', 419));
    }
  }
  next();
}

module.exports = { csrfToken, csrfProtect };
