import { financialAdd, financialNumber, financialSign } from './financial-math.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function dateValue(value) {
  if (!value) return null;
  const raw = String(value);
  const date = new Date(raw.length <= 10 ? `${raw}T12:00:00+08:00` : raw);
  return Number.isFinite(date.getTime()) ? date : null;
}

function calendarDayNumber(value) {
  const date = dateValue(value);
  if (!date) return null;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const [year, month, day] = formatter.format(date).split('-').map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

export function closedTradeRows(snapshots) {
  return snapshots
    .filter(snapshot => !snapshot.isOpen && Number(snapshot.totalExitQty || 0) > 0)
    .map(snapshot => {
      const entries = (snapshot.executions || []).filter(row => row.kind === 'ENTRY');
      const exits = (snapshot.executions || []).filter(row => row.kind === 'EXIT');
      const firstEntry = entries[0]?.executed_at || snapshot.created_at || null;
      const finalExit = exits[exits.length - 1]?.executed_at || snapshot.closed_at || null;
      const startDay = calendarDayNumber(firstEntry);
      const endDay = calendarDayNumber(finalExit);
      const holdDays = startDay == null || endDay == null ? null : Math.max(0, endDay - startDay);

      return {
        id: snapshot.id,
        symbol: snapshot.symbol,
        assetName: snapshot.asset_name || '',
        market: snapshot.market,
        side: snapshot.side,
        strategy: snapshot.strategy || '未分類',
        currency: snapshot.currency,
        nativePnl: financialNumber(snapshot.realizedPnl || 0),
        firstEntry,
        closeDate: finalExit,
        holdDays,
        executionCount: (snapshot.executions || []).length
      };
    })
    .filter(row => row.closeDate);
}

export function streakStats(rows) {
  const ordered = [...rows].sort((a, b) => {
    const ad = dateValue(a.closeDate)?.getTime() ?? 0;
    const bd = dateValue(b.closeDate)?.getTime() ?? 0;
    if (ad !== bd) return ad - bd;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });

  let currentWin = 0;
  let currentLoss = 0;
  let maxWin = 0;
  let maxLoss = 0;

  for (const row of ordered) {
    const pnlSign = financialSign(row.nativePnl || 0);
    if (pnlSign > 0) {
      currentWin += 1;
      currentLoss = 0;
      maxWin = Math.max(maxWin, currentWin);
    } else if (pnlSign < 0) {
      currentLoss += 1;
      currentWin = 0;
      maxLoss = Math.max(maxLoss, currentLoss);
    } else {
      currentWin = 0;
      currentLoss = 0;
    }
  }

  return { maxWin, maxLoss };
}

export function averageHoldDays(rows) {
  const values = rows.map(row => row.holdDays).filter(value => Number.isFinite(value));
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function weekdayLabel(value) {
  const date = dateValue(value);
  if (!date) return '未知';
  return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', weekday: 'short' }).format(date);
}

export function groupClosedTrades(rows, keyFn) {
  const map = new Map();
  rows.forEach(row => {
    const key = keyFn(row);
    const item = map.get(key) || { key, label: key, count: 0, wins: 0, losses: 0, pnl: 0, holdDaysTotal: 0, holdDaysCount: 0 };
    item.count += 1;
    if (financialSign(row.nativePnl) > 0) item.wins += 1;
    if (financialSign(row.nativePnl) < 0) item.losses += 1;
    if (Number.isFinite(row.convertedPnl)) item.pnl = financialAdd(item.pnl, row.convertedPnl);
    if (Number.isFinite(row.holdDays)) {
      item.holdDaysTotal += row.holdDays;
      item.holdDaysCount += 1;
    }
    map.set(key, item);
  });
  return [...map.values()].map(item => ({
    ...item,
    avgHoldDays: item.holdDaysCount ? item.holdDaysTotal / item.holdDaysCount : null
  }));
}
