import { randomBytes, createHash } from "node:crypto";
import fs from "node:fs";

export interface SeedRecord {
  raw: string; // hex, SECRET until revealed
  hash: string; // hex sha256(raw), safe to publish
  committedAt: number;
  revealed: boolean;
}

export interface SeedStoreData {
  current: SeedRecord;
  retired: SeedRecord[];
}

export function newSeedRecord(): SeedRecord {
  const raw = randomBytes(32);
  const hash = createHash("sha256").update(raw).digest();
  return { raw: raw.toString("hex"), hash: hash.toString("hex"), committedAt: Date.now(), revealed: false };
}

export function loadStore(path: string): SeedStoreData {
  if (!fs.existsSync(path)) {
    const data: SeedStoreData = { current: newSeedRecord(), retired: [] };
    saveStore(path, data);
    return data;
  }
  return JSON.parse(fs.readFileSync(path, "utf-8"));
}

export function saveStore(path: string, data: SeedStoreData): void {
  // mode 0o600: this file holds secret seeds, never commit it (see .gitignore).
  fs.writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function rotateSeed(path: string): SeedStoreData {
  const data = loadStore(path);
  data.retired.push(data.current);
  data.current = newSeedRecord();
  saveStore(path, data);
  return data;
}

export function findSeedByHash(store: SeedStoreData, hash: string): SeedRecord | undefined {
  if (store.current.hash === hash) return store.current;
  return store.retired.find((s) => s.hash === hash);
}
