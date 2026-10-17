// The web app's vault: one encrypted blob in this browser's own storage.
//
// There is no DevLedger server and no account. The passphrase is stretched with
// Argon2id (19 MiB, 2 passes: OWASP's first recommended setting, sized for
// phones) into a 256-bit key, which WebCrypto then holds as a non-extractable
// AES-256-GCM key, so script can use it but never read it out. The whole
// ledger, values included, is sealed with a fresh IV on every save and stored
// under one localStorage key. Clearing the site's data deletes it.
//
// Vaults made before Argon2id (format 1, PBKDF2-SHA256 with 600,000 rounds)
// still open, and are re-sealed in format 2 the moment they are unlocked.

import { argon2idAsync } from "@noble/hashes/argon2.js";

import type { AuditEntry } from "../../lib/types";
import type { DemoDb } from "../demo/seed";

export const STORAGE_KEY = "devledger.vault.v1";

/** Argon2id cost: memory in KiB, passes, lanes. */
export interface Argon2Params {
  m: number;
  t: number;
  p: number;
}

export const ARGON2: Argon2Params = { m: 19_456, t: 2, p: 1 };

/** What a backup may ask for. Below wastes the KDF; above could freeze the tab. */
const BOUNDS = { m: [8_192, 262_144], t: [1, 10], p: [1, 4], rounds: [100_000, 10_000_000] } as const;

const AAD = {
  1: new TextEncoder().encode("devledger/web-vault/v1"),
  2: new TextEncoder().encode("devledger/web-vault/v2"),
} as const;

/** Format 1: PBKDF2. Read, never written. */
interface SealedV1 {
  v: 1;
  kdf: "pbkdf2-sha256";
  rounds: number;
  salt: string;
  iv: string;
  ct: string;
}

/** Format 2: Argon2id. What every save writes. */
interface SealedV2 extends Argon2Params {
  v: 2;
  kdf: "argon2id";
  salt: string;
  iv: string;
  ct: string;
}

type Sealed = SealedV1 | SealedV2;

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

const within = (n: unknown, [lo, hi]: readonly [number, number]) =>
  typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi;

/** Parse a stored or backed-up vault, refusing anything out of bounds. */
function parseSealed(text: string): Sealed | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (![s.salt, s.iv, s.ct].every((x) => typeof x === "string" && x.length > 0)) return null;
  if (s.v === 1 && s.kdf === "pbkdf2-sha256" && within(s.rounds, BOUNDS.rounds)) return s as unknown as SealedV1;
  if (s.v === 2 && s.kdf === "argon2id" && within(s.m, BOUNDS.m) && within(s.t, BOUNDS.t) && within(s.p, BOUNDS.p)) {
    return s as unknown as SealedV2;
  }
  return null;
}

async function pbkdf2Key(passphrase: string, salt: Uint8Array, rounds: number): Promise<CryptoKey> {
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

/** Argon2id to raw bytes, handed straight to WebCrypto and then wiped. */
async function argon2Key(passphrase: string, salt: Uint8Array, params: Argon2Params): Promise<CryptoKey> {
  const password = new TextEncoder().encode(passphrase);
  const raw = await argon2idAsync(password, salt, { ...params, dkLen: 32, asyncTick: 25 });
  try {
    return await crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  } finally {
    raw.fill(0);
    password.fill(0);
  }
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
  private params: Argon2Params;

  /** `kdf` is for tests, which cannot afford the real cost on every case. */
  constructor(
    private readonly backing: Backing,
    private readonly kdf: Argon2Params = ARGON2,
  ) {
    this.params = kdf;
  }

  exists(): boolean {
    return this.backing.get(STORAGE_KEY) !== null;
  }

  get isOpen(): boolean {
    return this.key !== null;
  }

  /** Take a fresh salt and an Argon2id key for `passphrase`. */
  private async rekey(passphrase: string): Promise<void> {
    this.salt = crypto.getRandomValues(new Uint8Array(16));
    this.params = this.kdf;
    this.key = await argon2Key(passphrase, this.salt, this.params);
  }

  /** A new vault, sealed under this passphrase. Refuses to replace one that exists. */
  async create(passphrase: string, contents: Contents): Promise<void> {
    if (this.exists()) throw new Error("a vault already exists in this browser");
    await this.rekey(passphrase);
    await this.save(contents);
  }

  /**
   * Open the vault. A wrong passphrase fails authentication and throws
   * WrongPassphrase. A format 1 vault is re-sealed in format 2 on the way.
   */
  async open(passphrase: string): Promise<Contents> {
    const text = this.backing.get(STORAGE_KEY);
    if (text === null) throw new Error("there is no vault in this browser");
    const sealed = parseSealed(text);
    if (!sealed) throw new Error("the stored vault is damaged or from a newer DevLedger");
    const salt = unb64(sealed.salt);
    const key =
      sealed.v === 2
        ? await argon2Key(passphrase, salt, { m: sealed.m, t: sealed.t, p: sealed.p })
        : await pbkdf2Key(passphrase, salt, sealed.rounds);
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: unb64(sealed.iv) as BufferSource, additionalData: AAD[sealed.v] },
        key,
        unb64(sealed.ct) as BufferSource,
      );
    } catch {
      throw new WrongPassphrase("that passphrase does not open this vault");
    }
    const contents = decode(new TextDecoder().decode(plain));
    if (sealed.v === 1) {
      await this.rekey(passphrase);
      await this.save(contents);
    } else {
      this.key = key;
      this.salt = salt;
      this.params = { m: sealed.m, t: sealed.t, p: sealed.p };
    }
    return contents;
  }

  /** Seal and store the current contents. Only while open. */
  async save(contents: Contents): Promise<void> {
    if (!this.key || !this.salt) throw new Error("the vault is locked");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: AAD[2] },
      this.key,
      new TextEncoder().encode(encode(contents)),
    );
    const sealed: SealedV2 = {
      v: 2,
      kdf: "argon2id",
      ...this.params,
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

/** Whether a file's text has the shape of a vault this version can open, within safe bounds. */
export function isBackup(text: string): boolean {
  return parseSealed(text) !== null;
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
