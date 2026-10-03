// Port of LogService: NDJSON log file viewer/search/retention.
const fs = require('fs');
const path = require('path');
const logger = require('../core/logger');
const settings = require('./settingsService');
const { intOr } = require('../core/helpers');

const logDir = logger.logDir;
const activeFile = logger.logFile;

function readEntries(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      entry.line_number = i + 1;
      entries.push(entry);
    } catch (_) {}
  }
  return entries;
}

function parseMessage(message) {
  const msg = String(message || '');
  if (/^Exception \d+:/.test(msg)) return { type: 'exception', title: 'Exception', details: msg };
  if (/^SQLSTATE\[/.test(msg)) return { type: 'database', title: 'Database Error', details: msg };
  if (/smtp|mail/i.test(msg)) return { type: 'smtp', title: 'Mail', details: msg };
  if (/^Warning[:\[]/.test(msg)) return { type: 'warning', title: 'Warning', details: msg };
  if (/^Fatal error[:\[]/.test(msg)) return { type: 'fatal', title: 'Fatal Error', details: msg };
  return { type: 'generic', title: msg.slice(0, 80), details: msg };
}

function enrich(entry) {
  const level = String(entry.level || 'INFO').toLowerCase();
  const ctx = entry.context || {};
  return {
    ...entry,
    parsed_message: parseMessage(entry.message),
    parsed_trace: ctx.trace ? String(ctx.trace).split('\n').map(raw => ({ raw })) : [],
    context_summary: {
      file: ctx.file, line: ctx.line, url: ctx.url, method: ctx.method,
      ip: ctx.ip, user_id: ctx.user_id, request_uri: ctx.request_uri
    },
    severity_class: ['error', 'warning', 'info', 'debug'].includes(level) ? level : 'info'
  };
}

function search(filters = {}, page = 1, perPage = 50) {
  const filePath = filters.file || activeFile;
  let entries = readEntries(filePath);
  if (filters.level && filters.level !== 'ALL') {
    entries = entries.filter(e => e.level === String(filters.level).toUpperCase());
  }
  if (filters.search) {
    const q = String(filters.search).toLowerCase();
    entries = entries.filter(e => JSON.stringify(e).toLowerCase().includes(q));
  }
  if (filters.date_from) entries = entries.filter(e => e.timestamp >= filters.date_from);
  if (filters.date_to) entries = entries.filter(e => e.timestamp <= filters.date_to + ' 23:59:59');
  if (filters.user_id) entries = entries.filter(e => String(e.user_id) === String(filters.user_id));

  const total = entries.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  page = Math.min(Math.max(1, page), totalPages);
  entries = entries.reverse().slice((page - 1) * perPage, page * perPage).map(enrich);
  return { entries, total, page, perPage, totalPages };
}

function getStats() {
  const entries = readEntries(activeFile);
  const byLevel = { ERROR: 0, WARNING: 0, INFO: 0, DEBUG: 0 };
  const byHour = Array(24).fill(0);
  const recentErrors = [];
  for (const e of entries) {
    if (byLevel[e.level] !== undefined) byLevel[e.level] += 1;
    const h = parseInt(String(e.timestamp || '').slice(11, 13), 10);
    if (!Number.isNaN(h) && h >= 0 && h < 24) byHour[h] += 1;
    if (e.level === 'ERROR') {
      recentErrors.push({ message: e.message, timestamp: e.timestamp, file: (e.context || {}).file, line: (e.context || {}).line });
    }
  }
  return { total: entries.length, by_level: byLevel, by_hour: byHour, recent_errors: recentErrors.slice(-10).reverse() };
}

function getLogFiles() {
  if (!fs.existsSync(logDir)) return [];
  return fs.readdirSync(logDir)
    .filter(f => f.endsWith('.log'))
    .map(f => {
      const full = path.join(logDir, f);
      const stat = fs.statSync(full);
      const lines = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean).length;
      return {
        name: f, path: full, size: stat.size,
        size_human: stat.size > 1048576 ? (stat.size / 1048576).toFixed(1) + ' MB' : Math.ceil(stat.size / 1024) + ' KB',
        modified: stat.mtime.toISOString().replace('T', ' ').slice(0, 19),
        lines
      };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

async function getUsersInLogs(dbModule) {
  const entries = readEntries(activeFile);
  const ids = [...new Set(entries.map(e => e.user_id).filter(Boolean))];
  if (!ids.length) return [];
  const ph = ids.map((_, i) => `$${i + 1}`).join(', ');
  return dbModule.query(`SELECT id, name, email FROM users WHERE id IN (${ph})`, ids);
}

function getEntry(filePath, lineNumber) {
  const entries = readEntries(filePath);
  const entry = entries.find(e => e.line_number === lineNumber);
  return entry ? enrich(entry) : null;
}

function clearLogs(file = null) {
  if (file) {
    const full = path.join(logDir, path.basename(file));
    if (!fs.existsSync(full)) return false;
    fs.writeFileSync(full, '');
    return true;
  }
  for (const f of getLogFiles()) fs.writeFileSync(f.path, '');
  return true;
}

async function getRetentionSettings() {
  return {
    retention_days: intOr(await settings.get('system', 'log_retention_days', '30'), 30),
    max_file_size_mb: intOr(await settings.get('system', 'log_max_file_size_mb', '50'), 50)
  };
}

async function updateRetentionSettings(days, maxMb, userId) {
  days = Math.min(Math.max(1, intOr(days, 30)), 365);
  maxMb = Math.min(Math.max(1, intOr(maxMb, 50)), 500);
  await settings.set('system', 'log_retention_days', String(days), userId);
  await settings.set('system', 'log_max_file_size_mb', String(maxMb), userId);
  return true;
}

async function enforceRetention() {
  const { retention_days: days, max_file_size_mb: maxMb } = await getRetentionSettings();
  const maxBytes = maxMb * 1048576;
  const cutoff = Date.now() - days * 86400000;
  let count = 0;
  if (!fs.existsSync(logDir)) return 0;
  for (const f of fs.readdirSync(logDir)) {
    const full = path.join(logDir, f);
    const stat = fs.statSync(full);
    if (f.endsWith('.log')) {
      if (stat.mtimeMs < cutoff) { fs.unlinkSync(full); count += 1; }
      else if (stat.size > maxBytes) {
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        fs.renameSync(full, `${full}.${stamp}.bak`);
        fs.writeFileSync(full, '');
        count += 1;
      }
    } else if (f.endsWith('.bak') && stat.mtimeMs < cutoff) {
      fs.unlinkSync(full);
      count += 1;
    }
  }
  return count;
}

module.exports = {
  logDir, activeFile, search, getStats, getLogFiles, getUsersInLogs, getEntry,
  clearLogs, getRetentionSettings, updateRetentionSettings, enforceRetention
};
