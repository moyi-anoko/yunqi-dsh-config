# 本机插件清单与本地适配记录

- 环境：DSH 0.2.2-rc.1 · profile `desktop` · 2026-11-11 整理
- 权威来源：`C:\Users\35218\.dsh\profiles\desktop\package.json`（依赖 + bundles）与 `cordis.patch.yml`（配置层）
- 目的：换机器重装、升级插件、排查「明明关了却还在跑」时，先看这一份。

## 0. 三类来源，三种升级风险

| 类型 | 判断依据 | 升级时会发生什么 | 保留难度 |
|---|---|---|---|
| **npm 包** | 版本号（如 `0.9.18`） | `npm install` 覆盖 `node_modules`，本地改动**全部丢失** | 中 |
| **本地 vendor** | `file:` / `link:` 指向 `whale-work/vendor/` | 不自动更新；要更新只能重新拷上游再手工合并 | 高 |
| **本地路径插件** | patch 里直接写 `.js` 路径 | 不受 npm 影响，但也不受版本管理 | 低 |

**底线**：`whale-work/vendor/` 下 8 个包**都没有 `.git`**——改了没法 diff、没法回退、没法追溯。这是「面目全非」的根因。

## 1. 清单 A：npm 包（升级走 npm，改动会丢）

| id | 包名 | 版本 | 作用 | 来源 |
|---|---|---|---|---|
| dsh-at-file | dsh-at-file | 0.6.3 | 输入框 `@` 路径引用 | npm |
| dsh-bili-whale | dsh-bili-whale | 0.4.6 | 养鱼：B站浏览/日记/@人 | **GitHub tarball fork**（`Alterssss/dsh-bili-whale`，非 npm 原版） |
| dsh-context | dsh-context | 0.82.0 | 上下文洞察面板 | npm |
| dsh-cookie-guard | dsh-cookie-guard | 0.1.1 | 限制 cookie 寿命，防 431 | npm |
| dsh-feiyu-mood | dsh-feiyu-mood | 0.9.0 | 心情数值挂饰 | npm |
| dsh-find-plugins | dsh-find-plugins | 0.2.10 | 插件市场搜索工具 | npm |
| dsh-genui | dsh-genui | 0.3.1 | 生成式 UI 卡片 | npm |
| dsh-onebot-qq | dsh-onebot-qq | 0.9.18 | QQ 通道（OneBot 11） | npm，**已改过** |
| dsh-ops | dsh-ops | 0.5.2 | 文件/PT​C 工具、bash、powershell | npm |
| dsh-pet | dsh-pet | 0.3.8 | 桌宠 | npm |
| dsh-see-now | dsh-see-now | 0.2.1 | 看屏幕/摄像头 | npm |
| dsh-speak-up | dsh-speak-up | 0.3.0 | 主动搭话 | npm |
| dsh-token-diet | dsh-token-diet | 0.1.0 | token 统计与预算 | npm |
| dsh-univer-office | dsh-univer-office | 0.3.7 | Office 预览/协作 | npm |
| dsh-video-storyboard | dsh-video-storyboard | 0.7.1 | 视频分镜 | npm |
| dsh-watch-together | dsh-watch-together | 0.3.1 | 一起看视频 | npm |
| dsh-whale-widget | dsh-whale-widget | 0.4.2 | 余额小鲸鱼挂件 | npm |
| dshmarket | dshmarket | 1.66.38 | 插件市场 UI | npm |
| billion-context | billion-context | 0.1.213 | 上下文压缩（当前会话在用） | npm |
| hindsight | @vectorize-io/hindsight-coding-agents | 0.8.1 | 仓库记忆/知识页 | npm |
| automation | @michengai/dsh-automation | 1.0.4 | 自动化任务 | npm |
| agency-agents | @michengai/dsh-agency-agents | 1.2.7 | 角色/代理 | npm |
| skill-explorer | @linxin666/dsh-client-ui-skill-explorer | 0.4.7 | 技能浏览 UI | npm |
| skin-maid | @smalltailqwq/dsh-client-ui-skin-maid-atelier | 0.1.8 | 女仆皮肤 | npm |
| full-life-memory | @tuhengyu/dsh-full-life-memory | 0.4.0 | 另一套记忆（与 yunqi-memory 并存） | npm |
| modlens | @liustack/modlens | 3.27.1 | 视觉桥 | npm |
| — | @zaofan/dsh-qqbot | 1.12.6 | 另一个 QQ 插件 | npm，**装了但不在 bundles 里，未启用** |

## 2. 清单 B：本地 vendor（8 个，无 git）

路径：`C:\Users\35218\.dsh\whale-work\vendor\<name>`

| 目录 | 包名 | 版本 | 作用 | 已确认改动 |
|---|---|---|---|---|
| auto-checkpoint | dsh-auto-checkpoint | — | 自动检查点 | `index.js.bak-before-wording`（改过措辞） |
| dsh-computer-use | @local/dsh-computer-use | — | 电脑操作 | 未见备份 |
| dsh-memewiki | dsh-memewiki | 0.1.20 | 梗百科 | 未见备份 |
| dsh-music-analyze | dsh-music-analyze | 0.2.0 | 音乐四联图 | 未见备份 |
| dsh-persona-distill | dsh-persona-distill | 2.1.1 | 人格蒸馏 | 未见备份 |
| dsh-soundtry | dsh-soundtry | 1.0.2 | 听觉六件套 | 未见备份 |
| thinking-guard | dsh-thinking-guard | — | 思考逃逸阀 | 未见备份 |
| qian-music-dsh | qian-music-dsh | 0.3.1 | 音乐播放器 | `package.json.bak-20261104-client`（加 `client` 入口） |

## 3. 清单 C：本地路径插件

| 路径 | 作用 | 说明 |
|---|---|---|
| `C:\Users\35218\.dsh\plugins\yunqi-memory\index.js` | 记忆/人格 | 自写，不走 npm，patch 直接引路径 |

## 4. 已确认的本地改动（有证据）

| 包 | 文件 | 证据 | 更新时怎么办 |
|---|---|---|---|
| dsh-onebot-qq | `lib/inbound.js` | 修改时间 11-09，另有 `.bak-20261107184352`、`.bak-20261107185533` | 升级前先备份整个 `lib/`；新版装上后逐个比对，把改动重放 |
| dsh-onebot-qq | `lib/tools.js` | 修改时间 11-09，无备份 | 同上 |
| dsh-onebot-qq | `lib/outbound.js` | 修改时间 11-09，无备份 | 同上 |
| auto-checkpoint | `index.js` | `.bak-before-wording` | 改的是措辞，合并时看 `diff` |
| qian-music-dsh | `package.json` | `.bak-20261104-client` | 加的是 `client` 入口，重装后补一行 |

**onebot 三个文件的具体差异还没逐行核对**。它们对应的是 QQ 入站（steer/群策略）、工具面、出站护栏——是最容易在升级时悄悄丢的一批改动，升级前必须做一次完整 diff。

## 5. 更新时怎么保留

1. **升级前先备份**：`cp -r node_modules/<pkg>/lib node_modules/<pkg>/lib.bak-<日期>`
2. **npm 包**：`npm install <pkg>@<新版本>` → 整包被覆盖 → 再从 `lib.bak-*` 把改动搬回去
3. **vendor 包**：从上游重新拉一份到临时目录 → 与当前目录 `diff -r` → 手工合并 → 跑该包自带测试
4. **onebot 特殊**：升级会同时动协议解析和出站，改完先在一个群试，别直接开全群
5. **本地路径插件**：改前 `copy` 一份 `index.js.bak-<日期>`，改完跑 `node test/smoke.mjs`

## 6. 回退

| 类型 | 回退方法 |
|---|---|
| npm 包 | `npm install <pkg>@<旧版本>` |
| vendor 包 | 备过的目录直接换回；没备份就只能从上游重拉 |
| 配置层 | `cordis.patch.yml` 的改动都带日期注释，按注释删段 |
| 系统层 | 重启 DSH 生效；配置层加载失败会拒启，看 DSH 日志 |

## 7. 开关在哪

- **单插件总开关**：`profiles/desktop/cordis.patch.yml` 里 `- id: <插件id>` + `disabled: true`
- **包内默认**：`node_modules/<pkg>/cordis.patch.yml`
- **运行时设置**：设置页里的「插件」分页（部分插件有独立设置面板）
- **注意**：`disabled: false` 不代表启用；没有 `disabled` 字段才走包内默认

## 8. 已知的重叠与隐患

1. **两套记忆并存**：`@tuhengyu/dsh-full-life-memory`（0.4.0，在 bundles 里）+ `yunqi-memory`（本地）。两份都在注入记忆，token 翻倍、数据分裂——要么停用前者，要么明确分工。
2. **两个 QQ 插件**：`dsh-onebot-qq`（启用）+ `@zaofan/dsh-qqbot`（装了没启用）。重装时别把两个都拉起来。
3. **vendor 无版本记录**：8 个目录没有 git，也没有记录「拷贝自哪个 commit」——这是下一步最该补的。
4. **dsh-bili-whale 是 fork tarball**：不是 npm 版本，升级要手动换 tarball 地址，改动同样会丢。

## 9. 待办

- [ ] 给 `whale-work/vendor/` 建 git（每个目录独立 `git init` + 首次提交），或整目录一个仓
- [ ] onebot 三个文件与 `.bak` 做逐行 diff，把改动写进第 4 节
- [ ] 决定 `@tuhengyu/dsh-full-life-memory` 去留
- [ ] 决定 `@zaofan/dsh-qqbot` 卸载或启用
- [ ] 每个 vendor 包补一行「上游仓库 + 拷贝时的 commit」
