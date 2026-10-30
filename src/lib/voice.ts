// Voice mode helpers (V0.4 Phase 4, feature 'voice'). Browser Web Speech API only — no paid
// speech-to-text or Realtime API. One utterance per tap (never continuous recording); the
// transcript is shown for correction before it is sent, and goes through the same chat path
// (local router first). Voice never confirms anything: write/send proposals still need a tap
// on the confirmation card.

export interface VoiceSupport { recognition: boolean; synthesis: boolean; reason?: string }

type SpeechWindow = { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown; speechSynthesis?: unknown; isSecureContext?: boolean };

/** What this browser can do, with a plain reason when it can't. */
export function voiceSupport(win: SpeechWindow | undefined): VoiceSupport {
  if (!win) return { recognition: false, synthesis: false, reason: '目前不在瀏覽器中。' };
  const synthesis = Boolean(win.speechSynthesis);
  if (win.isSecureContext === false) return { recognition: false, synthesis, reason: '語音輸入需要 HTTPS。' };
  const recognition = Boolean(win.SpeechRecognition ?? win.webkitSpeechRecognition);
  return recognition ? { recognition, synthesis } : { recognition, synthesis, reason: '這個瀏覽器不支援語音輸入，請改用鍵盤（或系統的聽寫功能）。' };
}

/** Settings for one utterance: zh-TW, interim text for live display, stops after one phrase. */
export const RECOGNITION_OPTIONS = { lang: 'zh-TW', continuous: false, interimResults: true, maxAlternatives: 1 } as const;

/** Reply text for read-back: drops markdown, links and code, and keeps it short. */
export function speakable(reply: string, max = 220): string {
  // Tables are read row by row ("SPY，612.30，+0.42%。"); separator rows and dividers are dropped.
  const lines = reply.split('\n')
    .filter(line => !/^\s*\|?\s*:?-{2,}[-|:\s]*$/.test(line) && !/^\s*(-{3,}|\*{3,})\s*$/.test(line))
    .map(line => (/^\s*\|.*\|\s*$/.test(line) ? `${line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()).filter(Boolean).join('，')}。` : line.replace(/^\s*#{1,4}\s+(.*)$/, '$1。').replace(/^\s*(?:[-*•]|\d+[.)、])\s+(.*?)[。.]?$/, '$1。')));
  const plain = lines.join('\n')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
  return `${stop > max * 0.5 ? cut.slice(0, stop + 1) : cut}……詳細內容在畫面上。`;
}
