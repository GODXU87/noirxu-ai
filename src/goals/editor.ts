import type { GoalPatch, GoalView } from './model';
export interface GoalEditState { current: GoalView; editing: { mode: 'update' | 'complete'; goal: GoalView } | null }
type GoalEditAction = { type: 'refresh' | 'saved'; goal: GoalView } | { type: 'begin'; mode: 'update' | 'complete' } | { type: 'close' };
/** Keep the edit's original revision across focus/list refreshes; the server must reject stale edits. */
export function goalEditReducer(state: GoalEditState, action: GoalEditAction): GoalEditState {
  switch (action.type) {
    case 'begin': return { ...state, editing: { mode: action.mode, goal: state.current } };
    case 'refresh': return { ...state, current: action.goal };
    case 'saved': return { current: action.goal, editing: null };
    case 'close': return { ...state, editing: null };
  }
}
export function goalEditRequest(state: GoalEditState, patch: GoalPatch) {
  const snapshot = state.editing?.goal ?? state.current;
  return { id: snapshot.id, revision: snapshot.revision, ...patch };
}
