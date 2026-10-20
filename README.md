# Vista Artisans

A private web app for tracking clients, estimates, jobs, job expenses and payments received.
Several people can share one organization, and separate organizations never see each other's data.

- **Stack:** Node.js 22.13+, server-rendered pages, the `pg` driver. Data and logins live in **Supabase**
  (Postgres + Supabase Auth with email and password).
- **Data isolation:** every record belongs to an organization. The app runs each request inside a database transaction
  as the signed-in user (`authenticated` role with that user's id), so Postgres Row Level Security decides what can be
  read or changed, not just the app's own filters.
- **Money:** stored as whole cents (`bigint`); quantities as hundredths. Line totals are computed by the database.

## Setup

### 1. Create the Supabase project

1. At [supabase.com](https://supabase.com), create a new project and save its database password.
2. In the project's **SQL Editor**, paste all of `supabase/setup.sql` and click **Run** (once, on a new project).
   It is the files in `supabase/migrations/` combined. If you already ran an older `setup.sql`, run only the
   migration files added since (for example `0003_payouts.sql`).
3. Optional: under **Authentication → Sign In / Providers → Email**, decide whether new users must confirm their email
   (recommended on). With it on, people confirm by email and then log in.

### 2. Collect the settings

| Variable | Where to find it in Supabase |
|---|---|
| `SUPABASE_URL` | Project Settings → Data API → Project URL (`https://xxxx.supabase.co`) |
| `SUPABASE_ANON_KEY` | Project Settings → API Keys → the `anon` / publishable key |
| `DATABASE_URL` | Connect button → Session pooler connection string, with your database password filled in |

Other optional settings: `PORT` (default 3000), `COOKIE_SECURE=1` when served over HTTPS (always in production),
`DATABASE_CA_FILE` (path to Supabase's CA certificate, to verify the database's TLS certificate), `DATABASE_POOL_SIZE`.

The service-role key is **not** needed. Keep `DATABASE_URL` secret: it contains the database password.

### 3. Run it

```sh
npm install
SUPABASE_URL=... SUPABASE_ANON_KEY=... DATABASE_URL=... npm start
```

Open http://localhost:3000, create an account, and create your organization (you become its admin). Teammates create
their own accounts, then an admin adds their email on the **Team** page as an **Admin** or a **Worker**.

### Putting it online (Render)

`render.yaml` sets up a Render web service in Oregon (next to the Supabase database) with HTTPS.

1. Push this folder to a private GitHub repository.
2. In Render: **New → Blueprint**, pick the repository, and when asked for `DATABASE_URL`, paste the Supabase
   Session pooler connection string with the database password filled in. Render keeps it secret.
3. When it's live, copy the site address (like `https://vista-artisans.onrender.com`). In Supabase, open
   **Authentication → URL Configuration** and set **Site URL** to that address followed by `/login`, so email
   confirmation links land on the login page.
4. Open the site, create your account, and create your organization.

The `starter` plan stays awake; Render's free plan also works but sleeps when idle and takes a while to wake up.

## Tests

Both test suites run against a local Postgres 16 server, not your Supabase project.

```sh
# Full workflow through the real server, with a local stand-in for Supabase Auth:
TEST_PG_ADMIN_URL=postgresql://postgres@localhost:5432/postgres npm test

# Database isolation rules on their own:
createdb vista_test
psql -d vista_test -f supabase/tests/local_auth_stub.sql
psql -d vista_test -f supabase/setup.sql
psql -d vista_test -f supabase/tests/isolation_test.sql   # ends with ALL ISOLATION TESTS PASSED
```

`npm test` covers sign-up, organization creation, login required everywhere, create client → estimate → save and reopen →
approve → convert (5 simultaneous clicks make one job) → expenses with correction and deletion → payments → complete job,
totals at every step, silent session refresh, an admin teammate, a worker who sees only the schedule, role changes,
deleting estimates and clients (and refusing for converted ones), moving an estimate to another client, another organization getting
"not found" on every record, and data unchanged after a server restart.

## How things work

- **Estimates:** total = sum of line totals (quantity × unit price, rounded to the cent). Estimated profit = total − internal estimated cost.
  Status is draft / sent / approved / declined.
- **Converting:** only approved estimates convert. The job copies the client, the client's property address at that moment,
  project name, scope and the estimate total. The database allows one job per estimate and locks converted estimates.
- **Worker payouts:** on a job, an admin assigns people and enters what each will be paid. Payouts are records only.
- **Jobs:** outstanding balance = contract total − payments. Gross profit = contract total − expenses − worker payouts, labeled provisional
  until the job is completed. Payments are records only; the app never processes money.
- **Home:** open estimates are draft, sent, or approved-but-not-converted. Total outstanding adds up every job's positive
  balance in the current organization, including completed jobs that still owe money.
- **Roles:** *Admins* see and manage everything, including money and the team. *Workers* see only open jobs they are
  assigned to: schedule, client name, address, scope of work, notes and their own pay; no prices, costs, payments,
  clients list, estimates, or anyone else's pay. The database
  enforces this (workers have no access to the business tables; they read through `worker_schedule()`).
  An organization always keeps at least one admin.
- **Deleting:** estimates can be deleted unless converted to a job. Clients can be deleted along with their estimates,
  unless they have jobs (kept so job, expense and payment records stay complete). Both ask for confirmation.
  To move an estimate to another client, edit it and pick a different client.
- **Organizations:** a person can belong to several organizations and switch between them from the header.
