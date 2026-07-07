# codex-defer

Public Codex Marketplace repository for the `at` plugin.

The plugin provides:

- `/at`: schedule a prompt for a concrete time in the current chat thread
- `/defer`: schedule a prompt for 2 minutes after quota is available again
- `/quota`: print local quota snapshot debug details for troubleshooting
- `/at stop`: stop pending scheduled prompts in the current thread

## Why this plugin exists

Some tasks should run later, not now. This plugin allows local, programmatic scheduling in the running chat thread.

Typical use cases:

- run a reminder prompt at a specific time
- queue a follow-up prompt without consuming model budget immediately
- defer work until rate limits reset

## How it works

The plugin uses a local `UserPromptSubmit` hook.

- On `/at`, `/defer`, or `/quota`, the hook parses the command locally.
- For `/at` and `/defer`, it writes a local heartbeat automation to `~/.codex/automations/<id>/automation.toml`.
- For `/quota`, it returns only a local debug summary and creates no automation.
- It blocks the current turn so the command itself does not trigger an immediate model response.
- At the scheduled time, Codex runs the stored prompt in the same thread.

`/defer` uses local Codex session logs (`~/.codex/sessions/**/*.jsonl`) and reads the latest `token_count.rate_limits` snapshot.
`/quota` uses the same local data source and returns a debug line with normalized percentages and reset timestamps.

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

- chooses the newest usable local snapshot by timestamp (not the first usable file)
- if quota is currently available: schedule for `now + 2 minutes`
- if quota is exhausted: schedule for `max(primary_reset, secondary_reset) + 2 minutes`

Examples:

```text
/defer | e2e hook test
/defer Starte den Prompt, sobald das Kontingent wieder frei ist.
```

### `/quota`

Syntax:

```text
/quota
```

Behavior:

- reads the most recent local `token_count.rate_limits` snapshot
- prints raw and normalized values for primary (5h) and secondary (7d)
- prints `snapshot_age_min` and `stale_for_defer` to explain whether `/defer` would accept this snapshot
- prints the plugin decision (`Quota currently available` or exhausted window) and computed free time
- does not schedule anything and does not call an LLM

Example:

```text
/quota
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

4. Trust plugin hooks (required):

- Open hook review in Codex (`/hooks` in CLI or Hooks panel in app).
- Review the `at` plugin hook entries and mark them as trusted.
- If hook code changes in a future plugin update, trust must be confirmed again before execution.

Without trust, `/at`, `/defer`, and `/quota` are installed but skipped.

## Official distribution / approval

There are two different distribution paths:

- Repo marketplace (this repository): custom curated source that you manage yourself, suitable for personal/team distribution.
- Public Codex Plugin Directory listing: use OpenAI app submission and review flow in the Platform Dashboard.

For public listing, OpenAI currently uses the app review path and creates Codex plugin distribution from approved apps.

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

`/quota: no token_count snapshot found in local sessions.`

- cause: no usable local quota data is present yet on this machine/profile
- fix: run one normal prompt in a quota-backed Codex chat, then run `/quota` again

`Invalid schema for function 'automation_update' ... type: "None"`

- cause: Codex platform/tool schema issue, not this plugin hook
- fix: restart Codex or open a fresh thread and retry; plugin commands `/at`, `/defer`, `/quota` work without `automation_update`

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
