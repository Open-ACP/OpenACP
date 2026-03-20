# Telegram Setup

## Create a Bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram
2. Send `/newbot`, follow the prompts
3. Copy the bot token

## Create a Supergroup

1. Create a new Group in Telegram
2. Go to **Group Settings** → enable **Topics**
3. This converts it to a Supergroup with forum topics

## Add Bot as Admin

Add your bot to the group and promote to **Admin** with:
- **Manage Topics** (required)
- **Send Messages**
- **Delete Messages** (optional)

## Get Chat ID

Forward any message from the group to [@RawDataBot](https://t.me/raw_data_bot). It replies with the chat ID (negative number starting with `-100`).

Or use the API directly:
```
https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
```

## System Topics

On first start, OpenACP creates two topics automatically:

| Topic | Purpose |
|-------|---------|
| **Notifications** | Session completed, errors, permission requests — with deep links |
| **Assistant** | AI-powered helper that guides you through creating and managing sessions |

Topic IDs are saved to config (`notificationTopicId`, `assistantTopicId`).

## Session Topics

Each `/new` command creates a **separate forum topic** for that session. Features:

- **Real-time streaming** — agent responses stream as they're generated, with throttled message updates (1s interval)
- **Auto-naming** — after the first prompt, the topic is renamed to a 5-word summary
- **Prompt queue** — send multiple messages while agent is busy, they queue up
- **Skill commands** — agent publishes available skills as inline buttons, pinned in the topic
- **Permission buttons** — when agent needs approval, inline buttons appear (Allow / Always Allow / Reject)
- **Viewer links** — if tunnel is enabled, tool calls include clickable file/diff viewer links

## Message Streaming

Agent output is streamed in real-time using a `MessageDraft` system:
- Text buffers and flushes at 1-second intervals
- First chunk creates a new message, subsequent chunks edit it
- Markdown → Telegram HTML conversion with syntax highlighting
- Messages split at 4096 chars (Telegram limit)
- Graceful fallback to plain text if HTML parsing fails

## Environment Variables

```bash
OPENACP_TELEGRAM_BOT_TOKEN=your_token openacp
OPENACP_TELEGRAM_CHAT_ID=-1001234567890 openacp
```
