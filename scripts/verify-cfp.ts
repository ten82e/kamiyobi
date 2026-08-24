import { existsSync } from "node:fs";
import { type PromotionObservation, resolvePromotion, verifyBatch } from "../src/promotion.ts";

const argv = process.argv.slice(2);
const source = argv[0] === "--file" ? argv[1] : argv[0];
if (!source) process.exitCode = 2;
else {
  if (existsSync(source)) process.stdout.write(`${JSON.stringify(verifyBatch(source))}\n`);
  else
    process.stdout.write(
      `${JSON.stringify(resolvePromotion(JSON.parse(source) as PromotionObservation))}\n`,
    );
}
