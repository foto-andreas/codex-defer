# codex-defer

Public Codex Marketplace repository for the `at` plugin.

The plugin provides:

- `/at`: schedule a prompt for a concrete time in the current chat thread
- `/defer`: schedule a prompt for 2 minutes after quota is available again
- `/at stop`: stop pending scheduled prompts in the current thread

## Why this plugin exists

Some tasks should run later, not now. This plugin allows local, programmatic scheduling in the running chat thread.

Typical use cases:

- run a reminder prompt at a specific time
- queue a follow-up prompt without consuming model budget immediately
- defer work until rate limits reset

## How it works

The plugin uses a local `UserPromptSubmit` hook.

- On `/at` or `/defer`, the hook parses the command locally.
- It writes a local heartbeat automation to `~/.codex/automations/<id>/automation.toml`.
- It blocks the current turn so the command itself does not trigger an immediate model response.
- At the scheduled time, Codex runs the stored prompt in the same thread.

`/defer` uses local Codex session logs (`~/.codex/sessions/**/*.jsonl`) and reads the latest `token_count.rate_limits` snapshot.

## Command reference

### `/at`

Syntax:

```text
/at <time> | <prompt>
```

Supported time formats:

- `HH:MM` (today or next day if time already passed)
- `YYYY-MM-DD HH:MM`
- `YYYY-MM-DDTHH:MM`
- ISO datetime with timezone, for example `2026-07-10T14:00+02:00`
- relative format, for example `in 20 minutes`, `in 2 hours`, `in 20 minuten`

Examples:

```text
/at 22:22 | zeige die uhrzeit
/at in 15 minutes | erinnere mich an den Release-Check
/at 2026-07-10 09:30 | starte den Tagesreport
```

### `/defer`

Syntax:

```text
/defer <prompt>
/defer | <prompt>
```

Behavior:

- if quota is currently available: schedule for `now + 2 minutes`
- if quota is exhausted: schedule for `max(primary_reset, secondary_reset) + 2 minutes`

Examples:

```text
/defer | e2e hook test
/defer Starte den Prompt, sobald das Kontingent wieder frei ist.
```

### Stop scheduled prompts

Syntax:

```text
/at stop
/at stop all
/at stop <automation-id>
/defer stop
```

Behavior:

- `/at stop` removes the latest pending `/at` or `/defer` automation in this thread
- `/at stop all` removes all pending `/at` or `/defer` automations in this thread
- `/at stop <automation-id>` removes one specific automation by id

Examples:

```text
/at stop
/at stop all
/at stop at-20260707-224216-a1123f
/defer stop
```

## Install

1. Add marketplace:

```powershell
codex plugin marketplace add foto-andreas/codex-defer
```

2. Install plugin:

```powershell
codex plugin add at@codex-defer
```

3. Verify:

```powershell
codex plugin list
```

## Update

Reinstall the plugin from marketplace:

```powershell
codex plugin add at@codex-defer
```

After reinstall, open a new thread so Codex picks up updated hooks and skills.

## Troubleshooting

`/defer failed: no local quota snapshot found`

- cause: no local quota-backed `token_count.rate_limits` snapshot exists
- fix: run one normal prompt in a quota-backed Codex chat, then retry `/defer`

`/defer failed: local quota snapshot is stale (...)`

- cause: last local snapshot is too old
- fix: run a fresh normal prompt in a quota-backed chat, then retry

`Invalid time '...'`

- cause: unsupported `/at` time format
- fix: use one of the formats listed above

No automation is created when command is sent

- check that plugin is installed and enabled via `codex plugin list`
- check that Node.js is installed (hook runtime)
- retry in a new thread after plugin updates

## Notes and limitations

- `/defer` depends on local session logs and cannot infer quota from API-only contexts without local snapshots.
- Scheduled execution still needs available quota at execution time.
- This plugin is optimized for local Codex desktop workflows.

## Repository layout

```text
.agents/plugins/marketplace.json
plugins/at/.codex-plugin/plugin.json
plugins/at/hooks/at-user-prompt-submit.js
plugins/at/hooks/claude-codex-hooks.json
plugins/at/skills/at/SKILL.md
```
