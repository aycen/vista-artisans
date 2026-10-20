'use strict';
// Tiny HTML templating: interpolated values are escaped unless wrapped in raw().

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
const raw = (s) => new Raw(s);

function esc(v) {
  if (v == null || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(esc).join('');
  return String(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += esc(v) + strings[i + 1]; });
  return raw(out);
}

module.exports = { html, raw, esc };
