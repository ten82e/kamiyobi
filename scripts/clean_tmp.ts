/**
 * 検査の使い捨て目録を掃く（第 482 回）。
 *
 * 検査は `$TMPDIR` に一個ずつ目録を作る（`tests/helpers.ts` の `tempWork`）。プロセスが終る時に
 * 自分が作った物は消すが、殺されたワーカーの分は残る – 実測（2026-11-08）で 139 546 個・
 * 約 40 GB に積まつて、ディスクは 97 % まで詰まつた。其れをまとめて掃く入口。
 * 走つて居る検査を壊さぬやう、最終更新が一時間より古い物だけ触る。
 *
 *   npm run clean:tmp                       # 自分の $TMPDIR を掃く（デフォルトは一時間より古い物）
 *   KAMIYOBI_TMP_SWEEP_MINUTES=10 npm run clean:tmp   # PID の読めぬ目録の待つ時間を十分に縮める

 * PID を名前に持つ目録（`tempWork` が作る `…p<PID>-…`）は、其のプロセスが終はつて居れば
 * 何時でも消す – 実測（2026-11-08）で、時間でだけ見ると、長く走つた検査（改ざん検査を連続で
 * 回した時など）の使用中の目録を消してビルドの決定性が割れた為。
 *   node scripts/clean_tmp.ts <目録>     # 指定した目録を掃く
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const 分 = Number(process.env.KAMIYOBI_TMP_SWEEP_MINUTES ?? 60);
const 猶予 = (Number.isFinite(分) && 分 > 0 ? 分 : 60) * 60 * 1000;
const 接頭辞 = /^(?:kamiyobi|cfp|build-now-test|tracked-test|aideadlines-shape|ccfddl-shape)-/;
const 場 = process.argv[2] ?? tmpdir();
const 今 = Date.now();
let 消した = 0;
let 空けた = 0;

function 大きさ(道: string): number {
  let 計 = 0;
  for (const 項 of readdirSync(道, { withFileTypes: true, recursive: true })) {
    if (!項.isFile()) continue;
    try {
      計 += statSync(join(道, 項.name)).size;
    } catch {
      /* 無視 */
    }
  }
  return 計;
}

function 生きて居る(目録名: string): boolean | null {
  const マッチ = /p(\d+)-/.exec(目録名);
  if (!マッチ) return null;
  try {
    process.kill(Number(マッチ[1]), 0); // 何も送らずに存在だけ見る
    return true;
  } catch (誤) {
    return (誤 as NodeJS.ErrnoException).code === "EPERM"; // 有るが触れぬ → 生きて居る
  }
}

for (const 名前 of readdirSync(場)) {
  if (!接頭辞.test(名前)) continue;
  const 道 = join(場, 名前);
  try {
    const 状態 = 生きて居る(名前);
    if (状態 === true) continue; // 走つて居る検査の目録
    if (状態 === null && 今 - statSync(道).mtimeMs <= 猶予) continue; // PID の読めぬ物は時間で守る
    空けた += 大きさ(道);
    rmSync(道, { recursive: true, force: true });
    消した += 1;
  } catch {
    /* 消せなければ見送る */
  }
}

console.log(
  `${場}: 古い目録 ${消した} 個を掃いた（約 ${(空けた / 1048576).toFixed(1)} MB – 一時間以内の物は触つて居ない）`,
);
