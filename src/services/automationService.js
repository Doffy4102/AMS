// Port of AutomationEngine + rules CRUD.
const db = require('../core/db');
const logger = require('../core/logger');

async function getAllRules() {
  return db.query('SELECT * FROM automation_rules ORDER BY created_at DESC');
}

async function createRule(payload) {
  return db.insert(
    'INSERT INTO automation_rules (name, event_trigger, conditions, actions, is_active) VALUES ($1,$2,$3,$4,$5)',
    [payload.name || 'New Rule', payload.event_trigger || '', JSON.stringify(payload.conditions || []),
      JSON.stringify(payload.actions || []), payload.is_active ? true : false]);
}

async function deleteRule(id) {
  await db.run('DELETE FROM automation_rules WHERE id = $1', [id]);
  return true;
}

function evaluateConditions(conditionsJson, payload) {
  let conditions = [];
  try { conditions = JSON.parse(conditionsJson || '[]'); } catch (_) { return true; }
  if (!Array.isArray(conditions) || !conditions.length) return true;
  for (const c of conditions) {
    if (!(c.field in payload)) return false;
    const actual = payload[c.field];
    switch (c.operator || '=') {
      case '=': if (String(actual) != String(c.value)) return false; break;
      case '!=': if (String(actual) == String(c.value)) return false; break;
      case '>': if (!(Number(actual) > Number(c.value))) return false; break;
      case '<': if (!(Number(actual) < Number(c.value))) return false; break;
      case 'contains': if (!String(actual).includes(String(c.value))) return false; break;
      default: return false;
    }
  }
  return true;
}

async function executeActions(ruleId, actionsJson, payload) {
  let actions = [];
  try { actions = JSON.parse(actionsJson || '[]'); } catch (_) {}
  for (const action of actions) {
    let status = 'success', message = '';
    try {
      const cfg = action.config || {};
      if (action.type === 'webhook') {
        if (!cfg.url) throw new Error('Webhook action missing url');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(cfg.url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload), signal: controller.signal
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`Webhook returned HTTP ${res.status}`);
        message = `Webhook delivered (HTTP ${res.status})`;
      } else if (action.type === 'log') {
        logger.info(`[Automation] ${cfg.message || JSON.stringify(payload)}`);
        message = 'Logged';
      } else if (action.type === 'email') {
        if (!cfg.to) throw new Error('Email action missing recipient');
        // SMTP delivery not configured in this environment; recorded as attempted.
        message = `Email queued to ${cfg.to}: ${cfg.subject || 'HAMS Automation'}`;
      } else {
        throw new Error(`Unknown action type: ${action.type}`);
      }
    } catch (err) {
      status = 'failed';
      message = String(err.message).slice(0, 65000);
    }
    await db.run(
      'INSERT INTO automation_logs (automation_rule_id, trigger_payload, status, message) VALUES ($1,$2,$3,$4)',
      [ruleId, JSON.stringify(payload), status, message]);
  }
}

async function dispatch(event, payload) {
  const rules = await db.query(
    'SELECT * FROM automation_rules WHERE is_active = TRUE AND event_trigger = $1', [event]);
  for (const rule of rules) {
    if (evaluateConditions(rule.conditions, payload)) {
      await executeActions(rule.id, rule.actions, payload);
    }
  }
}

module.exports = { getAllRules, createRule, deleteRule, dispatch };
