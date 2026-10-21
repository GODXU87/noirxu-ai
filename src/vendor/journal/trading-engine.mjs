import {
  financialIntAdd,
  financialIntDiv,
  financialIntMax,
  financialIntMul,
  financialIntProportion,
  financialIntSign,
  financialIntSub,
  financialNumber,
  financialString,
  toFinancialInt
} from './financial-math.mjs';


export function actualQuantity(market, unit, input) {
  const qty = Number(input || 0);
  if (!Number.isFinite(qty)) return 0;
  return market === 'TW' && unit === 'LOT' ? qty * 1000 : qty;
}

export function executionDisplayQuantity(execution, position) {
  const q = Number(execution.quantity || 0);
  const display = execution.quantity_display == null ? q : Number(execution.quantity_display);
  const unit = execution.quantity_unit || 'SHARE';
  if (position.market === 'TW' && unit === 'LOT') return `${trimNumber(display, 4)} 張`;
  if (position.market === 'TW') return `${trimNumber(q, 4)} 股`;
  if (position.market === 'US' || position.market === 'JP') return `${trimNumber(q, 6)} 股`;
  if (position.market === 'FX') return `${trimNumber(q, 6)} ${parseFxPair(position.symbol).base}`;
  return `${trimNumber(q, 8)} 單位`;
}

export function positionQuantityLabel(snapshot) {
  const q = Number(snapshot.openQuantity || 0);
  if (snapshot.market === 'TW') return `${trimNumber(q, 4)} 股`;
  if (snapshot.market === 'US' || snapshot.market === 'JP') return `${trimNumber(q, 6)} 股`;
  if (snapshot.market === 'FX') return `${trimNumber(q, 6)} ${parseFxPair(snapshot.symbol).base}`;
  return `${trimNumber(q, 8)} 單位`;
}

export function parseFxPair(symbol) {
  const raw = String(symbol || '').trim().toUpperCase();
  if (raw.includes('/')) {
    const [base, quote] = raw.split('/');
    if (base && quote) return { base, quote };
  }
  const clean = raw.replace(/[^A-Z]/g, '');
  if (clean.length === 6) return { base: clean.slice(0, 3), quote: clean.slice(3) };
  return { base: 'USD', quote: 'JPY' };
}

export function trimNumber(value, maximumFractionDigits = 2) {
  const n = Number(value || 0);
  return n.toLocaleString(undefined, { maximumFractionDigits });
}

function execSort(a, b) {
  const dateCompare = String(a.executed_at || '').localeCompare(String(b.executed_at || ''));
  if (dateCompare) return dateCompare;

  // V0.45: execution_sequence is resequenced by the database from the user's
  // actual execution date + time. It is therefore the canonical same-position
  // order and no longer depends on when the journal row was entered.
  const seqA = Number(a.execution_sequence);
  const seqB = Number(b.execution_sequence);
  if (Number.isFinite(seqA) && Number.isFinite(seqB) && seqA !== seqB) return seqA - seqB;

  const timeCompare = String(a.executed_time || '').localeCompare(String(b.executed_time || ''));
  if (timeCompare) return timeCompare;

  // Legacy rows created before V0.45 may not have an execution time. Keep the
  // previous deterministic fallback until the user supplies the missing time.
  const createdCompare = String(a.created_at || '').localeCompare(String(b.created_at || ''));
  if (createdCompare) return createdCompare;

  const kindCompare = (a.kind === 'ENTRY' ? 0 : 1) - (b.kind === 'ENTRY' ? 0 : 1);
  if (kindCompare) return kindCompare;

  return String(a.id || '').localeCompare(String(b.id || ''));
}

export function computePosition(position, executions) {
  const rows = [...executions].sort(execSort);

  let qty = 0n;
  let avg = 0n;
  let lastAverageEntryPrice = null;
  let entryValuePool = 0n;
  let entryCostPool = 0n;
  let realizedNet = 0n;
  let realizedGross = 0n;
  let realizedCosts = 0n;
  let realizedBasis = 0n;
  let totalFees = 0n;
  let totalTax = 0n;
  let totalEntryQty = 0n;
  let totalExitQty = 0n;
  let weightedExitValue = 0n;
  const realizedEvents = [];
  const warnings = [];

  for (const row of rows) {
    const q = toFinancialInt(row.quantity || 0);
    const price = toFinancialInt(row.price || 0);
    const rawFee = toFinancialInt(row.fee || 0);
    const rawTax = toFinancialInt(row.tax || 0);
    const fee = financialIntMax(0n, rawFee);
    const tax = financialIntMax(0n, rawTax);

    if (financialIntSign(q) <= 0 || financialIntSign(price) <= 0) {
      warnings.push(`成交資料異常：${row.id || 'unknown'}`);
      continue;
    }
    if (financialIntSign(rawFee) < 0 || financialIntSign(rawTax) < 0) {
      warnings.push(`費用不可為負數：${row.id || 'unknown'}`);
    }

    totalFees = financialIntAdd(totalFees, fee);
    totalTax = financialIntAdd(totalTax, tax);

    if (row.kind === 'ENTRY') {
      const entryValue = financialIntMul(price, q);
      entryValuePool = financialIntAdd(entryValuePool, entryValue);
      qty = financialIntAdd(qty, q);
      avg = financialIntSign(qty) > 0 ? financialIntDiv(entryValuePool, qty) : 0n;
      lastAverageEntryPrice = avg;
      entryCostPool = financialIntAdd(entryCostPool, financialIntAdd(fee, tax));
      totalEntryQty = financialIntAdd(totalEntryQty, q);
      continue;
    }

    if (row.kind === 'EXIT') {
      if (financialIntSign(financialIntSub(q, qty)) > 0) {
        warnings.push(`出場數量超過持倉：${row.id || 'unknown'}`);
        continue;
      }

      const qtyBefore = qty;
      const allocatedEntryValue = financialIntSign(qtyBefore) > 0
        ? financialIntProportion(entryValuePool, q, qtyBefore)
        : 0n;
      const allocatedEntryCosts = financialIntSign(qtyBefore) > 0
        ? financialIntProportion(entryCostPool, q, qtyBefore)
        : 0n;
      const exitValue = financialIntMul(price, q);
      const gross = position.side === 'SHORT'
        ? financialIntSub(allocatedEntryValue, exitValue)
        : financialIntSub(exitValue, allocatedEntryValue);
      const exitCosts = financialIntAdd(fee, tax);
      const eventCosts = financialIntAdd(allocatedEntryCosts, exitCosts);
      const net = financialIntSub(gross, eventCosts);

      realizedGross = financialIntAdd(realizedGross, gross);
      realizedCosts = financialIntAdd(realizedCosts, eventCosts);
      realizedNet = financialIntAdd(realizedNet, net);
      realizedBasis = financialIntAdd(realizedBasis, allocatedEntryValue);

      realizedEvents.push({
        id: row.id,
        date: row.executed_at,
        time: row.executed_time || null,
        sequence: row.execution_sequence ?? null,
        pnl: financialNumber(net),
        pnlExact: financialString(net),
        net: financialNumber(net),
        netExact: financialString(net),
        gross: financialNumber(gross),
        grossExact: financialString(gross),
        costs: financialNumber(eventCosts),
        costsExact: financialString(eventCosts),
        fee: financialNumber(fee),
        tax: financialNumber(tax),
        allocatedEntryFees: financialNumber(allocatedEntryCosts),
        allocatedEntryCosts: financialNumber(allocatedEntryCosts),
        allocatedEntryValue: financialNumber(allocatedEntryValue),
        quantity: financialNumber(q),
        price: financialNumber(price)
      });

      entryValuePool = financialIntMax(0n, financialIntSub(entryValuePool, allocatedEntryValue));
      entryCostPool = financialIntMax(0n, financialIntSub(entryCostPool, allocatedEntryCosts));
      qty = financialIntMax(0n, financialIntSub(qty, q));
      totalExitQty = financialIntAdd(totalExitQty, q);
      weightedExitValue = financialIntAdd(weightedExitValue, exitValue);

      if (financialIntSign(qty) === 0) {
        qty = 0n;
        avg = 0n;
        entryValuePool = 0n;
        entryCostPool = 0n;
      } else {
        avg = financialIntDiv(entryValuePool, qty);
      }
    }
  }

  const markPrice = position.mark_price == null || position.mark_price === '' ? null : toFinancialInt(position.mark_price);
  let unrealizedGross = null;
  if (markPrice != null && financialIntSign(qty) > 0) {
    const markValue = financialIntMul(markPrice, qty);
    unrealizedGross = position.side === 'SHORT'
      ? financialIntSub(entryValuePool, markValue)
      : financialIntSub(markValue, entryValuePool);
  }
  const unrealized = unrealizedGross == null ? null : financialIntSub(unrealizedGross, entryCostPool);
  const investedAmount = entryValuePool;

  const realizedReturnPctInt = financialIntSign(realizedBasis) > 0
    ? financialIntDiv(financialIntMul(realizedNet, toFinancialInt(100)), realizedBasis)
    : null;
  const unrealizedReturnPctInt = financialIntSign(investedAmount) > 0 && unrealized != null
    ? financialIntDiv(financialIntMul(unrealized, toFinancialInt(100)), investedAmount)
    : null;

  const totalCosts = financialIntAdd(totalFees, totalTax);
  const totalPnl = unrealized == null ? realizedNet : financialIntAdd(realizedNet, unrealized);

  return {
    ...position,
    executions: rows,
    openQuantity: financialNumber(qty),
    averageEntryPrice: financialNumber(financialIntSign(qty) > 0 ? avg : (lastAverageEntryPrice ?? 0n)) || null,
    averageExitPrice: financialIntSign(totalExitQty) > 0 ? financialNumber(financialIntDiv(weightedExitValue, totalExitQty)) : null,
    investedAmount: financialNumber(investedAmount),
    grossRealizedPnl: financialNumber(realizedGross),
    grossRealizedPnlExact: financialString(realizedGross),
    realizedTradingCosts: financialNumber(realizedCosts),
    realizedTradingCostsExact: financialString(realizedCosts),
    netRealizedPnl: financialNumber(realizedNet),
    netRealizedPnlExact: financialString(realizedNet),
    realizedPnl: financialNumber(realizedNet),
    realizedPnlExact: financialString(realizedNet),
    realizedBasis: financialNumber(realizedBasis),
    unrealizedGrossPnl: unrealizedGross == null ? null : financialNumber(unrealizedGross),
    unrealizedPnl: unrealized == null ? null : financialNumber(unrealized),
    totalPnl: financialNumber(totalPnl),
    realizedReturnPct: realizedReturnPctInt == null ? null : financialNumber(realizedReturnPctInt),
    unrealizedReturnPct: unrealizedReturnPctInt == null ? null : financialNumber(unrealizedReturnPctInt),
    totalFees: financialNumber(totalFees),
    totalTax: financialNumber(totalTax),
    totalCosts: financialNumber(totalCosts),
    openEntryValue: financialNumber(entryValuePool),
    openEntryFees: financialNumber(entryCostPool),
    openEntryCosts: financialNumber(entryCostPool),
    totalEntryQty: financialNumber(totalEntryQty),
    totalExitQty: financialNumber(totalExitQty),
    realizedEvents,
    isOpen: financialIntSign(qty) > 0,
    hasMarkPrice: markPrice != null && financialIntSign(markPrice) > 0,
    warnings
  };
}

export function buildSnapshots(positions, executions) {
  const grouped = new Map();
  for (const row of executions) {
    if (!grouped.has(row.position_id)) grouped.set(row.position_id, []);
    grouped.get(row.position_id).push(row);
  }
  return positions.map(position => computePosition(position, grouped.get(position.id) || []));
}

export function snapshotStatus(snapshot) {
  return snapshot.isOpen ? 'OPEN' : 'CLOSED';
}

export function exitActionLabel(side) {
  return side === 'SHORT' ? '回補' : '賣出';
}

export function entryActionLabel(side) {
  return side === 'SHORT' ? '放空' : '買入';
}
