import { describe, expect, it } from 'vitest';
import { speechChunks, STOP_WORDS } from '@/app/components/Voice';
import { speakable } from '@/lib/voice';

describe('voice read-back', () => {
  it('reads tables row by row and drops list markers, headings and dividers', () => {
    const text = speakable(['Sir，美股收盤如下。', '### 指數', '| 標的 | 收盤 |', '|---|---:|', '| SPY | 612.3 |', '---', '- 熱身多做 10 分鐘', '1. 先休息'].join('\n'), 600);
    expect(text).toBe('Sir，美股收盤如下。 指數。 標的，收盤。 SPY，612.3。 熱身多做 10 分鐘。 先休息。');
  });

  it('splits long replies into sentence-sized pieces', () => {
    const long = '今天的狀況不錯。'.repeat(30);
    const parts = speechChunks(long, 120);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(p => p.length <= 120)).toBe(true);
    expect(parts.join('')).toBe(long);
    expect(speechChunks('好的。')).toEqual(['好的。']);
  });

  it('recognises the words that end a conversation', () => {
    for (const t of ['結束', '結束對話。', '不用了', '謝謝就好']) expect(STOP_WORDS.test(t), t).toBe(true);
    for (const t of ['結束後提醒我', '停車費多少']) expect(STOP_WORDS.test(t), t).toBe(false);
  });
});
