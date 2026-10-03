#!/usr/bin/env node
// Port of hams-cli: migrate, seed, routes, archive:purge, logs:cleanup,
// reports:run-schedules, backup:run-schedules, tokens:prune.
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const db = require('../src/core/db');
const config = require('../src/config');

const command = process.argv[2] || 'help';

async function ensureMigrationsTable() {
  await db.run(`CREATE TABLE IF NOT EXISTS migrations (
    id SERIAL PRIMARY KEY, migration VARCHAR(255) NOT NULL, batch INT NOT NULL,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
}

async function migrate() {
  await ensureMigrationsTable();
  const dir = path.join(config.rootDir, 'database');
  const files = ['schema.sql', 'heartbeat.sql', 'agents.sql', 'software.sql', 'new_joinees.sql', 'software_allocation.sql', 'software_prices.sql'];
  const applied = (await db.query('SELECT migration FROM migrations')).map(r => r.migration);
  const batchRow = await db.get('SELECT COALESCE(MAX(batch), 0) + 1 AS b FROM migrations');
  const batch = batchRow.b;
  for (const file of files) {
    if (applied.includes(file)) {
      console.log(`~ ${file} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log(`> Applying ${file}...`);
    await db.run(sql);
    await db.run('INSERT INTO migrations (migration, batch) VALUES ($1, $2)', [file, batch]);
    console.log(`  OK`);
  }
  console.log('Migrations complete.');
}

async function seed() {
  console.log('Seeding Enterprise Data...');
  const sql = fs.readFileSync(path.join(config.rootDir, 'database', 'seed.sql'), 'utf8');
  await db.run(sql);
  // Admin user (bcrypt hash generated at seed time; default password: "password")
  const existing = await db.get(`SELECT id FROM users WHERE email = 'admin@hams.inc'`);
  if (!existing) {
    const hash = await bcrypt.hash('password', 10);
    const adminId = await db.insert(
      `INSERT INTO users (name, email, password, role, status) VALUES ('Administrator', 'admin@hams.inc', $1, 'super_admin', 'active')`,
      [hash]);
    const role = await db.get(`SELECT id FROM roles WHERE name = 'super_admin'`);
    if (role) {
      await db.run('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [adminId, role.id]);
    }
    console.log('  Admin user created: admin@hams.inc / password');
  } else {
    console.log('  Admin user already exists.');
  }
  // Demo assets (port of demo_data.sql)
  const demo = [
    ['MacBook Pro M3', 'QW98122', 'A2991', 'Laptop', '2026-01-15', '2027-01-15'],
    ['Dell XPS 15', 'DXP9021', '9530', 'Laptop', '2026-02-10', '2027-02-10'],
    ['Logitech MX Master 3S', 'LMX302', 'MXM3S', 'Accessory', '2026-03-05', '2027-03-05']
  ];
  const crypto = require('crypto');
  for (const [name, serial, model, category, pd, we] of demo) {
    const dup = await db.get('SELECT id FROM assets WHERE serial_number = $1', [serial]);
    if (dup) continue;
    const idRow = await db.get('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM assets');
    const tag = 'HAMS-' + String(idRow.next).padStart(6, '0');
    await db.run(
      `INSERT INTO assets (asset_tag, label_token, name, serial_number, model_number, category, status,
         category_id, status_label_id, purchase_date, warranty_expiry)
       VALUES ($1, $2, $3, $4, $5, $6, 'available',
         (SELECT id FROM asset_categories WHERE name = $7),
         (SELECT id FROM status_labels WHERE name = 'Ready to Deploy'), $8, $9)`,
      [tag, crypto.randomBytes(16).toString('hex'), name, serial, model, category, category, pd, we]);
    console.log(`  Demo asset: ${name} (${tag})`);
  }
  console.log('Seed complete.');
}

async function main() {
  try {
    switch (command) {
      case 'migrate': await migrate(); break;
      case 'seed': await seed(); break;
      case 'routes':
        console.log('Routes are defined in src/routes/*.js');
        break;
      case 'archive:purge': {
        const archiveService = require('../src/services/archiveService');
        const count = await archiveService.purgeExpired();
        console.log(`Purged ${count} expired archived record(s).`);
        break;
      }
      case 'logs:cleanup': {
        const logService = require('../src/services/logService');
        const count = await logService.enforceRetention();
        console.log(`Log retention enforced: ${count} file(s) processed.`);
        break;
      }
      case 'reports:run-schedules': {
        const reportSchedules = require('../src/services/reportScheduleService');
        const count = await reportSchedules.runDue();
        console.log(`Executed ${count} due report schedule(s).`);
        break;
      }
      case 'backup:run-schedules': {
        const backupService = require('../src/services/backupService');
        const count = await backupService.runDueSchedules(null);
        console.log(`Executed ${count} due backup schedule(s).`);
        break;
      }
      case 'tokens:prune': {
        const apiTokenService = require('../src/services/apiTokenService');
        const count = await apiTokenService.pruneExpired();
        console.log(`Pruned ${count} expired API token(s).`);
        break;
      }
      default:
        console.log(`IT-HAMS CLI
Usage: node bin/hams-cli.js <command>

Commands:
  migrate                 Apply database schema
  seed                    Seed reference + demo data (admin@hams.inc / password)
  routes                  Route info
  archive:purge           Purge expired soft-deleted records
  logs:cleanup            Enforce log retention policy
  reports:run-schedules   Execute due report schedules
  backup:run-schedules    Execute due backup schedules
  tokens:prune            Delete expired API tokens`);
    }
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
