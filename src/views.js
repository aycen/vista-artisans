'use strict';
const { html, raw } = require('./html');
const { fmt, fmtQty } = require('./money');

const ESTIMATE_STATUS = { draft: 'Draft', sent: 'Sent', approved: 'Approved', declined: 'Declined' };
const JOB_STATUS = { not_started: 'Not started', in_progress: 'In progress', completed: 'Completed' };

const CSS = `
*{box-sizing:border-box}
body{margin:0;font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1d232a;background:#f5f6f7}
a{color:#1f5fa8}
header{background:#22303c;color:#fff}
header .in{max-width:980px;margin:0 auto;padding:10px 16px;display:flex;flex-wrap:wrap;gap:4px 16px;align-items:center}
header a{color:#fff;text-decoration:none}
header .brand{font-weight:700;margin-right:auto}
header form{margin:0}
.org-switch select{width:auto;padding:3px 6px;font-size:.9rem}
.muted-light{color:#c4ced8}
header button{background:none;border:1px solid #6b7c8c;color:#fff;padding:4px 10px}
main{max-width:980px;margin:0 auto;padding:16px}
h1{font-size:1.5rem;margin:.2em 0 .6em}
h2{font-size:1.15rem;margin:1.4em 0 .5em}
.card{background:#fff;border:1px solid #dde1e5;border-radius:6px;padding:16px;margin-bottom:16px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.spread{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}
.tablewrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;background:#fff}
th,td{text-align:left;padding:8px;border-bottom:1px solid #e6e9ec;vertical-align:top}
th{font-size:.85rem;color:#56616c;font-weight:600}
td.num,th.num{text-align:right;white-space:nowrap}
tr[data-href]{cursor:pointer}
tr[data-href]:hover{background:#f0f5fb}
label{display:block;font-weight:600;font-size:.9rem;margin:10px 0 4px}
input,select,textarea{font:inherit;padding:8px;border:1px solid #b9c1c9;border-radius:4px;width:100%;background:#fff}
textarea{min-height:90px}
.items input{min-width:80px}
.btn,button{font:inherit;display:inline-block;padding:8px 14px;border-radius:4px;border:1px solid #1f5fa8;background:#1f5fa8;color:#fff;text-decoration:none;cursor:pointer}
.btn.secondary,button.secondary{background:#fff;color:#1f5fa8}
button.danger,.btn.danger{background:#b3261e;border-color:#b3261e;color:#fff}
button.link{background:none;border:none;color:#1f5fa8;padding:0;text-decoration:underline}
button:disabled{opacity:.6;cursor:default}
.errors{background:#fdecea;border:1px solid #f5c2bd;color:#8a1c14;border-radius:6px;padding:10px 14px;margin-bottom:16px}
.errors ul{margin:4px 0 0;padding-left:20px}
.flash{background:#e7f4ea;border:1px solid #b7dfc0;color:#1e5b2c;border-radius:6px;padding:10px 14px;margin-bottom:16px}
.field-error{color:#b3261e;font-size:.85rem;margin-top:2px}
.invalid{border-color:#b3261e}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:.8rem;background:#e6e9ec;color:#333}
.badge.approved,.badge.completed{background:#dcf1e1;color:#1e5b2c}
.badge.sent,.badge.in_progress{background:#dde9f7;color:#1f4f87}
.badge.declined{background:#f8e0de;color:#8a1c14}
.muted{color:#66717c}
.pre{white-space:pre-wrap}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.stat{background:#fff;border:1px solid #dde1e5;border-radius:6px;padding:12px}
.stat .k{font-size:.85rem;color:#56616c}
.stat .v{font-size:1.25rem;font-weight:700}
.two{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
@media (max-width:640px){.two{grid-template-columns:1fr}}
@media (max-width:640px){.items thead{display:none}.items,.items tbody{display:block}.items tr.item{display:grid;grid-template-columns:1fr 1fr auto;gap:6px;padding:10px 0;border-bottom:1px solid #e6e9ec}.items td{border:none;padding:0;align-self:center}.items td:first-child{grid-column:1/-1}.items td:nth-child(4){grid-column:1/3;text-align:left}}
.notice{background:#fff7e0;border:1px solid #f0d98a;border-radius:6px;padding:10px 14px;margin-bottom:16px}
`;

const JS = `
document.addEventListener('click', function (e) {
  var tr = e.target.closest('tr[data-href]');
  if (tr && !e.target.closest('a,button,input,select,textarea,form')) location.href = tr.dataset.href;
});
document.addEventListener('submit', function (e) {
  var f = e.target;
  if (f.dataset.confirm && !confirm(f.dataset.confirm)) { e.preventDefault(); return; }
  if (f.dataset.submitted) { e.preventDefault(); return; }
  f.dataset.submitted = '1';
  f.querySelectorAll('button[type=submit],button:not([type])').forEach(function (b) { b.disabled = true; });
});
window.addEventListener('pageshow', function () {
  document.querySelectorAll('form[data-submitted]').forEach(function (f) {
    delete f.dataset.submitted;
    f.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
  });
});
`;

function layout(title, body, { authed = true, flash } = {}) {
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Vista Artisans</title><style>${raw(CSS)}</style></head>
<body>
<header><div class="in">
  <a class="brand" href="/">Vista Artisans</a>
  ${authed ? raw('<!--NAV-->') : ''}
</div></header>
<main>
${flash ? html`<div class="flash">${flash}</div>` : ''}
${body}
</main>
<script>${raw(JS)}</script>
</body></html>`.s;
}

function errorBox(errors) {
  const list = Object.values(errors || {}).flat();
  if (!list.length) return '';
  return html`<div class="errors" role="alert"><strong>Not saved. Please fix the following and try again:</strong>
    <ul>${list.map((e) => html`<li>${e}</li>`)}</ul></div>`;
}
const fieldErr = (errors, k) => (errors && errors[k] ? html`<div class="field-error">${errors[k]}</div>` : '');
const inv = (errors, k) => (errors && errors[k] ? 'invalid' : '');

const badge = (status, labels) => html`<span class="badge ${status}">${labels[status] || status}</span>`;

function input(name, label, values, errors, { type = 'text', required = false, placeholder = '', inputmode } = {}) {
  return html`<label for="${name}">${label}${required ? ' *' : ''}</label>
  <input id="${name}" name="${name}" type="${type}" value="${values[name] ?? ''}" class="${inv(errors, name)}"
    ${required ? raw('required') : ''} ${placeholder ? raw(`placeholder="${placeholder}"`) : ''} ${inputmode ? raw(`inputmode="${inputmode}"`) : ''}>
  ${fieldErr(errors, name)}`;
}
function textarea(name, label, values, errors, { required = false } = {}) {
  return html`<label for="${name}">${label}${required ? ' *' : ''}</label>
  <textarea id="${name}" name="${name}" class="${inv(errors, name)}">${values[name] ?? ''}</textarea>${fieldErr(errors, name)}`;
}

// ---------- Navigation (filled in per request by the server) ----------
function nav({ user, org, orgs }) {
  return html`${org ? html`
  ${orgs.length > 1 ? html`<form method="post" action="/org/switch" class="org-switch">
    <select name="org_id" aria-label="Organization" onchange="this.form.submit()">${orgs.map((o) =>
      html`<option value="${o.org_id}" ${o.org_id === org.org_id ? raw('selected') : ''}>${o.name}</option>`)}</select>
    <noscript><button type="submit">Switch</button></noscript></form>` : html`<span class="muted-light">${org.name}</span>`}
  ${org.role === 'admin' ? html`<a href="/">Home</a><a href="/clients">Clients</a><a href="/estimates">Estimates</a><a href="/jobs">Jobs</a><a href="/team">Team</a>`
    : html`<a href="/">Schedule</a>`}` : ''}
  <form method="post" action="/logout"><button type="submit" title="${user.email}">Log out</button></form>`.s;
}

// ---------- Auth ----------
function authCard(title, body) {
  return layout(title, html`<div class="card" style="max-width:400px;margin:40px auto"><h1>${title}</h1>${body}</div>`);
}

function loginPage({ error, notice, email = '' } = {}) {
  return authCard('Log in', html`
    ${error ? html`<div class="errors" role="alert">${error}</div>` : ''}
    ${notice ? html`<div class="flash">${notice}</div>` : ''}
    <form method="post" action="/login">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="email" value="${email}" required autofocus>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <p><button type="submit">Log in</button></p>
    </form>
    <p class="muted">New here? <a href="/signup">Create an account</a></p>`);
}

function signupPage({ errors = {}, values = {} } = {}) {
  return authCard('Create an account', html`
    ${errorBox(errors)}
    <form method="post" action="/signup" novalidate>
      ${input('email', 'Email', values, errors, { type: 'email', required: true })}
      <label for="password">Password * <span class="muted">(at least 8 characters)</span></label>
      <input id="password" name="password" type="password" autocomplete="new-password" class="${inv(errors, 'password')}" required>
      ${fieldErr(errors, 'password')}
      <p><button type="submit">Create account</button></p>
    </form>
    <p class="muted">Already have an account? <a href="/login">Log in</a></p>`);
}

function orgNewPage({ errors = {}, values = {}, hasOrgs }) {
  return layout('New organization', html`
  <div class="card" style="max-width:520px">
    <h1>${hasOrgs ? 'New organization' : 'Set up your organization'}</h1>
    <p class="muted">${hasOrgs ? 'Each organization keeps its own clients, estimates and jobs.'
      : 'Create your company to get started. If your company already uses this app, ask its owner to add your email instead.'}</p>
    ${errorBox(errors)}
    <form method="post" action="/org/new" novalidate>
      ${input('name', 'Organization name', values, errors, { required: true })}
      <p><button type="submit">Create organization</button></p>
    </form>
  </div>`);
}

const ROLES = { admin: 'Admin', worker: 'Worker' };
const roleSelect = (name, selected, id) => html`<select name="${name}" ${id ? raw(`id="${id}"`) : ''} style="width:auto">${Object.entries(ROLES).map(([k, l]) =>
  html`<option value="${k}" ${selected === k ? raw('selected') : ''}>${l}</option>`)}</select>`;

function teamPage({ org, members, me, errors = {}, values = {}, flash }) {
  const admin = org.role === 'admin';
  return layout('Team', html`
  <h1>Team: ${org.name}</h1>
  ${errorBox(errors)}
  <div class="tablewrap"><table><thead><tr><th>Email</th><th>Role</th><th></th></tr></thead><tbody>
  ${members.map((m) => html`<tr><td>${m.email}${m.user_id === me ? html` <span class="muted">(you)</span>` : ''}</td>
    <td>${admin ? html`<form method="post" action="/team/role" class="row">
        <input type="hidden" name="user_id" value="${m.user_id}">${roleSelect('role', m.role)}
        <button type="submit" class="secondary">Save</button></form>` : ROLES[m.role]}</td>
    <td class="num">${admin && m.user_id !== me ? html`<form method="post" action="/team/remove" data-confirm="Remove ${m.email} from ${org.name}?">
      <input type="hidden" name="user_id" value="${m.user_id}"><button type="submit" class="link">Remove</button></form>` : ''}</td></tr>`)}
  </tbody></table></div>
  <p class="muted"><strong>Admins</strong> see and manage everything, including money and the team.
    <strong>Workers</strong> see only open jobs assigned to them: schedule, address, scope of work and their own pay.</p>
  ${admin ? html`<form method="post" action="/team/add" class="card" style="margin-top:16px" novalidate>
    <h2 style="margin-top:0">Add a teammate</h2>
    <p class="muted">They need to <a href="/signup">create an account</a> first. Then add their email here.</p>
    ${input('email', 'Email', values, errors, { type: 'email', required: true })}
    <label for="new-role">Role</label>${roleSelect('role', values.role || 'worker', 'new-role')}
    <p><button type="submit">Add to ${org.name}</button></p>
  </form>` : ''}
  <p><a href="/org/new">Create another organization</a></p>`, { flash });
}

// ---------- Worker schedule ----------
function schedulePage({ jobs, flash }) {
  return layout('Schedule', html`<h1>Schedule</h1>
  ${jobs.length ? html`<div class="tablewrap"><table>
    <thead><tr><th>Date</th><th>Project</th><th>Address</th><th>Status</th><th class="num">Your pay</th></tr></thead>
    <tbody>${jobs.map((j) => html`<tr data-href="/schedule/${j.job_id}">
      <td>${j.scheduled_date || html`<span class="muted">Not scheduled</span>`}</td>
      <td><a href="/schedule/${j.job_id}">${j.project_name}</a><div class="muted">${j.client_name}</div></td>
      <td>${j.address}</td><td>${badge(j.status, JOB_STATUS)}</td>
      <td class="num">${j.my_payout_cents == null ? html`<span class="muted">—</span>` : fmt(j.my_payout_cents)}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">No open jobs assigned to you.</p>`}`, { flash });
}

function scheduleJobPage({ job }) {
  return layout(job.project_name, html`
  <p><a href="/">← Schedule</a></p>
  <h1>${job.project_name} ${badge(job.status, JOB_STATUS)}</h1>
  <div class="card two">
    <div><label>Scheduled date</label>${job.scheduled_date || html`<span class="muted">Not scheduled</span>`}</div>
    <div><label>Client</label>${job.client_name}</div>
    <div><label>Your pay for this job</label><strong data-k="my-pay">${job.my_payout_cents == null ? '—' : fmt(job.my_payout_cents)}</strong></div>
    <div style="grid-column:1/-1"><label>Address</label>${job.address || html`<span class="muted">—</span>`}</div>
    <div style="grid-column:1/-1"><label>Scope of work</label><div class="pre">${job.scope || html`<span class="muted">—</span>`}</div></div>
    ${job.notes ? html`<div style="grid-column:1/-1"><label>Notes</label><div class="pre">${job.notes}</div></div>` : ''}
  </div>`);
}

function confirmPage({ title, message, action, cancelHref, button = 'Yes, delete it' }) {
  return layout(title, html`
  <div class="card" style="max-width:560px">
    <h1>${title}</h1>
    <p>${message}</p>
    <form method="post" action="${action}" class="row">
      <button type="submit" class="danger">${button}</button>
      <a class="btn secondary" href="${cancelHref}">Cancel</a>
    </form>
  </div>`);
}

// ---------- Home ----------
function homePage({ openEstimates, activeJobs, outstandingCents, flash }) {
  return layout('Home', html`
  <div class="spread"><h1>Home</h1>
    <div class="row"><a class="btn" href="/clients/new">New Client</a><a class="btn" href="/estimates/new">New Estimate</a></div></div>
  <div class="grid" style="margin-bottom:16px">
    <div class="stat"><div class="k">Total outstanding balance (all jobs)</div><div class="v" id="total-outstanding">${fmt(outstandingCents)}</div></div>
    <div class="stat"><div class="k">Open estimates</div><div class="v">${openEstimates.length}</div></div>
    <div class="stat"><div class="k">Active jobs</div><div class="v">${activeJobs.length}</div></div>
  </div>
  <h2>Open estimates</h2>
  ${estimateTable(openEstimates, 'No open estimates.')}
  <h2>Active jobs</h2>
  ${jobTable(activeJobs, 'No active jobs.')}`, { flash });
}

function estimateTable(rows, empty, { showClient = true } = {}) {
  if (!rows.length) return html`<p class="muted">${empty}</p>`;
  return html`<div class="tablewrap"><table>
  <thead><tr><th>Project</th>${showClient ? html`<th>Client</th>` : ''}<th>Status</th><th class="num">Total</th><th>Updated</th></tr></thead>
  <tbody>${rows.map((e) => html`<tr data-href="/estimates/${e.id}">
    <td><a href="/estimates/${e.id}">${e.project_name}</a></td>
    ${showClient ? html`<td>${e.client_name}</td>` : ''}
    <td>${badge(e.status, ESTIMATE_STATUS)}${e.job_id ? html` <span class="muted">→ job</span>` : ''}</td>
    <td class="num">${fmt(e.total_cents)}</td><td class="muted">${e.updated_at.slice(0, 10)}</td></tr>`)}
  </tbody></table></div>`;
}

function jobTable(rows, empty, { showClient = true } = {}) {
  if (!rows.length) return html`<p class="muted">${empty}</p>`;
  return html`<div class="tablewrap"><table>
  <thead><tr><th>Project</th>${showClient ? html`<th>Client</th>` : ''}<th>Status</th><th>Scheduled</th><th class="num">Contract</th><th class="num">Balance</th></tr></thead>
  <tbody>${rows.map((j) => html`<tr data-href="/jobs/${j.id}">
    <td><a href="/jobs/${j.id}">${j.project_name}</a></td>
    ${showClient ? html`<td>${j.client_name}</td>` : ''}
    <td>${badge(j.status, JOB_STATUS)}</td><td>${j.scheduled_date || html`<span class="muted">—</span>`}</td>
    <td class="num">${fmt(j.contract_cents)}</td><td class="num">${fmt(j.balance_cents)}</td></tr>`)}
  </tbody></table></div>`;
}

// ---------- Clients ----------
function clientsPage({ clients, q }) {
  return layout('Clients', html`
  <div class="spread"><h1>Clients</h1><a class="btn" href="/clients/new">New Client</a></div>
  <form method="get" action="/clients" class="row" style="margin-bottom:12px">
    <input name="q" value="${q}" placeholder="Search by name" style="flex:1;min-width:180px" aria-label="Search by name">
    <button type="submit" class="secondary">Search</button>${q ? html` <a href="/clients">Clear</a>` : ''}
  </form>
  ${clients.length ? html`<div class="tablewrap"><table>
    <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Property address</th></tr></thead>
    <tbody>${clients.map((c) => html`<tr data-href="/clients/${c.id}"><td><a href="/clients/${c.id}">${c.name}</a></td>
      <td>${c.phone}</td><td>${c.email}</td><td>${c.address}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">${q ? 'No clients match that name.' : 'No clients yet.'}</p>`}`);
}

function clientFields(values, errors, prefix = '') {
  const v = {}; const er = {};
  for (const k of ['name', 'phone', 'email', 'address']) { v[prefix + k] = values[prefix + k]; er[prefix + k] = errors[prefix + k]; }
  return html`
    ${input(prefix + 'name', 'Name', v, er, { required: true })}
    <div class="two"><div>${input(prefix + 'phone', 'Phone', v, er, { type: 'tel' })}</div>
    <div>${input(prefix + 'email', 'Email', v, er, { type: 'email' })}</div></div>
    ${input(prefix + 'address', 'Property address', v, er)}`;
}

function clientFormPage({ client, values, errors = {} }) {
  const action = client ? `/clients/${client.id}` : '/clients';
  return layout(client ? 'Edit client' : 'New client', html`
  <h1>${client ? 'Edit client' : 'New client'}</h1>
  ${errorBox(errors)}
  <form method="post" action="${action}" class="card" novalidate>
    ${clientFields(values, errors)}
    <p class="row"><button type="submit">Save client</button>
    <a class="btn secondary" href="${client ? `/clients/${client.id}` : '/clients'}">Cancel</a></p>
  </form>`);
}

function clientPage({ client, estimates, jobs, flash }) {
  return layout(client.name, html`
  <div class="spread"><h1>${client.name}</h1>
    <div class="row"><a class="btn secondary" href="/clients/${client.id}/edit">Edit client</a>
    <a class="btn secondary" href="/clients/${client.id}/delete">Delete</a>
    <a class="btn" href="/estimates/new?client_id=${client.id}">New Estimate</a></div></div>
  <div class="card two">
    <div><label>Phone</label>${client.phone || html`<span class="muted">—</span>`}</div>
    <div><label>Email</label>${client.email ? html`<a href="mailto:${client.email}">${client.email}</a>` : html`<span class="muted">—</span>`}</div>
    <div><label>Property address</label>${client.address || html`<span class="muted">—</span>`}</div>
  </div>
  <h2>Estimates</h2>${estimateTable(estimates, 'No estimates for this client.', { showClient: false })}
  <h2>Jobs</h2>${jobTable(jobs, 'No jobs for this client.', { showClient: false })}`, { flash });
}

// ---------- Estimates ----------
function estimatesPage({ estimates, status }) {
  const tabs = [['', 'All'], ...Object.entries(ESTIMATE_STATUS)];
  return layout('Estimates', html`
  <div class="spread"><h1>Estimates</h1><a class="btn" href="/estimates/new">New Estimate</a></div>
  <p class="row">${tabs.map(([k, label]) => (k === status ? html`<strong>${label}</strong>` : html`<a href="/estimates${k ? `?status=${k}` : ''}">${label}</a>`))}</p>
  ${estimateTable(estimates, 'No estimates.')}`);
}

function estimateFormPage({ estimate, values, items, errors = {}, clients }) {
  const action = estimate ? `/estimates/${estimate.id}` : '/estimates';
  const rows = items;
  // Always offer a couple of blank rows so the form works without JavaScript too.
  const blanks = rows.length ? 1 : 3;
  const all = [...rows, ...Array.from({ length: blanks }, () => ({ desc: '', qty: '', price: '' }))];
  const isNewClient = values.client_id === 'new' || (!values.client_id && !clients.length);
  return layout(estimate ? 'Edit estimate' : 'New estimate', html`
  <h1>${estimate ? `Edit estimate: ${estimate.project_name}` : 'New estimate'}</h1>
  ${errorBox(errors)}
  <form method="post" action="${action}" id="estimate-form" novalidate>
    <div class="card">
      <label for="client_id">Client *</label>
      <select id="client_id" name="client_id" class="${inv(errors, 'client_id')}">
        <option value="">Choose a client…</option>
        <option value="new" ${isNewClient ? raw('selected') : ''}>+ New client</option>
        ${clients.map((c) => html`<option value="${c.id}" ${String(values.client_id) === String(c.id) ? raw('selected') : ''}>${c.name}</option>`)}
      </select>${fieldErr(errors, 'client_id')}
      <div id="new-client" style="${isNewClient ? '' : 'display:none'}">
        <p class="muted" style="margin:10px 0 0">New client details</p>
        ${clientFields(values, errors, 'new_')}
      </div>
    </div>
    <div class="card">
      ${input('project_name', 'Project name', values, errors, { required: true })}
      ${textarea('scope', 'Scope of work', values, errors)}
      <label for="status">Status</label>
      <select id="status" name="status">${Object.entries(ESTIMATE_STATUS).map(([k, l]) =>
        html`<option value="${k}" ${values.status === k ? raw('selected') : ''}>${l}</option>`)}</select>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Line items</h2>
      ${fieldErr(errors, 'items')}
      <div class="tablewrap"><table class="items">
        <thead><tr><th style="width:50%">Description</th><th>Quantity</th><th>Unit price ($)</th><th class="num">Line total</th><th></th></tr></thead>
        <tbody id="items">${all.map((it, i) => itemRow(it, errors[`item_${i}`]))}</tbody>
      </table></div>
      <p><button type="button" class="secondary" id="add-item">+ Add line item</button></p>
      <div class="two">
        <div>${input('estimated_cost', 'Internal estimated cost ($)', values, errors, { inputmode: 'decimal', placeholder: '0.00' })}
          <div class="muted" style="font-size:.85rem">Your expected cost for the whole project. Never shown to the client.</div></div>
        <div>
          <label>Estimate total</label><div style="font-size:1.25rem;font-weight:700" id="calc-total">—</div>
          <label>Estimated profit</label><div style="font-size:1.1rem" id="calc-profit">—</div>
          <div class="muted" style="font-size:.85rem">Preview only; the saved totals are calculated by the server.</div>
        </div>
      </div>
    </div>
    <p class="row"><button type="submit">Save estimate</button>
      <a class="btn secondary" href="${estimate ? `/estimates/${estimate.id}` : '/'}">Cancel</a></p>
  </form>
  <template id="item-template">${itemRow({ desc: '', qty: '', price: '' })}</template>
  <script>${raw(ESTIMATE_JS)}</script>`);
}

function itemRow(it, err) {
  return html`<tr class="item">
    <td><input name="item_desc" value="${it.desc}" aria-label="Description" placeholder="Description" class="${err ? 'invalid' : ''}">${err ? html`<div class="field-error">${err}</div>` : ''}</td>
    <td><input name="item_qty" value="${it.qty}" inputmode="decimal" aria-label="Quantity" placeholder="Qty"></td>
    <td><input name="item_price" value="${it.price}" inputmode="decimal" aria-label="Unit price" placeholder="Unit price $"></td>
    <td class="num line-total">—</td>
    <td><button type="button" class="link remove-item">Remove</button></td></tr>`;
}

// Client-side preview of totals, using integer cents like the server.
const ESTIMATE_JS = `
(function () {
  var tbody = document.getElementById('items');
  function cents(s, maxDp) {
    s = String(s || '').replace(/[$,\\s]/g, '');
    if (!/^\\d+(\\.\\d{1,2})?$/.test(s)) return null;
    var p = s.split('.'); return Number(p[0]) * 100 + Number((p[1] || '').padEnd(2, '0'));
  }
  function fmt(c) {
    var neg = c < 0; c = Math.abs(c);
    return (neg ? '-' : '') + '$' + Math.floor(c / 100).toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',') + '.' + String(c % 100).padStart(2, '0');
  }
  function recalc() {
    var total = 0, ok = true;
    tbody.querySelectorAll('tr.item').forEach(function (tr) {
      var q = cents(tr.querySelector('[name=item_qty]').value), p = cents(tr.querySelector('[name=item_price]').value);
      var cell = tr.querySelector('.line-total');
      if (q === null || p === null) { cell.textContent = '—'; return; }
      var lt = Math.floor((q * p + 50) / 100); total += lt; cell.textContent = fmt(lt);
    });
    document.getElementById('calc-total').textContent = fmt(total);
    var cost = cents(document.getElementById('estimated_cost').value);
    document.getElementById('calc-profit').textContent = cost === null ? 'Enter an estimated cost' : fmt(total - cost);
  }
  document.getElementById('add-item').addEventListener('click', function () {
    tbody.insertAdjacentHTML('beforeend', document.getElementById('item-template').innerHTML);
    tbody.lastElementChild.querySelector('input').focus();
  });
  tbody.addEventListener('click', function (e) {
    if (!e.target.classList.contains('remove-item')) return;
    var tr = e.target.closest('tr');
    var filled = Array.prototype.some.call(tr.querySelectorAll('input'), function (i) { return i.value.trim(); });
    if (filled && !confirm('Remove this line item?')) return;
    tr.remove(); recalc();
  });
  document.getElementById('estimate-form').addEventListener('input', recalc);
  var sel = document.getElementById('client_id');
  sel.addEventListener('change', function () { document.getElementById('new-client').style.display = sel.value === 'new' ? '' : 'none'; });
  recalc();
})();`;

function estimatePage({ estimate, client, items, totalCents, job, flash, errors }) {
  const locked = !!job;
  const profit = estimate.estimated_cost_cents == null ? null : totalCents - estimate.estimated_cost_cents;
  const statusButtons = Object.entries(ESTIMATE_STATUS).filter(([k]) => k !== estimate.status);
  return layout(estimate.project_name, html`
  <div class="spread"><h1>${estimate.project_name} ${badge(estimate.status, ESTIMATE_STATUS)}</h1>
    ${locked ? '' : html`<div class="row"><a class="btn secondary" href="/estimates/${estimate.id}/edit">Edit estimate</a>
      <a class="btn secondary" href="/estimates/${estimate.id}/delete">Delete</a></div>`}</div>
  ${errorBox(errors)}
  ${locked ? html`<div class="notice">Converted to <a href="/jobs/${job.id}">a job</a>. This estimate is locked and can no longer be edited.</div>` : ''}
  <div class="card two">
    <div><label>Client</label><a href="/clients/${client.id}">${client.name}</a></div>
    <div><label>Property address</label>${client.address || html`<span class="muted">—</span>`}</div>
  </div>
  <div class="card"><label style="margin-top:0">Scope of work</label><div class="pre">${estimate.scope || html`<span class="muted">—</span>`}</div></div>
  <div class="tablewrap"><table>
    <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Line total</th></tr></thead>
    <tbody>${items.map((i) => html`<tr><td>${i.description}</td><td class="num">${fmtQty(i.qty_hundredths)}</td>
      <td class="num">${fmt(i.unit_price_cents)}</td><td class="num">${fmt(i.line_total_cents)}</td></tr>`)}
    <tr><th colspan="3" class="num">Estimate total</th><th class="num" id="estimate-total">${fmt(totalCents)}</th></tr></tbody>
  </table></div>
  <div class="grid" style="margin:16px 0">
    <div class="stat"><div class="k">Estimate total</div><div class="v">${fmt(totalCents)}</div></div>
    <div class="stat"><div class="k">Internal estimated cost</div><div class="v">${fmt(estimate.estimated_cost_cents)}</div></div>
    <div class="stat"><div class="k">Estimated profit</div><div class="v" id="estimated-profit">${profit == null ? '—' : fmt(profit)}</div></div>
  </div>
  ${locked ? '' : html`
  <div class="card">
    <div class="row"><span class="muted">Change status:</span>
    ${statusButtons.map(([k, l]) => html`<form method="post" action="/estimates/${estimate.id}/status" style="display:inline">
      <input type="hidden" name="status" value="${k}"><button type="submit" class="secondary">Mark ${l.toLowerCase()}</button></form>`)}</div>
    ${estimate.status === 'approved' ? html`
    <form method="post" action="/estimates/${estimate.id}/convert" style="margin-top:12px"
      data-confirm="Convert this estimate to a job? The estimate will be locked.">
      <button type="submit" id="convert">Convert to job</button>
    </form>` : html`<p class="muted" style="margin-bottom:0">Mark the estimate approved to convert it to a job.</p>`}
  </div>`}`, { flash });
}

// ---------- Jobs ----------
function jobsPage({ jobs, status }) {
  const tabs = [['', 'All'], ...Object.entries(JOB_STATUS)];
  return layout('Jobs', html`<h1>Jobs</h1>
  <p class="row">${tabs.map(([k, label]) => (k === status ? html`<strong>${label}</strong>` : html`<a href="/jobs${k ? `?status=${k}` : ''}">${label}</a>`))}</p>
  ${jobTable(jobs, 'No jobs.')}`);
}

function jobPage({ job, client, expenses, payments, crew = [], members = [], forms = {}, flash }) {
  const af = forms.assign || { values: {}, errors: {} };
  const jf = forms.job || { values: { status: job.status, scheduled_date: job.scheduled_date || '', notes: job.notes }, errors: {} };
  const ef = forms.expense || { values: {}, errors: {} };
  const pf = forms.payment || { values: { paid_on: new Date().toISOString().slice(0, 10) }, errors: {} };
  const final = job.status === 'completed';
  return layout(job.project_name, html`
  <div class="spread"><h1>${job.project_name} ${badge(job.status, JOB_STATUS)}</h1>
    <a href="/estimates/${job.estimate_id}">View original estimate</a></div>
  ${errorBox({ ...jf.errors, ...ef.errors, ...pf.errors, ...af.errors })}
  <div class="card two">
    <div><label>Client</label><a href="/clients/${client.id}">${client.name}</a></div>
    <div><label>Job address</label>${job.address || html`<span class="muted">—</span>`}</div>
    <div style="grid-column:1/-1"><label>Scope of work</label><div class="pre">${job.scope || html`<span class="muted">—</span>`}</div></div>
  </div>
  <div class="grid" style="margin-bottom:16px" id="job-summary">
    <div class="stat"><div class="k">Contract total</div><div class="v" data-k="contract">${fmt(job.contract_cents)}</div></div>
    <div class="stat"><div class="k">Total expenses</div><div class="v" data-k="expenses">${fmt(job.expenses_cents)}</div></div>
    <div class="stat"><div class="k">Worker payouts</div><div class="v" data-k="payouts">${fmt(job.payouts_cents)}</div></div>
    <div class="stat"><div class="k">Payments received</div><div class="v" data-k="payments">${fmt(job.payments_cents)}</div></div>
    <div class="stat"><div class="k">Outstanding balance</div><div class="v" data-k="balance">${fmt(job.balance_cents)}</div></div>
    <div class="stat"><div class="k">Gross profit ${final ? '(final)' : html`<strong>(provisional)</strong>`}</div>
      <div class="v" data-k="profit">${fmt(job.gross_profit_cents)}</div>
      <div class="muted" style="font-size:.8rem">Contract − expenses − worker payouts.${final ? '' : ' Provisional until the job is completed.'}</div></div>
  </div>

  <form method="post" action="/jobs/${job.id}" class="card" novalidate>
    <h2 style="margin-top:0">Job details</h2>
    <div class="two">
      <div><label for="status">Status</label><select id="status" name="status">${Object.entries(JOB_STATUS).map(([k, l]) =>
        html`<option value="${k}" ${jf.values.status === k ? raw('selected') : ''}>${l}</option>`)}</select></div>
      <div>${input('scheduled_date', 'Scheduled date (optional)', jf.values, jf.errors, { type: 'date' })}</div>
    </div>
    ${textarea('notes', 'Notes', jf.values, jf.errors)}
    <p><button type="submit">Save job details</button></p>
  </form>

  <h2>Workers and payouts</h2>
  <p class="muted">What each person will be paid for this job. Workers see only jobs they are assigned to, and only their own pay.
    Records only; nothing is paid through this app.</p>
  ${crew.length ? html`<div class="tablewrap"><table><thead><tr><th>Person</th><th class="num">Payout</th><th></th></tr></thead>
  <tbody>${crew.map((c) => html`<tr><td>${c.email}${c.role === 'removed' ? html` <span class="muted">(no longer on team)</span>` : ''}</td>
    <td class="num">${fmt(c.payout_cents)}</td>
    <td class="num"><a href="/jobs/${job.id}/assignments/remove?user_id=${c.user_id}">Remove</a></td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">Nobody assigned yet.</p>`}
  ${members.length ? html`<form method="post" action="/jobs/${job.id}/assignments" class="card" novalidate>
    <div class="two"><div><label for="assign_user">Person</label>
      <select id="assign_user" name="user_id" class="${inv(af.errors, 'user_id')}">
        <option value="">Choose…</option>${members.map((m) => html`<option value="${m.user_id}" ${af.values.user_id === m.user_id ? raw('selected') : ''}>${m.email} (${ROLES[m.role]})</option>`)}
      </select>${fieldErr(af.errors, 'user_id')}</div>
    <div>${input('payout', 'Payout ($)', af.values, af.errors, { required: true, inputmode: 'decimal' })}</div></div>
    <p><button type="submit">Assign / update payout</button></p>
  </form>` : ''}

  <h2>Expenses</h2>
  ${moneyTable(expenses, 'expenses', (e) => html`<td>${e.description}</td>`, html`<th>Description</th>`, 'No expenses recorded.')}
  <form method="post" action="/jobs/${job.id}/expenses" class="card" novalidate>
    <div class="two"><div>${input('description', 'Expense description', ef.values, ef.errors, { required: true })}</div>
    <div>${input('amount', 'Amount ($)', ef.values, ef.errors, { required: true, inputmode: 'decimal' })}</div></div>
    <p><button type="submit">Add expense</button></p>
  </form>

  <h2>Payments received</h2>
  <p class="muted">Manual records only. No money is processed by this app.</p>
  ${moneyTable(payments, 'payments', (p) => html`<td>${p.paid_on}</td>`, html`<th>Date received</th>`, 'No payments recorded.')}
  <form method="post" action="/jobs/${job.id}/payments" class="card" novalidate>
    <div class="two"><div>${input('payment_amount', 'Amount ($)', pf.values, pf.errors, { required: true, inputmode: 'decimal' })}</div>
    <div>${input('paid_on', 'Date received', pf.values, pf.errors, { type: 'date', required: true })}</div></div>
    <p><button type="submit">Record payment</button></p>
  </form>`, { flash });
}

function moneyTable(rows, kind, firstCell, firstHead, empty) {
  if (!rows.length) return html`<p class="muted">${empty}</p>`;
  return html`<div class="tablewrap"><table><thead><tr>${firstHead}<th class="num">Amount</th><th></th></tr></thead>
  <tbody>${rows.map((r) => html`<tr>${firstCell(r)}<td class="num">${fmt(r.amount_cents)}</td>
    <td class="num"><a href="/${kind}/${r.id}/edit">Edit</a> · <a href="/${kind}/${r.id}/delete">Delete</a></td></tr>`)}</tbody></table></div>`;
}

function entryFormPage({ kind, entry, job, values, errors = {} }) {
  const isExpense = kind === 'expenses';
  return layout(isExpense ? 'Edit expense' : 'Edit payment', html`
  <h1>${isExpense ? 'Edit expense' : 'Edit payment'}</h1>
  <p>Job: <a href="/jobs/${job.id}">${job.project_name}</a></p>
  ${errorBox(errors)}
  <form method="post" action="/${kind}/${entry.id}" class="card" novalidate>
    ${isExpense ? input('description', 'Description', values, errors, { required: true }) : ''}
    ${input('amount', 'Amount ($)', values, errors, { required: true, inputmode: 'decimal' })}
    ${isExpense ? '' : input('paid_on', 'Date received', values, errors, { type: 'date', required: true })}
    <p class="row"><button type="submit">Save</button><a class="btn secondary" href="/jobs/${job.id}">Cancel</a></p>
  </form>`);
}

function confirmDeletePage({ kind, entry, job }) {
  const what = kind === 'expenses'
    ? html`the expense <strong>${entry.description}</strong> (${fmt(entry.amount_cents)})`
    : html`the payment of <strong>${fmt(entry.amount_cents)}</strong> received ${entry.paid_on}`;
  return layout('Confirm delete', html`
  <div class="card" style="max-width:520px">
    <h1>Delete this entry?</h1>
    <p>You are about to permanently delete ${what} from <a href="/jobs/${job.id}">${job.project_name}</a>.</p>
    <form method="post" action="/${kind}/${entry.id}/delete" class="row">
      <button type="submit" class="danger">Yes, delete it</button>
      <a class="btn secondary" href="/jobs/${job.id}">Cancel</a>
    </form>
  </div>`);
}

function messagePage(title, message, status) {
  return layout(title, html`<div class="card"><h1>${title}</h1><p>${message}</p><p><a href="/">Back to home</a></p></div>`);
}

module.exports = {
  ESTIMATE_STATUS, JOB_STATUS, nav, schedulePage, scheduleJobPage, confirmPage, loginPage, signupPage, orgNewPage, teamPage, homePage, clientsPage, clientFormPage, clientPage,
  estimatesPage, estimateFormPage, estimatePage, jobsPage, jobPage, entryFormPage, confirmDeletePage, messagePage,
};
