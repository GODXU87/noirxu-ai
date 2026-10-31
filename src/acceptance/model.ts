import { z } from 'zod';
export const PROJECTS = {
  'noirxu-ai': { name: 'NOIRXU AI', repo: 'GODXU87/noirxu-ai', url: 'https://noirxu-ai.vercel.app' },
  offscript: { name: 'OFFSCRIPT', repo: 'GODXU87/offscript', url: 'https://offscript-swart.vercel.app' },
  'noirxu-film-lab': { name: 'Film Lab', repo: 'GODXU87/noirxu-film-lab', url: 'https://noirxu-film-lab.vercel.app' },
} as const;
export type Project = keyof typeof PROJECTS;
export const projectSchema = z.enum(['noirxu-ai', 'offscript', 'noirxu-film-lab']);
export const shaSchema = z.string().regex(/^[a-f0-9]{40}$/i).transform(s => s.toLowerCase());
export const acceptanceCreate = z.object({ request_id: z.uuid(), project: projectSchema, sha: shaSchema,
 title: z.string().trim().min(1).max(100), criteria: z.string().trim().min(10).max(1000), due_at: z.iso.datetime({ offset: true }).nullable().default(null) }).strict();
export const acceptanceReport = z.object({ decision: z.enum(['pass','fail','cancel','reopen']), observation: z.string().trim().min(10).max(1500) }).strict();
export interface Stage { state: 'verified' | 'blocked' | 'unknown' | 'unsupported'; reason: string; url?: string }
export interface Evidence { checked_at: string; commit: Stage; ci: Array<{ context: string; state: string; url?: string }>; ci_reason?: string; deployment: Stage; runtime: Stage }
export interface Acceptance {
 id: string; request_id: string; project: Project; sha: string; title: string; criteria: string; due_at: string | null;
 revision: number; created_at: string; updated_at: string; status: 'open' | 'manual_pass' | 'manual_fail' | 'cancelled';
 evidence?: Evidence; checks: Array<{ revision: number; evidence: Evidence }>; check_claim?: string; check_until?: string;
 reports: Array<{ source: 'user_report'; decision: z.infer<typeof acceptanceReport>['decision']; observation: string; at: string; evidence_revision?: number }>;
}
export const ACCEPTANCE_STATUS = { open: '等待驗收', manual_pass: '人工驗收通過（非自動查證）', manual_fail: '人工驗收未通過', cancelled: '已取消驗收' };
export function acceptanceView(a: Acceptance) { const { request_id: _, check_claim: __, ...view } = a; return view; }
