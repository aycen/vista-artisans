'use strict';
// The emails Keystone sends for a company (estimates, follow-ups, reminders, review requests, notices to the company),
// their wording, the log of what was sent, and the background loop that sends the automatic ones.
const email = require('./email');
const sms = require('./sms');
const { asServer } = require('./db');
const { fmt } = require('./money');

const APP_TIMEZONE = process.env.APP_TIMEZONE || 'America/Los_Angeles';
// Links in emails sent without a web request (the background loop). Render sets RENDER_EXTERNAL_URL.
const appUrl = () => (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const longDate = (d) => {
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  return `${DAYS[new Date(Date.UTC(y, m - 1, day)).getUTCDay()]}, ${MONTHS[m - 1]} ${day}`;
};
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

// A plain, phone-friendly email: heading, paragraphs, one button, and the company's contact details.
function render(company, { heading, paragraphs = [], button, note }) {
  const contact = [company.phone, company.email].filter(Boolean).join(' · ');
  const html = `<!doctype html><html><body style="margin:0;background:#f3f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f8;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;padding:28px">
<tr><td style="font-size:15px;font-weight:700;color:#4f46e5;padding-bottom:16px">${esc(company.name)}</td></tr>
<tr><td style="font-size:22px;font-weight:700;line-height:1.25;padding-bottom:12px">${esc(heading)}</td></tr>
${paragraphs.map((p) => `<tr><td style="font-size:16px;line-height:1.5;padding-bottom:12px;white-space:pre-line">${esc(p)}</td></tr>`).join('')}
${button ? `<tr><td style="padding:8px 0 16px"><a href="${esc(button.url)}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:13px 22px;border-radius:12px">${esc(button.label)}</a></td></tr>` : ''}
${note ? `<tr><td style="font-size:13px;color:#64748b;line-height:1.5;padding-bottom:8px">${esc(note)}</td></tr>` : ''}
<tr><td style="border-top:1px solid #e6e8ef;padding-top:14px;font-size:13px;color:#64748b;line-height:1.5">${esc(company.name)}${contact ? `<br>${esc(contact)}` : ''}${company.address ? `<br>${esc(company.address)}` : ''}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [heading, '', ...paragraphs.flatMap((p) => [p, '']), button ? `${button.label}: ${button.url}\n` : '', note || '',
    '--', company.name, contact, company.address].filter((l) => l !== null && l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n');
  return { html, text };
}

async function companyOf(db, orgId) {
  return db.get(`SELECT o.name, coalesce(p.phone, '') AS phone, coalesce(p.email, '') AS email, coalesce(p.address, '') AS address,
      coalesce(p.estimate_followup_days, 3) AS estimate_followup_days, coalesce(p.appointment_reminders, true) AS appointment_reminders,
      coalesce(p.review_requests, false) AS review_requests, coalesce(p.review_url, '') AS review_url,
      coalesce(p.sms_estimate_followups, false) AS sms_estimate_followups, coalesce(p.sms_appointment_reminders, false) AS sms_appointment_reminders,
      coalesce(p.sms_review_requests, false) AS sms_review_requests, s.messaging_service_sid AS sms_sender
    FROM organizations o LEFT JOIN company_profiles p ON p.org_id = o.id LEFT JOIN sms_senders s ON s.org_id = o.id WHERE o.id = ?`, orgId);
}

// Sends one email and records it in email_log (sent or failed). `db` must be able to write email_log (asServer).
async function deliver(db, { orgId, kind, to, subject, content, company, estimateId = null, jobId = null, attachments = [] }) {
  const { html, text } = render(company, content);
  let providerId = ''; let error = '';
  try {
    providerId = await email.send({ fromName: company.name, to, replyTo: company.email, subject, html, text, attachments });
  } catch (e) {
    error = e.message.slice(0, 500);
    console.error(`Email (${kind}) to ${to} failed:`, error);
  }
  await db.run(`INSERT INTO email_log (org_id, kind, to_email, subject, estimate_id, job_id, status, error, provider_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, orgId, kind, to, subject, estimateId, jobId, error ? 'failed' : 'sent', error, providerId);
  return { ok: !error, error };
}

// Who can get a text from this company: texting set up for it, the client agreed, hasn't replied STOP, and has a US number.
const textable = (company, client) => (sms.configured() && company.sms_sender && client.sms_consent && !client.sms_opted_out_at && sms.e164(client.phone)) || null;

// Sends one text and records it in the message history. A STOP reply found at send time is saved on the client.
async function deliverText(db, { orgId, kind, client, body, company, estimateId = null, jobId = null }) {
  const to = sms.e164(client.phone);
  let providerId = ''; let error = '';
  try {
    providerId = await sms.send({ messagingServiceSid: company.sms_sender, to, body });
  } catch (e) {
    error = e.message.slice(0, 500);
    if (e.code === sms.UNSUBSCRIBED) await db.run('UPDATE clients SET sms_opted_out_at = now() WHERE id = ?', client.id);
    console.error(`Text (${kind}) to client ${client.id} failed:`, error);
  }
  await db.run(`INSERT INTO email_log (org_id, kind, to_email, subject, estimate_id, job_id, status, error, provider_id, channel)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sms')`, orgId, kind, to, body.slice(0, 300), estimateId, jobId, error ? 'failed' : 'sent', error, providerId);
  return { ok: !error, error };
}

// Texts are short, name the company first and always say how to opt out (carriers require both).
const STOP = 'Reply STOP to opt out.';
const texts = {
  estimate_reminder: ({ company, estimate, client, base }) =>
    `${company.name}: Hi ${firstName(client.name)}, just checking in on your estimate for ${estimate.project_name}. Review and approve here: ${estimateLink(base, estimate)} ${STOP}`,
  appointment_reminder: ({ company, job, client }) =>
    `${company.name}: Hi ${firstName(client.name)}, a reminder that we're scheduled to start ${job.project_name} on ${longDate(job.start_date)}.${company.phone ? ` Questions? Call ${company.phone}.` : ''} ${STOP}`,
  review_request: ({ company, job, client }) =>
    `${company.name}: Thanks for choosing us for ${job.project_name}, ${firstName(client.name)}! If you were happy with the work, a quick review would mean a lot: ${company.review_url} ${STOP}`,
};

const estimateLink = (base, e) => `${base}/e/${e.public_token}`;
const amountLine = (o) => (o.options.length > 1 ? `Options from ${fmt(Math.min(...o.options.map((x) => x.total)))}` : `Total: ${fmt(o.total)}`);

const templates = {
  estimate: ({ company, estimate, client, totals, message, base }) => ({
    subject: `Estimate from ${company.name}: ${estimate.project_name}`,
    content: {
      heading: `Your estimate for ${estimate.project_name}`,
      paragraphs: [`Hi ${firstName(client.name)},`, message || `Thanks for the opportunity. Here's your estimate from ${company.name}.`, amountLine(totals)],
      button: { label: 'Review and approve', url: estimateLink(base, estimate) },
      note: 'You can review the details, choose an option, and approve online with your signature.',
    },
  }),
  estimate_reminder: ({ company, estimate, client, totals, base }) => ({
    subject: `Reminder: your estimate from ${company.name}`,
    content: {
      heading: `Still thinking about ${estimate.project_name}?`,
      paragraphs: [`Hi ${firstName(client.name)},`, `Just following up on the estimate we sent for ${estimate.project_name}. ${amountLine(totals)}.`,
        'If you have any questions, reply to this email and we\'ll get right back to you.'],
      button: { label: 'View estimate', url: estimateLink(base, estimate) },
    },
  }),
  appointment_reminder: ({ company, job, client }) => ({
    subject: `Reminder: ${company.name} is scheduled for ${longDate(job.start_date)}`,
    content: {
      heading: `See you ${longDate(job.start_date)}`,
      paragraphs: [`Hi ${firstName(client.name)},`,
        `This is a reminder that ${company.name} is scheduled to start ${job.project_name}${job.address ? ` at ${job.address}` : ''} on ${longDate(job.start_date)}.`,
        'If anything has changed, just reply to this email.'],
    },
  }),
  review_request: ({ company, job, client }) => ({
    subject: `How did we do, ${firstName(client.name)}?`,
    content: {
      heading: 'Thank you for choosing us',
      paragraphs: [`Hi ${firstName(client.name)},`, `Thanks for trusting ${company.name} with ${job.project_name}. If you were happy with the work, a quick review would mean a lot to our small business.`],
      button: { label: 'Leave a review', url: company.review_url },
    },
  }),
  work_order: ({ company, job, name, payout }) => ({
    subject: `Work order from ${company.name}: ${job.project_name}`,
    content: {
      heading: `Work order: ${job.project_name}`,
      paragraphs: [`Hi ${firstName(name)},`,
        `Here's the work order for ${job.project_name}${job.address ? ` at ${job.address}` : ''}${job.start_date ? `, starting ${longDate(job.start_date)}` : ''}. It's attached as a PDF with the scope of work${payout != null ? ' and the agreed pay' : ''}.`,
        'Reply to this email with any questions.'],
    },
  }),
  estimate_approved: ({ company, estimate, client, job, total, deposit, base }) => ({
    subject: `${client.name} approved ${estimate.project_name}`,
    content: {
      heading: `${client.name} approved the estimate`,
      paragraphs: [`${estimate.signer_name} signed ${estimate.project_name}${estimate.chosen_option ? ` (${estimate.chosen_option})` : ''} for ${fmt(total)}. It's now a job in Keystone.`,
        deposit ? `A ${fmt(deposit)} deposit invoice was sent; you'll see the payment on the job when it's paid.` : ''].filter(Boolean),
      button: { label: 'Open the job', url: `${base}/jobs/${job}` },
    },
  }),
  estimate_declined: ({ company, estimate, client, base }) => ({
    subject: `${client.name} declined ${estimate.project_name}`,
    content: {
      heading: `${client.name} declined the estimate`,
      paragraphs: [estimate.decline_reason ? `Their note: "${estimate.decline_reason}"` : 'They didn\'t leave a note.'],
      button: { label: 'Open the estimate', url: `${base}/estimates/${estimate.id}` },
    },
  }),
};

// Option totals of an estimate: [{ name, total }] (empty when there are no options) and the current total.
async function estimateTotals(db, estimateId) {
  const items = await db.all('SELECT option_name, line_total_cents FROM line_items WHERE estimate_id = ? ORDER BY position', estimateId);
  const shared = items.filter((i) => !i.option_name).reduce((a, i) => a + i.line_total_cents, 0);
  const names = [...new Set(items.filter((i) => i.option_name).map((i) => i.option_name))];
  const options = names.map((name) => ({ name, total: shared + items.filter((i) => i.option_name === name).reduce((a, i) => a + i.line_total_cents, 0) }));
  const total = (await db.get('SELECT estimate_total(?) AS t', estimateId)).t;
  return { shared, options, total };
}

// ---------- Automatic emails ----------
// Runs every few minutes in the web server. An advisory lock keeps two servers from sending the same email twice,
// and each email is marked as sent in the same transaction that logs it.
const LOCK = 4_812_007;
const todayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const addDay = (s) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

async function runAutomations() {
  if (!(email.configured() || sms.configured()) || !appUrl()) return { skipped: true };
  const sent = { estimate_reminder: 0, appointment_reminder: 0, review_request: 0, texts: 0 };
  const canEmail = email.configured();
  // Texts only where the company turned that text on and has a registered sender.
  const textOn = (flag) => (sms.configured() ? `(p.${flag} AND EXISTS (SELECT 1 FROM sms_senders s WHERE s.org_id = p.org_id))` : 'false');
  await asServer(async (db) => {
    if (!(await db.get('SELECT pg_try_advisory_xact_lock(?) AS ok', LOCK)).ok) return;
    const base = appUrl();

    // Estimate follow-ups: after N days, and again after 2N days, while the estimate is still waiting.
    // By email when that's on (N = the chosen days), by text when that's on (every 3 days if the email follow-up is off).
    const emailFollowup = canEmail ? "(coalesce(p.estimate_followup_days, 3) > 0 AND e.sent_to <> '')" : 'false';
    const due = await db.all(`SELECT e.* FROM estimates e
      LEFT JOIN company_profiles p ON p.org_id = e.org_id
      WHERE e.status = 'sent' AND e.sent_at IS NOT NULL AND e.reminders_sent < 2
        AND (${emailFollowup} OR ${textOn('sms_estimate_followups')})
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.estimate_id = e.id)
        AND e.sent_at <= now() - make_interval(days => coalesce(nullif(p.estimate_followup_days, 0), 3) * (e.reminders_sent + 1))
      ORDER BY e.id LIMIT 50`);
    for (const e of due) {
      const company = await companyOf(db, e.org_id);
      const client = await db.get('SELECT * FROM clients WHERE id = ?', e.client_id);
      await db.run('UPDATE estimates SET reminders_sent = reminders_sent + 1, last_reminded_at = now() WHERE id = ?', e.id);
      if (canEmail && company.estimate_followup_days > 0 && e.sent_to) {
        const t = templates.estimate_reminder({ company, estimate: e, client, totals: await estimateTotals(db, e.id), base });
        await deliver(db, { orgId: e.org_id, kind: 'estimate_reminder', to: e.sent_to, ...t, company, estimateId: e.id });
        sent.estimate_reminder++;
      }
      if (company.sms_estimate_followups && textable(company, client)) {
        await deliverText(db, { orgId: e.org_id, kind: 'estimate_reminder', client, body: texts.estimate_reminder({ company, estimate: e, client, base }), company, estimateId: e.id });
        sent.texts++;
      }
    }

    // Appointment reminders: the day before a job starts.
    const emailReminder = canEmail ? "(c.email <> '' AND coalesce(p.appointment_reminders, true))" : 'false';
    const jobs = await db.all(`SELECT j.*, c.email AS client_email FROM jobs j JOIN clients c ON c.id = j.client_id
      LEFT JOIN company_profiles p ON p.org_id = j.org_id
      WHERE j.status <> 'completed' AND j.start_date IS NOT NULL AND (${emailReminder} OR ${textOn('sms_appointment_reminders')})
        AND j.start_date = ?::date AND j.reminder_sent_for IS DISTINCT FROM j.start_date
      ORDER BY j.id LIMIT 50`, addDay(todayIn(APP_TIMEZONE)));
    for (const j of jobs) {
      const company = await companyOf(db, j.org_id);
      const client = await db.get('SELECT * FROM clients WHERE id = ?', j.client_id);
      await db.run('UPDATE jobs SET reminder_sent_for = start_date WHERE id = ?', j.id);
      if (canEmail && company.appointment_reminders && j.client_email) {
        const t = templates.appointment_reminder({ company, job: j, client });
        await deliver(db, { orgId: j.org_id, kind: 'appointment_reminder', to: j.client_email, ...t, company, jobId: j.id });
        sent.appointment_reminder++;
      }
      if (company.sms_appointment_reminders && textable(company, client)) {
        await deliverText(db, { orgId: j.org_id, kind: 'appointment_reminder', client, body: texts.appointment_reminder({ company, job: j, client }), company, jobId: j.id });
        sent.texts++;
      }
    }

    // Review requests: an hour after a job is completed (time to undo a mistaken click), within the last week.
    const emailReview = canEmail ? "(c.email <> '' AND p.review_requests)" : 'false';
    const done = await db.all(`SELECT j.*, c.email AS client_email FROM jobs j JOIN clients c ON c.id = j.client_id
      JOIN company_profiles p ON p.org_id = j.org_id
      WHERE j.status = 'completed' AND j.review_requested_at IS NULL AND p.review_url <> '' AND (${emailReview} OR ${textOn('sms_review_requests')})
        AND j.completed_at <= now() - interval '1 hour' AND j.completed_at > now() - interval '7 days'
      ORDER BY j.id LIMIT 50`);
    for (const j of done) {
      const company = await companyOf(db, j.org_id);
      const client = await db.get('SELECT * FROM clients WHERE id = ?', j.client_id);
      await db.run('UPDATE jobs SET review_requested_at = now() WHERE id = ?', j.id);
      if (canEmail && company.review_requests && j.client_email) {
        const t = templates.review_request({ company, job: j, client });
        await deliver(db, { orgId: j.org_id, kind: 'review_request', to: j.client_email, ...t, company, jobId: j.id });
        sent.review_request++;
      }
      if (company.sms_review_requests && textable(company, client)) {
        await deliverText(db, { orgId: j.org_id, kind: 'review_request', client, body: texts.review_request({ company, job: j, client }), company, jobId: j.id });
        sent.texts++;
      }
    }
  });
  return sent;
}

function startAutomations(intervalMs = Number(process.env.AUTOMATION_INTERVAL_MS || 10 * 60_000)) {
  const tick = () => {
    runAutomations().catch((e) => console.error('Automatic emails failed:', e.message));
    require('./texting').check().catch((e) => console.error('Texting status check failed:', e.message));
  };
  setTimeout(tick, Math.min(30_000, intervalMs)).unref();
  setInterval(tick, intervalMs).unref();
}

module.exports = { templates, texts, deliver, deliverText, textable, companyOf, estimateTotals, runAutomations, startAutomations, appUrl, render };
