# B站：让 Omni 自己听看视频

## 与纯文本工具的区别

流程是 **视频链接/BV号 → 下载画面与音轨 → FFmpeg 合并并检查 → 百炼私有 OSS → 当前 Qwen Omni 主会话原生听看**。

评论区、简介、字幕和搜索摘要只可辅助查证，不作为看过视频的依据。没有观看子模型，音频模式也不经过 ASR。模型服务本身如何处理输入由服务端实现决定；本插件提交的是原始媒体，并未自行抽帧替代。

## 安装

先完成模型 Key 配置。安装者自己准备 Python 3.10+，然后在插件目录执行 `node setup-bili.mjs`。需要指定 Python 时：

```text
node setup-bili.mjs --python "自己的Python可执行文件路径"
```

依赖包括 bilibili-api-python、yt-dlp、二维码与 FFmpeg，安装到用户数据目录下的独立环境，源码包不包含这些运行时二进制。可用 `QIAN_BILI_PYTHON` 指向自己已装好依赖的解释器，`QIAN_FFMPEG` 指定自己的 FFmpeg。需要代理时配置 `QIAN_BILI_PROXY`，默认直连 B站接口。

## 扫码

在 DSH 的千小姐播放器点击“展开播放器”→“B站账号”→“扫码登录 / 刷新二维码”，用自己的 B站 App 扫码并在手机确认。页面会检查登录结果。也可让 Agent 调 `qian_bili_login` 获取二维码，随后检查 `qian_bili_status` 的账号名称。

二维码过期重新生成。Windows 当前用户 DPAPI 加密保存 Cookie；macOS/Linux 需要可用的系统安全钥匙串。不会以明文文件兜底，不把登录态发给模型或写入分发包。

## 使用

- `qian_bili_discover` 搜索/推荐，`qian_bili_info` 查看分P，`qian_bili_watch` 默认提交实际音视频；只想听时用 mode=audio。
- 等下一轮 Omni 原生处理后，`qian_bili_finish_video` 保存实际观察与不确定之处。用 `qian_bili_history` 恢复笔记，需要重看重新 watch。
- `qian_bili_comments` 读热评；用户授权时 `qian_bili_comment` 发评论。真实 @ 先用 `qian_bili_find_user` 核对 UID。
- `qian_bili_inbox` 读 @ 和回复；`qian_bili_reply` 按真实线程回复；无需处理的用 `qian_bili_inbox_ack`。
- 用户需要时开启 `qian_bili_notifications`，每分钟把新通知送回当前主会话。默认关闭，重启后不自动恢复。
- `sync_to_dynamic=true` 请求原生“转发到动态”。本机配置可设 `biliSyncToDynamic:true`，不改变其他安装者的默认行为。
- `qian_bili_dynamic` 可按用户要求发动态。写入有去重回执；接口接受不等于公开可见。取消、超时或结果不明确后先查回执与实际内容，不盲重发。

B站账号操作与视频观看是独立能力：登录不自动授权持续发言，下载成功也不代表模型已完成理解。遇到验证码、账号权限或平台拒绝，按实际结果处理，不声称能绕过。

## 私有数据

用户插件数据目录下 `bilibili/` 保存独立 Python 环境、加密登录态、二维码、下载缓存、观看笔记、通知处理记录与发表回执。它们全部不进入分发包。退出账号会清除本机登录态，但保留历史回执与观看笔记，方便核对。

这些工具为自有账号使用而提供。安装和测试不会自动发布评论或动态。
