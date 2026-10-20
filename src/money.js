'use strict';
// All money is stored as integer cents. Quantities are stored as integer hundredths
// (1.5 hours -> 150). No floating point is used for stored values or totals.

const MAX_CENTS = 100_000_000_00; // $100,000,000.00 per entered amount
const MAX_QTY_HUNDREDTHS = 1_000_000_00; // 1,000,000 units

function parseDecimal(input, label, { required = true, allowZero = true, max }) {
  const s = String(input ?? '').trim().replace(/[$,\s]/g, '');
  if (s === '') return required ? { error: `${label} is required.` } : { value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    return { error: `${label} must be a number with at most 2 decimal places (e.g. 1250 or 1250.50).` };
  }
  const [whole, frac = ''] = s.split('.');
  if (whole.length > 12) return { error: `${label} is too large.` };
  const value = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!allowZero && value === 0) return { error: `${label} must be greater than zero.` };
  if (value > max) return { error: `${label} is too large.` };
  return { value };
}

const parseMoney = (input, label, opts = {}) => parseDecimal(input, label, { max: MAX_CENTS, ...opts });
const parseQty = (input, label) =>
  parseDecimal(input, label, { allowZero: false, max: MAX_QTY_HUNDREDTHS });

// quantity (hundredths) x unit price (cents) -> cents, rounded half up. BigInt avoids overflow.
function lineTotal(qtyHundredths, unitPriceCents) {
  return Number((BigInt(qtyHundredths) * BigInt(unitPriceCents) + 50n) / 100n);
}

function plain(hundredths) {
  const neg = hundredths < 0;
  const abs = Math.abs(hundredths);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// 123456 -> "$1,234.56"
function fmt(cents) {
  if (cents == null) return '—';
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

// 150 -> "1.5", 200 -> "2"
function fmtQty(hundredths) {
  return plain(hundredths).replace(/\.?0+$/, '');
}

module.exports = { parseMoney, parseQty, lineTotal, fmt, fmtQty, plain };
