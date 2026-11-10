# dsh-onebot-qq 本地改动

上游包：`dsh-onebot-qq@0.9.18`（`profiles/desktop/node_modules/dsh-onebot-qq`）

## 改了什么

| 文件 | 改动 | 为什么 |
|---|---|---|
| `lib/inbound.js` | 群里发 `/q` 时不在群里回任何字，整条转为私聊回合处理 | 主人 2026-11-08 要求：群里不留回执，回复和报错都走私聊 |
| `lib/inbound.js` | 群准入规则 v4：群 645937444（深水区）和 1132779252（肥鱼大奖赛·朝鱼）统一——被 @ 或引用必回；没 @ 时主人直接放行，别人要有文字内容且掷到 5% 才回 | 主人 2026-11-08 定的群规则；旧版是深水区只认主人 @、另一群纯 5% 骰子 |
| `lib/chat.js` | `sessionIdOf` 返回固定 `onebot-yunqi`，私信和群聊共用一个会话 | 主人要求「我」是一个，不是三个 |

## 差异摘要

见 `DIFF-SUMMARY.txt`（用改动前后文件逐行集合比较生成）。

## 怎么恢复

升级 `dsh-onebot-qq` 后，npm 会把 `lib/` 覆盖回上游版本。恢复步骤：

1. 把本目录 `lib/inbound.js`、`lib/chat.js` 复制到
   `profiles/desktop/node_modules/dsh-onebot-qq/lib/`
2. 重启 DSH

改之前的原始文件备份还在 node_modules 里（`*.bak-20261107184352`、`*.bak-20261107185533`），但 npm 升级可能会清掉，所以以本目录为准。

## 注意

- 改的是 `node_modules` 里的文件，不是上游包。每次 `pnpm install` / 升级都要检查是否被覆盖。
- 改动只改行为、没改接口（sessionId 格式仍是字符串；`/q` 只在 inbound 分支里处理）。
- 上游以后可能自己加了这些功能，届时要对比再决定是否继续打补丁。
