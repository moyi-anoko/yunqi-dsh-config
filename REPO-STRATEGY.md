# 上传 .dsh 到仓库前的分层建议（草稿）

别整目录上传。`.dsh` 里混着四类东西，体积和敏感度差两个数量级：

| 层 | 内容 | 体积 | 进 git？ |
|---|---|---|---|
| 配置 | `profiles/desktop/cordis.patch.yml`、`package.json`、`package-lock.json` | 几十 KB | ✅ 进 |
| 自写插件 | `plugins/yunqi-memory/` | 几百 KB | ✅ 进 |
| vendor 源码 | `whale-work/vendor/` 8 个包 | 几十 MB | ✅ 进，但用 submodule |
| 安装产物 | `profiles/*/node_modules/` | 数百 MB ~ GB | ❌ `npm ci` 重建 |
| 数据 | `sessions/`、`state/`、`whale-work/` 工作区、yunqi-memory 数据 | 11 GB+ | ❌ 单独备份 |
| 密钥 | `cordis.patch.yml:49` 的 OneBot `accessToken`、cookie 路径 | — | ❌ 外置 |

## 「插件作为上游链接」怎么落

- **npm 包**：`package.json` + `package-lock.json` 已经是链接。不需要 submodule。
- **vendor 8 个**：各自 `git submodule` 指向上游；我们的改动提交到自己的 fork 分支，submodule 指 fork。
- **改过但没 fork 的（dsh-onebot-qq）**：改动在 `node_modules` 里，`package-lock` 恢复不出来。必须提取成 `patches/*.patch`，升级后 `git apply`。
- **tarball 源（dsh-bili-whale）**：换成 git 依赖或 submodule，否则每次升级都要手动换地址。

## 好处

1. 换机器：clone + `npm ci` + 恢复 secrets = 环境重建
2. 改动可 diff / 可回退 / 可追溯（vendor 无 git 的根本问题解决）
3. 升级时三方合并，不用凭记忆重放补丁
4. 每次改动留下「为什么」的 commit message

## 三个坑

1. **密钥**：`cordis.patch.yml:49` 现在是明文 `accessToken`。上传前必须挪到不入库的 `secrets.local.yml` 或环境变量。
2. **node_modules 改动**：onebot 的 `inbound.js`/`tools.js`/`outbound.js` 不在包里，只提交 package.json 等于没保存。
3. **数据体积**：`sessions/` 才是大头（11 GB），配置只有几 MB。备份策略要分开，别混在一个仓。

## 最小起步

只建一个仓，装三样：

```
.gitignore:
  profiles/*/node_modules/
  sessions/
  state/
  whale-work/
  *.log

入库:
  profiles/desktop/{package.json,package-lock.json,cordis.patch.yml}
  plugins/yunqi-memory/
  patches/            （onebot 等改动提取成 patch）
  PLUGINS-LOCAL-ADAPTATIONS.md
```

先只做这一步，vendor 的 submodule 化放第二步。
