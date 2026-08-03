import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const idlPath = path.resolve(__dirname, "../../target/idl/mines.json");

if (!fs.existsSync(idlPath)) {
  throw new Error(`IDL not found at ${idlPath} — run \`anchor build\` first.`);
}

export const minesIdl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
