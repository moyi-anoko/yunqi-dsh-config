# 本机全局说明

## B站（所有工作区通用）

- 看 B站一律走本地 CLI，**不要**用 `qian_bili_*` 那批插件工具——它背后的 Python 环境是空的，服务起不来。
- 命令：
  `node "C:\Users\35218\.dsh\profiles\desktop\node_modules\dsh-bili-whale\tools\bili.mjs" <命令> [参数]`
- 读（普通权限即可）：
  `session` 确认登录的是哪个号 · `video` 还原视频讲什么 · `subtitles` 官方字幕 · `debrief` 一条龙看懂 · `comments` 热评 · `search` 搜视频 · `covers` 封面 · `thread` 楼中楼 · `check-comment` 复核评论 · `comment-digest` 今天谁找过我 · `feed` 选题 · `likes` 谁赞了 · `diary show` 日记 · `quota status` 配额
- 写（私信 / 评论 / 回复 / 动态 / 弹幕 / 收藏）：`dm` `comment` `dynamic` `dynamic-image` `dynamic-edit` `danmaku` `fav`。必须显式带 `--dry`（只打印）或 `--go`（真发）；一次一条；发完用 `check-comment` / `thread` / `dynamic check` 回读复核。
- 凭据：cookie 在 `C:\Users\35218\.bili-ai`，配置在 `C:\Users\35218\.dsh\bili-whale.config.json`。不要读、不要打印 cookie 内容。
- 写操作要先写 `C:\Users\35218\.bili-ai\traffic-state.json.lock`（发送配额账本），workspace-write 沙箱下会报
  `Error: EPERM: operation not permitted, open 'C:\Users\35218\.bili-ai\traffic-state.json.lock'`，需要 danger-full-access。别把这个当成「B站不能用」。
- 完整命令表跑 `node bili.mjs help`。
- 出错了如实报错。不要自己去装依赖、改 venv、动系统级配置——先问用户。