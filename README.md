# WeChat Webhook Channel

OpenClaw 的微信渠道插件，支持通过 macOS 原生通知 + Webhook 双通道接收消息，通过 AppleScript UI 自动化发送消息。

## 功能特性

### 消息接收（双通道）

1. **macOS 原生通知监控（主要）**
   - 通过 AppleScript 持续监控 NotificationCenter 窗口
   - 几乎零延迟，实时接收通知
   - 可获取发送者名称和消息内容（最多约 65 字符）

2. **Webhook（辅助/兜底）**
   - 通过 `/api/webhook` 接收 chatlog 的推送
   - 延迟约 10 秒，但能获取完整消息内容
   - 用于补全被截断的长文本和多媒体消息

### 智能去重

- 使用 `发送者 + 内容前20字符` 作为消息唯一标识
- 通知和 Webhook 共用去重机制，避免重复处理

### 消息发送

- **图文混发**：文字和媒体先全部粘贴到输入框，最后一起发送
- **短文本（< 100 字符）**：使用 Peekaboo 模拟人类打字
- **长文本（>= 100 字符）**：使用剪贴板粘贴，更快速
- **媒体文件**：支持发送图片/文件，通过剪贴板粘贴
- **Markdown 清理**：自动去除 Markdown 格式（微信不支持）

发送流程：
```
Agent 回复: "这是图片 MEDIA:/path/img.jpg 后面还有文字"
    │
    ├─→ 解析为 3 部分：[文字1, 媒体, 文字2]
    │
    ├─→ 激活微信输入框
    │
    ├─→ 粘贴文字1（不发送）
    ├─→ 粘贴图片（不发送）
    ├─→ 粘贴文字2（不发送）
    │
    └─→ Cmd+Enter 一起发送 → 切后台
```

### 后台切换

- 发送消息后自动切换到 Finder
- 确保微信进入后台，以便接收下一条通知

## 消息处理流程

```
通知监控收到消息
    │
    ├─→ 消息已处理过？ → 跳过
    │
    ├─→ 短文本（< 60 字符）且非多媒体？
    │       └─→ 直接处理，发送给 Agent
    │
    └─→ 长文本或多媒体？
            └─→ 放入 pending，等待 Webhook（30 秒超时）
                    │
                    ├─→ Webhook 到达 → 用完整内容处理
                    │
                    └─→ 超时 → 用通知内容处理（多媒体则跳过）
```

## 配置

在 `openclaw.json` 中配置：

```json
  "channels": {
    "wechat": {
      "enabled": true,
      "streamMode": "partial",
      "blockStreaming": true,
      "allowedSenders": [
        "发送者微信昵称（有备注填备注）"
      ]
    }
  }
```

## 依赖

- **macOS**：需要 macOS 系统
- **WeChat for Mac**：需要安装微信 Mac 版
- **Peekaboo**：用于模拟人类打字（`brew install peekaboo`）
- **chatlog**（可选）：用于 Webhook 推送

## 注意事项

1. 需要在系统设置中为终端/IDE 授予辅助功能权限
2. 微信需要保持登录状态
3. 为接收通知，微信需要处于后台状态
4. 通知内容最多显示约 65 个字符，超长消息需要 Webhook 补全
