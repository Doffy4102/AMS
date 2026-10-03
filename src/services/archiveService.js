// Port of ArchiveService: soft-delete archive with retention purge.
const db = require('../core/db');
const settings = require('./settingsService');
const { HttpError, intOr } = require('../core/helpers');

const TABLES = {
  assets: { table: 'assets', label: 'Hardware Assets' },
  accessories: { table: 'accessories', label: 'Accessories' },
  consumables: { table: 'consumables', label: 'Consumables' },
  components: { table: 'components', label: 'Components' },
  licenses: { table: 'licenses', label: 'Licenses' }
};

async function getRetentionDays() {
  return intOr(await settings.get('archive', 'retention_days', 7), 7);
}

async function purgeExpired() {
  const days = await getRetentionDays();
  let total = 0;
  for (const { table } of Object.values(TABLES)) {
    const res = await db.run(
      `DELETE FROM ${table} WHERE deleted_at < NOW() - make_interval(days => $1)`, [days]);
    total += res.rowCount;
  }
  return total;
}

async function groups() {
  await purgeExpired();
  const out = {};
  for (const [key, meta] of Object.entries(TABLES)) {
    const items = await db.query(
      `SELECT id, name, deleted_at FROM ${meta.table} WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 50`);
    out[key] = { ...meta, items };
  }
  return out;
}

async function restore(type, id) {
  const meta = TABLES[type];
  if (!meta) throw new HttpError('Unknown archive type.', 400);
  await db.run(`UPDATE ${meta.table} SET deleted_at = NULL WHERE id = $1`, [id]);
  return true;
}

async function updateRetentionDays(days, userId) {
  days = intOr(days, 7);
  if (days < 1 || days > 3650) throw new HttpError('Retention days must be between 1 and 3650.', 422);
  await settings.set('archive', 'retention_days', String(days), userId);
  return true;
}

module.exports = { TABLES, groups, restore, getRetentionDays, updateRetentionDays, purgeExpired };
