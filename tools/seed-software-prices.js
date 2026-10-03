// Seed software_prices from the existing software_assets amount/qty data: a
// weighted average unit price per software (SUM(amount)/SUM(qty)), so the
// Budget & Cost Forecast feature starts from real historical spend rather
// than an arbitrary number. Software with no derivable price (no amount data)
// is left with unit_price = NULL, which the UI treats as "needs admin price".
// Idempotent: skips software that already has a price row.
const db = require('../src/core/db');

(async () => {
  const rows = await db.query(
    `SELECT sw_name,
            SUM(amount)::numeric AS total_amount,
            SUM(qty)::numeric AS total_qty
       FROM software_assets
      WHERE amount IS NOT NULL
      GROUP BY sw_name`);

  let inserted = 0, skipped = 0, noPrice = 0;
  for (const r of rows) {
    const exists = await db.get('SELECT 1 FROM software_prices WHERE sw_name = $1', [r.sw_name]);
    if (exists) { skipped++; continue; }
    const unitPrice = Number(r.total_qty) > 0
      ? Math.round((Number(r.total_amount) / Number(r.total_qty)) * 100) / 100
      : null;
    if (unitPrice === null) noPrice++;
    await db.run(
      `INSERT INTO software_prices (sw_name, unit_price, currency) VALUES ($1, $2, 'INR')`,
      [r.sw_name, unitPrice]);
    console.log(`+ ${r.sw_name.padEnd(35)} unit_price=${unitPrice === null ? 'NEEDS ADMIN PRICE' : '₹' + unitPrice}`);
    inserted++;
  }

  // Any software present in software_assets but with ALL-NULL amount never
  // appeared in the query above — seed those too, with no derivable price.
  const missing = await db.query(
    `SELECT DISTINCT sw_name FROM software_assets
      WHERE sw_name NOT IN (SELECT sw_name FROM software_prices)`);
  for (const r of missing) {
    await db.run(`INSERT INTO software_prices (sw_name, unit_price, currency) VALUES ($1, NULL, 'INR')`, [r.sw_name]);
    console.log(`+ ${r.sw_name.padEnd(35)} unit_price=NEEDS ADMIN PRICE (no amount data at all)`);
    inserted++; noPrice++;
  }

  console.log(`\nDone: ${inserted} inserted (${noPrice} need an admin price), ${skipped} already existed.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
