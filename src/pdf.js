'use strict';
// Customer-facing estimate PDFs and work orders for subcontractors, built with PDFKit.
const PDFDocument = require('pdfkit');
const { fmt, fmtQty } = require('./money');

const ACCENT = '#4f46e5';
const INK = '#0f172a';
const MUTED = '#64748b';
const LINE = '#e2e8f0';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (d) => {
  if (!d) return '';
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  return `${MONTHS[m - 1]} ${day}, ${y}`;
};

function render(build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 54, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try { build(doc); } catch (e) { reject(e); return; }
    // Page numbers once everything is laid out.
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // writing inside the bottom margin must not start a new page
      doc.font('Helvetica').fontSize(8).fillColor(MUTED)
        .text(`Page ${i + 1} of ${range.count}`, 54, doc.page.height - 40, { width: doc.page.width - 108, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

const width = (doc) => doc.page.width - doc.page.margins.left - doc.page.margins.right;
function ensureSpace(doc, h) {
  if (doc.y + h > doc.page.height - doc.page.margins.bottom - 20) doc.addPage();
}

// Logo and company details on the left, document title and number on the right.
function header(doc, { company, title, number, dateLabel, date }) {
  const left = doc.page.margins.left;
  const top = doc.page.margins.top;
  let y = top;
  if (company.logo) {
    try {
      doc.image(company.logo, left, y, { fit: [170, 64] });
      y += 74;
    } catch { /* unreadable image: fall back to the name */ }
  }
  doc.font('Helvetica-Bold').fontSize(14).fillColor(INK).text(company.name, left, y, { width: 280 });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  const lines = [company.address, [company.phone, company.email].filter(Boolean).join('  ·  '), company.website,
    company.license_number ? `License #${company.license_number}` : ''].filter(Boolean);
  for (const l of lines) doc.text(l, { width: 280 });
  const leftBottom = doc.y;

  const rx = left + width(doc) - 220;
  doc.font('Helvetica-Bold').fontSize(24).fillColor(ACCENT).text(title, rx, top, { width: 220, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor(INK).text(`No. ${number}`, rx, doc.y + 2, { width: 220, align: 'right' });
  doc.fillColor(MUTED).text(`${dateLabel}: ${longDate(date)}`, rx, doc.y, { width: 220, align: 'right' });

  doc.y = Math.max(leftBottom, doc.y) + 18;
  doc.moveTo(left, doc.y).lineTo(left + width(doc), doc.y).lineWidth(1).strokeColor(LINE).stroke();
  doc.y += 16;
}

function label(doc, text, x, y, w) {
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(text.toUpperCase(), x, y, { width: w, characterSpacing: 0.8 });
}

// Two side-by-side info blocks: [[label, [lines]], ...]
function infoColumns(doc, cols) {
  const left = doc.page.margins.left;
  const colW = (width(doc) - 24) / cols.length;
  const top = doc.y;
  let bottom = top;
  cols.forEach(([title, lines], i) => {
    const x = left + i * (colW + 24);
    label(doc, title, x, top, colW);
    doc.font('Helvetica').fontSize(10.5).fillColor(INK);
    lines.filter(Boolean).forEach((l, j) => {
      doc.font(j === 0 ? 'Helvetica-Bold' : 'Helvetica').text(l, x, doc.y + (j === 0 ? 4 : 1), { width: colW });
    });
    bottom = Math.max(bottom, doc.y);
  });
  doc.y = bottom + 20;
}

function section(doc, title, body) {
  if (!body || !String(body).trim()) return;
  ensureSpace(doc, 50);
  const left = doc.page.margins.left;
  label(doc, title, left, doc.y, width(doc));
  doc.font('Helvetica').fontSize(10.5).fillColor(INK).text(String(body).trim(), left, doc.y + 4, { width: width(doc), lineGap: 2 });
  doc.y += 18;
}

function estimatePdf({ company, estimate, client, items, totalCents, options = [] }) {
  return render((doc) => {
    header(doc, { company, title: 'ESTIMATE', number: `E-${estimate.id}`, dateLabel: 'Date', date: estimate.updated_at });
    infoColumns(doc, [
      ['Prepared for', [client.name, estimate.address || client.address, client.phone, client.email]],
      ['Project', [estimate.project_name]],
    ]);
    section(doc, 'Scope of work', estimate.scope);

    // Line items table
    const left = doc.page.margins.left;
    const w = width(doc);
    const cols = [{ t: 'Description', w: w - 250, a: 'left' }, { t: 'Qty', w: 60, a: 'right' }, { t: 'Unit price', w: 90, a: 'right' }, { t: 'Amount', w: 100, a: 'right' }];
    const row = (vals, { bold = false, fill } = {}) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
      const h = Math.max(...vals.map((v, i) => doc.heightOfString(v, { width: cols[i].w - 16 }))) + 14;
      ensureSpace(doc, h);
      const y = doc.y;
      if (fill) doc.rect(left, y, w, h).fill(fill);
      let x = left;
      vals.forEach((v, i) => {
        doc.fillColor(INK).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10)
          .text(v, x + 8, y + 7, { width: cols[i].w - 16, align: cols[i].a });
        x += cols[i].w;
      });
      doc.y = y + h;
    };
    ensureSpace(doc, 60);
    const hy = doc.y;
    doc.rect(left, hy, w, 24).fill(ACCENT);
    let x = left;
    for (const c of cols) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff').text(c.t.toUpperCase(), x + 8, hy + 8, { width: c.w - 16, align: c.a, characterSpacing: 0.5 });
      x += c.w;
    }
    doc.y = hy + 24;
    // With options: shared lines, then each option (only the chosen one once the client has picked).
    const chosen = estimate.chosen_option;
    const shared = items.filter((it) => !it.option_name);
    const groups = options.filter((o) => !chosen || o.name === chosen)
      .map((o) => ({ ...o, items: items.filter((it) => it.option_name === o.name) }));
    const heading = (text, amount) => row([text, '', '', amount], { bold: true, fill: '#eef0ff' });
    if (groups.length && shared.length) heading(chosen ? 'Included' : 'Included in every option', '');
    shared.forEach((it, i) => row([it.description, fmtQty(it.qty_hundredths), fmt(it.unit_price_cents), fmt(it.line_total_cents)],
      { fill: i % 2 ? '#f8fafc' : undefined }));
    for (const g of groups) {
      heading(`Option: ${g.name}`, chosen ? '' : `Total ${fmt(g.total)}`);
      g.items.forEach((it, i) => row([it.description, fmtQty(it.qty_hundredths), fmt(it.unit_price_cents), fmt(it.line_total_cents)],
        { fill: i % 2 ? '#f8fafc' : undefined }));
    }
    doc.moveTo(left, doc.y).lineTo(left + w, doc.y).lineWidth(1).strokeColor(LINE).stroke();

    const totalsList = groups.length > 1 ? groups.map((g) => [`${g.name} total`, g.total]) : [[chosen ? `Total (${chosen})` : 'Total', totalCents]];
    for (const [lbl, amt] of totalsList) {
      ensureSpace(doc, 50);
      const ty = doc.y + 12;
      doc.roundedRect(left + w - 260, ty, 260, 40, 6).fill('#eef0ff');
      doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(lbl, left + w - 248, ty + 14, { width: 130 });
      doc.fontSize(15).fillColor(ACCENT).text(fmt(amt), left + w - 248, ty + 11, { width: 236, align: 'right' });
      doc.y = ty + 44;
    }
    if (estimate.deposit_percent) {
      doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(`A ${estimate.deposit_percent}% deposit is due at approval.`, left, doc.y + 6, { width: w, align: 'right' });
    }
    doc.y += 20;

    section(doc, 'Terms', company.estimate_terms);
    ensureSpace(doc, 70);
    doc.y += 10;
    const sy = doc.y + 30;
    doc.moveTo(left, sy).lineTo(left + 220, sy).moveTo(left + w - 160, sy).lineTo(left + w, sy).lineWidth(0.8).strokeColor(MUTED).stroke();
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text('Customer acceptance', left, sy + 4).text('Date', left + w - 160, sy + 4);
    doc.y = sy + 30;
    doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(`Thank you for considering ${company.name}.`, left, doc.y, { width: w, align: 'center' });
  });
}

function workOrderPdf({ company, job, client, assignee }) {
  return render((doc) => {
    header(doc, { company, title: 'WORK ORDER', number: `WO-${job.id}`, dateLabel: 'Issued', date: new Date().toISOString() });
    const dates = job.start_date
      ? (job.end_date && job.end_date !== job.start_date ? `${longDate(job.start_date)} to ${longDate(job.end_date)}` : longDate(job.start_date))
      : 'To be scheduled';
    infoColumns(doc, [
      ['Job site', [job.address || 'No address on file', `Customer: ${client.name}`, client.phone ? `Customer phone: ${client.phone}` : '']],
      ['Schedule', [dates]],
    ]);
    if (assignee) {
      infoColumns(doc, [
        ['Assigned to', [assignee.full_name || assignee.email, assignee.full_name ? assignee.email : '', assignee.phone]],
        ['Agreed pay for this job', [fmt(assignee.payout_cents)]],
      ]);
    }
    section(doc, 'Project', job.project_name);
    section(doc, 'Scope of work', job.scope);
    section(doc, 'Notes', job.notes);
    section(doc, 'Terms', company.work_order_terms);

    const left = doc.page.margins.left; const w = width(doc);
    ensureSpace(doc, 80);
    doc.y += 14;
    const sy = doc.y + 30;
    doc.moveTo(left, sy).lineTo(left + 220, sy).moveTo(left + w - 160, sy).lineTo(left + w, sy).lineWidth(0.8).strokeColor(MUTED).stroke();
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text('Work completed by', left, sy + 4).text('Date', left + w - 160, sy + 4);
  });
}

module.exports = { estimatePdf, workOrderPdf };
