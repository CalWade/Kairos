/**
 * 判断 lark-cli JSON 记录是否为"噪声"，不应进入 Kairos 记忆管线。
 *
 * 当前命中条件：
 * 1. msg_type 为 interactive / post（通常是 lark-cli 或机器人自己发的卡片 / 富文本）
 * 2. 内容含 lark-cli 登录 OAuth 链接或卡片标签
 * 3. 内容是飞书撤回 / 损坏消息占位（"[Invalid text JSON]" / "[deleted]"）
 *
 * 注意：sender_type=="app" 本身不再作为噪声理由，避免把自定义机器人
 * webhook、合法 bot 的正常文本消息误过滤。
 */
export function isLarkCliNoiseRecord(record: Record<string, unknown>): boolean {
  if (record.msg_type === "interactive" || record.msg_type === "post") return true;
  const raw = String(record.content ?? record.text ?? "").trim();
  if (raw.startsWith("<card>") || raw.includes("open.feishu.cn/page/cli") || raw.includes("accounts.feishu.cn/oauth")) return true;
  if (raw === "[Invalid text JSON]" || raw === "[deleted]") return true;
  return false;
}
