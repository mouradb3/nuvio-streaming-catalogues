import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

const manifest = await readJson(path.join(PUBLIC, "manifest.json"));
if (!manifest.catalogs?.length || !manifest.resources?.includes("catalog") || !manifest.resources?.includes("meta")) {
  throw new Error("Manifest invalide : ressources ou catalogues manquants.");
}
let checked = 0;
for (const catalog of manifest.catalogs) {
  const file = path.join(PUBLIC, "catalog", catalog.type, `${catalog.id}.json`);
  const data = await readJson(file);
  if (!Array.isArray(data.metas)) throw new Error(`Catalogue invalide : ${catalog.id}`);
  checked++;
}
await readJson(path.join(PUBLIC, "status.json"));
await fs.writeFile(path.join(PUBLIC, ".nojekyll"), "", "utf8");
console.log(`Export statique validé : ${checked} catalogues dans public/.`);
