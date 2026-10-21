const SCALE_DIGITS = 12;
const SCALE = 10n ** BigInt(SCALE_DIGITS);

function expandScientific(raw) {
  const text = String(raw ?? '0').trim();
  if (!/[eE]/.test(text)) return text || '0';

  const match = text.match(/^([+-]?)(\d*)(?:\.(\d*))?[eE]([+-]?\d+)$/);
  if (!match) return '0';

  const sign = match[1] === '-' ? '-' : '';
  const integer = match[2] || '0';
  const fraction = match[3] || '';
  const exponent = Number(match[4] || 0);
  const digits = `${integer}${fraction}` || '0';
  const decimalIndex = integer.length + exponent;

  let body;
  if (decimalIndex <= 0) body = `0.${'0'.repeat(-decimalIndex)}${digits}`;
  else if (decimalIndex >= digits.length) body = `${digits}${'0'.repeat(decimalIndex - digits.length)}`;
  else body = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;

  body = body.replace(/^0+(?=\d)/, '');
  if (body.startsWith('.')) body = `0${body}`;
  return sign + (body || '0');
}

function roundDiv(numerator, denominator) {
  if (denominator === 0n) return 0n;
  const negative = (numerator < 0n) !== (denominator < 0n);
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  let quotient = a / b;
  if ((a % b) * 2n >= b) quotient += 1n;
  return negative ? -quotient : quotient;
}

export function toFinancialInt(value) {
  if (typeof value === 'bigint') return value;
  const expanded = expandScientific(value);
  const negative = expanded.startsWith('-');
  const body = negative || expanded.startsWith('+') ? expanded.slice(1) : expanded;
  const [integerRaw = '0', fractionRaw = ''] = body.split('.');
  const integer = integerRaw.replace(/\D/g, '') || '0';
  const fractionDigits = fractionRaw.replace(/\D/g, '');
  const kept = fractionDigits.slice(0, SCALE_DIGITS).padEnd(SCALE_DIGITS, '0');
  let scaled = BigInt(integer) * SCALE + BigInt(kept || '0');
  const nextDigit = fractionDigits[SCALE_DIGITS];
  if (nextDigit && Number(nextDigit) >= 5) scaled += 1n;
  return negative ? -scaled : scaled;
}

export function financialString(value) {
  const scaled = typeof value === 'bigint' ? value : toFinancialInt(value);
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const raw = abs.toString().padStart(SCALE_DIGITS + 1, '0');
  const whole = raw.slice(0, -SCALE_DIGITS) || '0';
  const fraction = raw.slice(-SCALE_DIGITS).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export function financialNumber(value) {
  return Number(financialString(value));
}

export function financialIntAdd(a, b) { return a + b; }
export function financialIntSub(a, b) { return a - b; }
export function financialIntMax(a, b) { return a >= b ? a : b; }
export function financialIntMul(a, b) { return roundDiv(a * b, SCALE); }
export function financialIntDiv(a, b) { return b === 0n ? null : roundDiv(a * SCALE, b); }
export function financialIntProportion(amount, part, total) { return total === 0n ? 0n : roundDiv(amount * part, total); }
export function financialIntSign(value) { return value > 0n ? 1 : value < 0n ? -1 : 0; }

export function financialAdd(a, b) {
  return financialNumber(toFinancialInt(a) + toFinancialInt(b));
}
export function financialSub(a, b) {
  return financialNumber(toFinancialInt(a) - toFinancialInt(b));
}
export function financialMul(a, b) {
  return financialNumber(roundDiv(toFinancialInt(a) * toFinancialInt(b), SCALE));
}
export function financialDiv(a, b) {
  const denominator = toFinancialInt(b);
  if (denominator === 0n) return null;
  return financialNumber(roundDiv(toFinancialInt(a) * SCALE, denominator));
}
export function financialSum(values) {
  return financialNumber((values || []).reduce((sum, value) => sum + toFinancialInt(value), 0n));
}
export function financialAbs(value) {
  const scaled = toFinancialInt(value);
  return financialNumber(scaled < 0n ? -scaled : scaled);
}
export function financialSign(value) {
  const scaled = toFinancialInt(value);
  return scaled > 0n ? 1 : scaled < 0n ? -1 : 0;
}
export function financialMax(a, b) {
  return toFinancialInt(a) >= toFinancialInt(b) ? financialNumber(a) : financialNumber(b);
}
export function financialProportion(amount, part, total) {
  const totalInt = toFinancialInt(total);
  if (totalInt === 0n) return 0;
  return financialNumber(roundDiv(toFinancialInt(amount) * toFinancialInt(part), totalInt));
}
export function weightedAveragePrice(currentAverage, currentQuantity, addedPrice, addedQuantity) {
  const currentQty = toFinancialInt(currentQuantity);
  const addQty = toFinancialInt(addedQuantity);
  const nextQty = currentQty + addQty;
  if (nextQty <= 0n) return 0;
  const currentValue = roundDiv(toFinancialInt(currentAverage) * currentQty, SCALE);
  const addedValue = roundDiv(toFinancialInt(addedPrice) * addQty, SCALE);
  return financialNumber(roundDiv((currentValue + addedValue) * SCALE, nextQty));
}
export function grossPnlForExit(side, entryPrice, exitPrice, quantity) {
  const diff = String(side || '').toUpperCase() === 'SHORT'
    ? toFinancialInt(entryPrice) - toFinancialInt(exitPrice)
    : toFinancialInt(exitPrice) - toFinancialInt(entryPrice);
  return financialNumber(roundDiv(diff * toFinancialInt(quantity), SCALE));
}
export function financialPercent(numerator, denominator) {
  const den = toFinancialInt(denominator);
  if (den === 0n) return null;
  return financialNumber(roundDiv(toFinancialInt(numerator) * 100n * SCALE, den));
}
