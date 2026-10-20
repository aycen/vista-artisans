# Keystone

Keystone (keystonefsm.com) is a web app for field-service companies for tracking clients, estimates, jobs, job expenses and payments received.
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
   migration files added since (for example `0005_company_profile_and_completion.sql`).
3. Optional: under **Authentication → Sign In / Providers → Email**, decide whether new users must confirm their email
   (recommended on). With it on, people confirm by email and then log in.

### 2. Collect the settings

| Variable | Where to find it in Supabase |
|---|---|
| `SUPABASE_URL` | Project Settings → Data API → Project URL (`https://xxxx.supabase.co`) |
| `SUPABASE_ANON_KEY` | Project Settings → API Keys → the `anon` / publishable key |
| `DATABASE_URL` | Connect button → Session pooler connection string, with your database password filled in |

Other optional settings: `PORT` (default 3000), `COOKIE_SECURE=1` when served over HTTPS (always in production),
`DATABASE_CA_FILE` (path to Supabase's CA certificate, to verify the database's TLS certificate), `DATABASE_POOL_SIZE`,
`APP_TIMEZONE` (default `America/Los_Angeles`; decides which payments count as "this month" on the home screen).

The service-role key is **not** needed. Keep `DATABASE_URL` secret: it contains the database password.

### 3. Run it

```sh
npm install
SUPABASE_URL=... SUPABASE_ANON_KEY=... DATABASE_URL=... npm start
```

Open http://localhost:3000, create an account, and choose **Start a new company** (you become its admin). Teammates
create their own accounts and choose **Join your company**, typing the join code shown on the admin's **Team** page; they
join as workers and an admin can promote them. Admins can also add someone who already has an account by email.

### Putting it online (Render)

`render.yaml` sets up a Render web service in Oregon (next to the Supabase database) with HTTPS.

1. Push this folder to a private GitHub repository.
2. In Render: **New → Blueprint**, pick the repository, and when asked for `DATABASE_URL`, paste the Supabase
   Session pooler connection string with the database password filled in. Render keeps it secret.
3. When it's live, copy the site address (like `https://vista-artisans.onrender.com`). In Supabase, open
   **Authentication → URL Configuration** and set **Site URL** to that address followed by `/login`, so email
   confirmation links land on the login page.
4. Open the site, create your account, and start your company.

On a phone, use the browser's **Add to Home Screen** to get an app icon that opens full screen.

The `starter` plan stays awake; Render's free plan also works but sleeps when idle and takes a while to wake up.

## Online invoicing with Stripe Connect

Each company links **its own** Stripe account from **Account → Company profile → Connect Stripe** (Stripe's hosted
sign-up). Admins then email invoices from any job with money owed: Stripe sends the client a pay link (card or bank
transfer), the money goes straight to that company's Stripe account, and that company pays Stripe's fees. When an
invoice is paid, Stripe calls `/stripe/webhook` and the payment is recorded on the job.

One-time setup by whoever runs the app (the "platform"), in the platform's own Stripe account:

1. Turn on **Connect** (Stripe dashboard → Connect → Get started) and complete the platform profile. Stay in **test mode** to try it.
2. **Developers → API keys:** copy the secret key into Render as `STRIPE_SECRET_KEY`.
3. **Developers → Webhooks → Add endpoint:** URL `https://<your site>/stripe/webhook`, choose **Events on Connected accounts**,
   and select `invoice.paid`, `invoice.voided`, `invoice.marked_uncollectible` and `account.updated`.
   Copy its signing secret into Render as `STRIPE_WEBHOOK_SECRET`.
4. Optional: `APP_URL` (for example `https://vista-artisans.onrender.com`) if Stripe's return links should use a different address.

Each company sets its logo and colors for invoice emails in its own Stripe dashboard (**Settings → Branding**).
Test mode moves no real money and Stripe doesn't email clients, but an invoice's **View** link opens the pay page,
where the test card `4242 4242 4242 4242` pays it. To go live, use live-mode keys and a live-mode webhook.
Security: the link between a company and its Stripe account is written only by the server, and webhook events are
accepted only with a valid signature and only for jobs of the company that owns the sending Stripe account.

## Plans and billing

Companies start on **Free** (one person). **Team** ($49/month or $499/year) allows up to 3 admins and 10 workers;
**Unlimited** ($99/month or $1,009/year) has no limits. Monthly plans get 50% off the first month (once per company).
Admins buy and manage plans under **Account → Plan & billing**: Stripe Checkout takes the payment, and Stripe's
billing portal handles plan changes, card updates, receipts and cancelling. If a plan ends, nobody is removed; the
company just can't add people until it upgrades again. Limits are enforced in the database. The first company ever
created (the app owner's) is free on Unlimited (`org_subscriptions.comped`).

Plans are paid to the platform's own Stripe account; products, prices, the coupon and the portal settings are created
automatically on first use. One-time setup:

1. **Developers → Webhooks → Add endpoint:** URL `https://<your site>/stripe/webhook`, choose **Events on Your account**,
   and select `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated` and
   `customer.subscription.deleted`. Copy its signing secret into Render as `STRIPE_BILLING_WEBHOOK_SECRET`.
2. Paid plans appear once that secret and `STRIPE_SECRET_KEY` are set.

## Online estimate approval and automatic emails

Every estimate has a private link (`/e/<token>`). Admins email it from the estimate page (or copy it and text it).
The client sees the company's logo and details, picks an option if the estimate has Good/Better/Best lines, signs with
a finger or mouse, and approves; the estimate becomes a job right away. If the estimate asks for a deposit and the
company has connected Stripe, a deposit invoice is created on the company's Stripe account and the client goes
straight to its pay page. The company gets an email when a client approves or declines. The signature, time, IP
address and browser are stored with the estimate and can only be written by the server.

Automatic emails (Company profile → Automatic emails): estimate follow-ups (after N and 2N days), an appointment
reminder the day before a job starts, and a review request an hour after a job is completed. They run inside the web
server every 10 minutes; every email is listed on its estimate or job.

Email is sent through [Resend](https://resend.com). One-time setup: add and verify your domain in Resend (it shows the
DNS records to add), create an API key with sending access, and set `RESEND_API_KEY` and `EMAIL_FROM` (for example
`estimates@keystonefsm.com`) in Render. Emails show each company's name as the sender and replies go to the company's
own email. Links in automatic emails use `APP_URL`, or Render's `RENDER_EXTERNAL_URL`.

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

`npm test` covers sign-up, the welcome page, joining with a code (wrong code, rotated code), organization creation, start/end dates, this month's revenue, login required everywhere, create client → estimate → save and reopen →
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
- **Job dates:** each job has an optional start date and end date; the end can't be before the start.
- **Jobs:** outstanding balance = contract total − payments. Gross profit = contract total − expenses − worker payouts, labeled provisional
  until the job is completed. Payments are records only; the app never processes money.
- **Home:** revenue this month = payments received with a date in the current calendar month (`APP_TIMEZONE`).
  Growth compares it with the same days of last month (the 1st through today's date), so it is fair early in the month.
  Gross profit this month = contract − expenses − payouts of jobs marked completed this month.
- **Jobs calendar:** the Jobs tab shows a month calendar; a job appears on every day from its start date to its end date.
  Tap a day to list its jobs below.
- **Team:** tap a person to see their open and completed jobs and their pay totals.
- **Company profile (Account → Company profile):** logo, contact details, license number, and terms printed on
  estimate PDFs (sent to customers; never shows internal cost or profit) and work order PDFs (for subcontractors;
  shows a person's pay only when downloaded from their row on the job).
  Open estimates are draft, sent, or approved-but-not-converted. Total outstanding adds up every job's positive
  balance in the current organization, including completed jobs that still owe money.
- **Roles:** *Admins* see and manage everything, including money and the team. *Workers* see only open jobs they are
  assigned to: schedule, client name, address, scope of work, notes and their own pay; no prices, costs, payments,
  clients list, estimates, or anyone else's pay. The database
  enforces this (workers have no access to the business tables; they read through `worker_schedule()`).
  An organization always keeps at least one admin.
- **Deleting:** estimates can be deleted unless converted to a job. Clients can be deleted along with their estimates,
  unless they have jobs (kept so job, expense and payment records stay complete). Both ask for confirmation.
  To move an estimate to another client, edit it and pick a different client.
- **Joining:** each company has an 8-character join code (shown as XXXX-XXXX on the Team page, admins only). Joining
  with it makes you a worker. An admin can make a new code, which stops the old one working. Ten wrong codes in an hour
  locks that person out of joining for the hour.
- **Invoices:** see *Online invoicing with Stripe Connect* above. Payments received outside the app are still entered by hand.
- **Organizations:** a person can belong to several companies and switch between them on the **Account** page.
