import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

interface EncryptedPayload {
  iv: string;
  tag: string;
  ciphertext: string;
}

function toKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY_BASE64 must decode to 32 bytes for AES-256-GCM"
    );
  }
  return key;
}

export function encryptString(value: string, keyBase64: string): EncryptedPayload {
  const key = toKey(keyBase64);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

export function decryptString(
  payload: EncryptedPayload,
  keyBase64: string
): string {
  const key = toKey(keyBase64);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(payload.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final()
  ]);

  return plaintext.toString("utf8");
}
