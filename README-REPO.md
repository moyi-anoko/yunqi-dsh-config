# DSH 本机配置仓库

DSH 0.2.2-rc.1 · profile `desktop` · 2026-11-11 建仓

## 这个仓库装什么

- `profiles/desktop/package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`：插件清单与锁定版本
- `profiles/desktop/cordis.patch.yml.example`：配置模板（真 token 不在这里）
- 记忆插件已拆到独立仓：https://github.com/moyi-anoko/dsh-yunqi-memory （本仓不跟踪）
- `whale-work/vendor/`：8 个本地插件源码（不含模型和 ffmpeg）
- `patches/`：在 npm 包里改过的内容的补丁
- `AGENTS.md`、`CONCEPTS.md`、`PLUGINS-LOCAL-ADAPTATIONS.md`、`REPO-STRATEGY.md`：说明文档

## 这个仓库不装什么

- `node_modules`：安装产物，用 pnpm 重建
- `sessions/`、`state/`、`whale-work/` 里的数据：会话、日记、作品
- `yunqi-memory/` 数据目录：facts、episodes、persona
- 密钥：OneBot token、B 站 cookie、API key
- 活的 `cordis.patch.yml`：被 .gitignore 挡住

## 换机器怎么恢复

1. 装 DSH 应用
2. `git clone` 本仓库到 `C:\Users\<你>\.dsh`
3. clone 记忆插件到 `plugins\yunqi-memory`：
   `git clone https://github.com/moyi-anoko/dsh-yunqi-memory.git plugins\yunqi-memory`
4. 复制配置模板并填 token：
   `copy profiles\desktop\cordis.patch.yml.example profiles\desktop\cordis.patch.yml`
   把 `REPLACE_ME_ONEBOT_ACCESS_TOKEN` 换成真的 OneBot access token
5. 装依赖（用 pnpm，不是 npm）：
   `cd profiles\desktop && pnpm install`
6. 从单独备份恢复数据：`sessions/`、`state/`、`yunqi-memory/`、`whale-work/` 里的日记与作品
7. 重启 DSH

## 升级插件时

- npm 包：改 `package.json` 版本 → `pnpm install` → 看 `patches/` 有没有要重贴的
- vendor 包：从上游重新拉 → 与仓库里的比 → 合并 → 提交
- 每次改动写清 commit message，说明「改了什么、为什么」
