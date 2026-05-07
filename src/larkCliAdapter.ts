/**
 * @deprecated 入口保留仅为向后兼容。新代码请直接从 src/adapter/* 导入具体模块。
 *
 * 模块已按职责拆分：
 * - spawn.ts      子进程封装（runLarkCliJson / runLarkCliText）
 * - status.ts     安装 + 授权检查 + preflight
 * - plan.ts       命令计划生成（buildLarkCliPlan，不执行）
 * - normalize.ts  lark-cli JSON → NormalizedMessage + stripRolePrefix
 * - chatInfo.ts   chat 元数据 / 文本提取
 * - noise.ts      噪声判断（隔离撤回占位 / 卡片 / 登录链接）
 */
export { runLarkCliJson, runLarkCliText } from "./adapter/spawn.js";
export {
  type LarkCliStatus,
  type LarkCliPurpose,
  type LarkCliPreflight,
  checkLarkCliStatus,
  preflightLarkCliPurpose,
} from "./adapter/status.js";
export { type LarkCliPlan, buildLarkCliPlan } from "./adapter/plan.js";
export { toNormalizedMessages, stripRolePrefix } from "./adapter/normalize.js";
export {
  type LarkCliChatInfo,
  type LarkCliExtractedText,
  extractChatInfoFromLarkCliJson,
  extractTextsFromLarkCliJson,
} from "./adapter/chatInfo.js";
