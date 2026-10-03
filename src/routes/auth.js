// Auth + Profile routes (port of AuthController + ProfileController).
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../core/db');
const config = require('../config');
const settings = require('../services/settingsService');
const assetService = require('../services/assetService');
const requestService = require('../services/requestService');
const totp = require('../core/totp');
const { csrfProtect } = require('../middleware/csrf');
const { loginRateLimit, clearAttempts } = require('../middleware/rateLimit');
const { authRequired, currentUser } = require('../middleware/auth');
const { hamsUrl, e, trimStr } = require('../core/helpers');
const { validate } = require('../core/validator');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

async function findUserByEmail(email) {
  return db.get(`SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL`, [email]);
}

function canLogin(user) {
  const status = String(user.status || 'active').toLowerCase();
  return !user.deleted_at && ['', 'active'].includes(status);
}

async function recordLogin(userId) {
  await db.run('UPDATE users SET last_login_at = NOW() WHERE id = $1', [userId]);
}

function completeLogin(req, user, flashMsg) {
  return new Promise(resolve => {
    req.session.regenerate(err => {
      req.session.user_id = user.id;
      req.session.user_role = user.role || 'user';
      req.flash('success', flashMsg);
      resolve();
    });
  });
}

// ─── Login ───
router.get('/login', async (req, res) => {
  if (req.session.user_id) return res.redirect(hamsUrl('/'));
  const providers = {
    oidc: (await settings.get('identity', 'oidc_enabled')) === '1',
    saml: (await settings.get('identity', 'saml_enabled')) === '1'
  };
  res.renderBare('auth/login', { providers });
});

router.post('/login', csrfProtect, loginRateLimit(), async (req, res, next) => {
  try {
    const email = trimStr(req.body.email);
    const password = req.body.password || '';
    const user = await findUserByEmail(email);
    if (!user || !(await bcrypt.compare(password, String(user.password).replace(/^\$2y\$/, '$2a$')))) {
      req.flash('error', 'Invalid email or password');
      return res.redirect(hamsUrl('/login'));
    }
    if (!canLogin(user)) {
      req.flash('error', 'Your account is not active. Please contact an administrator.');
      return res.redirect(hamsUrl('/login'));
    }
    const mfaSystem = (await settings.get('security', 'two_factor_system_enabled')) === '1';
    if (mfaSystem && user.two_factor_enabled) {
      req.session.mfa_user_id = user.id;
      if (!user.two_factor_secret) return res.redirect(hamsUrl('/login/mfa/setup'));
      return res.redirect(hamsUrl('/login/mfa'));
    }
    await clearAttempts(req.ip, email);
    await completeLogin(req, user, 'Welcome back, ' + e(user.name));
    await recordLogin(user.id);
    res.redirect(hamsUrl('/'));
  } catch (err) { next(err); }
});

router.get('/logout', (req, res) => {
  delete req.session.user_id;
  res.redirect(hamsUrl('/login'));
});

// ─── MFA ───
router.get('/login/mfa', async (req, res) => {
  if (!req.session.mfa_user_id) return res.redirect(hamsUrl('/login'));
  res.renderBare('auth/mfa', {});
});

router.post('/login/mfa', csrfProtect, loginRateLimit(), async (req, res, next) => {
  try {
    if (!req.session.mfa_user_id) return res.redirect(hamsUrl('/login'));
    const user = await db.get('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [req.session.mfa_user_id]);
    if (user && totp.verifyCode(user.two_factor_secret, req.body.code)) {
      if (!canLogin(user)) {
        delete req.session.mfa_user_id;
        req.flash('error', 'Your account is not active. Please contact an administrator.');
        return res.redirect(hamsUrl('/login'));
      }
      delete req.session.mfa_user_id;
      await completeLogin(req, user, 'MFA Verified. Welcome back!');
      await recordLogin(user.id);
      return res.redirect(hamsUrl('/'));
    }
    req.flash('error', 'Invalid 2FA code');
    res.redirect(hamsUrl('/login/mfa'));
  } catch (err) { next(err); }
});

router.get('/login/mfa/setup', async (req, res, next) => {
  try {
    if (!req.session.mfa_user_id) return res.redirect(hamsUrl('/login'));
    const user = await db.get('SELECT * FROM users WHERE id = $1', [req.session.mfa_user_id]);
    if (!user) return res.redirect(hamsUrl('/login'));
    if (user.two_factor_secret) return res.redirect(hamsUrl('/login/mfa'));
    const secret = req.session.mfa_setup_secret || totp.createSecret();
    req.session.mfa_setup_secret = secret;
    const appName = await settings.get('branding', 'app_name', 'HAMS');
    res.renderBare('auth/mfa_setup', { secret, qrCodeUrl: totp.getQRCodeUrl(user.email, secret, appName) });
  } catch (err) { next(err); }
});

router.post('/login/mfa/setup', csrfProtect, loginRateLimit(), async (req, res, next) => {
  try {
    if (!req.session.mfa_user_id) return res.redirect(hamsUrl('/login'));
    const { code, secret } = req.body;
    if (!totp.verifyCode(secret, code)) {
      req.flash('error', 'Invalid verification code. Please scan again.');
      return res.redirect(hamsUrl('/login/mfa/setup'));
    }
    await db.run('UPDATE users SET two_factor_secret = $1, two_factor_enabled = TRUE WHERE id = $2',
      [secret, req.session.mfa_user_id]);
    const user = await db.get('SELECT * FROM users WHERE id = $1', [req.session.mfa_user_id]);
    delete req.session.mfa_setup_secret;
    delete req.session.mfa_user_id;
    await completeLogin(req, user, 'MFA Verified. Welcome back!');
    await recordLogin(user.id);
    res.redirect(hamsUrl('/'));
  } catch (err) { next(err); }
});

// ─── Forgot / Reset password ───
router.get('/forgot-password', (req, res) => res.renderBare('auth/forgot_password', {}));

router.post('/forgot-password', csrfProtect, loginRateLimit(), async (req, res, next) => {
  try {
    const email = trimStr(req.body.email);
    if (!email) {
      req.flash('error', 'Please enter your email address.');
      return res.redirect(hamsUrl('/forgot-password'));
    }
    const user = await findUserByEmail(email);
    if (user) {
      await db.run('DELETE FROM password_resets WHERE email = $1', [email]);
      const token = crypto.randomBytes(32).toString('hex');
      const hash = crypto.createHash('sha256').update(token).digest('hex');
      await db.run(
        `INSERT INTO password_resets (email, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
        [email, hash]);
      // Email delivery requires SMTP config; reset link logged for administrators.
      require('../core/logger').info(`Password reset link for ${email}: ${hamsUrl('/reset-password/' + token)}`);
    }
    req.flash('success', 'If an account exists for that email, a reset link has been sent.');
    res.redirect(hamsUrl('/forgot-password'));
  } catch (err) { next(err); }
});

async function verifyResetToken(token) {
  const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
  const row = await db.get('SELECT email FROM password_resets WHERE token = $1 AND expires_at > NOW()', [hash]);
  return row ? row.email : null;
}

router.get('/reset-password/:token', async (req, res, next) => {
  try {
    const email = await verifyResetToken(req.params.token);
    if (!email) {
      req.flash('error', 'This reset link is invalid or has expired.');
      return res.redirect(hamsUrl('/forgot-password'));
    }
    res.renderBare('auth/reset_password', { token: req.params.token });
  } catch (err) { next(err); }
});

router.post('/reset-password', csrfProtect, loginRateLimit(), async (req, res, next) => {
  try {
    const { token, password, password_confirmation } = req.body;
    if (!password || String(password).length < 8) {
      req.flash('error', 'Password must be at least 8 characters.');
      return res.redirect(hamsUrl('/reset-password/' + token));
    }
    if (password !== password_confirmation) {
      req.flash('error', 'Passwords do not match.');
      return res.redirect(hamsUrl('/reset-password/' + token));
    }
    const email = await verifyResetToken(token);
    if (!email) {
      req.flash('error', 'Reset failed. The link may have expired.');
      return res.redirect(hamsUrl('/forgot-password'));
    }
    const hashPw = await bcrypt.hash(String(password), 10);
    await db.tx(async t => {
      await t.run('UPDATE users SET password = $1 WHERE email = $2', [hashPw, email]);
      await t.run('DELETE FROM password_resets WHERE email = $1', [email]);
    });
    req.flash('success', 'Password reset successful. You can now log in.');
    res.redirect(hamsUrl('/login'));
  } catch (err) { next(err); }
});

// ─── OIDC / SAML (enabled-state stubs; identity provider settings drive availability) ───
router.get('/auth/oidc', async (req, res) => {
  const enabled = (await settings.get('identity', 'oidc_enabled')) === '1';
  const authUrl = await settings.get('identity', 'oidc_authorization_url', '');
  if (!enabled || !authUrl) {
    req.flash('error', 'OIDC sign-in is not configured.');
    return res.redirect(hamsUrl('/login'));
  }
  const state = crypto.randomBytes(24).toString('hex');
  req.session.oidc_state = state;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: await settings.get('identity', 'oidc_client_id', ''),
    redirect_uri: await settings.get('identity', 'oidc_redirect_uri', hamsUrl('/auth/oidc/callback')),
    scope: await settings.get('identity', 'oidc_scopes', 'openid email profile'),
    state
  });
  res.redirect(`${authUrl}?${params.toString()}`);
});

router.get('/auth/oidc/callback', async (req, res) => {
  req.flash('error', 'Identity provider error: OIDC callback handling requires a configured provider.');
  res.redirect(hamsUrl('/login'));
});

router.get('/auth/saml', async (req, res) => {
  const enabled = (await settings.get('identity', 'saml_enabled')) === '1';
  const ssoUrl = await settings.get('identity', 'saml_sso_url', '');
  if (!enabled || !ssoUrl) {
    req.flash('error', 'SAML sign-in is not configured.');
    return res.redirect(hamsUrl('/login'));
  }
  res.redirect(ssoUrl);
});

router.post('/auth/saml/acs', (req, res) => {
  req.flash('error', 'Identity provider error: SAML assertion handling requires a configured provider.');
  res.redirect(hamsUrl('/login'));
});

// ─── Profile ───
router.get('/profile', authRequired, async (req, res, next) => {
  try {
    const user = await db.get(
      `SELECT u.*, d.name AS department_name, l.name AS location_name FROM users u
       LEFT JOIN departments d ON u.department_id = d.id
       LEFT JOIN locations l ON u.location_id = l.id
       WHERE u.id = $1`, [req.session.user_id]);
    const [assets, accessories, licenses, components, requests] = await Promise.all([
      assetService.getAssignedToUser(user.id),
      assetService.getAssignedAccessories(user.id),
      assetService.getAssignedLicenses(user.id),
      assetService.getAssignedComponents(user.id),
      requestService.mine(user.id)
    ]);
    res.renderPage('users/profile', { user, assets, accessories, licenses, components, requests });
  } catch (err) { next(err); }
});

router.post('/profile', authRequired, upload.single('avatar_file'), csrfProtect, async (req, res, next) => {
  try {
    const data = req.body;
    const v = validate(data, { name: 'required|max:255', email: 'required|email' });
    if (v.fails) {
      req.flash('error', v.firstError);
      return res.redirect(hamsUrl('/profile'));
    }
    const user = await currentUser(req);
    let avatarUrl = user.avatar_url;
    if (data.remove_avatar === '1') avatarUrl = null;
    if (req.file) {
      const allowed = ['image/jpeg', 'image/png', 'image/jpg'];
      if (!allowed.includes(req.file.mimetype)) {
        req.flash('error', 'Only JPG, JPEG, and PNG images are allowed.');
        return res.redirect(hamsUrl('/profile'));
      }
      if (req.file.size > 2097152) {
        req.flash('error', 'Image size must be less than 2MB.');
        return res.redirect(hamsUrl('/profile'));
      }
      const dir = path.join(config.publicDir, 'uploads', 'avatars');
      fs.mkdirSync(dir, { recursive: true });
      const filename = Date.now().toString(36) + '_' + req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      fs.writeFileSync(path.join(dir, filename), req.file.buffer);
      avatarUrl = 'uploads/avatars/' + filename;
    }
    await db.run('UPDATE users SET name = $1, email = $2, avatar_url = $3 WHERE id = $4',
      [trimStr(data.name), trimStr(data.email), avatarUrl, user.id]);
    req.flash('success', 'Profile updated successfully.');
    res.redirect(hamsUrl('/profile'));
  } catch (err) { next(err); }
});

router.post('/profile/password', authRequired, csrfProtect, async (req, res, next) => {
  try {
    const v = validate(req.body, {
      current_password: 'required',
      new_password: 'required|min:8',
      confirm_password: 'required|same:new_password'
    });
    if (v.fails) {
      req.flash('error', v.firstError);
      return res.redirect(hamsUrl('/profile'));
    }
    const user = await currentUser(req);
    const ok = await bcrypt.compare(String(req.body.current_password), String(user.password).replace(/^\$2y\$/, '$2a$'));
    if (!ok) {
      req.flash('error', 'Current password is incorrect.');
      return res.redirect(hamsUrl('/profile'));
    }
    await db.run('UPDATE users SET password = $1 WHERE id = $2',
      [await bcrypt.hash(String(req.body.new_password), 10), user.id]);
    req.flash('success', 'Password updated successfully.');
    res.redirect(hamsUrl('/profile'));
  } catch (err) { next(err); }
});

router.get('/profile/2fa/setup', authRequired, async (req, res, next) => {
  try {
    if ((await settings.get('security', 'two_factor_system_enabled')) !== '1') {
      req.flash('error', 'Two-Factor Authentication is currently disabled by the administrator.');
      return res.redirect(hamsUrl('/profile'));
    }
    const user = await currentUser(req);
    if (user.two_factor_enabled) return res.redirect(hamsUrl('/profile'));
    const secret = req.session.mfa_setup_secret || totp.createSecret();
    req.session.mfa_setup_secret = secret;
    const appName = await settings.get('branding', 'app_name', 'HAMS');
    res.renderPage('users/2fa_setup', { secret, qrCodeUrl: totp.getQRCodeUrl(user.email, secret, appName) });
  } catch (err) { next(err); }
});

router.post('/profile/2fa/enable', authRequired, csrfProtect, async (req, res, next) => {
  try {
    const { code, secret } = req.body;
    if (!code || !secret) {
      req.flash('error', 'Validation code and secret are required.');
      return res.redirect(hamsUrl('/profile/2fa/setup'));
    }
    if (!totp.verifyCode(secret, code)) {
      req.flash('error', 'Invalid verification code. Please scan the QR code again.');
      return res.redirect(hamsUrl('/profile/2fa/setup'));
    }
    await db.run('UPDATE users SET two_factor_secret = $1, two_factor_enabled = TRUE WHERE id = $2',
      [secret, req.session.user_id]);
    delete req.session.mfa_setup_secret;
    req.flash('success', 'Two-factor authentication has been enabled.');
    res.redirect(hamsUrl('/profile'));
  } catch (err) { next(err); }
});

router.post('/profile/2fa/disable', authRequired, csrfProtect, async (req, res, next) => {
  try {
    await db.run('UPDATE users SET two_factor_secret = NULL, two_factor_enabled = FALSE WHERE id = $1',
      [req.session.user_id]);
    req.flash('success', 'Two-Factor Authentication disabled.');
    res.redirect(hamsUrl('/profile'));
  } catch (err) { next(err); }
});

module.exports = router;
