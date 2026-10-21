import { randomUUID } from 'node:crypto';

export interface OutgoingMessage {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}

function hasLineBreak(value: string) {
  return /[\r\n]/.test(value);
}

/** RFC 2047 encoded-word, so non-ASCII subjects survive every mail client. */
export function encodeHeaderWord(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Builds an RFC 5322 message (base64url, as Gmail's `raw` field expects). Rejects header injection. */
export function buildRawMessage(message: OutgoingMessage, from?: string | null): string {
  const headerValues = [...message.to, ...message.cc, message.subject, message.inReplyTo ?? '', message.references ?? '', from ?? ''];
  if (headerValues.some(hasLineBreak)) throw new Error('Header values must not contain line breaks');

  const lines = [
    ...(from ? [`From: ${from}`] : []),
    `To: ${message.to.join(', ')}`,
    ...(message.cc.length ? [`Cc: ${message.cc.join(', ')}`] : []),
    `Subject: ${encodeHeaderWord(message.subject)}`,
    ...(message.inReplyTo ? [`In-Reply-To: ${message.inReplyTo}`] : []),
    ...(message.references ? [`References: ${message.references}`] : []),
    `Message-ID: <${randomUUID()}@noirxu-ai>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(message.body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n')
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

function decode(data: string | undefined) {
  return data ? Buffer.from(data, 'base64url').toString('utf8') : '';
}

function stripHtml(html: string) {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Prefers text/plain; falls back to stripped text/html. */
export function extractBody(payload: GmailPart | undefined): string {
  if (!payload) return '';
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (part: GmailPart) => {
    if (part.mimeType === 'text/plain') plain.push(decode(part.body?.data));
    else if (part.mimeType === 'text/html') html.push(decode(part.body?.data));
    part.parts?.forEach(walk);
  };
  walk(payload);
  if (plain.some(Boolean)) return plain.join('\n').trim();
  return stripHtml(html.join('\n'));
}
