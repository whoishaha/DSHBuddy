# DSHBuddy 🐋

DeepSeek Harness 陪伴宠物插件 —— 一只桌面鲸鱼实时反映你的 DSH 会话状态，陪你写代码。

> Host（Node）订阅 DSH `session/event` 驱动 9 状态宠物状态机；Client（浏览器）在 Web GUI 里渲染宠物浮层、气泡、番茄钟、聊天、统计与成长系统。纯插件方案，无桌面端、无 sidecar，数据全部留在本机（`~/.petdex/`）。

## ✨ 功能

- **宠物浮层双模式**：角落常驻（可拖拽、位置记忆）/ 页面底部自由散步（悬停暂停），一键切换。
- **实时状态动画**：9 状态精灵图（idle / running×2 / wave / jump / fail / wait / run / review），
  对话、工具调用、审批、提问实时驱动，配状态气泡与安慰气泡。
- **状态感知双保险**：事件驱动状态机之外另有 agents 注册表轮询兜底——即使部署环境不投递
  `session/event` 帧，工作/等待状态依旧可靠；调试端点 `GET /api/dshbuddy/debug` 暴露
  状态机与轮询健康度计数。
- **事件音效 🔔**：任务完成 / 需要确认 / 出错分级提示音走 OS 级播放（浏览器静音也能响），设置中可关。
- **睡眠模式 💤**：页面长时间闲置且代理空闲时，鲸鱼会打瞌睡（变暗减速 + 💤 标记）；鼠标靠近即惊醒弹跳。
- **等级成就墙 🏅**：8 大分类 × 21 条成就轨道 × 37 个等级（任务阶梯 / 工具排障 / 团队指挥 / 转生轮回 /
  陪伴羁绊 / 周末战士·夜航员·早起鸟 / 番茄阶梯 / 史诗·闪光收藏）由真实使用数据解锁，
  设置→成长档案内环形完成度 + 分类筛选画廊展示进度，解锁时宠物播报庆祝。
- **金币经济 🪙**：完成任务、跑番茄钟、升级、解徽章都能赚金币；商店可买零食/玩具（限时开心 buff，
  不过期不腐烂）与蝴蝶结/礼帽/围巾配饰（戴上后宠物头顶可见）。
- **市场领养揭示 ✨**：领养新宠物即触发稀有度揭示动画——普通(80%)/稀有(15%)/史诗(5%)三档 +
  1% 闪光变色变体，确定性哈希保证跨设备一致。
- **性格五维调节 🎚**：毒舌/热情/话痨/幽默/温柔五个数值滑杆即时改写 LLM 语气（定性映射进系统提示词）。
- **进化阶段 + 转生 🌟**：Lv1 幼鲸 → Lv5 少年鲸 → Lv10 成年鲸 → Lv20 深渊鲸 → Lv30 星鲸五阶段外观标签；
  Lv30+ 可转生重置成长曲线，成就/亲密度/金币全保留。
- **多会话感知 👂**：并行会话以蓝/紫光点亮在宠物头顶，子代理工作时显示 🎧×n 计数芯片。
- **上下文容量教练 🧠**：探测当前模型上下文窗口并显示容量芯片；会话连续运行过久时琥珀色提醒
  `/compact` 或新开会话（模型未披露容量时自动隐藏整个功能）。
- **鼠标小偷 🐭**：长时间不动鼠标时，宠物会把箭头"叼走"满屏跑；一有动静立刻把箭头送回真实指针
  位置并恢复光标——离开再回来一眼就能找到鼠标。可在设置中开关并调整触发时长（1–15 分钟）。
- **成长系统**：XP / 等级 / 心情 / 精力 / 连续使用 / 强度分级，六维职业雷达与称号演进。
- **LLM 记忆与画像**：每日总结、周报、成长综述、用户画像（走 DSH 自带 LLM，可关、离线自动降级模板）。
- **主动陪伴**：任务完成庆祝、长时间忙碌休息提醒、错误安慰、里程碑祝贺（低频克制可关闭）。
- **番茄钟**：倒计时/正计时、阶段配色圆环、提示音，阶段切换自动让宠物播报气泡。
- **聊天面板**：经 host 代理模型 API（默认复用 DSH 的 LLM 配置，兼容 Ollama/OpenAI/Gemini），
  本地会话持久化。
- **快捷指令**：斜杠命令在当前会话直接执行，自定义指令管理。
- **待办清单 · 工作日历 · 统计仪表盘**（效率/节律/工具流/洞察/纪录 + CSV 导出）。
- **摸头互动 🫶**：长按宠物（或菜单「摸摸头」）触发开心摆动 + 爱心粒子，累积**亲密度**
  （每天上限 20 次，10/50/100/200/500 里程碑有庆祝气泡并写入成长档案）。
- **每日晨报 🌅**：每天早上首次打开页面自动生成：昨日回顾 + 今日待办 + 节日问候 +
  一句鼓励（LLM 撰写，模板兜底），当天只弹一次。
- **番茄钟统计 · 数据打通**：完成的专注分钟进入统计仪表盘（今日/累计/近 7 天柱图）；
  待办勾选完成自动记入当日工作日历，日历记录可一键转为待办。
- **主动关怀系统 💛**：宠物会主动发起对话——时段问候（早安/午安/深夜关怀）、节日祝福（公历节日 +
  已核验年份的农历节日：春节/元宵/端午/中秋）、长时间专注后的喝水·护眼·起身轮换提醒、
  午饭提醒、久未说话时的朋友式搭话、低精力+多报错日的安慰鼓励、晚间一日回顾；
  全部基于真实使用记录与 LLM 生成（离线自动模板兜底），凌晨 1–7 点安静勿扰，每类触发独立限频。
- **在线宠物市场**：浏览 petdex.dev 目录并一键安装切换宠物。
- **设置面板**：DSH 设置内一个「DSHBuddy」入口，15 个标签页覆盖全部功能；深浅色皮肤 + 中英双语。

## 📦 安装（从 GitHub）

前置：已安装 [DeepSeek Harness](https://github.com/deepseek-ai)（`dsh` CLI 可用）、Node.js ≥ 18、npm。

在仓库页面点击 **Code**，复制 HTTPS 地址并克隆仓库。进入项目目录后执行：

```bash
# 安装依赖并构建（产出 lib/index.js + lib/client.js）
npm ci
npm run build

# 安装进 DSH web profile（替换为项目的绝对路径）
dsh plugin --profile web add "/absolute/path/to/dshbuddy"

# 重启 dsh web，刷新页面
```

重启后：

- 页面角落出现鲸鱼宠物（首次运行有欢迎语）；点击宠物打开菜单，可切散步模式、换宠物、开面板。
- 在 DSH 中发起对话 / 工具调用 / 审批，宠物实时切换动画与气泡。
- DSH 设置面板出现「DSHBuddy」入口。

### 更新

```bash
git pull && npm ci && npm run build
# 重启 dsh web 即可（lib 由 profile 以路径引用）
```

### 离线自检

```bash
npm run test          # host API 集成 + client bundle 契约测试
node scripts/verify-live.mjs   # 运行中环境检查（API 可达 / 精灵图 / 统计）
```

### English quickstart

Prerequisites: [DeepSeek Harness](https://github.com/deepseek-ai) installed (the `dsh` CLI works), Node.js ≥ 18, npm.

Copy the HTTPS clone URL from the repository's **Code** menu and clone it. From the project directory, run:

```bash
# Install & build (produces lib/index.js + lib/client.js)
npm ci
npm run build

# Install into the DSH web profile (replace with the project’s absolute path)
dsh plugin --profile web add /absolute/path/to/dshbuddy

# Restart dsh web and refresh the page
```

After restarting:

- A whale pet appears in the corner of the page (with a one-time welcome bubble). Click it for the menu — walker mode, pet switching, panels.
- Chats / tool calls / approvals in DSH drive the pet's animations and bubbles in real time.
- A "DSHBuddy" entry shows up in the DSH settings panel, with four top-level categories and direct access to every feature. The UI is Chinese/English and follows the configured language.

Update later with:

```bash
git pull && npm ci && npm run build
# restart dsh web — lib/ is referenced by path from the profile
```

## ⌨️ 使用速览

| 操作 | 效果 |
|---|---|
| 单击宠物 | 打开菜单（面板 / 切换宠物 / 缩放 / 模式 / 设置 / 隐藏） |
| 拖拽宠物 | 移动位置（松手即保存，刷新后保持） |
| 双击宠物 | 直达设置 |
| Esc | 关闭当前菜单 / 浮层面板 |

## 🗂 数据与配置

全部保存在**本机** `~/.petdex/`，不上传，也不会写进插件的开发/安装文件夹
（可用环境变量 `DSHBUDDY_DATA_DIR` 整体重定向到其他本地目录）：

```
~/.petdex/
├── active.json              # 当前宠物
├── pets/<slug>/             # 宠物资源（pet.json + spritesheet.webp|png）
└── runtime/
    ├── dshbuddy.json        # 插件配置（模式/外观/聊天/性格/番茄钟…）
    ├── stats.json           # 会话统计
    ├── growth.json career.json memory.json profile.json   # 成长系统
    └── chats.json notes.json calendar.json buddy-memory.json
```

## 🧩 架构

```
DSH (web profile)
├── host 半（Node ESM）
│   ├─ 订阅 session/event → PetStateMachine（9 状态 + 气泡 + 陪伴通道）
│   ├─ StatsCollector / GrowthEngine / CareerEngine / MemoryEngine / ProfileEngine
│   └─ 在 DSH webserver 注册同源 API：/api/dshbuddy/*
└── client 半（浏览器 ModuleLoader bundle）
    ├─ shell.overlay：宠物浮层（corner / walker）+ 浮动面板
    └─ settings.section：「DSHBuddy」15 标签页
```

## 🛠 开发

```bash
npm run build:dev   # 带 sourcemap 的开发构建
npm run typecheck   # tsc --noEmit
npm run test        # 离线集成测试
```

- 源码：`src/host/*`（Node）、`src/client/*`（React + esbuild 打包为 CJS ModuleLoader bundle）。
- 默认鲸鱼为程序生成占位图（`assets/whale/`），可直接替换为美术资源（9 行 × N 列，192×208/帧）。

## 📝 Changelog

### v0.1.0 · 首个公开版本

DSHBuddy 的首个公开版本，为 DSH 提供完整的桌面陪伴宠物体验。

- **陪伴与状态感知**：宠物浮层支持角落停留与桌面散步，能感知工作、等待确认、完成和出错等会话状态，并通过动作、气泡、提示音与主动关怀作出反馈。
- **成长档案**：统一展示等级、经验、亲密度、连续陪伴、工作洞察和成长时间线；21 条成就轨道按累计数量逐级解锁，共 37 个等级，并提供金币奖励、进化阶段与转生机制。
- **效率工具**：内置番茄钟、工作安排、快捷指令、待办与笔记日历，让陪伴体验与日常工作节奏相连。
- **个性化体验**：支持中英文界面、性格参数、显示与提醒设置、永久配饰、互动道具，以及宠物外观和浮层模式调整。
- **Petdex 生态接入**：可在插件内浏览、安装和切换 Petdex 社区宠物，并以稀有度与闪光变体呈现领养结果。
- **本地数据与工程质量**：成长、统计和偏好默认保存在本机；采用 host/client 分层结构，提供类型检查、离线集成测试和 GitHub Actions 持续集成。

## 🙏 致谢 / Acknowledgements

特别感谢 [Petdex](https://github.com/crafter-station/petdex) 提供宠物平台与社区生态。DSHBuddy 直接接入了 Petdex，让用户可以在插件内浏览、安装和切换社区宠物。

Special thanks to [Petdex](https://github.com/crafter-station/petdex) for its pet platform and community ecosystem. DSHBuddy integrates directly with Petdex so users can browse, install, and switch community pets from within the plugin.

## 📄 License

[MIT](./LICENSE)
