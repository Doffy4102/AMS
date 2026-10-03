// Port of RateLimitMiddleware: DB-backed login throttle keyed by md5(ip|email).
const crypto = require('crypto');
const db = require('../core/db');
const { hamsUrl } = require('../core/helpers');

function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

function loginRateLimit(maxAttempts = 5, decayMinutes = 15) {
  return (req, res, next) => {
    (async () => {
      const ip = req.ip || '127.0.0.1';
      const email = String((req.body && req.body.email) || '').trim().toLowerCase();
      const key = 'login_attempts:' + md5(ip + '|' + email);
      const now = Math.floor(Date.now() / 1000);
      const row = await db.get('SELECT * FROM login_rate_limits WHERE rate_key = $1', [key]);
      if (row && Number(row.expires_at) > now && row.attempts >= maxAttempts) {
        const remaining = Math.max(1, Math.ceil((Number(row.expires_at) - now) / 60));
        req.flash('error', `Too many login attempts. Please try again in ${remaining} minute(s).`);
        return res.redirect(hamsUrl('/login'));
      }
      const expires = now + decayMinutes * 60;
      if (!row) {
        await db.run(
          'INSERT INTO login_rate_limits (rate_key, attempts, expires_at) VALUES ($1, 1, $2) ON CONFLICT (rate_key) DO UPDATE SET attempts = 1, expires_at = $2',
          [key, expires]
        );
      } else if (Number(row.expires_at) <= now) {
        await db.run('UPDATE login_rate_limits SET attempts = 1, expires_at = $1 WHERE rate_key = $2', [expires, key]);
      } else {
        await db.run('UPDATE login_rate_limits SET attempts = attempts + 1 WHERE rate_key = $1', [key]);
      }
      next();
    })().catch(next);
  };
}

async function clearAttempts(ip, email) {
  const key = 'login_attempts:' + md5(ip + '|' + String(email || '').trim().toLowerCase());
  await db.run('DELETE FROM login_rate_limits WHERE rate_key = $1', [key]);
}

module.exports = { loginRateLimit, clearAttempts };
