# PlaceMill

简体中文 | [English](./README.md)

在 Google Maps 网页版上采集商家数据的 Windows 桌面工具（Tauri v2 + React + Ant Design）：左侧是控制面板，右侧是真实的 Google Maps。给定关键词、中心点与半径，它会在地图里按网格自动逐格采集商家。

核心能力：

- **区域采集**：给定关键词 + 中心点 + 半径，自动按网格逐格移动地图并收集结果；结果密集的格子会自动四分成更小的格子（自适应细分），保证覆盖不漏
- **任务队列**：多个关键词一次入队，自动逐个执行；程序崩溃或重启后可从断点继续，已完成的格子不会重跑；地图停在同意页/验证码等死页时任务会自动暂停，不会白烧请求
- **数据管理**：按名称/评分/联系方式/类型筛选，SQL 分页浏览（十万行级别依然流畅），一键导出 Excel / CSV，或复制电话
- **邮箱与社媒挖掘**：访问商家网站及其联系页，提取邮箱与社媒链接（可选，默认关闭）
- **可观测**：诊断抽屉实时显示采集状态、数据库行数、分页查询 P95 与最近错误

## 系统要求

- Windows 10 / 11（依赖系统自带的 WebView2 运行时，Win11 通常已内置）
- 一个可正常使用 Google Maps 的网络环境（应用内嵌的就是 maps.google.com 页面）

## 安装

1. 从 [最新 Release](https://github.com/usedel/placemill/releases/latest) 下载 `PlaceMill_<版本>_x64-setup.exe` 直接运行，无需任何开发环境
2. 首次启动时 SmartScreen 可能提示未签名程序：点「更多信息 → 仍要运行」（Authenticode 代码签名证书在计划中，到位前所有构建均为未签名）
3. 启动后左右分栏：左侧控制面板，右侧 Google Maps

应用会从这些 Release 自动更新，不必再手动下载安装包。从源码构建仅在开发时需要，见下文「开发」。

## 首次运行

1. 在右侧地图页登录你的 Google 账号（和平时用浏览器一样）
2. 如果出现 Cookie 同意页，先手动完成同意，再使用采集功能
3. 点面板顶部的「新建任务」，填好关键词与半径后开始采集；顶部状态会显示「采集中」与已用时长

## 采集方式

所有采集都由任务驱动。点面板顶部的「新建任务」：

| 字段 | 说明 |
|---|---|
| 关键词 | 支持一次填多个，每个关键词一个任务 |
| 中心点 | 自动取当前地图中心，也可手动填坐标 |
| 半径 / 格子 | 半径越大、格子越小，格数越多（上限 200 格）；对话框会实时预估格数与时长 |
| 细分阈值 | 单格结果达到该数量（默认 100，上限约 120）就自动拆成 4 个更小的格子，最多 3 层 |

任务进入队列后自动逐个执行，可随时暂停 / 继续 / 取消 / 删除。**采集过程中请勿操作右侧地图**，否则会干扰正在运行的格子。

## 数据存在哪里

- 本地 SQLite：`%APPDATA%\com.placemill.app\placemill.db`
- 导出文件：默认目录可在设置中修改，文件名模板支持 `{date}` 占位
- 「清空数据」只删除商家数据，不影响任务记录；诊断抽屉可查看数据库路径、行数与查询性能

## 故障排查

| 现象 | 处理 |
|---|---|
| 任务在跑但没有新数据 | 任务连续 90 秒没有新数据或格子进展时，面板会弹出告警卡片；多半是地图页停在同意页 / 验证码 / 登录过期。到右侧手动处理后，点卡片上的「刷新地图」或「重新开始采集」 |
| 网格任务自己变成「暂停」 | 死页看门狗触发了：地图页连续多格无响应（多半是同意页/验证码）。处理掉那个页面后按「继续」 |
| 某些格子显示失败 | 单格会自动重试 2 次；仍失败的任务可在队列中重新开始，已完成的格子不会重跑 |
| 结果里出现重复 | 正常情况下不会：三层去重（脚本 / 数据库 / 界面）。如遇到请提 issue 并附诊断抽屉里的错误信息 |
| 表格卡顿 | 不应发生（分页查询 P95 < 100ms）；可在诊断抽屉确认，若异常请反馈 |

## 合规提醒

本工具自动化的是你自己在浏览器里的正常浏览行为，请遵守 Google 服务条款，控制采集频率与规模，仅将数据用于合法用途。本项目与 Google 无任何隶属或合作关系；"Google Maps" 是 Google LLC 的商标，此处仅为描述工具的交互对象。

---

## 开发

### 环境要求

- Node.js >= 18
- Rust stable（[rustup](https://rustup.rs)；构建报错先 `rustup update`）
- Windows 10+（WebView2 运行时，Win11 自带）

### 日常命令

```bash
npm install          # 安装依赖
npm run tauri dev    # 开发运行
npm run build        # 前端构建检查（tsc + vite build）
cargo test --lib     # Rust 单元测试（在 src-tauri/ 下）
```

### 端到端套件

Windows 真实启动应用驱动（CDP），会临时备份并恢复数据库：

```bash
npm run e2e:settings    # 设置持久化
npm run e2e:grid        # 网格采集
npm run e2e:queue       # 队列与断点续跑
npm run e2e:tasks       # 任务视图
npm run e2e:browse      # 分页浏览
npm run e2e:interceptor # 注入脚本
npm run e2e:emails      # 邮箱挖掘
npm run e2e:real        # 真实抓取（网络依赖）
npm run e2e:probe       # 字段索引探针（debug 构建）
npm run bench:grid-ab   # 网格 A/B 基准
```

`e2e:real` 会真实向 Google 发起搜索，受网络、账号态与同意页影响；失败先看 `tauri dev` 尾部日志，不要直接当成代码回归。其余套件用假关键词，只验证状态机。

### 打包

```bash
npm run build:release    # NSIS 安装包（默认）
npm run build:msi        # MSI 安装包
npm run build:clean      # 清理后重新打包
npm run tauri build      # 等价于 build:release
```

或直接使用脚本：`.\build.ps1`（`-Dev` 开发构建、`-Clean` 清理重建、`-Target msi|all`）。

### 签名与发布（自动更新）

应用通过 `tauri-plugin-updater` 检查更新：启动时静默检查一次，设置抽屉里也可手动「检查更新」；发现新版本后弹窗展示更新内容，确认即下载并自动重启。更新端点配置在 `src-tauri/tauri.conf.json` 的 `plugins.updater.endpoints`（GitHub Releases 的静态 `latest.json`，换托管只需改这一处；请求由 Rust 发起，不受面板 CSP 约束）。

发布由 CI 完成：[`.github/workflows/release.yml`](.github/workflows/release.yml) 在每次推送 `v*` tag 时构建 NSIS 安装包、生成 `latest.json` 并创建 Release。非开发者直接从 Releases 页面下载安装即可。

**一次性配置**：

1. **生成签名密钥**（私钥永远不要入库）：

   ```bash
   npm run signer:generate -- -w %USERPROFILE%\.tauri\placemill.key
   ```

2. 把输出的 public key 填进 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。

3. 在仓库 Secrets 里添加私钥 —— `TAURI_SIGNING_PRIVATE_KEY`（整个密钥文件内容）与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（生成时设了密码才需要）：

   *Settings → Secrets and variables → Actions → New repository secret*

**发版步骤**：

1. 同步提升 `src-tauri/tauri.conf.json`、`package.json`、`src-tauri/Cargo.toml` 里的 `version`。
2. 提交后打 tag 并推送：`git tag v0.1.1 && git push origin v0.1.1`。
3. CI 构建安装包、写入 `latest.json` 并发布 Release；客户端下次检查更新即可收到。tag 与版本号不一致时工作流会直接失败，避免发出错误版本。

本地想手工验证自动更新时，才需要带签名构建：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = "$env:USERPROFILE\.tauri\placemill.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<密钥密码>"   # 生成时设了密码才需要
.\build.ps1
```

`scripts/release-latest-json.mjs` 会在 bundle 目录旁生成 `latest.json`。

4. **签名远端解析配置**（改动 `parser-config.json` 时）：应用只接受带
   `parser-config.json.sig` 且能通过内置公钥校验的配置；未签名或被篡改的配置会被
   丢弃，回退到上次验签通过的缓存（再不行用内置映射）。

   ```powershell
   node scripts/sign-parser-config.mjs D:\path\to\parser-config.json
   ```

   把 `parser-config.json` 与 `parser-config.json.sig` **一起**上传到
   `usedel.github.io/placemill-config`：只传 JSON 会让客户端直接拒绝这份配置
   （fail closed），直到 `.sig` 上线为止。公钥是 `remote_config.rs` 里的
   `CONFIG_PUBKEY`（与 `tauri.conf.json` 的 updater `pubkey` 同一把密钥），
   轮换密钥需要发版。

> 说明：minisign 密钥管的是「更新包可信」；安装包本体的 SmartScreen 信誉是另一回事，需要 Authenticode 代码签名证书（采购中），到位前首次安装仍会看到 SmartScreen 提示。

### 项目结构

```
placemill/
├── src/                       # React 前端
│   ├── App.tsx                # 主界面与数据编排（服务端分页取数）
│   ├── components/            # 头部、指标、筛选、任务队列、抽屉、分割条
│   ├── settings/ i18n/ types/ # 偏好、多语言、类型定义
├── src-tauri/                 # Rust 后端
│   ├── src/
│   │   ├── lib.rs             # 应用入口、双 webview 布局、共享状态
│   │   ├── commands.rs        # Tauri 命令（查询、导出、任务队列、诊断）
│   │   ├── collector.rs       # 任务 worker（单飞、重试、死页看门狗）
│   │   ├── grid.rs            # 网格生成与自适应四分几何
│   │   ├── db.rs              # SQLite（业务表 + 任务表 + 迁移）
│   │   └── settings.rs        # 偏好持久化
│   ├── scripts/
│   │   └── intercept.js       # Google Maps 注入脚本
│   └── tauri.conf.json        # 窗口、CSP 与打包配置
├── scripts/e2e/               # 端到端套件（CDP 驱动真实应用）
├── skills/placemill-leads/    # MCP server / Agent Skill（本地库只读出口）
├── docs/                      # 技术文档（英文）
└── build.ps1                  # 打包脚本（NSIS / MSI）
```

### 注入脚本的工作方式

`intercept.js` 通过 Tauri 的 `initialization_script` 注入 Google Maps webview：

1. 猴子补丁 `fetch` 与 `XMLHttpRequest`，匹配商家搜索响应；解析走三条兜底路径（包装对象 / 原始 XSSI 文本 / 正则）
2. 区域采集由 **Rust 调度器**驱动：逐格 `location.href` 硬导航，Rust 在每个新页面重新下发采集开关并启动滚动
3. 每个批次携带来源元数据（关键词 / 任务 / 格子）发给 Rust，三层去重后写入 SQLite，`businesses:updated` 通知面板刷新当前页
4. 滚动停止时发出 `collector:scroll-idle`，调度器据此判定格子完成；连续多格无响应时看门狗自动暂停任务

采集开关由 Rust 持有，每次页面加载后重新下发；`localStorage` 里只留一份镜像，供导航后的瞬间读取。所有数据只写本地 SQLite，不会离开这台机器。

### 技术文档

- [`docs/architecture.md`](docs/architecture.md)：双 webview 架构、数据流水线、任务/网格模型与贡献代码时不可破坏的约束（英文）
- [`docs/parser.md`](docs/parser.md)：拦截与解析层的工作方式、字段索引对照及 Google 改版时的维护指南（英文）
- [`CONTRIBUTING.md`](CONTRIBUTING.md)：构建/测试流程、提交规范与 PR 指南
- [`skills/placemill-leads/SKILL.md`](skills/placemill-leads/SKILL.md)：用 Claude Desktop / CodeBuddy / Cursor 通过 MCP 查询本地线索库

## 镜像

英文用户请访问 GitHub 仓库：[GitHub](https://github.com/usedel/placemill)。

## License

[MIT](LICENSE) © 2026 Placemill contributors
