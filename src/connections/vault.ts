import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

function loadKey(raw: string | undefined): Buffer {
  const key = Buffer.from(String(raw || ''), 'base64');
  if (key.length !== 32) throw new Error('NOIRXU_TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64-encoded');
  return key;
}

/** AES-256-GCM envelope for stored credentials. `aad` binds a ciphertext to its owner and connection. */
export class TokenVault {
  private readonly key: Buffer;

  constructor(rawKey: string | undefined = process.env.NOIRXU_TOKEN_ENCRYPTION_KEY) {
    this.key = loadKey(rawKey);
  }

  seal(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
  }

  open(sealed: string, aad: string): string {
    const [version, iv, tag, body] = String(sealed).split('.');
    if (version !== VERSION || !iv || !tag || !body) throw new Error('Unrecognised credential envelope');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  }
}
