---
name: 视频帧提取
description: 从视频中使用 ffmpeg 提取关键帧或截图
triggers: 视频, 抽帧, ffmpeg, 关键帧, 截图, video, frame
tools: shell
---
# 从视频提取帧

## 使用 ffmpeg 从视频中提取关键帧

### 提取单帧（指定时间点）
```bash
ffmpeg -ss 00:01:30 -i input.mp4 -frames:v 1 output.png
```

### 每 N 秒提取一帧
```bash
ffmpeg -i input.mp4 -vf "fps=1/10" frame_%04d.png
```

### 提取关键帧（I-frames）
```bash
ffmpeg -i input.mp4 -vf "select=eq(pict_type\,I)" -vsync vfr keyframe_%04d.png
```

### 提取缩略图
```bash
ffmpeg -i input.mp4 -vf "scale=320:-1" -frames:v 1 thumb.png
```

## 注意事项
- `-ss` 放在 `-i` 之前速度更快（seek 到关键帧附近再解码）
- 提取大量帧时注意磁盘空间
- 支持的格式：mp4, mkv, avi, mov, webm 等
