import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareModels } from "../src/prepare-models.ts";
import { REPO_ROOT, tempWork } from "./helpers.ts";

it("prepares real pinned models from an empty cache and verifies them in a fresh offline process", async () => {
  const root = tempWork("kamiyobi-prepare-models-");
  await expect(prepareModels(root, true)).rejects.toMatchObject({
    diagnostic: { code: "MODEL_NOT_READY" },
  });
  const models = await prepareModels(root);
  expect(models).toEqual([
    { id: "Xenova/all-MiniLM-L6-v2", revision: "751bff37182d3f1213fa05d7196b954e230abad9" },
    {
      id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
      revision: "2c4055b12046f11709e9df2c122e59ffbdc2f900",
    },
  ]);
  mkdirSync(join(root, "src"));
  for (const file of ["prepare-models.ts", "embedding-runtime.ts", "semantic-model-error.ts"])
    cpSync(join(REPO_ROOT, "src", file), join(root, "src", file));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(
    join(root, "offline.ts"),
    'import {env} from "@huggingface/transformers"; env.allowRemoteModels=false; env.fetch=async()=>{throw new Error("unexpected external request")}; import {prepareModels} from "./src/prepare-models.ts"; console.log(JSON.stringify(await prepareModels(import.meta.dirname,true)));',
  );
  const child = spawnSync(process.execPath, [join(root, "offline.ts")], {
    cwd: root,
    encoding: "utf8",
    timeout: 120000,
  });
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual(models);
  for (const file of ["public", "data", "embeddings.json"])
    expect(existsSync(join(root, file))).toBe(false);
}, 600000);
