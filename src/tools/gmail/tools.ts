import { z } from 'zod';
import { ToolError } from '@/hub/errors';
import { defineTool } from '@/hub/registry';
import type { ToolDefinition } from '@/hub/types';
import type { GmailService } from './google';
import { buildRawMessage, extractBody } from './mime';

interface GmailHeader { name: string; value: string }
interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: { headers?: GmailHeader[]; mimeType?: string; body?: { data?: string }; parts?: unknown[] };
}

const MAX_BODY_CHARS = 20_000;
const singleLine = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\r\n]/.test(value), '不可包含換行');

const messageSummary = z.object({
  id: z.string(),
  thread_id: z.string(),
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  date: z.string(),
  snippet: z.string(),
  unread: z.boolean(),
  labels: z.array(z.string())
});

const draftInput = z.object({
  to: z.array(z.email()).min(1).max(20).describe('使用者明確提供的收件人信箱，不可猜測'),
  cc: z.array(z.email()).max(20).default([]),
  subject: singleLine(200),
  body: z.string().min(1).max(MAX_BODY_CHARS).describe('完整信件內文（純文字）'),
  reply_to_message_id: z.string().regex(/^[A-Za-z0-9]+$/).optional().describe('若是回覆，填原信的 message id')
}).strict();

function header(message: GmailMessage, name: string) {
  return message.payload?.headers?.find(item => item.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function summarize(message: GmailMessage) {
  return {
    id: message.id,
    thread_id: message.threadId,
    from: header(message, 'From'),
    to: header(message, 'To'),
    subject: header(message, 'Subject'),
    date: header(message, 'Date'),
    snippet: message.snippet ?? '',
    unread: Boolean(message.labelIds?.includes('UNREAD')),
    labels: message.labelIds ?? []
  };
}

function gmailLink(id: string) {
  return [{ label: '在 Gmail 開啟', url: `https://mail.google.com/mail/u/0/#all/${id}` }];
}

async function requireGrant(gmail: GmailService, userId: string, grant: 'read' | 'send') {
  if (!(await gmail.hasGrant(userId, grant))) {
    throw new ToolError('FORBIDDEN', grant === 'send' ? '尚未授權寄信，請到 Connections 頁面另外授權「寄送郵件」。' : '尚未授權讀取 Gmail，請到 Connections 頁面授權。');
  }
}

async function replyHeaders(gmail: GmailService, userId: string, messageId: string) {
  const original = await gmail.api<GmailMessage>(userId, `/messages/${messageId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject&metadataHeaders=From`);
  const parentId = header(original, 'Message-ID');
  return {
    threadId: original.threadId,
    inReplyTo: parentId || undefined,
    references: [header(original, 'References'), parentId].filter(Boolean).join(' ') || undefined,
    from: header(original, 'From'),
    subject: header(original, 'Subject')
  };
}

export function gmailTools(gmail: GmailService): ToolDefinition[] {
  return [
    defineTool({
      name: 'gmail.messages.search',
      description: '用 Gmail 搜尋語法查信（例如「in:inbox is:unread newer_than:2d -category:promotions」）。只回傳標題、寄件人、摘要等，不含全文。',
      connection: 'gmail',
      kind: 'read',
      input: z.object({ query: z.string().trim().max(300).default('in:inbox'), max_results: z.number().int().min(1).max(25).default(10) }).strict(),
      output: z.object({ query: z.string(), messages: z.array(messageSummary) }),
      async run(value, ctx) {
        await requireGrant(gmail, ctx.userId, 'read');
        const list = await gmail.api<{ messages?: Array<{ id: string }> }>(ctx.userId, `/messages?${new URLSearchParams({ q: value.query, maxResults: String(value.max_results) })}`);
        const messages = await Promise.all((list.messages ?? []).map(item =>
          gmail.api<GmailMessage>(ctx.userId, `/messages/${item.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`)));
        return { data: { query: value.query, messages: messages.map(summarize) }, links: [{ label: '在 Gmail 查看搜尋結果', url: `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(value.query)}` }] };
      }
    }),
    defineTool({
      name: 'gmail.message.read',
      description: '讀取一封 Gmail 的完整內文（純文字），用來摘要或準備回覆。',
      connection: 'gmail',
      kind: 'read',
      input: z.object({ message_id: z.string().regex(/^[A-Za-z0-9]+$/) }).strict(),
      output: messageSummary.extend({ body: z.string(), truncated: z.boolean() }),
      async run(value, ctx) {
        await requireGrant(gmail, ctx.userId, 'read');
        const message = await gmail.api<GmailMessage>(ctx.userId, `/messages/${value.message_id}?format=full`);
        const body = extractBody(message.payload as Parameters<typeof extractBody>[0]);
        return { data: { ...summarize(message), body: body.slice(0, MAX_BODY_CHARS), truncated: body.length > MAX_BODY_CHARS }, links: gmailLink(message.id) };
      }
    }),
    defineTool({
      name: 'gmail.message.prepare',
      description: '整理一封待寄的信（檢查收件人格式、帶入回覆主旨），不會寄出。給使用者看過內容後，再用 gmail.message.send 送出確認。',
      connection: 'gmail',
      kind: 'read',
      input: draftInput,
      output: draftInput.extend({ reply_thread_id: z.string().nullable(), replying_to: z.string().nullable() }),
      async run(value, ctx) {
        let reply: Awaited<ReturnType<typeof replyHeaders>> | null = null;
        if (value.reply_to_message_id) {
          await requireGrant(gmail, ctx.userId, 'read');
          reply = await replyHeaders(gmail, ctx.userId, value.reply_to_message_id);
        }
        const subject = reply && !/^re:/i.test(value.subject) && value.subject === reply.subject ? `Re: ${value.subject}` : value.subject;
        return { data: { ...value, subject, reply_thread_id: reply?.threadId ?? null, replying_to: reply?.from ?? null } };
      }
    }),
    defineTool({
      name: 'gmail.message.send',
      description: '寄出一封信。會先把收件人、主旨與完整內文交給使用者確認，使用者按下確認才會寄出。',
      connection: 'gmail',
      kind: 'send',
      input: draftInput,
      output: z.object({ id: z.string(), thread_id: z.string() }),
      async preview(value, ctx) {
        await requireGrant(gmail, ctx.userId, 'send');
        const account = await gmail.connection(ctx.userId);
        return {
          title: '寄出 Gmail',
          fields: [
            { label: '寄件人', value: account?.email ?? '（已連接的 Gmail 帳號）' },
            { label: '收件人', value: value.to.join(', ') },
            ...(value.cc.length ? [{ label: '副本', value: value.cc.join(', ') }] : []),
            { label: '主旨', value: value.subject },
            ...(value.reply_to_message_id ? [{ label: '回覆', value: value.reply_to_message_id }] : [])
          ],
          body: value.body,
          warnings: ['按下確認後信件會立即寄出，無法收回。']
        };
      },
      async run(value, ctx) {
        await requireGrant(gmail, ctx.userId, 'send');
        // A reply needs read access for the original headers; without it the mail is sent as a new thread.
        const reply = value.reply_to_message_id && await gmail.hasGrant(ctx.userId, 'read')
          ? await replyHeaders(gmail, ctx.userId, value.reply_to_message_id)
          : null;
        const raw = buildRawMessage({ to: value.to, cc: value.cc, subject: value.subject, body: value.body, inReplyTo: reply?.inReplyTo, references: reply?.references });
        const sent = await gmail.api<{ id: string; threadId: string }>(ctx.userId, '/messages/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw, ...(reply?.threadId ? { threadId: reply.threadId } : {}) })
        }, 'write');
        return { data: { id: sent.id, thread_id: sent.threadId }, recordId: sent.id, links: gmailLink(sent.id) };
      },
      async reconcile(value, ctx) {
        if (!(await gmail.hasGrant(ctx.userId, 'read'))) return { candidates: [] };
        const query = `in:sent newer_than:1d to:${value.to[0]}`;
        const list = await gmail.api<{ messages?: Array<{ id: string }> }>(ctx.userId, `/messages?${new URLSearchParams({ q: query, maxResults: '5' })}`);
        const messages = await Promise.all((list.messages ?? []).map(item =>
          gmail.api<GmailMessage>(ctx.userId, `/messages/${item.id}?format=metadata&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`)));
        return { candidates: messages.map(summarize).filter(item => item.subject.includes(value.subject.slice(0, 40))) };
      }
    })
  ];
}
