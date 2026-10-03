// Port of TwoFactorService: RFC 6238 TOTP, HMAC-SHA1, 30s period, 6 digits,
// 16-char base32 secret, +/-1 slice verification window.
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function createSecret(length = 16) {
  let s = '';
  for (let i = 0; i < length; i++) s += ALPHABET[crypto.randomInt(0, 32)];
  return s;
}

function base32Decode(input) {
  const clean = String(input).replace(/=+$/, '').toUpperCase();
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) return Buffer.alloc(0);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function getCode(secret, timeSlice = null) {
  if (timeSlice === null) timeSlice = Math.floor(Date.now() / 1000 / 30);
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(0, 0);
  buf.writeUInt32BE(timeSlice, 4);
  const hm = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hm[hm.length - 1] & 0x0f;
  const code = ((hm.readUInt32BE(offset) & 0x7fffffff) % 1000000);
  return String(code).padStart(6, '0');
}

function verifyCode(secret, code, discrepancy = 1) {
  if (!secret || !code) return false;
  const current = Math.floor(Date.now() / 1000 / 30);
  for (let i = -discrepancy; i <= discrepancy; i++) {
    if (getCode(secret, current + i) === String(code).trim()) return true;
  }
  return false;
}

// Same external QR service as the original (api.qrserver.com is CSP-allowed)
function getQRCodeUrl(name, secret, title = null) {
  const issuer = title || 'HAMS';
  const otpauth = `otpauth://totp/${title ? title + ':' : ''}${name}?secret=${secret}&issuer=${issuer}`;
  return `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(otpauth)}&size=200x200&ecc=M`;
}

module.exports = { createSecret, getCode, verifyCode, getQRCodeUrl };
