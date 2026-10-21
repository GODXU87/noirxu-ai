import 'server-only';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks`));
export const OIDC_AUDIENCE = 'noirxu-ai';
const REPOSITORY = 'GODXU87/noirxu-ai';

/**
 * Accepts only GitHub Actions identity tokens minted for this repository's main branch,
 * so the scheduler needs no shared secret.
 */
export async function verifyGithubScheduler(authorization: string | null): Promise<boolean> {
  const token = /^Bearer\s+(.+)$/.exec(authorization ?? '')?.[1];
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: ISSUER, audience: OIDC_AUDIENCE });
    return payload.repository === REPOSITORY && payload.ref === 'refs/heads/main'
      && ['schedule', 'workflow_dispatch'].includes(String(payload.event_name));
  } catch {
    return false;
  }
}
