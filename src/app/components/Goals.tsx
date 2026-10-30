'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { goalFinished, type GoalEvent, type GoalPatch, type GoalView } from '@/goals/model';
import { goalEditReducer, goalEditRequest } from '@/goals/editor';
import { submitGoalForm, taipeiLocalToIso } from '@/goals/form';
import { callTool } from './shared';

const CHANGED = 'noirxu-goals-changed';
const local = (iso: string) => new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
const inputTime = (iso: string) => new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 16);
const errorText = (r: Awaited<ReturnType<typeof callTool>>) => r.status === 'error' ? r.message : '目標尚未更新，請重新讀取。';

function GoalEditor({ goal, complete, busy, onSave, onCancel }: { goal: GoalView; complete: boolean; busy: boolean; onSave: (patch: () => GoalPatch) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(goal.title);
  const [step, setStep] = useState(goal.next_step ?? '');
  const [deadline, setDeadline] = useState(inputTime(goal.deadline));
  const [check, setCheck] = useState(goal.check_at ? inputTime(goal.check_at) : '');
  const [progress, setProgress] = useState(goal.progress);
  const [status, setStatus] = useState<'active' | 'blocked' | 'paused'>(goal.status as 'active' | 'blocked' | 'paused');
  const [blocker, setBlocker] = useState(goal.blocker ?? '');
  const [evidence, setEvidence] = useState('');
  const [result, setResult] = useState('');
  return <form className="stack" onSubmit={e => {
    e.preventDefault();
    if (busy) return;
    if (!e.currentTarget.checkValidity()) { e.currentTarget.reportValidity(); return; }
    onSave(() => complete ? { status: 'completed', evidence, result } : {
      title, next_step: step, deadline: taipeiLocalToIso(deadline), check_at: check ? taipeiLocalToIso(check) : null,
      progress, status, ...(status === 'blocked' ? { blocker } : {}), ...(evidence.trim() ? { evidence } : {})
    });
  }}>
    {complete ? <label>完成結果<textarea value={result} onChange={e => setResult(e.target.value)} required maxLength={1000} /></label> : <>
      <label>目標<input value={title} onChange={e => setTitle(e.target.value)} required maxLength={100} /></label>
      <label>下一步<input value={step} onChange={e => setStep(e.target.value)} required maxLength={400} /></label>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <label>期限（台灣時間）<input type="datetime-local" value={deadline} onChange={e => setDeadline(e.target.value)} required /></label>
        <label>下次確認（台灣時間；空白不提醒）<input type="datetime-local" value={check} onChange={e => setCheck(e.target.value)} required={goal.status === 'paused' && status === 'active'} /></label>
      </div>
      <label>進度（0–99%；完成請用「回報完成」）<input type="number" min={0} max={99} value={progress} onChange={e => setProgress(Number(e.target.value))} required /></label>
      <label>狀態<select value={status} onChange={e => setStatus(e.target.value as typeof status)}><option value="active">進行中</option><option value="blocked">受阻</option><option value="paused">暫停追蹤</option></select></label>
      {status === 'blocked' && <label>阻礙<input value={blocker} onChange={e => setBlocker(e.target.value)} required maxLength={400} /></label>}
    </>}
    <label>回報依據（進度變動或完成必填）<textarea value={evidence} onChange={e => setEvidence(e.target.value)} required={complete || progress !== goal.progress} maxLength={1000} placeholder="寫下實際完成的內容或可核對的結果；不會視為獨立查證。" /></label>
    {complete && <p className="hint">將依你的回報標記完成並停止追蹤；結果依通知偏好處理，不代表已在裝置顯示。</p>}
    <div className="actions"><button className="primary" disabled={busy}>{busy ? '儲存中…' : complete ? '確認回報完成' : '儲存更正'}</button><button type="button" className="ghost" disabled={busy} onClick={onCancel}>取消</button></div>
  </form>;
}

export function GoalCard({ goal: initial, onChanged }: { goal: GoalView; onChanged?: () => void }) {
  const [state, dispatch] = useReducer(goalEditReducer, { current: initial, editing: null });
  const goal = state.current; const editor = state.editing;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [history, setHistory] = useState<{ events: GoalEvent[]; total: number; truncated: boolean } | null>(null);
  useEffect(() => { dispatch({ type: 'refresh', goal: initial }); }, [initial]);
  async function save(input: GoalPatch | (() => GoalPatch)) {
    await submitGoalForm(saving, setBusy, setError, async () => {
      const patch = typeof input === 'function' ? input() : input;
      const r = await callTool('goals.update', goalEditRequest(state, patch));
      if (r.status !== 'ok') throw new Error(errorText(r));
      dispatch({ type: 'saved', goal: (r.data as { goal: GoalView }).goal }); setHistory(null);
      window.dispatchEvent(new Event(CHANGED)); onChanged?.();
    });
  }
  async function readHistory(show: boolean) {
    await submitGoalForm(saving, setBusy, setError, async () => {
      const r = await callTool('goals.history.get', { id: goal.id });
      if (r.status !== 'ok') throw new Error(errorText(r));
      const data = r.data as { goal: GoalView; events: GoalEvent[]; total: number; truncated: boolean };
      dispatch({ type: show ? 'refresh' : 'saved', goal: data.goal }); setHistory(show ? data : null);
    });
  }
  const finished = goalFinished(goal);
  return <article id={`goal-${goal.id}`} className="card stack" aria-label={`目標：${goal.title}`}>
    <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><h3>{goal.title}</h3><span className="tag">{goal.status_label}</span></div>
    <p><b>{goal.progress}%</b> <span className="hint">使用者回報，未獨立驗證</span></p>
    <p>期限：{local(goal.deadline)}（台灣時間）</p>
    {goal.next_step && <p><b>下一步：</b>{goal.next_step}</p>}
    {goal.blocker && <p className="status-error">阻礙：{goal.blocker}</p>}
    <p className="hint">{finished ? '追蹤已停止。' : goal.status === 'paused' ? '追蹤已暫停，不會產生新提醒。' : goal.check_at ? `下次確認：${local(goal.check_at)}；僅確認一次，不代表背景工作已執行。` : '目前沒有排定下次確認；可更新時間，目標尚未自動完成。'}</p>
    {goal.latest_evidence && <p>最近依據：{goal.latest_evidence}</p>}
    {goal.completion && <section><b>完成結果</b><p>{goal.completion.result}</p><p className="hint">依據：{goal.completion.evidence}</p></section>}
    {goal.notifications.length > 0 && <ul className="hint">{goal.notifications.slice(-3).map(n => <li key={n.key}>{n.kind === 'completion' ? '結果通知' : '進度確認'}：{n.label}{n.last_error ? `（${n.last_error}）` : ''}</li>)}</ul>}
    {error && <p role="alert" className="status-error">{error}</p>}
    {editor ? <GoalEditor key={`${goal.id}:${editor.mode}`} goal={editor.goal} complete={editor.mode === 'complete'} busy={busy} onSave={p => void save(p)} onCancel={() => dispatch({ type: 'close' })} /> : <div className="actions" style={{ flexWrap: 'wrap' }}>
      {!finished && <><button type="button" className="ghost" disabled={busy} onClick={() => dispatch({ type: 'begin', mode: 'update' })}>更新進度／更正</button><button type="button" className="primary" disabled={busy} onClick={() => dispatch({ type: 'begin', mode: 'complete' })}>回報完成</button>
        <button type="button" className="ghost" disabled={busy} onClick={() => { if (window.confirm(`取消追蹤「${goal.title}」？此目標將結束，保留歷程。`)) void save({ status: 'cancelled' }); }}>取消追蹤</button></>}
      <button type="button" className="ghost" disabled={busy} onClick={() => history ? setHistory(null) : void readHistory(true)}>{history ? '收起歷程' : '歷程'}</button>
      <button type="button" className="ghost" disabled={busy} onClick={() => void readHistory(false)}>重新讀取</button>
    </div>}
    {history && <section><p className="hint">顯示最近 {history.events.length} / {history.total} 次歷程{history.truncated ? '（較早歷程已超出保留範圍）' : ''}</p><ol>{history.events.map(e => <li key={e.revision}><small>{local(e.at)} · v{e.revision} · {e.source === 'scheduler' ? '排程確認' : '使用者回報'}</small><p>{e.title} · {e.progress}%{e.evidence ? ` · ${e.evidence}` : ''}</p>{e.next_step && <p className="hint">下一步：{e.next_step}</p>}</li>)}</ol></section>}
  </article>;
}

export function GoalsPanel({ initialGoalId }: { initialGoalId?: string }) {
  const [goals, setGoals] = useState<GoalView[] | null>(null);
  const [all, setAll] = useState(Boolean(initialGoalId)); const [error, setError] = useState('');
  const [creating, setCreating] = useState(false); const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(''); const [step, setStep] = useState(''); const [deadline, setDeadline] = useState('');
  const requestId = useRef<string | null>(null); const generation = useRef(0); const saving = useRef(false);
  const load = useCallback(async () => {
    const version = ++generation.current;
    const r = await callTool('goals.list', { include_finished: all });
    if (version !== generation.current) return;
    if (r.status === 'ok') { setGoals((r.data as { goals: GoalView[] }).goals); setError(''); }
    else setError(errorText(r));
  }, [all]);
  useEffect(() => {
    void load(); const refresh = () => { if (document.visibilityState === 'visible') void load(); };
    window.addEventListener(CHANGED, refresh); window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { generation.current++; window.removeEventListener(CHANGED, refresh); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [load]);
  const focused = useRef(false);
  useEffect(() => {
    if (initialGoalId && goals?.some(g => g.id === initialGoalId) && !focused.current) {
      focused.current = true; document.getElementById(`goal-${initialGoalId}`)?.scrollIntoView({ block: 'center' });
    }
  }, [goals, initialGoalId]);
  async function create() {
    await submitGoalForm(saving, setBusy, setError, async () => {
      const at = taipeiLocalToIso(deadline);
      requestId.current ??= crypto.randomUUID();
      const r = await callTool('goals.create', { request_id: requestId.current, title, next_step: step, deadline: at });
      if (r.status !== 'ok') throw new Error(errorText(r));
      requestId.current = null; setCreating(false); setTitle(''); setStep(''); setDeadline(''); void load();
    });
  }
  return <section className="stack" aria-label="目標追蹤">
    <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}><h2>目標追蹤</h2><div className="row" style={{ gap: 8 }}><button type="button" className="ghost" onClick={() => setAll(v => !v)}>{all ? '只看進行中' : '含已結束'}</button><button type="button" className="primary" onClick={() => setCreating(v => !v)} disabled={busy}>新增目標</button></div></div>
    <p className="hint">記住進度、下一步和期限；完成依據由你回報。不是自動執行工作的排程，提醒依既有通知偏好與排程服務。</p>
    {creating && <form className="card stack" onSubmit={e => { e.preventDefault(); if (!e.currentTarget.checkValidity()) { setError('請填妥目標、下一步與有效的日期時間。'); e.currentTarget.reportValidity(); return; } void create(); }}>
      <label>目標<input value={title} onChange={e => { setTitle(e.target.value); requestId.current = null; }} required maxLength={100} /></label>
      <label>下一步<input value={step} onChange={e => { setStep(e.target.value); requestId.current = null; }} required maxLength={400} /></label>
      <label>期限（台灣時間）<input type="datetime-local" value={deadline} onChange={e => { setDeadline(e.target.value); requestId.current = null; }} required /></label>
      <p className="hint">預設在期限確認一次進度；建立後可更改或清除確認時間。</p>
      <div className="actions"><button className="primary" disabled={busy}>{busy ? '儲存中…' : '建立目標'}</button><button type="button" className="ghost" disabled={busy} onClick={() => setCreating(false)}>取消</button></div>
    </form>}
    {error && <p role="alert" className="status-error">{error} <button type="button" className="ghost" onClick={() => void load()}>重新讀取</button></p>}
    {goals === null ? <p className="hint">讀取目標中…</p> : goals.length ? goals.map(g => <GoalCard key={g.id} goal={g} />) : <p className="hint">還沒有{all ? '' : '進行中的'}目標。可以在此建立，或在對話中明確交代目標、下一步與期限。</p>}
  </section>;
}
