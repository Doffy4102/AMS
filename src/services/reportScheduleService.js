// Port of ReportScheduleService.
const fs = require('fs');
const path = require('path');
const db = require('../core/db');
const config = require('../config');
const importExport = require('./importExportService');
const { HttpError, trimStr, csvRow, timestampSlug } = require('../core/helpers');

async function schedules() {
  return db.query(
    `SELECT rs.*, u.name AS created_by_name FROM report_schedules rs
     LEFT JOIN users u ON rs.created_by = u.id ORDER BY rs.created_at DESC`);
}

function calculateNextRun(frequency, runTime) {
  const m = String(runTime || '').match(/^(\d{1,2}):(\d{2})/);
  const [h, min] = m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [8, 0];
  const next = new Date();
  next.setHours(h, min, 0, 0);
  if (next <= new Date()) {
    if (frequency === 'weekly') next.setDate(next.getDate() + 7);
    else if (frequency === 'monthly') next.setMonth(next.getMonth() + 1);
    else next.setDate(next.getDate() + 1);
  }
  return next;
}

async function create(data, userId) {
  const name = trimStr(data.name);
  const moduleKey = trimStr(data.module_key);
  if (!name || !moduleKey) throw new HttpError('Schedule name and report module are required.', 422);
  const format = ['csv', 'json'].includes(data.format) ? data.format : 'csv';
  const frequency = ['daily', 'weekly', 'monthly'].includes(data.frequency) ? data.frequency : 'daily';
  const runTime = trimStr(data.run_time) || '08:00';
  const delivery = ['both', 'email', 'download'].includes(data.delivery) ? data.delivery : 'both';
  if (!importExport.getModuleConfig(moduleKey)) throw new HttpError('Invalid report module selected.', 422);
  return db.insert(
    `INSERT INTO report_schedules (name, module_key, format, frequency, run_time, delivery, recipients,
       filters_json, is_active, next_run_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,$10)`,
    [name, moduleKey, format, frequency, runTime, delivery, trimStr(data.recipients),
      JSON.stringify(data.filters || {}), calculateNextRun(frequency, runTime), userId]);
}

async function toggle(id) {
  await db.run('UPDATE report_schedules SET is_active = NOT is_active WHERE id = $1', [id]);
  return true;
}

async function remove(id) {
  const res = await db.run('DELETE FROM report_schedules WHERE id = $1', [id]);
  if (!res.rowCount) throw new HttpError('Schedule not found.', 404);
  return true;
}

async function find(id) {
  return db.get('SELECT * FROM report_schedules WHERE id = $1', [id]);
}

async function generateAndSend(schedule) {
  let filters = {};
  try { filters = JSON.parse(schedule.filters_json || '{}'); } catch (_) {}
  const rows = (await importExport.exportFiltered(schedule.module_key, filters)).map(importExport.rowIterator);
  const dir = path.join(config.storageDir, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const safeName = String(schedule.name).replace(/[^a-zA-Z0-9_\-.]/g, '_');
  const ext = schedule.format === 'json' ? 'json' : 'csv';
  const filePath = path.join(dir, `report-${safeName}-${timestampSlug()}.${ext}`);
  if (ext === 'json') {
    fs.writeFileSync(filePath, JSON.stringify(rows, null, 2));
  } else {
    const headers = rows.length ? Object.keys(rows[0]) : [];
    const lines = [csvRow(headers), ...rows.map(r => csvRow(headers.map(h => r[h])))];
    fs.writeFileSync(filePath, lines.join('\n'));
  }
  await db.run(
    `UPDATE report_schedules SET last_run_at = NOW(), next_run_at = $1, last_status = 'success',
       last_file_path = $2, last_message = NULL WHERE id = $3`,
    [calculateNextRun(schedule.frequency, schedule.run_time), filePath, schedule.id]);
  return filePath;
}

async function markFailed(id, msg) {
  await db.run(`UPDATE report_schedules SET last_status = 'failed', last_message = $1 WHERE id = $2`,
    [String(msg).slice(0, 500), id]);
}

async function runDue() {
  const due = await db.query(
    'SELECT * FROM report_schedules WHERE is_active = TRUE AND (next_run_at IS NULL OR next_run_at <= NOW())');
  let count = 0;
  for (const schedule of due) {
    try {
      await generateAndSend(schedule);
      count += 1;
    } catch (err) {
      await markFailed(schedule.id, err.message);
    }
  }
  return count;
}

module.exports = { schedules, create, toggle, remove, find, runDue, generateAndSend, calculateNextRun };
