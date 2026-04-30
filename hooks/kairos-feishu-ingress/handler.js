import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const handler = async (event) => {
  if (event?.type !== "message" || event?.action !== "received") return;
  const context = event.context ?? {};
  const workspaceDir = context.workspaceDir ?? process.cwd();
  const repoDir = resolveRepoDir(workspaceDir);
  const channel = String(context.channelId ?? context.metadata?.channel ?? context.metadata?.provider ?? "");
  const text = String(context.content ?? context.bodyForAgent ?? context.text ?? "").trim();

  log(repoDir, {
    at: new Date().toISOString(),
    phase: "received",
    type: event.type,
    action: event.action,
    channel,
    repoDir,
    context_keys: Object.keys(context),
    metadata_keys: context.metadata ? Object.keys(context.metadata) : [],
    content_preview: text.slice(0, 80),
  });

  if (channel && !channel.includes("feishu") && context.metadata?.provider !== "feishu" && context.metadata?.channel !== "feishu") return;
  if (!text) return;

  try {
    ensureBuilt(repoDir);
    const [{ createMemoryStore }, { runFeishuWorkflow }, { sendFeishuInteractiveWebhook, redactWebhookUrl }, { loadEnvValue }] = await Promise.all([
      importFromRepo(repoDir, "dist/memory/storeFactory.js"),
      importFromRepo(repoDir, "dist/workflow/feishuWorkflow.js"),
      importFromRepo(repoDir, "dist/feishuWebhook.js"),
      importFromRepo(repoDir, "dist/llm/config.js"),
    ]);
    const store = createMemoryStore({
      store: process.env.KAIROS_STORE ?? "jsonl",
      db: resolve(repoDir, "data/memory.jsonl"),
      events: resolve(repoDir, "data/memory_events.jsonl"),
    });
    const output = runFeishuWorkflow(store, { text, project: process.env.KAIROS_PROJECT ?? "kairos" });
    let sent;
    let webhook;
    if (process.env.KAIROS_HOOK_SEND_FEISHU === "1" && output.action === "push_decision_card" && output.card) {
      const webhookUrl = process.env.KAIROS_FEISHU_WEBHOOK_URL ?? loadEnvValue("KAIROS_FEISHU_WEBHOOK_URL", resolve(repoDir, ".env"));
      if (!webhookUrl) throw new Error("KAIROS_HOOK_SEND_FEISHU=1 but KAIROS_FEISHU_WEBHOOK_URL is missing");
      sent = await sendFeishuInteractiveWebhook(webhookUrl, output.card);
      webhook = redactWebhookUrl(webhookUrl);
    }
    log(repoDir, {
      at: new Date().toISOString(),
      sessionKey: event.sessionKey,
      channel,
      output,
      sent,
      webhook,
    });
  } catch (error) {
    log(repoDir, {
      at: new Date().toISOString(),
      sessionKey: event.sessionKey,
      channel,
      error: String(error).slice(0, 1000),
    });
  }
};

function importFromRepo(repoDir, relativePath) {
  return import(pathToFileURL(resolve(repoDir, relativePath)).href);
}

function log(repoDir, item) {
  const path = resolve(repoDir, "runs/kairos-feishu-ingress.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(item)}\n`);
}

function ensureBuilt(repoDir) {
  const required = [
    "dist/memory/storeFactory.js",
    "dist/memory/jsonlStore.js",
    "dist/workflow/feishuWorkflow.js",
    "dist/feishuWebhook.js",
    "dist/llm/config.js",
  ];
  const missing = required.filter((item) => !existsSync(resolve(repoDir, item)));
  if (missing.length > 0) {
    throw new Error(`Kairos dist/ is missing required files: ${missing.join(", ")}. Run \`npm run build\` before linking, or install a packaged release built by \`npm pack\`.`);
  }
}

function resolveRepoDir(workspaceDir) {
  if (process.env.KAIROS_REPO_DIR) return process.env.KAIROS_REPO_DIR;
  const hookDir = dirname(fileURLToPath(import.meta.url));
  const packageRootFromHook = resolve(hookDir, "../..");
  const normalized = workspaceDir.replace(/\/$/, "");
  const candidates = [
    packageRootFromHook,
    "/home/ecs-user/.openclaw/workspace/memoryops",
    `${normalized}/memoryops`,
    normalized,
    process.cwd(),
  ];
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, "package.json"))) return candidate;
  }
  return packageRootFromHook;
}

export default handler;
