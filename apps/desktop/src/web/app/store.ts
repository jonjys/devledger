// The web app's vault: one encrypted blob in this browser's own storage.
//
// There is no DevLedger server and no account. The passphrase is stretched with
// PBKDF2-SHA256 (600,000 rounds, a random salt) into an AES-256-GCM key that
// WebCrypto marks non-extractable, so script can use it but never read it out.
// The whole ledger, values included, is sealed with a fresh IV on every save
// and stored under one localStorage key. Clearing the site's data deletes it.

import type { AuditEntry } from "../../lib/types";
import type { DemoDb } from "../demo/seed";

export const STORAGE_KEY = "devledger.vault.v1";
const ROUNDS = 600_000;
const AAD = new TextEncoder().encode("devledger/web-vault/v1");

/** What sits in storage. Only `ct` is secret; the rest is needed to open it. */
interface Sealed {
  v: 1;
  kdf: "pbkdf2-sha256";
  rounds: number;
  salt: string;
  iv: string;
  ct: string;
}

/** What is sealed: the ledger and its audit trail. */
export interface Contents {
  db: DemoDb;
  audit: AuditEntry[];
}

export class WrongPassphrase extends Error {}

/** Where the blob lives. localStorage in the app; a Map in tests. */
export interface Backing {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

function b64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function derive(passphrase: string, salt: Uint8Array, rounds: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: rounds },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// Maps and Sets do not survive JSON; the ledger keeps its values in a Map.
const encode = (c: Contents) =>
  JSON.stringify({ ...c, db: { ...c.db, values: [...c.db.values.entries()] } });
function decode(text: string): Contents {
  const raw = JSON.parse(text) as { db: Omit<DemoDb, "values"> & { values: [string, string][] }; audit: AuditEntry[] };
  return { db: { ...raw.db, values: new Map(raw.db.values) }, audit: raw.audit ?? [] };
}

export class BrowserVault {
  private key: CryptoKey | null = null;
  private salt: Uint8Array | null = null;
  private rounds = ROUNDS;

  constructor(private readonly backing: Backing) {}

  exists(): boolean {
    return this.backing.get(STORAGE_KEY) !== null;
  }

  get isOpen(): boolean {
    return this.key !== null;
  }

  /** A new vault, sealed under this passphrase. Refuses to replace one that exists. */
  async create(passphrase: string, contents: Contents): Promise<void> {
    if (this.exists()) throw new Error("a vault already exists in this browser");
    this.salt = crypto.getRandomValues(new Uint8Array(16));
    this.rounds = ROUNDS;
    this.key = await derive(passphrase, this.salt, this.rounds);
    await this.save(contents);
  }

  /** Open the vault. A wrong passphrase fails authentication and throws WrongPassphrase. */
  async open(passphrase: string): Promise<Contents> {
    const text = this.backing.get(STORAGE_KEY);
    if (text === null) throw new Error("there is no vault in this browser");
    const sealed = JSON.parse(text) as Sealed;
    const salt = unb64(sealed.salt);
    const key = await derive(passphrase, salt, sealed.rounds);
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: unb64(sealed.iv) as BufferSource, additionalData: AAD },
        key,
        unb64(sealed.ct) as BufferSource,
      );
    } catch {
      throw new WrongPassphrase("that passphrase does not open this vault");
    }
    this.key = key;
    this.salt = salt;
    this.rounds = sealed.rounds;
    return decode(new TextDecoder().decode(plain));
  }

  /** Seal and store the current contents. Only while open. */
  async save(contents: Contents): Promise<void> {
    if (!this.key || !this.salt) throw new Error("the vault is locked");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: AAD },
      this.key,
      new TextEncoder().encode(encode(contents)),
    );
    const sealed: Sealed = {
      v: 1,
      kdf: "pbkdf2-sha256",
      rounds: this.rounds,
      salt: b64(this.salt),
      iv: b64(iv),
      ct: b64(new Uint8Array(ct)),
    };
    this.backing.set(STORAGE_KEY, JSON.stringify(sealed));
  }

  /** Forget the key. The stored blob stays sealed. */
  close(): void {
    this.key = null;
    this.salt = null;
  }
}

export const localBacking: Backing = {
  get: (k) => window.localStorage.getItem(k),
  set: (k, v) => window.localStorage.setItem(k, v),
};

/**
 * The sealed vault as it sits in storage, for a backup file. It is already
 * encrypted under the passphrase, so the file is as safe as the vault itself
 * and opens with the same passphrase.
 */
export function exportBackup(backing: Backing): string | null {
  return backing.get(STORAGE_KEY);
}

/** Whether a file's text has the shape of a vault this version can open. */
export function isBackup(text: string): boolean {
  try {
    const s = JSON.parse(text) as Partial<Sealed>;
    return (
      s.v === 1 &&
      s.kdf === "pbkdf2-sha256" &&
      typeof s.rounds === "number" &&
      s.rounds >= 100_000 &&
      [s.salt, s.iv, s.ct].every((x) => typeof x === "string" && x.length > 0)
    );
  } catch {
    return false;
  }
}

/**
 * Put a backup in place, for a browser with no vault yet. It never replaces
 * an existing vault: that would be the one way to lose data by clicking.
 */
export function restoreBackup(backing: Backing, text: string): void {
  if (backing.get(STORAGE_KEY) !== null) throw new Error("this browser already has a vault");
  if (!isBackup(text)) throw new Error("that file is not a DevLedger backup");
  backing.set(STORAGE_KEY, text.trim());
}
