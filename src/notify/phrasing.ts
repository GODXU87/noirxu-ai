// Varied, warm wording for notifications. Fixed phrase pools picked by a stable seed (the
// notification's own key), so a retry repeats the same words while different reminders and
// different days sound different. No model call; Sir once, at the start.

export function pick<T>(pool: readonly T[], seed: string): T {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return pool[h % pool.length];
}

/** An action-like title ("看電腦", "繳電話費") reads naturally after 該…了 / 別忘了…; anything else is said as is. */
function actionLike(t: string) {
  return t.length <= 12 && !/了$/.test(t) && !/^(該|要|記得|別忘)/.test(t);
}

const ACTION = [
  (t: string) => `Sir，該${t}了`,
  (t: string) => `Sir，${t}的時間到了`,
  (t: string) => `Sir，別忘了${t}`,
  (t: string) => `Sir，現在去${t}剛剛好`,
  (t: string) => `Sir，跟你說一聲：該${t}了`,
  (t: string) => `Sir，${t}，我幫你記著的`
];
const PLAIN = [(t: string) => `Sir，${t}`, (t: string) => `Sir，提醒你：${t}`, (t: string) => `Sir，時間到了：${t}`];
const GENERIC = ['Sir，時間到了', 'Sir，你設的時間到了', 'Sir，到點了，該處理那件事了'];

export function reminderTitle(thing: string, seed: string) {
  const t = thing.trim();
  if (!t || t === '提醒') return pick(GENERIC, seed);
  const short = t.length > 30 ? `${t.slice(0, 29)}…` : t;
  return actionLike(short) ? pick(ACTION, seed)(short) : pick(PLAIN, seed)(short);
}

const WATER_TITLES = ['Sir，該喝水了', 'Sir，喝口水吧', 'Sir，補點水再繼續', 'Sir，水杯該拿起來了', 'Sir，休息一下，喝杯水'];

export function waterWords(input: { total: number; goal: number; behind: number; suggest: number; seed: string }) {
  const n = (v: number) => v.toLocaleString('en-US');
  const progress = `${n(input.total)} / ${n(input.goal)} ml`;
  const body = input.total === 0
    ? pick([`今天還沒喝水，先來 ${n(input.suggest)} ml 暖個身`, `今天的第一杯還沒喝，先喝 ${n(input.suggest)} ml`, `早上到現在 0 ml，先喝 ${n(input.suggest)} ml 就好`], input.seed)
    : input.behind >= 600
      ? pick([`目前 ${progress}，落後有點多了，先喝 ${n(input.suggest)} ml，不用一次補完`, `${progress}，忙歸忙，身體要顧，先來 ${n(input.suggest)} ml`], input.seed)
      : pick([`目前 ${progress}，再喝 ${n(input.suggest)} ml 就跟上進度`, `${progress}，差一點點，喝 ${n(input.suggest)} ml 剛好`, `${progress}，來 ${n(input.suggest)} ml，保持節奏`], input.seed);
  return { title: pick(WATER_TITLES, input.seed), body };
}
