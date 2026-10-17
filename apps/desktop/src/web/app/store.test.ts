// The web app's vault: what lands in the browser's storage, and what it takes to open it.

import type { AuditEntry } from "../../lib/types";
import { emptyDb } from "../demo/seed";
import {
  ARGON2,
  BrowserVault,
  STORAGE_KEY,
  WrongPassphrase,
  exportBackup,
  isBackup,
  restoreBackup,
  type Backing,
} from "./store";

/** The cheapest setting a backup may carry, so the many cases below stay quick. */
const FAST = { m: 8_192, t: 1, p: 1 };

const PASS = "correct horse battery staple";
const VALUE = ["sk", "live", "FAKE0000WEBVAULT1111NOTREAL"].join("_");

function memory(): Backing & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return { raw, get: (k) => raw.get(k) ?? null, set: (k, v) => void raw.set(k, v) };
}

function contents() {
  const db = emptyDb();
  db.values.set("k1", VALUE);
  db.projects.push({
    id: "p1",
    name: "Shop",
    description: null,
    created_at: "2026-10-12T00:00:00Z",
    updated_at: "2026-10-12T00:00:00Z",
  } as never);
  const audit: AuditEntry[] = [];
  return { db, audit };
}

describe("browser vault", () => {
  it("stores only ciphertext, and opens again with the passphrase", async () => {
    const backing = memory();
    const vault = new BrowserVault(backing, FAST);
    expect(vault.exists()).toBe(false);
    await vault.create(PASS, contents());

    const stored = backing.raw.get(STORAGE_KEY)!;
    expect(stored).not.toContain(VALUE);
    expect(stored).not.toContain("Shop");
    expect(JSON.parse(stored)).toMatchObject({ v: 2, kdf: "argon2id", ...FAST });

    vault.close();
    const opened = await new BrowserVault(backing, FAST).open(PASS);
    expect(opened.db.values.get("k1")).toBe(VALUE);
    expect(opened.db.projects[0]!.name).toBe("Shop");
  });

  it("refuses a wrong passphrase and never replaces an existing vault", async () => {
    const backing = memory();
    const vault = new BrowserVault(backing, FAST);
    await vault.create(PASS, contents());
    await expect(new BrowserVault(backing, FAST).open("not the passphrase at all")).rejects.toBeInstanceOf(
      WrongPassphrase,
    );
    await expect(new BrowserVault(backing, FAST).create(PASS, contents())).rejects.toThrow(/already exists/);
  });

  it("seals each save with a fresh IV and cannot save once closed", async () => {
    const backing = memory();
    const vault = new BrowserVault(backing, FAST);
    await vault.create(PASS, contents());
    const first = JSON.parse(backing.raw.get(STORAGE_KEY)!).iv;
    await vault.save(contents());
    expect(JSON.parse(backing.raw.get(STORAGE_KEY)!).iv).not.toBe(first);
    vault.close();
    await expect(vault.save(contents())).rejects.toThrow(/locked/);
  });
});

describe("backups", () => {
  it("restores into an empty browser and opens with the same passphrase", async () => {
    const from = memory();
    await new BrowserVault(from, FAST).create(PASS, contents());
    const file = exportBackup(from)!;
    expect(file).not.toContain(VALUE);

    const to = memory();
    restoreBackup(to, file);
    const opened = await new BrowserVault(to, FAST).open(PASS);
    expect(opened.db.values.get("k1")).toBe(VALUE);
  });

  it("refuses a file that is not a backup, and never replaces a vault", async () => {
    const to = memory();
    expect(() => restoreBackup(to, '{"hello":"world"}')).toThrow(/not a DevLedger backup/);
    expect(() => restoreBackup(to, "not json")).toThrow(/not a DevLedger backup/);
    await new BrowserVault(to, FAST).create(PASS, contents());
    expect(() => restoreBackup(to, exportBackup(to)!)).toThrow(/already has a vault/);
  });
});

describe("the key derivation", () => {
  it("uses Argon2id at OWASP's first recommended setting by default", async () => {
    const backing = memory();
    await new BrowserVault(backing).create(PASS, contents());
    expect(ARGON2).toEqual({ m: 19_456, t: 2, p: 1 });
    expect(JSON.parse(backing.raw.get(STORAGE_KEY)!)).toMatchObject({ v: 2, kdf: "argon2id", m: 19_456, t: 2, p: 1 });
    expect((await new BrowserVault(backing).open(PASS)).db.values.get("k1")).toBe(VALUE);
  });

  it("opens a vault from before Argon2id and re-seals it in the new format", async () => {
    // Seal a format 1 vault the way the previous version did: PBKDF2-SHA256.
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(PASS), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const plain = JSON.stringify({ db: { ...emptyDb(), values: [["k1", VALUE]] }, audit: [] });
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode("devledger/web-vault/v1") },
        key,
        new TextEncoder().encode(plain),
      ),
    );
    const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
    const backing = memory();
    backing.set(STORAGE_KEY, JSON.stringify({ v: 1, kdf: "pbkdf2-sha256", rounds: 100_000, salt: b64(salt), iv: b64(iv), ct: b64(ct) }));

    await expect(new BrowserVault(backing, FAST).open("not the passphrase at all")).rejects.toBeInstanceOf(WrongPassphrase);
    expect(JSON.parse(backing.raw.get(STORAGE_KEY)!).v).toBe(1);

    const opened = await new BrowserVault(backing, FAST).open(PASS);
    expect(opened.db.values.get("k1")).toBe(VALUE);
    const upgraded = JSON.parse(backing.raw.get(STORAGE_KEY)!);
    expect(upgraded).toMatchObject({ v: 2, kdf: "argon2id", ...FAST });
    expect(upgraded.salt).not.toBe(b64(salt));
    expect((await new BrowserVault(backing, FAST).open(PASS)).db.values.get("k1")).toBe(VALUE);
  });

  it("refuses a backup whose cost could freeze the tab or is too cheap to protect it", () => {
    const shape = { salt: "c2FsdA==", iv: "aXY=", ct: "Y3Q=" };
    expect(isBackup(JSON.stringify({ v: 2, kdf: "argon2id", ...FAST, ...shape }))).toBe(true);
    expect(isBackup(JSON.stringify({ v: 2, kdf: "argon2id", m: 4_000_000, t: 2, p: 1, ...shape }))).toBe(false);
    expect(isBackup(JSON.stringify({ v: 2, kdf: "argon2id", m: 1_024, t: 1, p: 1, ...shape }))).toBe(false);
    expect(isBackup(JSON.stringify({ v: 1, kdf: "pbkdf2-sha256", rounds: 1_000, ...shape }))).toBe(false);
    expect(isBackup(JSON.stringify({ v: 3, kdf: "argon2id", ...FAST, ...shape }))).toBe(false);
  });
});
