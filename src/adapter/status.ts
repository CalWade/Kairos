import { spawnSync } from "node:child_process";

export type LarkCliStatus = {
  installed: boolean;
  version?: string;
  auth_checked: boolean;
  auth_ok?: boolean;
  auth_summary?: string;
  error?: string;
};

export type LarkCliPurpose = "chat_messages" | "message_search" | "doc_fetch" | "event_consume";

export type LarkCliPreflight = {
  purpose: LarkCliPurpose;
  installed: boolean;
  auth_ok: boolean;
  granted_scopes: string[];
  required_scopes: string[];
  missing_scopes: string[];
  recommended_command?: string[];
  notes: string[];
};

const REQUIRED_SCOPES: Record<LarkCliPurpose, string[]> = {
  chat_messages: ["im:message.group_msg:get_as_user"],
  message_search: ["search:message"],
  doc_fetch: ["docs:document.content:read"],
  event_consume: [],
};

/**
 * 探测本机 lark-cli 状态：是否安装、可选检查 auth 状态 / profile 授权摘要。
 * 永远不抛错，失败信息写进返回的 error 字段。
 */
export function checkLarkCliStatus(options: { checkAuth?: boolean; profile?: string } = {}): LarkCliStatus {
  const version = spawnSync("lark-cli", ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (version.error || version.status !== 0) {
    return {
      installed: false,
      auth_checked: false,
      error: version.error ? String(version.error) : (version.stderr || "lark-cli not found").trim(),
    };
  }

  const status: LarkCliStatus = {
    installed: true,
    version: (version.stdout || version.stderr).trim(),
    auth_checked: false,
  };

  if (!options.checkAuth) return status;

  const authArgs = ["auth", "status", ...(options.profile ? ["--profile", options.profile] : [])];
  const auth = spawnSync("lark-cli", authArgs, { encoding: "utf8", timeout: 15_000 });
  status.auth_checked = true;
  status.auth_ok = auth.status === 0 && !/not logged|未登录|no credential|no auth/i.test(`${auth.stdout}\n${auth.stderr}`);
  status.auth_summary = (auth.stdout || auth.stderr || "").trim();
  return status;
}

/**
 * 按数据获取用途（chat_messages / message_search / doc_fetch / event_consume）
 * 检查当前 lark-cli profile 是否已授权所需 scope，产出清单 + 补授权命令。
 */
export function preflightLarkCliPurpose(
  purpose: LarkCliPurpose,
  options: { profile?: string } = {},
): LarkCliPreflight {
  const status = checkLarkCliStatus({ checkAuth: true, profile: options.profile });
  const granted = parseGrantedScopes(status.auth_summary ?? "");
  const required = REQUIRED_SCOPES[purpose];
  const missing = required.filter((scope) => !granted.includes(scope));
  return {
    purpose,
    installed: status.installed,
    auth_ok: !!status.auth_ok,
    granted_scopes: granted,
    required_scopes: required,
    missing_scopes: missing,
    recommended_command: missing.length
      ? ["lark-cli", "auth", "login", "--scope", missing.join(" "), ...(options.profile ? ["--profile", options.profile] : [])]
      : undefined,
    notes: buildPreflightNotes(purpose, status.installed, !!status.auth_ok, missing),
  };
}

function parseGrantedScopes(authSummary: string): string[] {
  try {
    const parsed = JSON.parse(authSummary) as { scope?: unknown };
    if (typeof parsed.scope === "string") return parsed.scope.split(/\s+/).filter(Boolean);
  } catch {}
  const match = authSummary.match(/"scope"\s*:\s*"([^"]+)"/);
  if (match) return match[1].split(/\s+/).filter(Boolean);
  return [];
}

function buildPreflightNotes(purpose: LarkCliPurpose, installed: boolean, authOk: boolean, missing: string[]): string[] {
  if (!installed) return ["本机未安装 lark-cli：npm install -g @larksuite/cli"];
  if (!authOk) return ["lark-cli 未完成有效授权：先运行 lark-cli config init --new 和 lark-cli auth login --recommend"];
  if (missing.length) return [
    `当前授权缺少 ${missing.join(", ")}`,
    "如果租户/应用不允许授予该 scope，可改用飞书导出文件或 OpenClaw 飞书工具作为数据来源。",
  ];
  return [`${purpose} 所需 lark-cli scope 已满足`];
}
