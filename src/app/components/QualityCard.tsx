'use client';

import { useState } from 'react';
import { Icon } from './Icon';

// SASUKE's quality self-check: what failed, where it was corrected, how replies were rated.
// QualitySection sits inside the weekly review; QualityCard is the '/品質' answer.

type Kind = 'tool_error' | 'chat_error' | 'correction' | 'thumbs_up' | 'thumbs_down';
export interface QualitySummaryData {
  from: string; to: string;
  counts: Record<Kind, number>;
  failing_tools: Array<{ tool: string; count: number; code: string; reason: string }>;
  recent_issues: Array<{ at: string; kind: Kind; text: string; source?: string }>;
  suggestions: string[];
}

const when = (iso: string) => new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

export function QualitySection({ summary }: { summary: QualitySummaryData }) {
  const c = summary.counts;
  const rated = c.thumbs_up + c.thumbs_down;
  const quiet = !c.tool_error && !c.chat_error && !c.correction && !c.thumbs_down;
  return (
    <section className="brief-sec">
      <p className="brief-label"><Icon name="check" size={15} />SASUKE 自我檢查<span>近 7 天</span></p>
      <div className="brief-chips">
        <span className="brief-chip">工具失敗 <b>{c.tool_error}</b></span>
        <span className="brief-chip">AI 無回應 <b>{c.chat_error}</b></span>
        <span className="brief-chip">被糾正 <b>{c.correction}</b></span>
        <span className="brief-chip">評分 <b>{rated ? `👍 ${c.thumbs_up} · 👎 ${c.thumbs_down}` : '—'}</b></span>
      </div>
      {quiet ? <p className="brief-prose">這週沒有失誤紀錄。若有哪裡不滿意，在回覆下按 👎 讓我知道。</p> : (
        <>
          {summary.suggestions.length > 0 && <ul className="brief-list">{summary.suggestions.map(s => <li key={s}>{s}</li>)}</ul>}
          {summary.failing_tools.length > 0 && (
            <ul className="brief-quotes">
              {summary.failing_tools.map(t => <li key={t.tool}><span className="quality-tool">{t.tool}</span><span className="brief-num" title={t.code}>{t.reason}</span><b className="tone-down">{t.count} 次</b></li>)}
            </ul>
          )}
          {summary.recent_issues.length > 0 && (
            <ul className="quality-issues">
              {summary.recent_issues.map(i => <li key={i.at + i.text}><span className="muted">{when(i.at)} · {i.kind === 'correction' ? '糾正' : '👎'}{i.source ? ` · ${i.source}` : ''}</span>「{i.text}」</li>)}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export function QualityCard({ data }: { data: { summary: QualitySummaryData } }) {
  const [cleared, setCleared] = useState(false);
  const [error, setError] = useState('');
  async function clear() {
    if (!window.confirm('清除所有品質紀錄？清除後無法復原。')) return;
    const response = await fetch('/api/quality', { method: 'DELETE' }).catch(() => null);
    if (response?.ok) setCleared(true); else setError('清除失敗，請再試一次。');
  }
  return (
    <article className="brief">
      <header className="brief-head">
        <span className="brief-kicker">品質自我檢查</span>
        <h3>Sir，這是我最近的表現</h3>
      </header>
      {cleared ? <p className="brief-prose">紀錄已清除。</p> : <QualitySection summary={data.summary} />}
      {error && <p className="hint">{error}</p>}
      <p className="brief-foot">只保存最近 200 筆簡短片段（不含完整對話），加密存放。{!cleared && <button type="button" className="brief-more" onClick={clear}>清除紀錄</button>}</p>
    </article>
  );
}
