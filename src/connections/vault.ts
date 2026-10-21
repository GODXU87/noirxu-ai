import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const VERSION = 'v1';
const MIN_PASSPHRASE_LENGTH = 32;

/** Accepts 32 random bytes in base64, or a long typed passphrase that is stretched into a key. */
function loadKey(raw: string | undefined): Buffer {
  const value = String(raw || '').trim();
  const decoded = Buffer.from(value, 'base64');
  if (/^[A-Za-z0-9+/]{43}=$/.test(value) && decoded.length === 32) return decoded;
  if (value.length >= MIN_PASSPHRASE_LENGTH) return scryptSync(value, 'noirxu-ai-token-vault-v1', 32);
  throw new Error(`NOIRXU_TOKEN_ENCRYPTION_KEY must be a base64 32-byte key or a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters`);
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
