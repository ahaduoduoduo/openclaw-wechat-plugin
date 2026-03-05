import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { existsSync, statSync, readdirSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { exec as execCallback, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type {
  OpenClawPluginApi,
  PluginRuntime,
  ClawdbotConfig,
  RuntimeEnv,
  ReplyPayload,
} from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  emptyPluginConfigSchema,
  createReplyPrefixContext,
  createTypingCallbacks,
} from "openclaw/plugin-sdk";

const exec = promisify(execCallback);

// 带 UTF-8 环境变量的 exec，解决后台进程 emoji 问题
async function execWithUtf8(command: string): Promise<{ stdout: string; stderr: string }> {
  return exec(command, {
    env: {
      ...process.env,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    },
  });
}

// ============================================================
// 本地文件路径检测配置
// ============================================================

// 支持的媒体文件扩展名
const SUPPORTED_MEDIA_EXTENSIONS = new Set([
  // 图片
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff",
  // 视频
  ".mp4", ".mov", ".avi", ".mkv", ".webm",
  // 音频
  ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg",
  // 文档
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".md",
]);

// 最大文件大小：200MB
const MAX_MEDIA_SIZE_BYTES = 200 * 1024 * 1024;

// 微信每条消息最多 9 个媒体文件
const WECHAT_MAX_MEDIA_PER_MESSAGE = 9;

// 将 AI 输出的相对路径转为绝对路径
const OPENCLAW_PATH_ALIASES: [string, string][] = [
  ["openclaw/workspace", "/Users/clawdbot/.openclaw/workspace"],
];

function normalizeFilePath(filePath: string): string {
  for (const [alias, absolute] of OPENCLAW_PATH_ALIASES) {
    if (filePath.includes(alias)) {
      return filePath.replace(alias, absolute);
    }
  }
  return filePath;
}

// 移除字符串中的下划线，用于模糊比较
function removeUnderscores(str: string): string {
  return str.replace(/_/g, "").toLowerCase();
}

// 模糊匹配文件名（忽略下划线差异）
function findFuzzyMatchFile(filePath: string): string | null {
  try {
    const dir = dirname(filePath);
    const targetName = basename(filePath);
    const targetNormalized = removeUnderscores(targetName);

    if (!existsSync(dir)) return null;

    const files = readdirSync(dir);
    for (const file of files) {
      if (removeUnderscores(file) === targetNormalized) {
        return join(dir, file);
      }
    }
  } catch {
    // 忽略错误
  }
  return null;
}

// 检测文本中的本地文件路径
function detectLocalFilePaths(text: string): string[] {
  // 匹配绝对路径和相对路径（包含 / 且以支持的扩展名结尾）
  const extPattern = Array.from(SUPPORTED_MEDIA_EXTENSIONS)
    .map((ext) => ext.replace(".", "\\."))
    .join("|");
  const pathRegex = new RegExp(`((?:/|\\w+/)[^\\s"'<>|*?]+(?:${extPattern}))`, "gi");

  const matches = text.match(pathRegex) || [];
  const validPaths: string[] = [];

  for (const rawPath of matches) {
    try {
      // 尝试将相对路径转为绝对路径
      const resolvedPath = normalizeFilePath(rawPath);
      
      let finalPath: string | null = null;
      
      if (existsSync(resolvedPath)) {
        finalPath = resolvedPath;
      } else {
        // 文件不存在，尝试模糊匹配（忽略下划线差异）
        finalPath = findFuzzyMatchFile(resolvedPath);
      }
      
      if (finalPath) {
        const stats = statSync(finalPath);
        if (stats.isFile() && stats.size <= MAX_MEDIA_SIZE_BYTES) {
          validPaths.push(finalPath);
        }
      }
    } catch {
      // 忽略无法访问的路径
    }
  }

  return validPaths;
}

// ============================================================
// Runtime 管理
// ============================================================

let runtime: PluginRuntime | null = null;
let pluginApi: OpenClawPluginApi | null = null;

// 消息去重：存储已处理的消息 key（发送者 + 内容前20字符）
const processedMessages = new Set<string>();
const MAX_PROCESSED_MESSAGES = 1000;

// 生成消息去重 key
function getMessageKey(sender: string, content: string): string {
  const contentPrefix = content.slice(0, 20);
  return `${sender}:::${contentPrefix}`;
}

function isMessageProcessed(sender: string, content: string): boolean {
  const key = getMessageKey(sender, content);
  return processedMessages.has(key);
}

function markMessageProcessed(sender: string, content: string): void {
  const key = getMessageKey(sender, content);
  
  // 清理旧记录，避免内存无限增长
  if (processedMessages.size >= MAX_PROCESSED_MESSAGES) {
    const toDelete = Array.from(processedMessages).slice(0, 200);
    toDelete.forEach((k) => processedMessages.delete(k));
  }
  
  processedMessages.add(key);
}

// 判断是否是多媒体消息
function isMediaMessage(content: string): boolean {
  return /^\[(图片|视频|文件|语音)\]/.test(content);
}

// 判断消息是否需要等待 webhook（长文本或多媒体）
const NOTIFICATION_MAX_LENGTH = 60; // 通知最大显示约 65 字符，留点余量

function shouldWaitForWebhook(content: string): boolean {
  // 多媒体消息需要等待 webhook
  if (isMediaMessage(content)) {
    return true;
  }
  // 长文本可能被截断，需要等待 webhook
  if (content.length >= NOTIFICATION_MAX_LENGTH) {
    return true;
  }
  return false;
}

// 待处理的通知消息（等待 webhook 补全）
const pendingNotifications = new Map<string, { sender: string; content: string; timestamp: number }>();
const PENDING_TIMEOUT_MS = 30000; // 30 秒后如果 webhook 还没来，直接发送

// 通知监控进程
let notificationMonitorProcess: ChildProcess | null = null;
let lastNotificationSender = "";
let lastNotificationContent = "";

// 启动通知监控（使用 AppleScript 读取 NotificationCenter UI）
async function startNotificationMonitor(
  onNotification: (sender: string, content: string) => void,
  log: (...args: any[]) => void
): Promise<void> {
  log(`[wechat-notify] Starting notification monitor...`);

  // AppleScript 脚本：持续监控 NotificationCenter 窗口
  const appleScript = `
    on run
      set lastSender to ""
      set lastContent to ""
      repeat
        try
          tell application "System Events"
            tell process "NotificationCenter"
              if (count of windows) > 0 then
                set notifWindow to window "Notification Center"
                if exists notifWindow then
                  tell notifWindow
                    if exists group 1 then
                      tell group 1
                        if exists group 1 then
                          tell group 1
                            if exists scroll area 1 then
                              tell scroll area 1
                                if exists group 1 then
                                  tell group 1
                                    set senderText to ""
                                    set bodyText to ""
                                    repeat with staticText in (every static text)
                                      set textValue to value of staticText
                                      if senderText is "" then
                                        set senderText to textValue
                                      else if bodyText is "" then
                                        set bodyText to textValue
                                      end if
                                    end repeat
                                    -- 只有当发送者和内容都不为空，且与上次不同时才输出
                                    if senderText is not "" and bodyText is not "" then
                                      if senderText is not lastSender or bodyText is not lastContent then
                                        set lastSender to senderText
                                        set lastContent to bodyText
                                        log "NOTIFICATION:" & senderText & "|||" & bodyText
                                      end if
                                    end if
                                  end tell
                                end if
                              end tell
                            end if
                          end tell
                        end if
                      end tell
                    end if
                  end tell
                end if
              end if
            end tell
          end tell
        end try
        delay 0.5
      end repeat
    end run
  `;

  notificationMonitorProcess = spawn("osascript", ["-e", appleScript], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  notificationMonitorProcess.stderr?.on("data", (data: Buffer) => {
    const output = data.toString().trim();
    // AppleScript 的 log 输出会到 stderr
    if (output.startsWith("NOTIFICATION:")) {
      const content = output.replace("NOTIFICATION:", "");
      const parts = content.split("|||");
      if (parts.length === 2) {
        const [sender, body] = parts;
        log(`[wechat-notify] Received notification - sender: ${sender}, body: ${body.slice(0, 30)}...`);
        onNotification(sender, body);
      }
    }
  });

  notificationMonitorProcess.on("close", (code) => {
    log(`[wechat-notify] Monitor process exited with code ${code}`);
    notificationMonitorProcess = null;
  });

  notificationMonitorProcess.on("error", (err) => {
    log(`[wechat-notify] Monitor process error: ${err.message}`);
  });
}

function stopNotificationMonitor(): void {
  if (notificationMonitorProcess) {
    notificationMonitorProcess.kill();
    notificationMonitorProcess = null;
  }
}

function setWechatRuntime(next: PluginRuntime) {
  runtime = next;
}

function getWechatRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("WeChat runtime not initialized");
  }
  return runtime;
}

// ============================================================
// 微信消息发送 (AppleScript + Peekaboo)
// ============================================================

function escapeForShell(text: string): string {
  return text.replace(/'/g, "'\\''");
}

// 清理 Markdown 格式（微信不支持 Markdown 显示）
function stripMarkdown(text: string): string {
  let result = text;
  
  // 移除代码块（保留内容）
  result = result.replace(/```[\w]*\n?([\s\S]*?)```/g, "$1");
  
  // 移除行内代码（保留内容）
  result = result.replace(/`([^`]+)`/g, "$1");
  
  // 移除粗体 **text** 或 __text__
  result = result.replace(/\*\*([^*]+)\*\*/g, "$1");
  result = result.replace(/__([^_]+)__/g, "$1");
  
  // 移除斜体 *text* 或 _text_（注意不要误伤正常下划线）
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1");
  result = result.replace(/(?<!_)_([^_]+)_(?!_)/g, "$1");
  
  // 移除链接 [text](url) → text
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  
  // 移除标题 # ## ### 等
  result = result.replace(/^#{1,6}\s+/gm, "");
  
  // 移除引用 > 
  result = result.replace(/^>\s?/gm, "");
  
  // 移除水平线
  result = result.replace(/^[-*_]{3,}\s*$/gm, "");
  
  return result.trim();
}

// ============================================================
// 微信操作原子函数（用于图文混发）
// ============================================================

// 激活微信窗口并准备输入
async function activateWeChatInput(): Promise<void> {
  const log = pluginApi?.logger?.info?.bind(pluginApi?.logger) ?? console.log;

  // 1. 确保微信在前台并有窗口
  log(`[wechat-op] Activating WeChat...`);
  await execWithUtf8(`osascript -e '
    tell application "WeChat"
      activate
      reopen
    end tell
  '`);

  // 2. 等待窗口完全激活
  await new Promise((resolve) => setTimeout(resolve, 500));

  // 3. 按 2 次 Cmd+↓ 确保激活聊天窗口/输入框
  log(`[wechat-op] Focusing chat input...`);
  for (let i = 0; i < 2; i++) {
    await execWithUtf8(`osascript -e '
      tell application "System Events"
        tell process "WeChat"
          key code 125 using {command down}
        end tell
      end tell
    '`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // 4. 等待输入框获得焦点
  await new Promise((resolve) => setTimeout(resolve, 100));
}

// 粘贴文字，不发送（全部使用剪贴板粘贴）
async function typeOrPasteText(text: string): Promise<void> {
  const log = pluginApi?.logger?.info?.bind(pluginApi?.logger) ?? console.log;
  const cleanText = stripMarkdown(text);

  log(`[wechat-op] Pasting text (${cleanText.length} chars)...`);
  const escapedText = escapeForShell(cleanText);
  await execWithUtf8(`printf '%s' '${escapedText}' | pbcopy`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await execWithUtf8(`osascript -e '
    tell application "System Events"
      tell process "WeChat"
        key code 9 using {command down}
      end tell
    end tell
  '`);

  // 等待粘贴完成
  await new Promise((resolve) => setTimeout(resolve, 200));
}

// 仅粘贴媒体文件，不发送
async function pasteMedia(mediaPath: string): Promise<void> {
  const log = pluginApi?.logger?.info?.bind(pluginApi?.logger) ?? console.log;

  log(`[wechat-op] Pasting media: ${mediaPath}`);
  const escapedPath = escapeForShell(mediaPath);
  await execWithUtf8(`osascript -e 'set the clipboard to (POSIX file "${escapedPath}")'`);
  await new Promise((resolve) => setTimeout(resolve, 200));

  // 粘贴 (Cmd+V)
  await execWithUtf8(`osascript -e '
    tell application "System Events"
      tell process "WeChat"
        key code 9 using {command down}
      end tell
    end tell
  '`);

  // 等待粘贴完成
  await new Promise((resolve) => setTimeout(resolve, 100));
}

// 发送消息并切换到后台
async function sendAndSwitchToBackground(): Promise<void> {
  const log = pluginApi?.logger?.info?.bind(pluginApi?.logger) ?? console.log;

  // 发送消息 (Cmd+Enter)
  log(`[wechat-op] Sending message (Cmd+Enter)...`);
  await execWithUtf8(`osascript -e '
    tell application "System Events"
      tell process "WeChat"
        key code 36 using {command down}
      end tell
    end tell
  '`);

  // 等待发送完成
  await new Promise((resolve) => setTimeout(resolve, 500));

  // 切换到 Finder，让微信进入后台
  log(`[wechat-op] Switching to background...`);
  await execWithUtf8(`osascript -e 'tell application "Finder" to activate'`);
}

// ============================================================
// 图文混发：支持分批发送（微信限制每条消息最多 9 个媒体）
// ============================================================

// 将 parts 按媒体数量分批，每批最多 WECHAT_MAX_MEDIA_PER_MESSAGE 个媒体
function splitIntoBatches(parts: MessagePart[]): MessagePart[][] {
  const batches: MessagePart[][] = [];
  let currentBatch: MessagePart[] = [];
  let mediaCount = 0;

  for (const part of parts) {
    if (part.type === "media") {
      // 如果当前批次媒体数量已达上限，先保存当前批次
      if (mediaCount >= WECHAT_MAX_MEDIA_PER_MESSAGE) {
        batches.push(currentBatch);
        currentBatch = [];
        mediaCount = 0;
      }
      currentBatch.push(part);
      mediaCount++;
    } else {
      // 文字直接加入当前批次
      currentBatch.push(part);
    }
  }

  // 添加最后一批
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

async function sendMixedContent(parts: MessagePart[]): Promise<{ ok: boolean; error?: string }> {
  const log = pluginApi?.logger?.info?.bind(pluginApi?.logger) ?? console.log;
  const error = pluginApi?.logger?.error?.bind(pluginApi?.logger) ?? console.error;

  try {
    // 统计媒体数量
    const mediaCount = parts.filter((p) => p.type === "media").length;
    log(`[wechat-mixed] Starting to send ${parts.length} parts (${mediaCount} media files)...`);

    // 分批处理
    const batches = splitIntoBatches(parts);
    log(`[wechat-mixed] Split into ${batches.length} batch(es)`);

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const batchMediaCount = batch.filter((p) => p.type === "media").length;
      log(`[wechat-mixed] Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} parts, ${batchMediaCount} media)`);

      // 1. 激活微信并准备输入
      await activateWeChatInput();

      // 2. 依次粘贴当前批次的每个部分（不发送）
      for (let i = 0; i < batch.length; i++) {
        const part = batch[i];
        log(`[wechat-mixed] Batch ${batchIndex + 1}, part ${i + 1}/${batch.length}: ${part.type}`);

        if (part.type === "text") {
          await typeOrPasteText(part.content);
        } else if (part.type === "media") {
          await pasteMedia(part.path);
        }

        // 部分之间稍微等待
        if (i < batch.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      // 3. 发送当前批次
      await sendAndSwitchToBackground();
      log(`[wechat-mixed] Batch ${batchIndex + 1} sent`);

      // 4. 如果还有下一批，等待后继续
      if (batchIndex < batches.length - 1) {
        log(`[wechat-mixed] Waiting before next batch...`);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    log(`[wechat-mixed] All ${batches.length} batch(es) sent successfully`);
    return { ok: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    error(`[wechat-mixed] Failed: ${errorMsg}`);
    return { ok: false, error: errorMsg };
  }
}

// ============================================================
// 原有的单独发送函数（供 outbound.sendText/sendMedia 使用）
// ============================================================

async function sendToWeChat(text: string): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const log = pluginApi?.logger?.info?.bind(pluginApi?.logger) ?? console.log;
  const error = pluginApi?.logger?.error?.bind(pluginApi?.logger) ?? console.error;

  // 清理 Markdown 格式
  const cleanText = stripMarkdown(text);

  try {
    log(`[wechat-send] Starting to send message (${cleanText.length} chars): ${cleanText.substring(0, 50)}...`);

    // 1. 确保微信在前台并有窗口
    log(`[wechat-send] Activating WeChat and ensuring window is open...`);
    await execWithUtf8(`osascript -e '
      tell application "WeChat"
        activate
        reopen
      end tell
    '`);

    // 2. 等待窗口完全激活
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 3. 按 2 次 Cmd+↓ 确保激活聊天窗口/输入框
    log(`[wechat-send] Activating chat input (Cmd+Down)...`);
    for (let i = 0; i < 2; i++) {
      await execWithUtf8(`osascript -e '
        tell application "System Events"
          tell process "WeChat"
            key code 125 using {command down}
          end tell
        end tell
      '`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // 4. 等待输入框获得焦点
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 5. 使用剪贴板粘贴
    log(`[wechat-send] Pasting text (${cleanText.length} chars)...`);
    const escapedText = escapeForShell(cleanText);
    await execWithUtf8(`printf '%s' '${escapedText}' | pbcopy`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await execWithUtf8(`osascript -e '
      tell application "System Events"
        tell process "WeChat"
          key code 9 using {command down}
        end tell
      end tell
    '`);

    // 6. 等待粘贴完成
    await new Promise((resolve) => setTimeout(resolve, 200));

    // 7. 发送消息 (Cmd+Enter)
    log(`[wechat-send] Sending message (Cmd+Enter)...`);
    await execWithUtf8(`osascript -e '
      tell application "System Events"
        tell process "WeChat"
          key code 36 using {command down}
        end tell
      end tell
    '`);

    // 8. 等待发送完成
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 9. 切换到 Finder，让微信进入后台（这样才能收到通知）
    log(`[wechat-send] Switching to background (Finder)...`);
    await execWithUtf8(`osascript -e 'tell application "Finder" to activate'`);

    log(`[wechat-send] Message sent successfully`);
    return { ok: true, messageId: `wechat-${Date.now()}` };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    error(`[wechat-send] Failed to send message: ${errorMsg}`);
    return { ok: false, error: errorMsg };
  }
}

// 发送媒体文件到微信（图片/文件）
async function sendMediaToWeChat(mediaPath: string): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const log = pluginApi?.logger?.info?.bind(pluginApi?.logger) ?? console.log;
  const error = pluginApi?.logger?.error?.bind(pluginApi?.logger) ?? console.error;

  try {
    log(`[wechat-send-media] Starting to send media: ${mediaPath}`);

    // 1. 确保微信在前台并有窗口
    log(`[wechat-send-media] Activating WeChat and ensuring window is open...`);
    await execWithUtf8(`osascript -e '
      tell application "WeChat"
        activate
        reopen
      end tell
    '`);

    // 2. 等待窗口完全激活
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 3. 按 2 次 Cmd+↓ 确保激活聊天窗口/输入框
    log(`[wechat-send-media] Activating chat input (Cmd+Down)...`);
    for (let i = 0; i < 2; i++) {
      await execWithUtf8(`osascript -e '
        tell application "System Events"
          tell process "WeChat"
            key code 125 using {command down}
          end tell
        end tell
      '`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // 4. 等待输入框获得焦点
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 5. 用 AppleScript 把文件复制到剪贴板
    log(`[wechat-send-media] Copying file to clipboard...`);
    const escapedPath = escapeForShell(mediaPath);
    await execWithUtf8(`osascript -e 'set the clipboard to (POSIX file "${escapedPath}")'`);

    // 6. 等待剪贴板就绪
    await new Promise((resolve) => setTimeout(resolve, 200));

    // 7. 粘贴 (Cmd+V)
    log(`[wechat-send-media] Pasting file (Cmd+V)...`);
    await execWithUtf8(`osascript -e '
      tell application "System Events"
        tell process "WeChat"
          key code 9 using {command down}
        end tell
      end tell
    '`);

    // 8. 等待粘贴完成
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 9. 发送消息 (Cmd+Enter)
    log(`[wechat-send-media] Sending media (Cmd+Enter)...`);
    await execWithUtf8(`osascript -e '
      tell application "System Events"
        tell process "WeChat"
          key code 36 using {command down}
        end tell
      end tell
    '`);

    // 10. 等待发送完成
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 11. 切换到 Finder，让微信进入后台（这样才能收到通知）
    log(`[wechat-send-media] Switching to background (Finder)...`);
    await execWithUtf8(`osascript -e 'tell application "Finder" to activate'`);

    log(`[wechat-send-media] Media sent successfully`);
    return { ok: true, messageId: `wechat-media-${Date.now()}` };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    error(`[wechat-send-media] Failed to send media: ${errorMsg}`);
    return { ok: false, error: errorMsg };
  }
}

// ============================================================
// 解析消息中的 MEDIA: 标记
// ============================================================

type MessagePart = 
  | { type: "text"; content: string }
  | { type: "media"; path: string };

function parseMessageWithMedia(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const processedPaths = new Set<string>(); // 用于去重
  
  // 第一步：匹配 MEDIA:/path/to/file 格式（要求以已知文件扩展名结尾，防止误匹配对话文字）
  const extPattern = Array.from(SUPPORTED_MEDIA_EXTENSIONS)
    .map((ext) => ext.replace(".", ""))
    .join("|");
  const mediaRegex = new RegExp(`MEDIA:\\s*([^\\s\\n]+\\.(?:${extPattern}))`, "gi");
  
  let lastIndex = 0;
  let match;
  
  while ((match = mediaRegex.exec(text)) !== null) {
    // 添加 MEDIA 之前的文本
    if (match.index > lastIndex) {
      const textBefore = text.slice(lastIndex, match.index).trim();
      if (textBefore) {
        parts.push({ type: "text", content: textBefore });
      }
    }
    
    // 添加媒体文件
    const mediaPath = match[1];
    parts.push({ type: "media", path: mediaPath });
    processedPaths.add(mediaPath);
    
    lastIndex = mediaRegex.lastIndex;
  }
  
  // 添加剩余的文本
  if (lastIndex < text.length) {
    const textAfter = text.slice(lastIndex).trim();
    if (textAfter) {
      parts.push({ type: "text", content: textAfter });
    }
  }
  
  // 如果没有找到任何 MEDIA 标记，返回整个文本
  if (parts.length === 0 && text.trim()) {
    parts.push({ type: "text", content: text });
  }
  
  // 第二步：在文本部分中检测本地文件路径（自动检测功能）
  const finalParts: MessagePart[] = [];
  
  for (const part of parts) {
    if (part.type !== "text") {
      finalParts.push(part);
      continue;
    }
    
    // 检测文本中的本地文件路径
    const detectedPaths = detectLocalFilePaths(part.content);
    
    // 过滤掉已经通过 MEDIA: 处理过的路径
    const newPaths = detectedPaths.filter((p) => !processedPaths.has(p));
    
    if (newPaths.length === 0) {
      // 没有检测到新的路径，保留原文本
      finalParts.push(part);
    } else {
      // 有检测到路径，拆分文本
      let remainingText = part.content;
      
      for (const filePath of newPaths) {
        const pathIndex = remainingText.indexOf(filePath);
        if (pathIndex === -1) continue;
        
        // 路径之前的文本
        const textBefore = remainingText.slice(0, pathIndex).trim();
        if (textBefore) {
          finalParts.push({ type: "text", content: textBefore });
        }
        
        // 添加媒体
        finalParts.push({ type: "media", path: filePath });
        processedPaths.add(filePath);
        
        // 更新剩余文本
        remainingText = remainingText.slice(pathIndex + filePath.length);
      }
      
      // 添加最后剩余的文本
      const finalText = remainingText.trim();
      if (finalText) {
        finalParts.push({ type: "text", content: finalText });
      }
    }
  }
  
  return finalParts;
}

// ============================================================
// Reply Dispatcher (参考飞书)
// ============================================================

type CreateWechatReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtimeEnv: RuntimeEnv;
  chatId: string;
};

function createWechatReplyDispatcher(params: CreateWechatReplyDispatcherParams) {
  const core = getWechatRuntime();
  const { cfg, agentId, runtimeEnv, chatId } = params;

  const prefixContext = createReplyPrefixContext({
    cfg,
    agentId,
  });

  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      runtimeEnv.log?.(`wechat: typing started`);
    },
    stop: async () => {
      runtimeEnv.log?.(`wechat: typing stopped`);
    },
    onStartError: () => {},
    onStopError: () => {},
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit({
    cfg,
    channel: "wechat",
    defaultLimit: 2000,
  });

  let deliverCalled = false;
  let deliverBuffer = "";

  // 将 buffer 内容解析并发送，可附加额外的媒体文件
  async function flushDeliverBuffer(extraMediaPaths?: string[]): Promise<void> {
    const text = deliverBuffer;
    deliverBuffer = "";

    const hasText = !!text.trim();
    const hasMedia = extraMediaPaths && extraMediaPaths.length > 0;

    if (!hasText && !hasMedia) return;

    deliverCalled = true;

    // 从文本中解析 parts（文字 + MEDIA: 标记 + 自动检测路径）
    const parts: MessagePart[] = hasText ? parseMessageWithMedia(text) : [];

    // 追加框架传入的媒体文件
    if (hasMedia) {
      for (const mediaPath of extraMediaPaths) {
        parts.push({ type: "media", path: mediaPath });
      }
    }

    runtimeEnv.log?.(`wechat deliver flush: ${parts.length} parts (text=${hasText}, extraMedia=${extraMediaPaths?.length ?? 0})`);

    const result = await sendMixedContent(parts);
    if (!result.ok) {
      runtimeEnv.error?.(`wechat deliver failed: ${result.error}`);
    }

    runtimeEnv.log?.(`wechat deliver flush: complete`);
  }

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: typingCallbacks.onReplyStart,
      deliver: async (payload: ReplyPayload) => {
        runtimeEnv.log?.(`wechat deliver called: text=${payload.text?.slice(0, 100)}`);

        // 提取框架传入的媒体路径（mediaUrls 优先，fallback mediaUrl）
        const payloadAny = payload as any;
        const mediaPaths: string[] = [];
        if (Array.isArray(payloadAny.mediaUrls) && payloadAny.mediaUrls.length > 0) {
          for (const u of payloadAny.mediaUrls) {
            if (typeof u === "string" && u.trim()) mediaPaths.push(u.trim());
          }
        } else if (typeof payloadAny.mediaUrl === "string" && payloadAny.mediaUrl.trim()) {
          mediaPaths.push(payloadAny.mediaUrl.trim());
        }

        if (mediaPaths.length > 0) {
          runtimeEnv.log?.(`wechat deliver: found ${mediaPaths.length} media from payload: ${mediaPaths.join(", ")}`);
        }

        const incoming = payload.text ?? "";
        if (!incoming.trim() && !deliverBuffer && mediaPaths.length === 0) {
          runtimeEnv.log?.(`wechat deliver: empty text and no media, skipping`);
          return;
        }

        // 纯媒体 payload（无文字）→ 立即发送，不走 buffer
        if (!incoming.trim() && !deliverBuffer && mediaPaths.length > 0) {
          await flushDeliverBuffer(mediaPaths);
          return;
        }

        deliverBuffer += incoming;

        // 有媒体附件时立即 flush（不等 MEDIA: 标记完整性检查）
        if (mediaPaths.length > 0) {
          await flushDeliverBuffer(mediaPaths);
          return;
        }

        // 检查 buffer 末尾是否有未闭合的 MEDIA: 标记（路径可能被截断）
        const lastMediaIdx = deliverBuffer.lastIndexOf("MEDIA:");
        if (lastMediaIdx !== -1) {
          const tail = deliverBuffer.slice(lastMediaIdx);
          const hasCompleteTag = /MEDIA:\s*[^\s\n]+\.\w{2,5}(\s|$)/i.test(tail);
          if (!hasCompleteTag) {
            runtimeEnv.log?.(`wechat deliver: incomplete MEDIA: tag at tail, buffering`);
            return;
          }
        }

        // buffer 完整，flush
        await flushDeliverBuffer();
      },
      onError: (err, info) => {
        runtimeEnv.error?.(`wechat ${info.kind} reply failed: ${String(err)}`);
        typingCallbacks.onIdle?.();
      },
      onIdle: async () => {
        // 流结束时，强制 flush 剩余 buffer
        if (deliverBuffer.trim()) {
          runtimeEnv.log?.(`wechat onIdle: flushing remaining buffer (${deliverBuffer.length} chars)`);
          await flushDeliverBuffer();
        }
        typingCallbacks.onIdle?.();
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
    },
    markDispatchIdle,
    wasDelivered: () => deliverCalled,
  };
}

// ============================================================
// 消息处理 (参考飞书的 handleFeishuMessage)
// ============================================================

type WechatMessageContext = {
  chatId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  chatType: "direct" | "group";
  content: string;
};

async function handleWechatMessage(params: {
  cfg: ClawdbotConfig;
  ctx: WechatMessageContext;
  runtimeEnv: RuntimeEnv;
}): Promise<void> {
  const { cfg, ctx, runtimeEnv } = params;
  const log = runtimeEnv.log ?? console.log;
  const error = runtimeEnv.error ?? console.error;

  log(`wechat: received message from ${ctx.senderName} in ${ctx.chatId}`);

  try {
    const core = getWechatRuntime();

    const wechatFrom = `wechat:${ctx.senderId}`;
    const wechatTo = `wechat:${ctx.chatId}`;

    // 解析路由（获取 agentId 和 accountId）
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "wechat",
      peer: {
        kind: ctx.chatType === "group" ? "group" : "dm",
        id: ctx.chatId,
      },
    });

    // 生成独立的 sessionKey，确保每个微信用户/群有独立的 session
    // 格式：wechat:dm:用户名 或 wechat:group:群ID
    const sessionKey = `wechat:${ctx.chatType === "group" ? "group" : "dm"}:${ctx.chatId}`;

    // 直接使用纯消息内容，不添加任何前缀或格式
    const body = ctx.content;

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: ctx.content,
      CommandBody: ctx.content,
      From: wechatFrom,
      To: wechatTo,
      SessionKey: sessionKey,  // 使用自定义的 sessionKey
      AccountId: route.accountId,
      ChatType: ctx.chatType,
      SenderName: ctx.senderName,
      SenderId: ctx.senderId,
      Provider: "wechat" as const,
      Surface: "wechat" as const,
      MessageSid: ctx.messageId,
      Timestamp: Date.now(),
      WasMentioned: false,
      CommandAuthorized: true,
      OriginatingChannel: "wechat" as const,
      OriginatingTo: wechatTo,
    });

    const { dispatcher, replyOptions, markDispatchIdle, wasDelivered } = createWechatReplyDispatcher({
      cfg,
      agentId: route.agentId,
      runtimeEnv,
      chatId: ctx.chatId,
    });

    log(`wechat: dispatching to agent (session=${sessionKey})`);

    const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions,
    });

    markDispatchIdle();

    log(`wechat: dispatch complete (queuedFinal=${queuedFinal}, replies=${counts.final}, delivered=${wasDelivered()})`);

    // 只有当 deliver 从未被调用（AI 真的没有任何输出）时才发 ⏹️
    if (!queuedFinal && counts.final === 0 && !wasDelivered()) {
      log(`wechat: no replies sent, sending stop notification`);
      await sendToWeChat("⏹️");
    }
  } catch (err) {
    error(`wechat: failed to dispatch message: ${String(err)}`);
  }
}

// ============================================================
// Webhook Handler
// ============================================================

async function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024) {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({ ok: false, error: "empty payload" });
          return;
        }
        resolve({ ok: true, value: JSON.parse(raw) as unknown });
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

async function handleWechatWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ClawdbotConfig,
  runtimeEnv: RuntimeEnv
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/webhook") return false;

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  const body = await readJsonBody(req, 1024 * 1024);
  if (!body.ok) {
    res.statusCode = body.error === "payload too large" ? 413 : 400;
    res.end(body.error ?? "invalid payload");
    return true;
  }

  const webhookData = body.value as any;
  const messages = Array.isArray(webhookData?.messages) ? webhookData.messages : [];

  if (messages.length === 0) {
    res.statusCode = 200;
    res.end("ok");
    return true;
  }

  const log = runtimeEnv.log ?? console.log;

  log(`[wechat-webhook] Received ${messages.length} messages`);

  // 立即返回 200，异步处理消息
    res.statusCode = 200;
    res.end("ok");

  const coreRuntime = getWechatRuntime();

  // 处理每条消息
  for (const msg of messages) {
    // 打印消息详情用于调试
    log(`[wechat-webhook] Message: seq=${msg.seq}, isSelf=${msg.isSelf}, sender=${msg.sender}, content=${String(msg.content).substring(0, 30)}...`);
    
    // 跳过自己发送的消息
    if (msg.isSelf === true) {
      log(`[wechat-webhook] Skipping self message`);
      continue;
    }

    // 处理消息类型
    const messageType = msg.type;
    let content = msg.content;

    switch (messageType) {
      case 1:
        // 纯文本，保持原样
        break;
      case 3:
        content = `[图片] ${content}`;
        break;
      case 34:
        content = `[语音] ${content}`;
        break;
      case 43:
        content = `[视频] ${content}`;
        break;
      case 49:
        content = `[文件/链接] ${content}`;
        break;
      default:
        content = `[消息类型:${messageType}] ${content}`;
        break;
    }

    const senderName = msg.senderName || msg.sender || "微信用户";

    // 发件人白名单过滤（allowedSenders 未配置时不过滤）
    const allowedSenders = (cfg as any)?.channels?.wechat?.allowedSenders as string[] | undefined;
    if (allowedSenders && allowedSenders.length > 0) {
      if (!allowedSenders.includes(senderName)) {
        log(`[wechat-webhook] Ignored message from unlisted sender: ${senderName}`);
        continue;
      }
    }

    // === 新的去重逻辑：与通知监控配合 ===
    
    // 检查是否已被通知处理过（用发送者+内容前20字符去重）
    if (isMessageProcessed(senderName, content)) {
      log(`[wechat-webhook] Message already processed by notification, skipping: ${senderName}`);
      continue;
    }

    // 检查是否在 pending 中（通知收到了但等待 webhook 完整内容）
    // 通知只能获取截断的内容，用前20字符匹配
    let foundPendingKey: string | null = null;
    for (const [key, pending] of pendingNotifications.entries()) {
      if (pending.sender === senderName) {
        // 检查 webhook 内容是否以 pending 内容开头（通知内容可能被截断）
        if (content.startsWith(pending.content) || pending.content.startsWith(content.slice(0, 20))) {
          foundPendingKey = key;
          break;
        }
      }
    }

    if (foundPendingKey) {
      // 找到 pending 消息，用 webhook 的完整内容替换并处理
      log(`[wechat-webhook] Found pending notification, using webhook content: ${senderName}`);
      pendingNotifications.delete(foundPendingKey);
      markMessageProcessed(senderName, content);
    } else {
      // 不在 pending 中，也没被处理过，直接处理
      log(`[wechat-webhook] New message from webhook: ${senderName}`);
      markMessageProcessed(senderName, content);
    }

    const senderId = msg.sender || msg.talker || "unknown";
    const chatId = msg.talker || msg.sender || "unknown";
    const messageId = `wechat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    log(`[wechat-webhook] Processing message from ${senderName}: ${content.substring(0, 50)}...`);

    const ctx: WechatMessageContext = {
      chatId,
      messageId,
      senderId,
      senderName,
      chatType: msg.isChatRoom ? "group" : "direct",
      content,
    };

    // 调用内部消息处理
    handleWechatMessage({ cfg, ctx, runtimeEnv }).catch((err) => {
      runtimeEnv.error?.(`[wechat-webhook] Failed to handle message: ${err}`);
    });
  }

  return true;
}

// ============================================================
// Channel Plugin 定义 (参考飞书)
// ============================================================

type WechatChannelConfig = {
  enabled?: boolean;
  name?: string;
  allowedSenders?: string[];
};

function getWechatConfig(cfg: any): WechatChannelConfig {
  return (cfg?.channels?.wechat as WechatChannelConfig) ?? {};
}

function resolveWechatAccount(cfg: any): {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
} {
  const wechatCfg = getWechatConfig(cfg);
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    name: wechatCfg.name ?? "WeChat",
    enabled: wechatCfg.enabled ?? true,
    configured: true, // 微信通过 UI 自动化，不需要额外配置
  };
}

const wechatPlugin = {
  id: "wechat",
  meta: {
    id: "wechat",
    label: "WeChat",
    selectionLabel: "WeChat (Webhook + UI)",
    blurb: "微信通道，通过 Webhook 接收消息，AppleScript/Peekaboo 发送",
    aliases: ["wechat", "weixin"],
    order: 80,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    edit: false,
    reply: false,
  },
  reload: { configPrefixes: ["channels.wechat"] },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg: any) => resolveWechatAccount(cfg),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: () => true,
    describeAccount: (account: any) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  outbound: {
    deliveryMode: "stream",
    textChunkLimit: 2000,
    sendText: async ({ cfg, to, text }: { cfg: any; to: string; text: string }) => {
      pluginApi?.logger?.info(`[wechat-outbound] sendText called! to=${to}`);
      const result = await sendToWeChat(text);
      return {
        channel: "wechat",
        ok: result.ok,
        messageId: result.messageId ?? "",
        error: result.error,
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl }: { cfg: any; to: string; text?: string; mediaUrl?: string }) => {
      pluginApi?.logger?.info(`[wechat-outbound] sendMedia called! to=${to}, mediaUrl=${mediaUrl}`);
      
      // 如果有文字，先发送文字
      if (text?.trim()) {
        const textResult = await sendToWeChat(text);
        if (!textResult.ok) {
          return {
            channel: "wechat",
            ok: false,
            messageId: "",
            error: textResult.error,
          };
        }
        // 等待一下再发送媒体
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      
      // 发送媒体文件
      if (mediaUrl) {
        // 处理本地路径（去掉 file:// 前缀）
        let filePath = mediaUrl;
        if (filePath.startsWith("file://")) {
          filePath = filePath.replace("file://", "");
        }
        if (filePath.startsWith("~")) {
          filePath = filePath.replace("~", process.env.HOME ?? "");
        }
        
        const mediaResult = await sendMediaToWeChat(filePath);
        return {
          channel: "wechat",
          ok: mediaResult.ok,
          messageId: mediaResult.messageId ?? "",
          error: mediaResult.error,
        };
      }
      
      return {
        channel: "wechat",
        ok: true,
        messageId: `wechat-${Date.now()}`,
      };
    },
  },
  gateway: {
    startAccount: async (gatewayCtx: any) => {
      gatewayCtx.log?.info?.(`wechat: starting provider`);
      gatewayCtx.setStatus({ accountId: gatewayCtx.accountId, port: null });

      const log = gatewayCtx.log?.info?.bind(gatewayCtx.log) ?? console.log;
      const error = gatewayCtx.log?.error?.bind(gatewayCtx.log) ?? console.error;
      const cfg = gatewayCtx.cfg; // 注意：飞书插件用的是 ctx.cfg，不是 ctx.config

      // 构建 runtimeEnv
      const runtimeEnv: RuntimeEnv = {
        log,
        error,
      };

      // 辅助函数：从通知数据创建消息并发送给 Agent
      async function processNotificationMessage(sender: string, content: string): Promise<void> {
        const messageId = `wechat-notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const senderId = sender;
        const chatId = sender; // 通知中无法获取 chatId，用 sender 代替

        const messageCtx: WechatMessageContext = {
          chatId,
          messageId,
          senderId,
          senderName: sender,
          chatType: "direct", // 通知中无法判断，默认私聊
          content,
        };

        await handleWechatMessage({ cfg, ctx: messageCtx, runtimeEnv });
      }

      // 启动通知监控
      await startNotificationMonitor(
        async (sender: string, content: string) => {
          // 发件人白名单过滤（allowedSenders 未配置时不过滤）
          const allowedSenders = (cfg as any)?.channels?.wechat?.allowedSenders as string[] | undefined;
          if (allowedSenders && allowedSenders.length > 0) {
            if (!allowedSenders.includes(sender)) {
              log(`[wechat-notify] Ignored notification from unlisted sender: ${sender}`);
              return;
            }
          }

          // 通知监控不做去重检查，收到就处理
          // 去重只在 webhook 端做，防止 webhook 重复处理已被通知处理过的消息

          // 判断是否需要等待 webhook
          if (shouldWaitForWebhook(content)) {
            // 长文本或多媒体消息：记录到 pending，等待 webhook 提供完整内容
            const pendingKey = getMessageKey(sender, content);
            pendingNotifications.set(pendingKey, {
              sender,
              content,
              timestamp: Date.now(),
            });
            log(`[wechat-notify] Message may be truncated/media, waiting for webhook: ${sender}: ${content.slice(0, 30)}...`);

            // 设置超时：如果 30 秒后 webhook 还没来，就用通知的内容发送
            setTimeout(async () => {
              const pending = pendingNotifications.get(pendingKey);
              if (pending) {
                log(`[wechat-notify] Webhook timeout, processing with notification content: ${sender}`);
                pendingNotifications.delete(pendingKey);
                
                // 标记为已处理
                markMessageProcessed(sender, content);

                // 多媒体消息不能仅从通知获取，跳过
                if (isMediaMessage(content)) {
                  log(`[wechat-notify] Media message cannot be processed from notification, skipped`);
                  return;
                }

                // 发送给 Agent
                try {
                  await processNotificationMessage(sender, content);
                } catch (err) {
                  error(`[wechat-notify] Failed to process message: ${err}`);
                }
              }
            }, PENDING_TIMEOUT_MS);
            return;
          }

          // 短文本：直接处理
          log(`[wechat-notify] Processing short message directly: ${sender}: ${content}`);
          markMessageProcessed(sender, content);

          try {
            await processNotificationMessage(sender, content);
          } catch (err) {
            error(`[wechat-notify] Failed to process message: ${err}`);
          }
        },
        log
      );

      // 返回一个永不 resolve 的 Promise 保持运行
      return new Promise<void>((resolve) => {
        gatewayCtx.abortSignal?.addEventListener("abort", () => {
          gatewayCtx.log?.info?.(`wechat: provider stopped`);
          stopNotificationMonitor();
          resolve();
        });
      });
    },
  },
};

// ============================================================
// 插件注册
// ============================================================

const plugin = {
  id: "wechat",
  name: "WeChat Webhook Channel",
  description: "Receives WeChat messages via Webhook and registers WeChat channel.",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    pluginApi = api;

    // 保存 runtime 引用 (关键!)
    setWechatRuntime(api.runtime);

    api.logger.info(`[wechat-webhook] Plugin registering...`);

    // 注册 channel
    api.registerChannel({ plugin: wechatPlugin as any });

    // 注册 HTTP handler
    api.registerHttpHandler(async function wechatWebhookHandler(
      req: IncomingMessage,
      res: ServerResponse
    ): Promise<boolean> {
      return await handleWechatWebhookRequest(
        req,
        res,
        api.config as ClawdbotConfig,
        api.runtime as unknown as RuntimeEnv
      );
    });

    api.logger.info("WeChat Webhook channel plugin activated. Listening for webhooks on /api/webhook");
  },
};

export default plugin;
