import { createElement } from 'react';
// @ts-expect-error react-dom has no type declarations installed in this project
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RichText } from '@/app/components/shared';

describe('RichText', () => {
  it('renders headings, numbered lists, tables and a closing note without raw symbols', () => {
    const html = renderToStaticMarkup(createElement(RichText, { text: [
      'Sir，這週整體 **穩定**。',
      '### 重點',
      '- 睡眠平均 `7h12m`',
      '  - 週三最短',
      '1. 先熱身',
      '2. 再練主項',
      '| 標的 | 收盤 | 漲跌 |',
      '|---|---:|---:|',
      '| SPY | 612.30 | +0.42% |',
      '---',
      '> 若持續疲勞，請先休息。'
    ].join('\n') }));
    expect(html).toContain('<strong>穩定</strong>');
    expect(html).toContain('<h4>重點</h4>');
    expect(html).toContain('<code>7h12m</code>');
    expect(html).toContain('<li class="sub">週三最短</li>');
    expect(html).toMatch(/<ol><li>先熱身<\/li><li>再練主項<\/li><\/ol>/);
    expect(html).toContain('<th>標的</th>');
    expect(html).toContain('<td>+0.42%</td>');
    expect(html).toContain('<hr/>');
    expect(html).toContain('class="rich-note"');
    expect(html).not.toContain('|');
    expect(html).not.toContain('###');
  });

  it('only links http(s) URLs', () => {
    expect(renderToStaticMarkup(createElement(RichText, { text: '看 [RADAR](https://radar.noirxu.com) 與 [x](javascript:alert(1))' }))).toMatch(/<a href="https:\/\/radar.noirxu.com"[^>]*>RADAR<\/a>.*\[x\]\(javascript:alert\(1\)\)/);
  });
});
