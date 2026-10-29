import { expect, it } from 'vitest';
import { classify } from '@/router/intents';

it('answers "how is my body" phrasings and a bare Garmin mention from Garmin data, locally', () => {
  for (const t of ['我目前的身體狀況', '根據garmin啊北七', '我目前的身體狀況呢？', '看我的 Garmin 資料', '我身體狀況如何', '今天適合運動嗎']) expect(classify(t), t).toEqual({ kind: 'garmin', which: 'status' });
  for (const t of ['garmin 怎麼連', '我想買 Garmin 手錶', '幫我記住身體不舒服要休息']) expect(classify(t)?.kind, t).not.toBe('garmin');
});
