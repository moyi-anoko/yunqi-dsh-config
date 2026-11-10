# 主会话陪听、计时与记忆

## 持续工作

用户要求自动找歌、陪听或 DJ 时，使用 `qian_listening_mode`：

- `listen`：每首真正开始后，原生听当前曲并简短评价。
- `dj`：陪听评价，同时原生试听候选并把下一首追加到队列。
- `radio`：持续选歌接播，减少逐首讲话。
- `off`：停止后续播放器事件唤醒。

启用后先查当前播放状态；若已有歌在播放，立即原生听并处理一次，不必等待下次切歌。后续实际开始播放事件会通过 DSH 的 followup 唤醒**同一个主会话**。收到事件先查模式，已 off 就停止自动工作。事件里只有元信息，不能当作你听过歌曲。续歌用追加，不使用会打断当前曲的立即播放。用户新要求优先于自动模式。

DSH 必须保持运行。退出应用会取消定时器和陪听，不会偷偷在重启后继续消耗模型额度。Agent 取消、授权失败等情况按 DSH 实际状态反馈。

## 时间与歌曲位置

`qian_current_time` 读真实系统时间。`qian_sleep` 异步等候后继续当前调用，并遵守取消信号；不用它猜歌曲播放进度。

`qian_timer` 用 action=schedule，args_json 示例：

```json
{"trigger":"track_time","seconds":60,"action":"volume","args":{"volume":0.5}}
```

到当前歌曲 60 秒直接调音量，无需再等模型推理。歌曲切换或重播后，该条自动取消。delay 以当前墙钟计秒；clock 用带时区的 at_time；bind_current_song 可把延时操作绑定当前曲。trigger=reminder 用 reason 到时唤醒本会话。用 list 查真正执行结果，scheduled 只表示安排成功；cancel 指定 id 或取消全部。

## 可读、可更新的记忆

`qian_memory`：read 查现有内容；preference 保存用户偏好，forget_preference 删除指定偏好；listening 记录实际听感、key 与 selected。工具会检查本进程是否确实把该曲原生音频交给主模型并成功完成响应，未听过不能先写笔记。用户明确说不喜欢某种特点时记录为用户偏好，别把模型自己的猜测写成用户喜好。

压缩或切会话后先读偏好与实际队列，需要比较声音时重新 `qian_music_listen`。旧笔记不是原始音频。

`qian_history` 是本机播放、暂停、定位、音量等实际事件，带时间和进度，可按 offset/limit 分页给用户看。它与 `qian_memory` 的模型试听笔记、网易云账号最近记录是三个不同来源，不混为“用户整首听过”。
