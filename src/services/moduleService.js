// Port of ModuleService: module toggles with per-process cache.
const db = require('../core/db');
const { HttpError } = require('../core/helpers');

let enabledCache = null;

async function getModules() {
  return db.query('SELECT * FROM modules ORDER BY id ASC');
}

async function getEnabledModuleKeys() {
  if (enabledCache === null) {
    const rows = await db.query('SELECT name FROM modules WHERE is_active = TRUE');
    enabledCache = rows.map(r => r.name);
  }
  return enabledCache;
}

async function isEnabled(moduleKey) {
  const keys = await getEnabledModuleKeys();
  return keys.includes(moduleKey);
}

async function toggleModule(id) {
  const mod = await db.get('SELECT * FROM modules WHERE id = $1', [id]);
  if (!mod) throw new HttpError('Module not found.', 404);
  if (['settings', 'personnel'].includes(mod.name)) {
    throw new HttpError('Core access modules cannot be disabled.', 422);
  }
  await db.run('UPDATE modules SET is_active = NOT is_active WHERE id = $1', [id]);
  enabledCache = null;
  return mod;
}

function clearCache() { enabledCache = null; }

module.exports = { getModules, getEnabledModuleKeys, isEnabled, toggleModule, clearCache };
