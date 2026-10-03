// Port of SettingsService: in-memory settings map reloaded after each set().
// Values are stored & returned as raw strings; callers cast ('1'/'0' booleans).
const db = require('../core/db');

let settings = {}; // {group: {key: {value, type, is_encrypted}}}
let loaded = false;

async function loadSettings() {
  const rows = await db.query('SELECT * FROM settings');
  const map = {};
  for (const row of rows) {
    map[row.group_key] = map[row.group_key] || {};
    map[row.group_key][row.setting_key] = {
      value: row.setting_value,
      type: row.setting_type,
      is_encrypted: row.is_encrypted
    };
  }
  settings = map;
  loaded = true;
}

async function ensureLoaded() {
  if (!loaded) await loadSettings();
}

async function get(group, key, def = null) {
  await ensureLoaded();
  const v = settings[group] && settings[group][key] ? settings[group][key].value : undefined;
  return v === undefined || v === null ? def : v;
}

async function getByGroup(group) {
  await ensureLoaded();
  return settings[group] || {};
}

async function set(group, key, value, userId = null) {
  const existing = await db.get(
    'SELECT id, setting_value FROM settings WHERE group_key = $1 AND setting_key = $2',
    [group, key]
  );
  if (existing) {
    await db.run('UPDATE settings SET setting_value = $1 WHERE id = $2', [value, existing.id]);
    if (String(existing.setting_value ?? '') !== String(value ?? '')) {
      await db.run(
        'INSERT INTO settings_history (setting_id, old_value, new_value, user_id) VALUES ($1, $2, $3, $4)',
        [existing.id, existing.setting_value, value, userId]
      );
    }
  } else {
    await db.run(
      'INSERT INTO settings (group_key, setting_key, setting_value) VALUES ($1, $2, $3)',
      [group, key, value]
    );
  }
  await loadSettings();
  return true;
}

module.exports = { get, getByGroup, set, loadSettings };
