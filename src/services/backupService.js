// Port of BackupService: pg_dump-based database backups + schedules.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../core/db');
const config = require('../config');
const audit = require('./auditService');
const settings = require('./settingsService');
const { HttpError, timestampSlug, intOr, trimStr } = require('../core/helpers');

const backupDir = path.join(config.storageDir, 'backups');

function normalizeType(t) { return ['database', 'code', 'full'].includes(t) ? t : 'database'; }
function normalizeDest(t) { return ['local', 'network', 'ftp', 'sftp'].includes(t) ? t : 'local'; }

function findPgDump() {
  const candidates = [
    'pg_dump',
    'C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe',
    'C:\\Program Files\\PostgreSQL\\17\\bin\\pg_dump.exe',
    'C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe'
  ];
  for (const c of candidates) {
    try {
      const res = spawnSync(c, ['--version'], { encoding: 'utf8' });
      if (res.status === 0) return c;
    } catch (_) {}
  }
  return null;
}

async function dashboard() {
  const [jobs, schedules, stats] = await Promise.all([
    db.query(`SELECT bj.*, u.name AS created_by_name FROM backup_jobs bj
              LEFT JOIN users u ON bj.created_by = u.id ORDER BY bj.created_at DESC LIMIT 50`),
    db.query(`SELECT bs.*, u.name AS created_by_name FROM backup_schedules bs
              LEFT JOIN users u ON bs.created_by = u.id ORDER BY bs.created_at DESC`),
    db.get(`SELECT COUNT(*) FILTER (WHERE status = 'success')::int AS total,
                   COALESCE(SUM(file_size) FILTER (WHERE status = 'success'), 0)::bigint AS bytes,
                   MAX(created_at) FILTER (WHERE status = 'success') AS last_backup
            FROM backup_jobs`)
  ]);
  return {
    jobs, schedules,
    stats: { ...stats, storage_path: backupDir },
    can_zip: true, can_phar: false, can_zlib: true, can_ftp: false, can_sftp: false
  };
}

async function createBackup(type, data, userId) {
  type = normalizeType(type);
  fs.mkdirSync(backupDir, { recursive: true });
  const jobId = await db.insert(
    `INSERT INTO backup_jobs (backup_type, status, destination_type, destination_path, created_by)
     VALUES ($1, 'running', $2, $3, $4)`,
    [type, normalizeDest(data.destination_type), trimStr(data.destination_path) || null, userId]);

  try {
    if (type !== 'database') {
      throw new HttpError('Only database backups are supported in this deployment.', 422);
    }
    const pgDump = findPgDump();
    if (!pgDump) throw new HttpError('pg_dump was not found on this server.', 500);
    const fileName = `hams-${type}-${timestampSlug()}.sql`;
    const filePath = path.join(backupDir, fileName);
    const res = spawnSync(pgDump, [
      '-h', config.db.host, '-p', String(config.db.port), '-U', config.db.user,
      '-d', config.db.database, '-f', filePath
    ], { env: { ...process.env, PGPASSWORD: config.db.password }, encoding: 'utf8' });
    if (res.status !== 0) throw new HttpError('Backup archive was not created. ' + (res.stderr || ''), 500);
    const stat = fs.statSync(filePath);
    const checksum = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    await db.run(
      `UPDATE backup_jobs SET status = 'success', file_name = $1, file_path = $2, file_size = $3,
         checksum = $4, message = 'Backup stored locally.', completed_at = NOW() WHERE id = $5`,
      [fileName, filePath, stat.size, checksum, jobId]);
    await audit.log(userId, 'BACKUP_CREATED', `Backup created: ${fileName}`);
    return jobId;
  } catch (err) {
    await db.run(`UPDATE backup_jobs SET status = 'failed', message = $1, completed_at = NOW() WHERE id = $2`,
      [String(err.message), jobId]);
    await audit.log(userId, 'BACKUP_FAILED', `Backup failed: ${err.message}`);
    throw err;
  }
}

async function getJob(id) {
  return db.get('SELECT * FROM backup_jobs WHERE id = $1', [id]);
}

async function deleteJob(id) {
  const job = await getJob(id);
  if (job && job.file_path && job.file_path.startsWith(backupDir) && fs.existsSync(job.file_path)) {
    fs.unlinkSync(job.file_path);
  }
  await db.run('DELETE FROM backup_jobs WHERE id = $1', [id]);
  return true;
}

function validateRestoreSql(sql) {
  if (!/CREATE TABLE|INSERT INTO/i.test(sql)) {
    throw new HttpError('Restore file does not contain valid SQL backup content.', 422);
  }
  if (/CREATE USER|GRANT |REVOKE |LOAD_FILE|INTO OUTFILE|INTO DUMPFILE/i.test(sql)) {
    throw new HttpError('Restore file contains privileged SQL statements and was rejected.', 422);
  }
}

async function restoreDatabaseFromJob(id, userId) {
  const job = await getJob(id);
  if (!job || job.status !== 'success') throw new HttpError('Backup record is not available for restore.', 404);
  if (!job.file_path || !fs.existsSync(job.file_path)) throw new HttpError('Backup file is missing from storage.', 404);
  const sql = fs.readFileSync(job.file_path, 'utf8');
  validateRestoreSql(sql);
  await db.run(sql); // pg_dump output executes as a single multi-statement script
  await audit.log(userId, 'DATABASE_RESTORED', `Database restored from backup #${id}.`);
  return true;
}

function nextRunAt(frequency, runTime) {
  const m = String(runTime || '').match(/^(\d{2}):(\d{2})/);
  const [h, min] = m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [2, 0];
  const next = new Date();
  next.setHours(h, min, 0, 0);
  if (next <= new Date()) {
    if (frequency === 'weekly') next.setDate(next.getDate() + 7);
    else if (frequency === 'monthly') next.setMonth(next.getMonth() + 1);
    else next.setDate(next.getDate() + 1);
  }
  return next;
}

async function saveSchedule(data, userId) {
  const type = normalizeType(data.backup_type);
  const frequency = ['daily', 'weekly', 'monthly'].includes(data.frequency) ? data.frequency : 'daily';
  let runTime = '02:00:00';
  if (/^\d{2}:\d{2}$/.test(trimStr(data.run_time))) runTime = trimStr(data.run_time) + ':00';
  const retention = Math.max(1, Math.min(365, intOr(data.retention_days, 30)));
  const id = await db.insert(
    `INSERT INTO backup_schedules (name, backup_type, frequency, run_time, retention_days, destination_type,
       destination_path, host, port, username, password, is_active, next_run_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [trimStr(data.name) || `${type.charAt(0).toUpperCase() + type.slice(1)} backup`, type, frequency, runTime,
      retention, normalizeDest(data.destination_type), trimStr(data.destination_path) || null,
      trimStr(data.host) || null, data.port ? intOr(data.port) : null,
      trimStr(data.username) || null, trimStr(data.password) || null,
      data.is_active === '1' || data.is_active === undefined,
      nextRunAt(frequency, runTime), userId]);
  await audit.log(userId, 'BACKUP_SCHEDULE_CREATED', `Backup schedule created (#${id}).`);
  return id;
}

async function toggleSchedule(id, userId) {
  await db.run('UPDATE backup_schedules SET is_active = NOT is_active WHERE id = $1', [id]);
  await audit.log(userId, 'BACKUP_SCHEDULE_TOGGLED', `Backup schedule #${id} toggled.`);
  return true;
}

async function runDueSchedules(userId) {
  const enabled = await settings.get('backup', 'auto_backup_enabled');
  if (enabled !== '1') return 0;
  const due = await db.query(
    'SELECT * FROM backup_schedules WHERE is_active = TRUE AND (next_run_at IS NULL OR next_run_at <= NOW())');
  let count = 0;
  for (const schedule of due) {
    try {
      await createBackup(schedule.backup_type, { destination_type: schedule.destination_type, destination_path: schedule.destination_path }, userId);
      // Retention cleanup
      const expired = await db.query(
        `SELECT * FROM backup_jobs WHERE backup_type = $1 AND status = 'success'
         AND created_at < NOW() - make_interval(days => $2)`,
        [schedule.backup_type, schedule.retention_days]);
      for (const job of expired) await deleteJob(job.id);
      count += 1;
    } catch (_) { /* failure noted on job */ }
    await db.run('UPDATE backup_schedules SET last_run_at = NOW(), next_run_at = $1 WHERE id = $2',
      [nextRunAt(schedule.frequency, schedule.run_time), schedule.id]);
  }
  return count;
}

module.exports = {
  backupDir, dashboard, createBackup, getJob, deleteJob,
  restoreDatabaseFromJob, validateRestoreSql, saveSchedule, toggleSchedule, runDueSchedules
};
