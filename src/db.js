'use strict';
// Postgres access. Every request that touches business data runs inside asUser(), which opens a
// transaction, switches to the `authenticated` role and sets the user id the way Supabase does,
// so the database's Row Level Security decides what the user can see and change.
const pg = require('pg');

// Keep dates as 'YYYY-MM-DD' strings, timestamps as ISO strings, and integer sums as numbers.
pg.types.setTypeParser(1082, (s) => s); // date
pg.types.setTypeParser(1184, (s) => new Date(s).toISOString()); // timestamptz
pg.types.setTypeParser(20, Number); // bigint (all amounts are far below 2^53)
pg.types.setTypeParser(1700, Number); // numeric (SUM of bigint)

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL must be set. See README.md.');
  process.exit(1);
}
// Supabase requires TLS. Set DATABASE_CA_FILE to Supabase's CA certificate to also verify the server.
const ssl = process.env.DATABASE_SSL === '0' ? false
  : process.env.DATABASE_CA_FILE ? { ca: require('node:fs').readFileSync(process.env.DATABASE_CA_FILE, 'utf8') }
    : { rejectUnauthorized: false };
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
  max: Number(process.env.DATABASE_POOL_SIZE || 5),
  // Fail fast with an error page instead of hanging if the database can't be reached.
  connectionTimeoutMillis: 10_000,
  query_timeout: 20_000,
});
pool.on('error', (e) => console.error('Idle database connection error:', e.message));

// "?" placeholders -> $1, $2 ... so queries read the same as before.
const numbered = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };

function wrap(client) {
  const query = (sql, params) => client.query(numbered(sql), params);
  return {
    get: async (sql, ...p) => (await query(sql, p)).rows[0],
    all: async (sql, ...p) => (await query(sql, p)).rows,
    run: async (sql, ...p) => { const r = await query(sql, p); return { changes: r.rowCount, id: r.rows[0]?.id }; },
  };
}

async function asUser(userId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE authenticated');
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId]);
    const result = await fn(wrap(client));
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Shared line items plus the chosen option (see estimate_total in migration 0008).
const ESTIMATE_TOTAL_SQL = 'estimate_total(estimates.id)';

// For the few things done without a signed-in user (a client opening an estimate link, scheduled emails):
// a transaction as the database owner, so every query must be scoped by hand.
async function asServer(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(wrap(client));
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const JOB_TOTALS_SQL = `
  (SELECT COALESCE(SUM(amount_cents), 0) FROM expenses WHERE job_id = jobs.id) AS expenses_cents,
  (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE job_id = jobs.id) AS payments_cents,
  (SELECT COALESCE(SUM(payout_cents), 0) FROM job_assignments WHERE job_id = jobs.id)
    + (SELECT COALESCE(SUM(labor_cents(clock_in, clock_out, rate_cents)), 0) FROM time_entries WHERE job_id = jobs.id) AS payouts_cents`;

function withJobMath(job) {
  if (!job) return job;
  return {
    ...job,
    balance_cents: job.contract_cents - job.payments_cents,
    gross_profit_cents: job.contract_cents - job.expenses_cents - job.payouts_cents,
  };
}

module.exports = { pool, asUser, asServer, ESTIMATE_TOTAL_SQL, JOB_TOTALS_SQL, withJobMath };
