import { spawnSync } from "node:child_process";

export type LarkCliStatus = {
  installed: boolean;
  version?: string;
  auth_checked: boolean;
  auth_ok?: boolean;
  auth_summary?: string;
  error?: string;
};

export function checkLarkCliStatus(options: { checkAuth?: boolean } = {}): LarkCliStatus {
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

  const auth = spawnSync("lark-cli", ["auth", "status", "--format", "json"], { encoding: "utf8", timeout: 15_000 });
  status.auth_checked = true;
  status.auth_ok = auth.status === 0;
  status.auth_summary = (auth.stdout || auth.stderr || "").trim().slice(0, 1000);
  return status;
}
