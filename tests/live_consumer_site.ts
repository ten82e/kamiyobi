import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Build from raw sources and explicit empty paper profiles, with only pretrained weights reused. */
export function prepareLiveConsumerSite() {
  const repo = join(import.meta.dirname, "..");
  const root = mkdtempSync(join(tmpdir(), "kamiyobi-live-consumers-"));
  for (const name of ["src", "site"])
    cpSync(join(repo, name), join(root, name), { recursive: true });
  mkdirSync(join(root, "tests/fixtures"), { recursive: true });
  cpSync(join(repo, "tests/full_venue_pool.ts"), join(root, "tests/full_venue_pool.ts"));
  cpSync(
    join(repo, "tests/fixtures/full-pool-sources"),
    join(root, "tests/fixtures/full-pool-sources"),
    { recursive: true },
  );
  mkdirSync(join(root, "data"));
  for (const name of ["manual.yaml", "curated.generated.yaml", "overrides.yaml"])
    cpSync(join(repo, "data", name), join(root, "data", name));
  for (const name of ["config.yaml", "package.json", "tsconfig.json"])
    cpSync(join(repo, name), join(root, name));
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
  const forbidden = [
    "data/snapshot.json",
    "data/venue-profiles.json",
    "data/recommender-reranker.json",
  ];
  for (const name of forbidden)
    if (existsSync(join(root, name))) throw new Error(`generated input: ${name}`);
  writeFileSync(
    join(root, "prepare.mjs"),
    `
import fs from "node:fs";
import {load} from "js-yaml";
import {env} from "@huggingface/transformers";
import {freshFullVenuePool} from "./tests/full_venue_pool.ts";
import {setRoot,buildAll} from "./src/build.ts";
const pool=freshFullVenuePool();
env.cacheDir=${JSON.stringify(join(repo, ".cache/embedding-models"))};
env.allowRemoteModels=false;
setRoot(import.meta.dirname);
const config=load(fs.readFileSync("config.yaml","utf8"));
const stats=await buildAll(pool.conferences,config,"public",new Date("2026-10-14T00:00:00Z"),{venuePapers:{},reranker:null,localEmbeddingsOnly:true});
if(!stats.files.includes("embeddings.json"))throw new Error("actual model output missing");
console.log(JSON.stringify(stats));
fs.rmSync(pool.raw,{recursive:true,force:true});
`,
  );
  execFileSync(process.execPath, [join(root, "prepare.mjs")], {
    cwd: root,
    timeout: 600000,
    maxBuffer: 8 * 1024 * 1024,
  });
  for (const name of forbidden)
    if (existsSync(join(root, name))) throw new Error(`generated input: ${name}`);
  const data = JSON.parse(readFileSync(join(root, "public/data.json"), "utf8"));
  if (
    data.conferences.length !== 696 ||
    data.conferences.some((conf: { papers: unknown[] }) => conf.papers.length)
  )
    throw new Error("consumer fixture lost venues or imported paper profiles");
  return root;
}
