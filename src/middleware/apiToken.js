// Port of ApiTokenMiddleware + ApiRateLimiter (DB fallback path).
const crypto = require('crypto');
const db = require('../core/db');
const authz = require('../services/authorizationService');

const RATE_LIMIT = 1000;
const RATE_WINDOW = 3600; // seconds

function normalizeEndpoint(path) {
  return path.replace(/\/\d+/g, '/:id');
}

function extractRequiredPermission(path) {
  const normalized = normalizeEndpoint(path);
  if (normalized.startsWith('/api/v1/assets')) return 'assets.view';
  return null;
}

async function checkRateLimit(tokenId, endpoint) {
  const now = Date.now();
  const windowStartCutoff = new Date(now - RATE_WINDOW * 1000);
  const row = await db.get(
    `SELECT COALESCE(SUM(attempts), 0)::int AS total, MIN(window_start) AS earliest
     FROM api_rate_limits WHERE token_id = $1 AND endpoint = $2 AND window_start >= $3`,
    [tokenId, endpoint, windowStartCutoff]
  );
  const total = row ? row.total : 0;
  if (total >= RATE_LIMIT) {
    const earliest = row.earliest ? new Date(row.earliest).getTime() : now;
    return { allowed: false, limit: RATE_LIMIT, remaining: 0, reset: Math.floor(earliest / 1000) + RATE_WINDOW };
  }
  const bucket = new Date(Math.floor(now / 60000) * 60000);
  await db.run(
    `INSERT INTO api_rate_limits (token_id, endpoint, attempts, window_start)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT (token_id, endpoint, window_start) DO UPDATE SET attempts = api_rate_limits.attempts + 1`,
    [tokenId, endpoint, bucket]
  );
  return { allowed: true, limit: RATE_LIMIT, remaining: RATE_LIMIT - total - 1, reset: Math.floor(now / 1000) + RATE_WINDOW };
}

function apiTokenAuth(req, res, next) {
  (async () => {
    const header = req.headers.authorization || '';
    const match = header.match(/Bearer\s+(\S+)/);
    if (!match) {
      return res.status(401).json({ success: false, error: 'Unauthorized. Missing or invalid Authorization header.' });
    }
    const tokenHash = crypto.createHash('sha256').update(match[1]).digest('hex');
    const token = await db.get(
      `SELECT t.*, u.role, u.status AS user_status FROM api_tokens t
       JOIN users u ON t.user_id = u.id
       WHERE t.token_hash = $1 AND u.deleted_at IS NULL`,
      [tokenHash]
    );
    if (!token) return res.status(401).json({ success: false, error: 'Unauthorized. Invalid API token.' });
    if (token.revoked_at !== null) return res.status(401).json({ success: false, error: 'Unauthorized. API token has been revoked.' });
    if (token.expires_at && new Date(token.expires_at).getTime() < Date.now()) {
      return res.status(401).json({ success: false, error: 'Unauthorized. API token has expired.' });
    }
    if (token.user_status !== 'active') {
      return res.status(403).json({ success: false, error: 'Forbidden. User account is not active.' });
    }

    const endpoint = normalizeEndpoint(req.path);
    const rl = await checkRateLimit(token.id, endpoint);
    res.setHeader('X-RateLimit-Limit', rl.limit);
    res.setHeader('X-RateLimit-Remaining', rl.remaining);
    res.setHeader('X-RateLimit-Reset', rl.reset);
    if (!rl.allowed) {
      const retryAfter = Math.max(rl.reset - Math.floor(Date.now() / 1000), 1);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({ success: false, error: 'Too Many Requests. Rate limit exceeded.', retry_after: retryAfter });
    }

    // Abilities check
    let abilities = token.abilities;
    if (typeof abilities === 'string') { try { abilities = JSON.parse(abilities); } catch (_) { abilities = null; } }
    const requiredPermission = extractRequiredPermission(req.path);
    if (abilities !== null && Array.isArray(abilities) && abilities.length > 0 && requiredPermission) {
      const user = { id: token.user_id, role: token.role };
      if (abilities.includes('*')) {
        if (!(await authz.can(requiredPermission, user))) {
          return res.status(403).json({ success: false, error: `Forbidden. Token does not have the required permission: ${requiredPermission}` });
        }
      } else if (!abilities.includes(requiredPermission)) {
        return res.status(403).json({ success: false, error: `Forbidden. Token does not have the required permission: ${requiredPermission}` });
      } else if (!(await authz.can(requiredPermission, user))) {
        return res.status(403).json({ success: false, error: `Forbidden. Token does not have the required permission: ${requiredPermission}` });
      }
    }

    await db.run('UPDATE api_tokens SET last_used_at = NOW(), last_ip = $1 WHERE id = $2', [req.ip, token.id]);
    req.apiToken = token;
    req.session.user_id = token.user_id;
    req.session.user_role = token.role;
    req.session.api_authenticated = true;
    next();
  })().catch(next);
}

module.exports = { apiTokenAuth };
