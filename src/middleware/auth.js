// Port of AuthMiddleware: session guard + employee redirect to portal.
const db = require('../core/db');
const authz = require('../services/authorizationService');
const { hamsUrl } = require('../core/helpers');

const ALWAYS_ALLOWED_PREFIXES = ['/portal', '/logout', '/profile', '/api/'];

async function currentUser(req) {
  if (!req.session || !req.session.user_id) return null;
  if (req._cachedUser !== undefined) return req._cachedUser;
  const user = await db.get(
    'SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL',
    [req.session.user_id]
  );
  req._cachedUser = user;
  return user;
}

function authRequired(req, res, next) {
  (async () => {
    if (!req.session.user_id) {
      return res.redirect(hamsUrl('/login'));
    }
    const path = req.path;
    if (ALWAYS_ALLOWED_PREFIXES.some(p => path.startsWith(p))) return next();
    const user = await currentUser(req);
    if (!user || !(await authz.can('dashboard.view', user))) {
      return res.redirect(hamsUrl('/portal/dashboard'));
    }
    next();
  })().catch(next);
}

module.exports = { authRequired, currentUser };
