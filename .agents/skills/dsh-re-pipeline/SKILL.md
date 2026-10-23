---
name: dsh-re-pipeline
description: >
  dsh-tap 巨型二进制/上游桌面端逆向分析流水线（WSL + Ghidra 直跑纪律）：何时
  绕开 REA 包裹层、导入先落库的三步流水线、跨 shell 层传参纪律、needle 形态
  矩阵、验收双条件、产出落库规范。当需要分析上游桌面端/二进制目标（Trae
  harness.dll / ai_agent.dll、Qoder CN app.asar、qoder_auth.wasm 等），或要
  复用已落库的 Ghidra 工程继续挖掘时使用。通用调查方法与 REA MCP 工具族见
  用户级 skill reverse-engineer-anything。
  触发词：逆向、反编译、harness.dll、ai_agent.dll、Ghidra、REA、WSL 分析、
  app.asar、qoder_auth.wasm、strings、xref。
license: MIT
---

# dsh-tap 逆向分析流水线

触发场景：需要分析上游桌面端/二进制目标时（Trae `harness.dll`、`ai_agent.dll`、
Qoder CN `app.asar`、`qoder_auth.wasm` 等）。**通用调查方法（MCP 工具族、证据
模型、调查工作流）加载用户级 skill `reverse-engineer-anything`（REA 官方）**；
本 skill 只沉淀本仓实战纪律，不复制其内容。

## 硬边界：巨型目标（百 MB 级）禁止走 REA 固定窗口模式

REA 的 Ghidra provider = 固定启动窗口（`REA_GHIDRA_STARTUP_TIMEOUT_MS`）+ 临时
工程 `-deleteProject`——超时/被杀即清零。2026-10-10/11 实战中 202MB 的
harness.dll 因此烧掉两轮多（REA 窗内 OOM 一次 + 30min/4h 窗口各超时一次，直跑
6.5h 因无检查点也归零）。**百 MB 级目标一律走下文 WSL 直跑 Ghidra 流水线**。
另两条实测边界：REA Windows P0 只收 PE **EXE**（DLL 不收）；REA 分析无中途
检查点。REA 仍适用的面：JS/Electron 静态分析（`analyze-javascript-application`
免引擎）、中小 native 目标、网页/抓包分析、agent 内对话式调查。

## 环境（WSL Ubuntu-22.04，已在开发机装妥）

- Ghidra 12.1.4 = `/root/tools/ghidra_12.1.4_PUBLIC`；JDK 21 = `/root/tools/jdk-21`
  （PATH/JAVA_HOME/GHIDRA_INSTALL_DIR 已入 `~/.profile`；堆 6G、启动时限 4h）。
- 健康检查：`wsl.exe -d Ubuntu-22.04 -- bash -lc 'rea doctor --provider ghidra --json'`。
- 脚本目录 `/root/scripts/`：`DisableHeavy.java`（禁重分析器）、`DigApiRoutes.java`
  （needle → xref → 调用函数清单）、`DecompileTargets.java`（定点反编译）。
- 已分析落库工程：`/root/targets/ghidra-proj`（harness.dll，524k 函数/2.2M 符号）、
  `/root/targets/ghidra-proj2`（ai_agent.dll）——**查询秒级，勿重复分析**。

## 标准流水线（三步，新目标照抄）

1. **导入先落库**（先保地基）：
   `analyzeHeadless <proj目录> <工程名> -import <目标> -noanalysis -log <日志>`
   （192MB 实测 60s、278MB 实测 225s；`-import` 模式 save-at-end——全程只此一次
   save，此时被杀只亏 60 秒）。
2. **轻量分析**（禁长尾 + 超时保险）：
   `analyzeHeadless <proj> <工程名> -process <文件名> -scriptPath /root/scripts
   -preScript DisableHeavy.java -postScript <挖掘脚本> -analysisTimeoutPerFile 3600
   -log <日志>`。
   DisableHeavy 禁 `Decompiler Switch Analysis` / `Decompiler Parameter ID`
   （实测两者占全量分析 **95.7%** 时间，而 xref/函数边界在流水线早期就建好）；
   `- One Time` 变体在本版本不存在，脚本容错跳过（stderr 有 ERROR 行但无碍）。
   参考耗时：192MB ≈ 87 分钟、278MB ≈ 79 分钟。
3. **验收双条件**（防把超时半成品当完成品）：stdout 出现 `Save succeeded` **且**
   `ANALYSIS_TIMEOUT=false`。超时打断照样 Save（部分落库），必须靠标记区分。
   注意：超时标记 API 真名是 **`analysisTimeoutOccurred()`**（`HeadlessScript`
   上，javap 实证；README 写的 `getHeadlessAnalysisTimeoutStatus()` 在 12.1.4
   不存在），脚本必须 `extends HeadlessScript`。改脚本后若报旧编译错，清
   `~/.config/ghidra/*/osgi/compiled-bundles`（OSGi 缓存会记住编译失败）。

## 跨 shell 层纪律（Git Bash → wsl.exe → bash）

- 命令串里 **`$变量` 会被中间层提前展开成空**（探针：`export FOO=bar; echo
  "X${FOO}X"` 打出 `XX` 即中招）——一律绝对路径、零 `$`；脚本/文件内容用
  base64 包裹传输（`echo <b64> | base64 -d > 目标`），heredoc 引号界定符会失效。
- `pkill -f <模式>` 会匹配调用壳自身——必须括号写法 `pkill -f "[A]nalyzeHeadless"`。
- WSL 内存配置在 `C:\Users\<用户>\.wslconfig`（本机 memory=10GB / swap=8GB；
  默认 7.6GB 跑 200MB 级目标必 OOM）。

## 挖掘纪律

- **needle 形态矩阵先行**：文档记的 URL 形态（`/api/agent/v3`）≠ 二进制存储
  形态（`api/agent/v3`，无前导斜杠、运行时拼接）。先用原始字节多形态扫描
  （有/无前导 × ASCII/UTF-16）锁定存储形态再进分析器层，否则假阴性误判漂移。
- 定点反编译用 `DecompInterface.decompileFunction` 按函数取——不要为几个函数
  开全量反编译。
- 分析期日志静默是正常的（非反编译分析器不写日志）；活性判据 = jstack 栈帧在
  `AnalysisScheduler.runAnalyzer` + CPU TIME 增长 + RSS 有 GC 循环——别只看
  CPU 数字判卡死。

## 产出纪律

- 证据脱敏后落盘 `docs/probes/`（踩坑 #26），命名 `<主题>-<日期>.<ext>`。
- 结论按类别进 `docs/reverse/`（协议面档案）或 `docs/rules/`（网关事实）。
- 新坑进 `docs/pitfalls.md` 取新编号 + AGENTS.md 踩坑速查加标签。

## 相关踩坑（细节 grep docs/pitfalls.md 对应编号）

#22 逆向档案非协议真相 · #26 响应整体脱敏 · #69 跨 shell 层 $VAR 被吃 ·
#70 pkill 自匹配 · #71 Ghidra save-at-end / 超时双判据 / HeadlessScript API ·
#72 needle 形态矩阵
