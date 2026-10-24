import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";

/** Feed generated Node programs through stdin: Linux limits each argv value to 128 KiB. */
export function spawnScript(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
  const evalIndex = command === "node" ? args.indexOf("-e") : -1;
  if (evalIndex < 0) return spawnSync(command, args, options);
  const source = args[evalIndex + 1];
  const stdinArgs = [...args];
  stdinArgs.splice(evalIndex, 2, "-");
  return spawnSync(command, stdinArgs, { ...options, input: source });
}
