IT-AMS — Asset Management System 

Node.js + PostgreSQL replication of the AMS platform.

Stack
- Backend: Node.js (Express 4), raw SQL via `pg`
- Database: PostgreSQL (`it_hams`)
- Views: EJS + Tailwind CSS (CDN) + Alpine.js + ApexCharts + Lucide icons
- Auth: Session-based (DB-backed store), bcrypt, TOTP 2FA, CSRF, login rate limiting
- API: REST v1 with SHA-256-hashed Bearer tokens, ability scoping, rate limiting

Setup

```bash
npm install
node bin/hams-cli.js migrate   # apply database/schema.sql
node bin/hams-cli.js seed      # roles, modules, permissions, settings, admin + demo assets
npm start                      # http://localhost:3000
```

Configuration lives in `.env` (DB credentials, port, session secret).

 CLI (`node bin/hams-cli.js <command>`)
| Command | Purpose |
|---|---|
| `migrate` | Apply database schema |
| `seed` | Seed reference + demo data |
| `archive:purge` | Purge expired soft-deleted records |
| `logs:cleanup` | Enforce log retention |
| `reports:run-schedules` | Run due report schedules |
| `backup:run-schedules` | Run due backup schedules (pg_dump) |
| `tokens:prune` | Delete expired API tokens |

Modules
Dashboard · Assets (CRUD, checkout/checkin, labels/QR, scanner, custom fields, bulk ops) ·
Procurement · Inventory (accessories, consumables, components, licenses) ·
Inventory Setup catalog (categories, models, manufacturers, suppliers, locations, sub-locations,
status labels, custom fields/fieldsets) · Stock Movements ledger (rollback, export) ·
Maintenance (repair lifecycle automation) · Alerts · Audit · Archive (retention purge) ·
Requests + approval auto-checkout · Employee Portal · Users/Departments/Roles/Permissions
(RBAC + location scopes) · Settings (branding, organization, security, identity, notifications,
monitoring, modules, backups, report schedules, automations, API tokens) · Reports/Exports ·
Import Center (validated CSV) · Data Transfer (column mapper) · Log Viewer · REST API v1.

REST API v1
```
GET  /api/v1/assets           Authorization: Bearer hams_<token>
GET  /api/v1/assets/:id
POST /api/v1/assets
POST /api/v1/assets/:id/update
POST /api/v1/assets/:id/delete
```
Create tokens under Settings → API Tokens (super admin only).

 Asset Health Check Agent (heartbeat)

Monitors registered assets for reachability (ICMP ping, TCP port, or HTTP health
endpoint), keeps a current-status table plus full heartbeat history, and raises
alert records on UP→DOWN / DOWN→UP transitions.

Configure monitored assets — one row per asset in `asset_monitors`
(FK to `assets`). Via API:
```
POST /api/v1/asset-monitors/:assetId     Authorization: Bearer hams_<token>
     hostname=..., ip_address=..., check_method=icmp|tcp|http,
     port=<for tcp>, health_url=<for http>, monitoring_enabled=true
```
or via service call: `heartbeatService.upsertMonitor(assetId, {...})`. Only rows
with `monitoring_enabled = TRUE` are checked. `ip_address` wins over `hostname`
when both are set.

Run the agent
```bash
npm run heartbeat           continuous, on the configured interval
npm run heartbeat:once      single cycle, then exit (cron-friendly)
HEARTBEAT_ENABLED=1 npm start    or run it inside the web process
```

Check interval — every `HEARTBEAT_INTERVAL` seconds (default 60) the agent
loads all enabled monitors and checks them concurrently (`HEARTBEAT_CONCURRENCY`
workers, default 10; per-check timeout `HEARTBEAT_TIMEOUT_MS`, default 3000).
If a cycle is still running when the next tick fires, the tick is skipped —
cycles never stack. A failing host never crashes the agent: each check is
isolated, and unexpected errors are logged (`storage/logs/hams.log`) and recorded
as DOWN.

View current health status
```
GET /api/v1/health-status                       all assets (status, latency, error, context)
GET /api/v1/health-status/:assetId              one asset
GET /api/v1/health-status/:assetId/heartbeats   history (?limit=, default 100)
GET /api/v1/heartbeat-alerts                    unresolved alerts
POST /api/v1/heartbeat-alerts/:id/resolve       mark an alert resolved
```

**How alerts are generated** — after every check the new status is compared with
the previous one in `asset_health_status`. `UP→DOWN` inserts a `down` alert;
`DOWN→UP` inserts a `recovered` alert and auto-resolves the open `down` alert.
Unchanged status never creates a duplicate, and the very first check of an asset
(UNKNOWN→…) sets state without alerting.

Tests: `npm test` (node:test — checkers, state transitions, agent resilience).

Endpoint Agents (real-time, agent-reported)

For machines you can't reach with an active probe (laptops off-network, NAT'd
endpoints), install a lightweight agent that pushes its state to the server:
it reports full system details on first run (enrollment), then a
heartbeat every 15 minutes. Agent-reported assets appear on the Health
Monitor exactly like probed ones (`check_method = 'agent'`).

Manage & download — Administration → Endpoint Agents(`/agents`, admin only):
- Roster of enrolled machines with live status (online / stale / offline),
  OS, logged-in user, IP, serial, and linked asset.
- Download for Windows(`hams-agent.ps1`) and macOS (`hams-agent.sh`).
  The server URL and enrollment key are baked into the downloaded file.
- Rotate the enrollment key (existing agents keep their tokens).

Install (Windows) — PowerShell as Administrator:
```powershell
powershell -ExecutionPolicy Bypass -File .\hams-agent.ps1 -Install
```
Registers a Scheduled Task that runs every 15 minutes. `-Uninstall` removes it.

Install (macOS) — Terminal:
```bash
chmod +x hams-agent.sh && ./hams-agent.sh install
```
Installs a launchd agent (`StartInterval` 900s). `uninstall` removes it.

How enrollment maps to assets — the machine's serial number is matched to an
existing asset; if none matches, a new asset is auto-created. On first run the
agent gets a unique bearer token (stored locally) and is linked to that asset.

Agent API (called by the installed agent, header-authenticated — not the session):
```
POST /api/v1/agent/enroll      X-Enrollment-Key: <key>    -> { token, asset_id }
POST /api/v1/agent/heartbeat    X-Agent-Token: <token>     -> records a beat
```
An agent is online if it beat within 20 min, stale up to 45 min,
offline beyond that (15-min cadence tolerates one missed beat).
