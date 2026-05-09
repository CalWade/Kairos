#!/usr/bin/env node
/**
 * Kairos CLI 入口。负责 commander program 的组装，把命令注册
 * 委托给 src/cli/ 下的各个模块。
 *
 * 每个模块暴露 register(program: Command)，在内部用 program.command(...)
 * 注册自己管的命令组。新增命令组只需要：
 *   1. 在 src/cli/ 里新建 <group>.ts，export register(program)
 *   2. 在下面 import + 调用
 */
import { Command } from "commander";
import * as evalDashboard from "./cli/eval-dashboard.js";
import * as extract from "./cli/extract.js";
import * as install from "./cli/install.js";
import * as larkCli from "./cli/lark-cli.js";
import * as memory from "./cli/memory.js";
import * as queue from "./cli/queue.js";
import * as workflow from "./cli/workflow.js";

const program = new Command()
  .name("memoryops")
  .description("Kairos: Enterprise long-term collaborative memory engine for Feishu and OpenClaw")
  .version("0.1.0");

install.register(program);       // doctor / setup-wizard / llm:check / schema:check
larkCli.register(program);       // lark-cli 子命令 10 个（runtime / ingest-chat / ...）
extract.register(program);       // extract-decision / segment-chat-export / normalize-chat-export
memory.register(program);        // ingest / add / search / recall / decision-card / list / history / card-feedback
workflow.register(program);      // feishu-workflow
queue.register(program);         // remind / refine / induction 三个子命令组
evalDashboard.register(program); // eval / dashboard

program.parse();
