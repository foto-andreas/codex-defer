#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const USAGE_AT =
  "Usage: /at <time> | <prompt>. Example: /at 22:22 | zeige die uhrzeit";
const USAGE_DEFER =
  "Usage: /defer <prompt>. Example: /defer | pruefe in 2 minuten erneut";
const USAGE_STOP =
  "Usage: /at stop [all|<id>] or /defer stop [all|<id>].";

const TWO_MINUTES_MS = 2 * 60 * 1000;
const MAX_RATE_LIMIT_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1000;

let inputBuffer = "";
let finished = false;

function pad2(value) {
  return String(value).padStart(2, "0");
}

function nowMs() {
  return Date.now();
}

function tomlEscape(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "")
    .replace(/\n/g, "\\n");
}

function emitBlock(reason) {
  const safeReason =
    typeof reason === "string" && reason.trim().length > 0
      ? reason.trim()
      : "Blocked by /at local scheduler.";
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: safeReason,
    }),
  );
}

function parseAtPrompt(promptText) {
  const trimmed = String(promptText || "").trim();
  if (!/^\/at\b/i.test(trimmed)) {
    return null;
  }

  const body = trimmed.replace(/^\/at\b/i, "").trim();
  if (!body) {
    return { error: USAGE_AT };
  }

  const separatorIndex = body.indexOf("|");
  if (separatorIndex < 0) {
    return { error: USAGE_AT };
  }

  const timeText = body.slice(0, separatorIndex).trim();
  const scheduledPrompt = body.slice(separatorIndex + 1).trim();
  if (!timeText || !scheduledPrompt) {
    return { error: USAGE_AT };
  }

  return { kind: "at", timeText, scheduledPrompt };
}

function parseStopPrompt(promptText) {
  const trimmed = String(promptText || "").trim();
  const match = trimmed.match(/^\/(at|defer)\s+(stop|cancel)(?:\s+([^\s]+))?\s*$/i);
  if (!match) {
    return null;
  }

  const rawScope = String(match[3] || "").trim();
  if (!rawScope) {
    return { kind: "stop", scope: "last" };
  }

  if (/^all$/i.test(rawScope)) {
    return { kind: "stop", scope: "all" };
  }

  return { kind: "stop", scope: "id", automationId: rawScope };
}

function parseDeferPrompt(promptText) {
  const trimmed = String(promptText || "").trim();
  if (!/^\/defer\b/i.test(trimmed)) {
    return null;
  }

  let body = trimmed.replace(/^\/defer\b/i, "").trim();
  if (body.startsWith("|")) {
    body = body.slice(1).trim();
  }

  if (!body) {
    return { error: USAGE_DEFER };
  }

  return { kind: "defer", scheduledPrompt: body };
}

function parseCommand(promptText) {
  const stopCommand = parseStopPrompt(promptText);
  if (stopCommand) {
    return stopCommand;
  }

  const atCommand = parseAtPrompt(promptText);
  if (atCommand) {
    return atCommand;
  }

  return parseDeferPrompt(promptText);
}

function buildLocalDate(year, month, day, hour, minute, second) {
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    return null;
  }
  return date;
}

function parseRelativeTime(text, now) {
  const match = text.match(
    /^in\s+(\d+)\s*(m|min|mins|minute|minutes|minuten|h|hr|hrs|hour|hours|stunde|stunden)$/i,
  );
  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  const unit = match[2].toLowerCase();
  const minuteUnits = new Set(["m", "min", "mins", "minute", "minutes", "minuten"]);
  const hourUnits = new Set(["h", "hr", "hrs", "hour", "hours", "stunde", "stunden"]);

  let deltaMs;
  if (minuteUnits.has(unit)) {
    deltaMs = value * 60 * 1000;
  } else if (hourUnits.has(unit)) {
    deltaMs = value * 60 * 60 * 1000;
  } else {
    return null;
  }

  return new Date(now.getTime() + deltaMs);
}

function parseClockTime(text, now) {
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || "0");
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  let candidate = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hour,
    minute,
    second,
    0,
  );
  if (candidate.getTime() <= now.getTime()) {
    candidate = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
  }
  return candidate;
}

function parseLocalDateTime(text) {
  const match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)$/,
  );
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || "0");

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  return buildLocalDate(year, month, day, hour, minute, second);
}

function parseScheduledDate(timeText, now) {
  const trimmed = String(timeText || "").trim();
  if (!trimmed) {
    return null;
  }

  const relative = parseRelativeTime(trimmed, now);
  if (relative) {
    return relative;
  }

  const clock = parseClockTime(trimmed, now);
  if (clock) {
    return clock;
  }

  const localDateTime = parseLocalDateTime(trimmed);
  if (localDateTime) {
    return localDateTime;
  }

  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  return null;
}

function toUtcTimestamp(date) {
  return (
    String(date.getUTCFullYear()) +
    pad2(date.getUTCMonth() + 1) +
    pad2(date.getUTCDate()) +
    "T" +
    pad2(date.getUTCHours()) +
    pad2(date.getUTCMinutes()) +
    pad2(date.getUTCSeconds()) +
    "Z"
  );
}

function toLocalIdStamp(date) {
  return (
    String(date.getFullYear()) +
    pad2(date.getMonth() + 1) +
    pad2(date.getDate()) +
    "-" +
    pad2(date.getHours()) +
    pad2(date.getMinutes()) +
    pad2(date.getSeconds())
  );
}

function formatLocalDisplay(date) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  const datePart = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  const timePart = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  return `${datePart} ${timePart} (${tz})`;
}

function parseIsoDateMs(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  const ms = Date.parse(text);
  if (Number.isNaN(ms)) {
    return null;
  }
  return ms;
}

function parseResetMs(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return Math.floor(seconds * 1000);
}

function normalizePercentToFraction(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  if (numeric <= 1) {
    return Math.max(0, numeric);
  }

  // Some runtimes report percent as 0..100 instead of 0..1.
  if (numeric > 2 && numeric <= 100) {
    return Math.max(0, numeric / 100);
  }

  return Math.max(0, numeric);
}

function getUsedFraction(windowData) {
  if (!windowData || typeof windowData !== "object") {
    return null;
  }

  const usedFromUsedPercent = normalizePercentToFraction(windowData.used_percent);
  if (usedFromUsedPercent !== null) {
    return usedFromUsedPercent;
  }

  const remainingFromRemainingPercent = normalizePercentToFraction(windowData.remaining_percent);
  if (remainingFromRemainingPercent !== null) {
    return Math.max(0, 1 - remainingFromRemainingPercent);
  }

  const usedFromUsed = normalizePercentToFraction(windowData.used);
  if (usedFromUsed !== null) {
    return usedFromUsed;
  }

  return null;
}

function isWindowExhausted(windowData) {
  const usedFraction = getUsedFraction(windowData);
  if (usedFraction === null) {
    return false;
  }
  return usedFraction >= 0.999;
}

function describeLimitState(rateLimits, freeAtMs, nowMs) {
  if (freeAtMs <= nowMs) {
    return "Quota currently available";
  }

  const exhausted = [];
  if (isWindowExhausted(rateLimits && rateLimits.primary)) {
    exhausted.push("5h");
  }
  if (isWindowExhausted(rateLimits && rateLimits.secondary)) {
    exhausted.push("7d");
  }

  if (exhausted.length > 0) {
    return `Quota currently exhausted (${exhausted.join(" + ")})`;
  }

  const reachedType = String(rateLimits && rateLimits.rate_limit_reached_type ? rateLimits.rate_limit_reached_type : "").trim();
  if (reachedType) {
    return `Quota currently exhausted (${reachedType})`;
  }

  return "Quota currently exhausted";
}

function resolveQuotaFreeAtMs(rateLimits, nowMs) {
  const resets = [];
  const primary = rateLimits && rateLimits.primary ? rateLimits.primary : null;
  const secondary = rateLimits && rateLimits.secondary ? rateLimits.secondary : null;

  if (isWindowExhausted(primary)) {
    const primaryReset = parseResetMs(primary && primary.resets_at);
    if (primaryReset !== null) {
      resets.push(primaryReset);
    }
  }

  if (isWindowExhausted(secondary)) {
    const secondaryReset = parseResetMs(secondary && secondary.resets_at);
    if (secondaryReset !== null) {
      resets.push(secondaryReset);
    }
  }

  if (resets.length === 0) {
    const reachedType = String(rateLimits && rateLimits.rate_limit_reached_type ? rateLimits.rate_limit_reached_type : "").toLowerCase();
    if (reachedType.includes("primary")) {
      const primaryReset = parseResetMs(primary && primary.resets_at);
      if (primaryReset !== null) {
        resets.push(primaryReset);
      }
    }
    if (reachedType.includes("secondary")) {
      const secondaryReset = parseResetMs(secondary && secondary.resets_at);
      if (secondaryReset !== null) {
        resets.push(secondaryReset);
      }
    }
  }

  if (resets.length === 0) {
    return nowMs;
  }

  return Math.max(nowMs, ...resets);
}

function collectJsonlFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (error) {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function findSessionFileById(rootDir, sessionId) {
  if (!sessionId || !fs.existsSync(rootDir)) {
    return null;
  }

  const suffix = `-${sessionId}.jsonl`.toLowerCase();
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (error) {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) {
        return fullPath;
      }
    }
  }

  return null;
}

function extractLatestRateLimitsFromJsonl(filePath) {
  const MAX_TAIL_BYTES = 1024 * 1024;

  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (error) {
    return null;
  }

  const fileSize = Number(stats.size || 0);
  if (fileSize <= 0) {
    return null;
  }

  const bytesToRead = Math.min(fileSize, MAX_TAIL_BYTES);
  const buffer = Buffer.alloc(bytesToRead);
  const startPosition = Math.max(0, fileSize - bytesToRead);

  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buffer, 0, bytesToRead, startPosition);
  } catch (error) {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (closeError) {
        // best effort close
      }
    }
  }

  const text = buffer.toString("utf8");
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line || !line.includes("\"token_count\"") || !line.includes("\"rate_limits\"")) {
      continue;
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      continue;
    }

    if (
      record &&
      record.type === "event_msg" &&
      record.payload &&
      record.payload.type === "token_count" &&
      record.payload.rate_limits
    ) {
      return {
        filePath,
        timestamp: record.timestamp || null,
        rateLimits: record.payload.rate_limits,
      };
    }
  }

  return null;
}

function getMostRecentRateLimitSnapshot(codexHome, sessionId) {
  const sessionsRoot = path.join(codexHome, "sessions");
  const archivedSessionsRoot = path.join(codexHome, "archived_sessions");
  const candidates = [];
  const seen = new Set();

  function addCandidate(filePath) {
    if (!filePath || seen.has(filePath)) {
      return;
    }
    seen.add(filePath);
    candidates.push(filePath);
  }

  addCandidate(findSessionFileById(sessionsRoot, sessionId));
  addCandidate(findSessionFileById(archivedSessionsRoot, sessionId));

  const recentSessions = collectJsonlFiles(sessionsRoot)
    .map((filePath) => {
      let mtimeMs = 0;
      try {
        mtimeMs = Number(fs.statSync(filePath).mtimeMs || 0);
      } catch (error) {
        mtimeMs = 0;
      }
      return { filePath, mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, 25);
  for (const item of recentSessions) {
    addCandidate(item.filePath);
  }

  for (const filePath of candidates) {
    const snapshot = extractLatestRateLimitsFromJsonl(filePath);
    if (snapshot) {
      return snapshot;
    }
  }

  return null;
}

function parseTomlStringValue(content, key) {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*"(.*)"\\s*$`, "m");
  const match = String(content || "").match(pattern);
  if (!match) {
    return null;
  }
  return String(match[1] || "");
}

function parseTomlNumberValue(content, key) {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)\\s*$`, "m");
  const match = String(content || "").match(pattern);
  if (!match) {
    return null;
  }

  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric;
}

function loadAtAutomationMetadata(automationDir) {
  const tomlPath = path.join(automationDir, "automation.toml");
  if (!fs.existsSync(tomlPath)) {
    return null;
  }

  let content;
  try {
    content = fs.readFileSync(tomlPath, "utf8");
  } catch (error) {
    return null;
  }

  const id = parseTomlStringValue(content, "id");
  if (!id || !id.startsWith("at-")) {
    return null;
  }

  const targetThreadId = parseTomlStringValue(content, "target_thread_id");
  const status = parseTomlStringValue(content, "status") || "ACTIVE";
  const updatedAt = parseTomlNumberValue(content, "updated_at");
  const createdAt = parseTomlNumberValue(content, "created_at");

  let mtimeMs = 0;
  try {
    mtimeMs = Number(fs.statSync(tomlPath).mtimeMs || 0);
  } catch (error) {
    mtimeMs = 0;
  }

  return {
    id,
    automationDir,
    tomlPath,
    targetThreadId,
    status,
    updatedAt,
    createdAt,
    mtimeMs,
  };
}

function listAtAutomationsForThread(codexHome, sessionId) {
  const automationsRoot = path.join(codexHome, "automations");
  if (!fs.existsSync(automationsRoot)) {
    return [];
  }

  let entries;
  try {
    entries = fs.readdirSync(automationsRoot, { withFileTypes: true });
  } catch (error) {
    return [];
  }

  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("at-")) {
      continue;
    }

    const metadata = loadAtAutomationMetadata(path.join(automationsRoot, entry.name));
    if (!metadata) {
      continue;
    }

    if (String(metadata.targetThreadId || "").trim() !== sessionId) {
      continue;
    }

    result.push(metadata);
  }

  return result;
}

function getAutomationSortTimestamp(meta) {
  if (Number.isFinite(meta && meta.updatedAt)) {
    return Number(meta.updatedAt);
  }
  if (Number.isFinite(meta && meta.createdAt)) {
    return Number(meta.createdAt);
  }
  if (Number.isFinite(meta && meta.mtimeMs)) {
    return Number(meta.mtimeMs);
  }
  return 0;
}

function deleteAutomationDirectory(automationDir) {
  if (!fs.existsSync(automationDir)) {
    return false;
  }
  fs.rmSync(automationDir, { recursive: true, force: true });
  return true;
}

function makeAutomationId(scheduledAt, rootDir) {
  const base = `at-${toLocalIdStamp(scheduledAt)}`;
  for (let i = 0; i < 1000; i += 1) {
    const suffix = Math.random().toString(16).slice(2, 8).padEnd(6, "0");
    const candidate = `${base}-${suffix}`;
    if (!fs.existsSync(path.join(rootDir, candidate))) {
      return candidate;
    }
  }
  throw new Error("could not allocate unique automation id");
}

function writeHeartbeatAutomation(sessionId, scheduledAt, scheduledPrompt) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const automationsRoot = path.join(codexHome, "automations");
  fs.mkdirSync(automationsRoot, { recursive: true });

  const automationId = makeAutomationId(scheduledAt, automationsRoot);
  const automationDir = path.join(automationsRoot, automationId);
  fs.mkdirSync(automationDir, { recursive: false });

  const utcStart = toUtcTimestamp(scheduledAt);
  const rruleValue = `DTSTART:${utcStart}\nRRULE:FREQ=MINUTELY;COUNT=1`;
  const timestampMs = nowMs();

  const lines = [
    "version = 1",
    `id = "${tomlEscape(automationId)}"`,
    'kind = "heartbeat"',
    `name = "${tomlEscape(automationId)}"`,
    `prompt = "${tomlEscape(scheduledPrompt)}"`,
    'status = "ACTIVE"',
    `rrule = "${tomlEscape(rruleValue)}"`,
    `target_thread_id = "${tomlEscape(sessionId)}"`,
    `created_at = ${timestampMs}`,
    `updated_at = ${timestampMs}`,
    "",
  ];

  fs.writeFileSync(path.join(automationDir, "automation.toml"), lines.join("\n"), "utf8");
  return automationId;
}

function processPayload(raw) {
  const payload = JSON.parse(String(raw || "").replace(/^\uFEFF/, ""));
  const parsedCommand = parseCommand(payload.prompt);
  if (!parsedCommand) {
    return;
  }

  if (parsedCommand.error) {
    emitBlock(parsedCommand.error);
    return;
  }

  const sessionId = String(payload.session_id || "").trim();
  if (!sessionId) {
    emitBlock("Command failed: missing session_id in hook payload.");
    return;
  }

  const now = new Date();
  if (parsedCommand.kind === "stop") {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    const threadAutomations = listAtAutomationsForThread(codexHome, sessionId);
    if (threadAutomations.length === 0) {
      emitBlock("No scheduled /at or /defer prompts found for this thread.");
      return;
    }

    let targets;
    if (parsedCommand.scope === "all") {
      targets = threadAutomations;
    } else if (parsedCommand.scope === "id") {
      targets = threadAutomations.filter(
        (item) => String(item.id || "").trim() === String(parsedCommand.automationId || "").trim(),
      );
      if (targets.length === 0) {
        emitBlock(`No scheduled prompt with id '${parsedCommand.automationId}' found in this thread. ${USAGE_STOP}`);
        return;
      }
    } else {
      const activeCandidates = threadAutomations.filter(
        (item) => String(item.status || "").toUpperCase() === "ACTIVE",
      );
      const candidates = activeCandidates.length > 0 ? activeCandidates : threadAutomations;
      targets = [
        candidates
          .slice()
          .sort((left, right) => getAutomationSortTimestamp(right) - getAutomationSortTimestamp(left))[0],
      ];
    }

    const deletedIds = [];
    for (const target of targets) {
      if (deleteAutomationDirectory(target.automationDir)) {
        deletedIds.push(target.id);
      }
    }

    if (deletedIds.length === 0) {
      emitBlock("No scheduled prompts were removed.");
      return;
    }

    if (deletedIds.length === 1) {
      emitBlock(`Stopped scheduled prompt ${deletedIds[0]}.`);
      return;
    }

    emitBlock(`Stopped ${deletedIds.length} scheduled prompts: ${deletedIds.join(", ")}.`);
    return;
  }

  if (parsedCommand.kind === "at") {
    const scheduledAt = parseScheduledDate(parsedCommand.timeText, now);
    if (!scheduledAt) {
      emitBlock(`Invalid time '${parsedCommand.timeText}'. ${USAGE_AT}`);
      return;
    }

    if (scheduledAt.getTime() <= now.getTime()) {
      emitBlock("Time must be in the future.");
      return;
    }

    const automationId = writeHeartbeatAutomation(
      sessionId,
      scheduledAt,
      parsedCommand.scheduledPrompt,
    );

    emitBlock(
      `/at scheduled locally for ${formatLocalDisplay(scheduledAt)} as ${automationId}. Prompt will run later in this same thread.`,
    );
    return;
  }

  if (parsedCommand.kind === "defer") {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    const snapshot = getMostRecentRateLimitSnapshot(codexHome, sessionId);
    if (!snapshot || !snapshot.rateLimits) {
      emitBlock(
        "/defer failed: no local quota snapshot found. Run one prompt in a quota-backed Codex chat and retry.",
      );
      return;
    }

    const nowMs = now.getTime();
    const snapshotMs = parseIsoDateMs(snapshot.timestamp);
    if (snapshotMs !== null && nowMs - snapshotMs > MAX_RATE_LIMIT_SNAPSHOT_AGE_MS) {
      const snapshotAt = new Date(snapshotMs);
      emitBlock(
        `/defer failed: local quota snapshot is stale (${formatLocalDisplay(snapshotAt)}). Run one prompt in a quota-backed Codex chat and retry.`,
      );
      return;
    }

    const freeAtMs = resolveQuotaFreeAtMs(snapshot.rateLimits, nowMs);
    const scheduledAt = new Date(Math.max(nowMs, freeAtMs) + TWO_MINUTES_MS);
    const automationId = writeHeartbeatAutomation(
      sessionId,
      scheduledAt,
      parsedCommand.scheduledPrompt,
    );

    const stateText = describeLimitState(snapshot.rateLimits, freeAtMs, nowMs);
    const snapshotText = snapshot.timestamp ? ` Snapshot: ${snapshot.timestamp}.` : "";
    emitBlock(
      `/defer scheduled locally for ${formatLocalDisplay(scheduledAt)} as ${automationId}. ${stateText}.${snapshotText} Prompt will run later in this same thread.`,
    );
  }
}

function finish() {
  if (finished) {
    return;
  }
  finished = true;

  const trimmed = inputBuffer.trim();
  if (!trimmed) {
    return;
  }

  try {
    processPayload(inputBuffer);
  } catch (error) {
    const message =
      error && typeof error.message === "string" && error.message.trim()
        ? error.message.trim()
        : "unknown error";
    emitBlock(`/at failed: ${message}`);
  }
}

process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
});
process.stdin.on("end", finish);
process.stdin.on("error", () => {
  finish();
  process.exit(0);
});
setTimeout(() => {
  finish();
  process.exit(0);
}, 1000).unref();
