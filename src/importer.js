'use strict';
// Importing clients and jobs from another app's CSV export (Jobber, Housecall Pro, QuickBooks, a spreadsheet…).
// Each app names its columns differently, so every Keystone field has a list of header names it's usually called;
// the owner can change any guess before importing. Everything here is pure: parsing, matching and checking rows.
const { parseMoney } = require('./money');

const MAX_ROWS = 5000;
const MAX_CSV = 3_000_000; // characters

// RFC 4180: quoted fields may hold commas, quotes ("") and line breaks. Also handles a BOM, CRLF and blank lines.
function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  const headers = (rows.shift() || []).map((h) => h.trim());
  return { headers, rows: rows.map((r) => headers.map((_, i) => (r[i] ?? '').trim())) };
}

// Keystone fields and the header names other apps use for them (compared lowercase, ignoring spaces and punctuation).
const CLIENT_FIELDS = [
  ['name', 'Client name', ['client name', 'client', 'customer', 'customer name', 'customer full name', 'display name', 'full name', 'name', 'contact name']],
  ['first_name', 'First name', ['first name', 'firstname', 'given name', 'client first name', 'customer first name']],
  ['last_name', 'Last name', ['last name', 'lastname', 'surname', 'family name', 'client last name', 'customer last name']],
  ['company', 'Company', ['company', 'company name', 'business name', 'organization']],
  ['email', 'Email', ['email', 'e-mail', 'email address', 'client email', 'customer email', 'primary email']],
  ['phone', 'Phone', ['phone', 'main phone', 'mobile', 'mobile number', 'mobile phone', 'cell', 'phone number', 'home number', 'work number', 'client phone', 'customer phone', 'primary phone']],
  ['street', 'Street address', ['address', 'street', 'street address', 'address 1', 'address line 1', 'street 1', 'billing street', 'billing street 1', 'billing address', 'service street 1', 'property address', 'service address', 'client address', 'customer address']],
  ['city', 'City', ['city', 'town', 'billing city', 'service city', 'property city']],
  ['state', 'State', ['state', 'province', 'region', 'billing state', 'service state', 'property state']],
  ['zip', 'ZIP code', ['zip', 'zip code', 'zipcode', 'postal code', 'postcode', 'billing zip', 'billing zip code', 'service zip code', 'property zip']],
];
const JOB_FIELDS = [
  ...CLIENT_FIELDS,
  ['title', 'Job title or work', ['title', 'job title', 'job name', 'job', 'description', 'job description', 'service', 'services', 'work', 'line items', 'type', 'job type', 'project', 'project name']],
  ['job_address', 'Job address', ['job address', 'job site', 'jobsite', 'site address', 'service location', 'property', 'location', 'job location', 'work address', 'site']],
  ['amount', 'Contract amount ($)', ['total', 'amount', 'job total', 'contract', 'contract amount', 'price', 'invoice total', 'total price', 'revenue', 'value', 'job value', 'subtotal', 'grand total']],
  ['start_date', 'Start date', ['start date', 'start', 'scheduled start', 'schedule start', 'scheduled date', 'scheduled', 'date', 'job date', 'visit date', 'created date', 'start at']],
  ['end_date', 'End date', ['end date', 'end', 'scheduled end', 'schedule end', 'completed date', 'completion date', 'finished', 'end at', 'completed on', 'closed date', 'finish', 'finish date', 'due date']],
  ['status', 'Status', ['status', 'job status', 'stage', 'state of job', 'work status']],
  ['notes', 'Notes', ['notes', 'note', 'job notes', 'instructions', 'internal notes', 'comments', 'details']],
];
const FIELDS = { clients: CLIENT_FIELDS, jobs: JOB_FIELDS };

const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Best guess for each field: an exact synonym first, then the most specific synonym the header contains.
function guessMapping(kind, headers) {
  const used = new Set(); const map = {};
  const nh = headers.map(norm);
  for (const pass of ['exact', 'contains']) {
    for (const [key, , syn] of FIELDS[kind]) {
      if (map[key] !== undefined) continue;
      let best = -1; let bestLen = 0;
      nh.forEach((h, i) => {
        if (used.has(i)) return;
        for (const s of syn.map(norm)) {
          const hit = pass === 'exact' ? h === s : (` ${h} `).includes(` ${s} `);
          if (hit && s.length > bestLen) { best = i; bestLen = s.length; }
        }
      });
      if (best >= 0) { map[key] = best; used.add(best); }
    }
  }
  // "name" alone is ambiguous when first/last columns exist (it's often the company); keep both.
  return map;
}

// Mapping from the form: field -> column index (or nothing).
function mappingFrom(kind, form, headers) {
  const map = {};
  for (const [key] of FIELDS[kind]) {
    const v = form.get(`map_${key}`);
    if (v != null && /^\d+$/.test(v) && Number(v) < headers.length) map[key] = Number(v);
  }
  return map;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// Dates as apps export them: 2026-10-05, 10/5/2026, 10/5/26, Oct 5, 2026, 5 Oct 2026 (times are ignored). US order for slashes.
function parseDate(s) {
  s = String(s || '').trim(); if (!s) return { value: null };
  let y; let m; let d; let mm;
  if ((mm = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) [, y, m, d] = mm;
  else if ((mm = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/.exec(s))) { [, m, d, y] = mm; if (y.length === 2) y = `20${y}`; }
  else if ((mm = /^([a-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/i.exec(s))) { m = MONTHS[mm[1].toLowerCase()]; d = mm[2]; y = mm[3]; }
  else if ((mm = /^(\d{1,2}) ([a-z]{3})[a-z]* (\d{4})/i.exec(s))) { d = mm[1]; m = MONTHS[mm[2].toLowerCase()]; y = mm[3]; }
  if (!m) return { error: `"${s}" isn't a date we can read` };
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso || +y < 1990 || +y > 2100) return { error: `"${s}" isn't a valid date` };
  return { value: iso };
}

function parseStatus(s) {
  const t = norm(s);
  if (!t) return null;
  if (/complete|done|closed|finished|paid|invoiced|archived|won/.test(t)) return 'completed';
  if (/progress|active|started|ongoing|working|underway/.test(t)) return 'in_progress';
  return 'not_started';
}

const cell = (row, map, key) => (map[key] !== undefined ? String(row[map[key]] ?? '').trim() : '');
const joinAddr = (street, city, state, zip) => [street, city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');

// Turns one CSV row into a client (and job) using the mapping; returns the problems instead when it can't.
function readRow(kind, row, map) {
  const first = cell(row, map, 'first_name'); const last = cell(row, map, 'last_name');
  const company = cell(row, map, 'company');
  const name = (cell(row, map, 'name') || [first, last].filter(Boolean).join(' ') || company).slice(0, 200);
  const email = cell(row, map, 'email').slice(0, 200);
  const client = {
    name, email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '',
    phone: cell(row, map, 'phone').slice(0, 50),
    address: joinAddr(cell(row, map, 'street'), cell(row, map, 'city'), cell(row, map, 'state'), cell(row, map, 'zip')).slice(0, 500),
  };
  const problems = [];
  if (!name) problems.push('no client name');
  if (kind === 'clients') return { client, problems };
  const job = {
    title: (cell(row, map, 'title') || 'Imported job').split(/\r?\n/)[0].slice(0, 500),
    address: (cell(row, map, 'job_address') || client.address).slice(0, 500),
    notes: cell(row, map, 'notes').slice(0, 5000),
    status: parseStatus(cell(row, map, 'status')) || 'not_started',
  };
  const amt = cell(row, map, 'amount');
  const money = amt ? parseMoney(amt.replace(/^\((.*)\)$/, '-$1'), 'Amount') : { value: 0 };
  if (money.error) problems.push(`amount "${amt}" isn't a dollar amount`); else job.amount = money.value;
  for (const k of ['start_date', 'end_date']) {
    const dt = parseDate(cell(row, map, k));
    if (dt.error) problems.push(dt.error); else job[k] = dt.value;
  }
  if (job.start_date && job.end_date && job.end_date < job.start_date) problems.push('end date is before start date');
  if (!job.start_date && job.end_date) job.start_date = job.end_date;
  return { client, job, problems };
}

// Checks every row against what's already in the company (existing: { names:Set, emails:Set, jobs:Set }).
// Clients: duplicates by name or email are skipped. Jobs: reuse a client with the same name; skip a job whose
// client, address and amount already match one in Keystone or earlier in the file.
function check(kind, rows, map, existing) {
  const out = { ok: [], dupes: 0, problems: [] };
  const names = new Set(existing.names); const emails = new Set(existing.emails); const jobs = new Set(existing.jobs);
  rows.forEach((row, i) => {
    const r = readRow(kind, row, map);
    if (r.problems.length) { out.problems.push({ line: i + 2, name: r.client.name, why: r.problems.join('; ') }); return; }
    const nk = r.client.name.toLowerCase();
    if (kind === 'clients') {
      if (names.has(nk) || (r.client.email && emails.has(r.client.email.toLowerCase()))) { out.dupes++; return; }
      names.add(nk); if (r.client.email) emails.add(r.client.email.toLowerCase());
    } else {
      const jk = `${nk}|${r.job.address.toLowerCase()}|${r.job.amount}`;
      if (jobs.has(jk)) { out.dupes++; return; }
      jobs.add(jk);
    }
    out.ok.push({ line: i + 2, ...r });
  });
  return out;
}

module.exports = { parseCsv, guessMapping, mappingFrom, check, readRow, parseDate, parseStatus, FIELDS, MAX_ROWS, MAX_CSV };
