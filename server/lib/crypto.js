import crypto from 'crypto'

// AES-256-GCM encryption for API keys at rest.
// The key comes from VAULT_ENCRYPTION_KEY (64 hex chars = 32 bytes). GCM gives
// us confidentiality + integrity (the auth tag detects tampering on decrypt).

const ALGO = 'aes-256-gcm'

function getKey() {
  const hex = process.env.VAULT_ENCRYPTION_KEY || ''
  if (hex.length !== 64) {
    throw new Error(
      'VAULT_ENCRYPTION_KEY must be 64 hex chars (32 bytes). Generate one with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    )
  }
  return Buffer.from(hex, 'hex')
}

// Returns { ciphertext, iv, tag } — all base64 strings safe to store in text columns.
export function encrypt(plaintext) {
  const key = getKey()
  const iv = crypto.randomBytes(12) // 96-bit nonce recommended for GCM
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  }
}

// Reverses encrypt(). Throws if the data was tampered with.
export function decrypt({ ciphertext, iv, tag }) {
  const key = getKey()
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ])
  return plaintext.toString('utf8')
}
