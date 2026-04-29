import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const handler = async (event: any) => {
  if (event?.type !== "message" || event?.action !== "received") return;
  const context = event.context ?? {};
  const channel = String(context.channelId ?? context.metadata?.channel ?? "");
  if (channel && !channel.includes("feishu") && context.metadata?.provider !== "feishu") return;

  const text = String(context.content ?? context.bodyForAgent ?? "").trim();
  if (!text) return;

  const workspaceDir = context.workspaceDir ?? process.cwd();
  const repoDir = resolveRepoDir(workspaceDir);
  const args = [
    "run", "-s", "dev", "--",
    "feishu-workflow",
    "--project", process.env.KAIROS_PROJECT ?? "kairos",
    "--text", text,
  ];
  if (process.env.KAIROS_HOOK_SEND_FEISHU === "1") args.push("--send-feishu-webhook");

  const result = spawnSync("npm", args, {
    cwd: repoDir,
    encoding: "utf8",
    timeout: Number(process.env.KAIROS_HOOK_TIMEOUT_MS ?? 30000),
    env: process.env,
  });

  log(repoDir, {
    at: new Date().toISOString(),
    sessionKey: event.sessionKey,
    channel,
    status: result.status,
    stdout: safeJson(result.stdout),
    stderr: result.stderr?.slice(0, 500),
  });
};

function log(workspaceDir: string, item: unknown) {
  const path = resolve(workspaceDir, "runs/kairos-feishu-ingress.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(item)}\n`);
}

function resolveRepoDir(workspaceDir: string): string {
  if (process.env.KAIROS_REPO_DIR) return process.env.KAIROS_REPO_DIR;
  const normalized = workspaceDir.replace(/\/$/, "");
  const candidates = [normalized, `${normalized}/memoryops`, process.cwd()];
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, "package.json"))) return candidate;
  }
  return normalized;
}

function safeJson(text: unknown) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed); } catch { return trimmed.slice(0, 1000); }
}

export default handler;
