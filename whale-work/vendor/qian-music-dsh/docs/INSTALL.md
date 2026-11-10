# 安装与配置

本插件供 DeepSeek Harness 桌面版使用。已验证 DSH 0.2.1-rc.5、Node.js 24、Windows。其他系统可通过环境变量提供 Key，桌面播放器使用 DSH 自身音频能力；尚未做 macOS/Linux 实机测试。

## 从分发包安装

1. 安装 DSH 桌面版和 Node.js 24。解压插件到自己选择的固定目录。
2. 在插件目录打开终端，运行 `node install.mjs --profile desktop`。已有覆盖配置会备份；安装脚本只更新千小姐条目与默认模型，不清空其他插件。
3. Windows 执行 `pwsh -File ./setup-key.ps1`，按提示填写自己的百炼服务地址、模型和 Key。Key 隐藏输入，并以 Windows 当前用户 DPAPI 加密保存。
4. 退出 DSH 后执行 `pwsh -File ./start-dsh.ps1`。首次输入已安装的 `DeepSeek Harness.exe` 路径，此后会记住。启动器在启动 DSH 时临时提供已保存的 Key，避免欢迎页反复要求填写。
5. DSH 选择 `Qwen Omni · 千小姐`。底部点击“启用播放”，再点击“展开播放器”查看队列、歌单与歌词。

安装脚本也会将随包 `skills/qian-music` 安装到当前 `DSH_HOME/skills/qian-music`，已有 Skill 会备份。在 DSH 中让千小姐使用 qian-music Skill 即可加载详细指导。

B站扩展是可选安装：执行 `node setup-bili.mjs` 安装独立依赖，再在 DSH 内“B站账号”扫码。见 [B站原生多模态指南](BILIBILI.md)。

## 可选：网易云 Key 与账号登录

基础播放器不需要网易云开发者 Key。需要自己的网易云账号歌单、红心、日推等能力时，按 [网易云账号与操作指南](../skills/qian-music/references/netease.md) 申请自己的应用，安装官方 CLI，并依次运行 `ncm-cli configure`、`ncm-cli login --background`，扫码后用 `ncm-cli login --check` 验证。

AppID 和 PrivateKey 是网易云接口凭证，与百炼模型 API Key 不同。不要使用作者的凭证。CLI 直接在用户自己的环境运行，千小姐可通过 DSH 工具调用它读取和管理歌单；通过 qian_music_import 将结果导入内置播放器。

默认配置位于 `~/.dsh/qian-music/`。如 DSH 原本使用自定义数据目录，运行安装、配置与启动脚本前，都需要设置同一个 `DSH_HOME`。可用 `QIAN_CONFIG_DIR` 单独指定插件数据目录。

```powershell
$env:DSH_HOME = '你自己的DSH数据目录'
node ./install.mjs --profile desktop
pwsh -File ./setup-key.ps1
pwsh -File ./start-dsh.ps1 -DesktopPath '你安装的DeepSeek Harness.exe路径'
```

已安装插件的位置会写入本机 DSH 配置，分发源码没有绑定开发者机器路径。移动解压目录后，重新运行安装脚本。

## 环境变量方式

跨平台可以通过 `QIAN_OMNI_API_KEY` 或 `DASHSCOPE_API_KEY` 提供模型 Key，并在同一环境启动 DSH。不要把 Key 写进源码、README、聊天或提交记录。

`config.json` 只存服务地址和模型等公开配置：

```json
{
  "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "model": "qwen3.8-omni-flash"
}
```

模型是否可用、支持的原生音视频类型与费用，以自己的百炼地域和开通状态为准。自定义部署要填写自己的服务地址。

## 人设

包内 `workspace/AGENTS.md` 可复制到为千小姐新建的 DSH 工作区。已有工作区请合并规则，避免覆盖自己的说明。

## 歌单与数据

### 本地音源

播放器点击“导入本地音源”可多选 MP3、WAV、FLAC、M4A、OGG 等文件，加入当前队列；也支持 MP4/WebM 中的声音，实际编码需 DSH 能解码。选择的文件流式保存到自己的 `local-media/` 私有缓存，不设额外文件大小上限，仍受本机磁盘和实际解码能力影响。

也可以告诉千小姐“把这个本地文件加入播放列表”，给出绝对路径。她使用 `qian_music_import` 的 `source=local`、`path` 导入，随后播放、追加队列或收藏到已有本地歌单。支持 `file://` URL。路径导入引用原位置，同目录同名 `.lrc` 会自动读取；原文件移动后需重新导入。

本地播放通过本机带授权的音源接口提供数据，支持拖动进度，不需要云端音源，也不会为播放上传模型。让千小姐原生试听时才把文件提供给模型。安装包不带这些音源或你的绝对路径。

- `player-library.json`：本地歌单、队列、音量和模式。
- 歌曲元信息会保存，带时效的音源 URL 不持久化，播放时重新获取。
- 本地歌单不会同步到网易云或其他平台账号。
- `cache/` 与 `uploads/` 为原生听歌和附件读取的私有缓存，不随插件发布。
- 卸载插件前如需保留歌单，请备份自己的数据目录。

## 排错

- **没有底部播放器**：确认插件已安装到当前桌面 profile，并重启 DSH；查看 DSH 插件页的失败原因。当前兼容目标为 0.2.1-rc.5。
- **没有声音**：点击“启用播放”，检查系统音量，再查看插件提示。无音源就请千小姐换来源；不会绕过会员、区域或版权限制。
- **没有歌词**：部分平台没有返回 LRC，显示实际返回状态，不以模型生成歌词替代。
- **欢迎页要求 Key**：Windows 用包内启动器启动；环境变量方式需确保 DSH 进程继承了变量。已运行的 DSH 应完整退出后再启动。
- **DSH 切换工作区**：播放器属于窗口底部的插件面板，切换会话不会另建播放器。关闭整个 DSH 会停止播放；仅收起面板不会。

开发测试：`node --test tests/*.test.mjs`。分发包不含 DSH 主程序、模型 Key、音乐平台账号或歌曲文件。
