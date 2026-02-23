import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OAuthTokenRecord } from "../types.js";
import { decryptString, encryptString } from "../utils/crypto.js";

interface PersistedEncryptedRecord {
  iv: string;
  tag: string;
  ciphertext: string;
}

type PersistedStore = Record<string, PersistedEncryptedRecord>;

export class EncryptedTokenStore {
  private cache: PersistedStore = {};

  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly encryptionKeyBase64: string
  ) {}

  async get(userId: string): Promise<OAuthTokenRecord | null> {
    await this.load();
    const encrypted = this.cache[userId];
    if (!encrypted) {
      return null;
    }

    try {
      const plaintext = decryptString(encrypted, this.encryptionKeyBase64);
      return JSON.parse(plaintext) as OAuthTokenRecord;
    } catch (error) {
      throw new Error(`Failed to decrypt token record for user ${userId}: ${String(error)}`);
    }
  }

  async set(userId: string, token: OAuthTokenRecord): Promise<void> {
    await this.load();
    this.cache[userId] = encryptString(
      JSON.stringify(token),
      this.encryptionKeyBase64
    );
    await this.persist();
  }

  async delete(userId: string): Promise<void> {
    await this.load();
    delete this.cache[userId];
    await this.persist();
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    await mkdir(dirname(this.filePath), { recursive: true });

    try {
      const contents = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(contents) as PersistedStore;
      this.cache = parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.cache = {};
      } else {
        throw error;
      }
    }

    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.cache, null, 2), "utf8");
  }
}
