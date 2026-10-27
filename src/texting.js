'use strict';
// Self-serve texting setup. A company enters its business details once; Keystone buys it a toll-free number, puts the
// number in the company's own Twilio Messaging Service and files the number's toll-free verification with the carriers.
// Carriers review it (usually a few business days); when Twilio reports it approved, the company's sms_senders row is
// added and its text follow-ups can be switched on. Every step is saved as it finishes, so a failed setup resumes.
const sms = require('./sms');
const { asServer } = require('./db');

const BUSINESS_TYPES = { PRIVATE_PROFIT: 'Company (LLC, corporation, partnership)', SOLE_PROPRIETOR: 'Sole proprietor (no EIN)', NON_PROFIT: 'Nonprofit' };
const STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
const FIELDS = { business_name: 200, business_type: 20, ein: 12, street: 200, city: 100, state: 2, zip: 10, website: 300,
  contact_first_name: 100, contact_last_name: 100, contact_email: 200, contact_phone: 30 };
// Re-checks with Twilio at most this often (the page also checks when an admin opens it, at most once a minute).
const CHECK_EVERY_MIN = 30;

const str = (v, max) => String(v ?? '').trim().slice(0, max);

function validate(form) {
  const v = {}; const errors = {};
  for (const [k, max] of Object.entries(FIELDS)) v[k] = str(form.get(k), max);
  v.state = v.state.toUpperCase();
  if (!v.business_name) errors.business_name = 'Enter the business name as registered.';
  if (!BUSINESS_TYPES[v.business_type]) errors.business_type = 'Choose the type of business.';
  if (v.business_type === 'SOLE_PROPRIETOR') v.ein = '';
  else if (/^\d{9}$/.test(v.ein.replace(/\D/g, '')) && /^[\d\s-]+$/.test(v.ein)) v.ein = v.ein.replace(/\D/g, '').replace(/^(\d\d)/, '$1-');
  else if (v.business_type) errors.ein = 'Enter the 9-digit EIN (like 12-3456789). Carriers require it.';
  if (!v.street) errors.street = 'Enter the business street address.';
  if (!v.city) errors.city = 'Enter the city.';
  if (!STATES.includes(v.state)) errors.state = 'Choose the state.';
  if (!/^\d{5}(-\d{4})?$/.test(v.zip)) errors.zip = 'Enter a 5-digit ZIP code.'; else v.zip = v.zip.slice(0, 5);
  if (v.website && !/^https?:\/\//i.test(v.website)) v.website = `https://${v.website}`;
  if (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(v.website)) errors.website = 'Enter your website or business page (Google, Facebook, Yelp…). Carriers check it.';
  if (!v.contact_first_name) errors.contact_first_name = 'Enter a first name.';
  if (!v.contact_last_name) errors.contact_last_name = 'Enter a last name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.contact_email)) errors.contact_email = 'Enter an email address.';
  const phone = sms.e164(v.contact_phone);
  if (!phone) errors.contact_phone = 'Enter a US phone number.'; else v.contact_phone = phone;
  if (form.get('agree') !== 'on') errors.agree = 'Please confirm you text only clients who agreed to it.';
  return { values: v, errors };
}

const verificationFields = (r, base) => ({
  BusinessName: r.business_name, BusinessWebsite: r.website,
  NotificationEmail: process.env.TWILIO_NOTIFICATION_EMAIL || 'support@keystonefsm.com',
  UseCaseCategories: ['ACCOUNT_NOTIFICATIONS', 'CUSTOMER_CARE'],
  UseCaseSummary: `${r.business_name} is a contractor. It texts its own clients, who agreed to receive texts when they requested work, about their estimates and jobs: a follow-up on an estimate they received, a reminder the day before work starts, and a request for a review after the job. No marketing. Sent through Keystone, the business's job management software.`,
  ProductionMessageSample: `${r.business_name}: Hi Pat, a reminder that we're scheduled to start 12 Oak St tomorrow, Tuesday, March 3. Questions? Call ${r.contact_phone}. Reply STOP to opt out.`,
  OptInImageUrls: [`${base}/texting?company=${encodeURIComponent(r.business_name)}`],
  OptInType: 'VERBAL', MessageVolume: '1,000',
  TollfreePhoneNumberSid: r.phone_number_sid,
  BusinessStreetAddress: r.street, BusinessCity: r.city, BusinessStateProvinceRegion: r.state, BusinessPostalCode: r.zip, BusinessCountry: 'US',
  BusinessContactFirstName: r.contact_first_name, BusinessContactLastName: r.contact_last_name,
  BusinessContactEmail: r.contact_email, BusinessContactPhone: r.contact_phone,
  BusinessType: r.business_type,
  ...(r.ein ? { BusinessRegistrationNumber: r.ein, BusinessRegistrationAuthority: 'EIN', BusinessRegistrationCountry: 'US' } : {}),
  ExternalReferenceId: r.org_id,
});

// Saves the details and runs (or resumes) the setup. Returns the registration row.
async function submit(orgId, values, base) {
  return asServer(async (db) => {
    const cols = Object.keys(FIELDS);
    await db.run(`INSERT INTO sms_registrations (org_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
      ON CONFLICT (org_id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}, status = 'pending', problem = '', updated_at = now()`,
    orgId, ...cols.map((c) => values[c]));
    const r = await db.get('SELECT * FROM sms_registrations WHERE org_id = ?', orgId);
    const save = (sets, ...args) => db.run(`UPDATE sms_registrations SET ${sets}, updated_at = now() WHERE org_id = ?`, ...args, orgId);
    try {
      if (!r.phone_number_sid) {
        const n = await sms.buyTollFreeNumber(`Keystone · ${r.business_name}`.slice(0, 64));
        Object.assign(r, { phone_number_sid: n.sid, phone: n.phone });
        await save('phone_number_sid = ?, phone = ?', n.sid, n.phone);
      }
      if (!r.messaging_service_sid) {
        const mg = await sms.createService({ name: `Keystone · ${r.business_name}`.slice(0, 64), inboundUrl: `${base}/twilio/inbound` });
        await sms.addNumberToService(mg, r.phone_number_sid);
        r.messaging_service_sid = mg;
        await save('messaging_service_sid = ?', mg);
      }
      const fields = verificationFields(r, base);
      if (r.verification_sid && r.edit_allowed) {
        await sms.updateVerification(r.verification_sid, { ...fields, EditReason: 'Updated business details' });
      } else {
        if (r.verification_sid) await sms.deleteVerification(r.verification_sid).catch(() => {});
        const tv = await sms.submitVerification(fields);
        r.verification_sid = tv.sid;
      }
      await save("verification_sid = ?, status = 'pending', edit_allowed = false, problem = '', submitted_at = now(), checked_at = now()", r.verification_sid);
    } catch (e) {
      console.error(`Texting setup for ${orgId} failed:`, e.message);
      await save("status = 'failed', problem = ?", `Twilio said: ${e.message}`.slice(0, 2000));
    }
    return db.get('SELECT * FROM sms_registrations WHERE org_id = ?', orgId);
  });
}

// Asks Twilio how pending verifications are doing. orgId: just that company (when its admin opens the page), else all due.
async function check(orgId = null) {
  if (!sms.configured()) return;
  await asServer(async (db) => {
    const due = await db.all(`SELECT * FROM sms_registrations WHERE status = 'pending' AND verification_sid <> ''
      AND ${orgId ? "org_id = ? AND (checked_at IS NULL OR checked_at < now() - interval '1 minute')" : `(checked_at IS NULL OR checked_at < now() - interval '${CHECK_EVERY_MIN} minutes')`}
      ORDER BY checked_at NULLS FIRST LIMIT 20`, ...(orgId ? [orgId] : []));
    for (const r of due) {
      let v;
      try { v = await sms.getVerification(r.verification_sid); } catch (e) {
        console.error(`Texting status check for ${r.org_id} failed:`, e.message);
        await db.run('UPDATE sms_registrations SET checked_at = now() WHERE org_id = ?', r.org_id);
        continue;
      }
      if (v.status === 'TWILIO_APPROVED') {
        await db.run(`INSERT INTO sms_senders (org_id, messaging_service_sid, phone) VALUES (?, ?, ?)
          ON CONFLICT (org_id) DO UPDATE SET messaging_service_sid = excluded.messaging_service_sid, phone = excluded.phone`, r.org_id, r.messaging_service_sid, r.phone);
        await db.run("UPDATE sms_registrations SET status = 'approved', problem = '', checked_at = now(), updated_at = now() WHERE org_id = ?", r.org_id);
      } else if (v.status === 'TWILIO_REJECTED') {
        const reasons = (v.rejection_reasons || []).map((x) => x.reason || x.message).filter(Boolean);
        const why = reasons.length ? reasons.join('; ') : (v.rejection_reason || 'The carriers did not approve these details.');
        await db.run("UPDATE sms_registrations SET status = 'rejected', problem = ?, edit_allowed = ?, checked_at = now(), updated_at = now() WHERE org_id = ?",
          why.slice(0, 2000), v.edit_allowed === true, r.org_id);
      } else {
        await db.run('UPDATE sms_registrations SET checked_at = now() WHERE org_id = ?', r.org_id);
      }
    }
  });
}

// When a company is deleted: give its number back and remove its Messaging Service (best effort; nothing else depends on it).
async function release(reg) {
  if (!reg || !sms.configured()) return;
  if (reg.messaging_service_sid) await sms.deleteService(reg.messaging_service_sid).catch((e) => console.error('Texting service delete failed:', e.message));
  if (reg.phone_number_sid) await sms.releaseNumber(reg.phone_number_sid).catch((e) => console.error('Number release failed:', e.message));
}

module.exports = { validate, submit, check, release, BUSINESS_TYPES, STATES };
