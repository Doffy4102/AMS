const config = require('../config');

// Mirrors PHP hams_url(): prefix APP_URL
function hamsUrl(p = '') {
  const path = '/' + String(p).replace(/^\/+/, '');
  return config.appUrl + (path === '/' ? '' : path);
}

// Mirrors PHP e() htmlspecialchars ENT_QUOTES
function e(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ''/null/undefined -> null else int
function nullableId(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

function intOr(v, def = 0) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}

function trimStr(v, def = '') {
  if (v === null || v === undefined) return def;
  return String(v).trim();
}

// Trim all string values of a body object (mirrors Request::getBody sanitize)
function sanitizeBody(body) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (typeof v === 'string') out[k] = v.trim();
    else if (Array.isArray(v)) out[k] = v.map(x => (typeof x === 'string' ? x.trim() : x));
    else out[k] = v;
  }
  return out;
}

// Extract cf_-prefixed custom fields (mirrors PHP extractCustomFields)
function extractCustomFields(data) {
  const cf = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (k.startsWith('cf_')) cf[k.substring(3)] = v;
  }
  return cf;
}

// HttpError with status code (mirrors PHP \Exception($msg, $code))
class HttpError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

function formatDate(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toISOString().slice(0, 10);
}

function formatDateTime(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// CSV encode a row of values (RFC-ish, like fputcsv)
function csvRow(values) {
  return values.map(v => {
    const s = v === null || v === undefined ? '' : String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }).join(',');
}

function timestampSlug() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

module.exports = {
  hamsUrl, e, nullableId, intOr, trimStr, sanitizeBody, extractCustomFields,
  HttpError, formatDate, formatDateTime, csvRow, timestampSlug
};
