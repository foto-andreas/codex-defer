# codex-defer

Public Codex Marketplace repository for the `at` plugin.

The plugin handles `/at`, `/defer`, `/quota`, and stop commands locally through
a `UserPromptSubmit` hook. Scheduled prompts are written as heartbeat
automations under `~/.codex/automations/<id>/automation.toml`, and the command
turn is blocked so it does not spend an immediate model response.

## Commands

| Command | What it does |
| --- | --- |
| `/at <time> \| <prompt>` | Schedules a prompt for a concrete time in the current thread. |
| `/defer [\|] <prompt>` | Schedules a prompt for 2 minutes after local quota appears available again. |
| `/quota` | Prints local quota snapshot details for debugging. |
| `/at stop [all|<id>]` | Stops pending `/at` or `/defer` automations in the current thread. |
| `/defer stop [all|<id>]` | Same stop behavior via the `/defer` command. |

Accepted `/at` time formats:

- `HH:MM`
- `YYYY-MM-DD HH:MM`
- `YYYY-MM-DDTHH:MM`
- ISO datetime with timezone, for example `2026-07-10T14:00+02:00`
- relative time, for example `in 20 minutes`, `in 2 hours`, `in 20 minuten`

Examples:

```text
/at 22:22 | zeige die uhrzeit
/at in 15 minutes | erinnere mich an den Release-Check
/defer | Starte den Prompt, sobald das Kontingent wieder frei ist.
/quota
/at stop
```

More runtime details live in `plugins/at/skills/at/SKILL.md`.

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

4. Trust plugin hooks:

- Open hook review in Codex (`/hooks` in CLI or Hooks panel in app).
- Review the `at` plugin hook entries and mark them as trusted.
- If hook code changes in a future plugin update, trust must be confirmed again.

Without trust, `/at`, `/defer`, and `/quota` are installed but skipped.

## Update

Reinstall the plugin from marketplace:

```powershell
codex plugin add at@codex-defer
```

After reinstall, open a new thread so Codex picks up updated hooks and skills.

## Troubleshooting

- If `/defer` or `/quota` reports no or stale quota snapshots, run one normal
  prompt in a quota-backed Codex chat, then retry.
- If commands do nothing, check that the plugin is installed, hooks are trusted,
  Node.js is installed, and the thread was opened after the latest plugin update.
- If `/at` reports `Invalid time`, use one of the formats above.

## Repository layout

```text
.agents/plugins/marketplace.json
plugins/at/.codex-plugin/plugin.json
plugins/at/hooks/at-user-prompt-submit.js
plugins/at/hooks/claude-codex-hooks.json
plugins/at/skills/at/SKILL.md
```
