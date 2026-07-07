---
name: at
description: Documentation for /at and /defer. Runtime scheduling is handled locally by a UserPromptSubmit hook.
---

# /at and /defer

## Goal

Document `/at` and `/defer`. Actual scheduling is done locally inside `hooks/at-user-prompt-submit.js`, not by model tool calls.

## Input

Use `/at` in this format:

- `<time> | <prompt>`

Accepted time examples:

- `2026-07-08 09:30`
- `2026-07-08T09:30`
- `2026-07-08T09:30+02:00`
- `in 20 minutes`
- `in 20 minuten`

Use `/defer` in this format:

- `<prompt>`
- `| <prompt>`

## Behavior

- The local hook parses command and prompt.
- If parsing fails, the hook blocks and returns a usage/error message.
- If valid, it writes `~/.codex/automations/<id>/automation.toml` with `kind = "heartbeat"`.
- It blocks this turn so no immediate model call is made.
- `/defer` reads the latest local `rate_limits` snapshot from `~/.codex/sessions/**/*.jsonl`.
- If a rate-limit window is exhausted, it schedules for `reset + 2 minutes`.
- If quota is currently available, it schedules for `now + 2 minutes`.
- If no fresh local quota snapshot exists, `/defer` blocks with an error and does not schedule.

## Scheduling

Runtime hook path:

- `hooks/claude-codex-hooks.json`
- `hooks/at-user-prompt-submit.js`

## Output

The hook returns a short local confirmation as block reason with:

- scheduled local datetime
- automation id/name
- quota state summary (for `/defer`)
- note that the prompt will run later in the same thread
