import { spawnSync } from "node:child_process";

/**
 * 同步调用 lark-cli 并解析 stdout 为 JSON。
 * 非零退出码时抛出描述性 Error。
 * 带 10MB maxBuffer 限制，超过会报错。
 */
export function runLarkCliJson(args: string[]): unknown {
  const result = spawnSync("lark-cli", args, { encoding: "utf8", timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `lark-cli failed with status ${result.status}`).trim());
  }
  return JSON.parse(result.stdout);
}

/**
 * 同步调用 lark-cli 并返回 {ok, stdout, stderr, status}，不解析也不抛错，
 * 给需要自定义错误处理的上层（比如 CLI 的排障命令）用。
 */
export function runLarkCliText(
  args: string[],
  options: { timeoutMs?: number } = {},
): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("lark-cli", args, {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}
