#!/usr/bin/env node
"use strict";

const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");

const USAGE_AT =
  "Usage: /at <time> | <prompt>. Example: /at 22:22 | zeige die uhrzeit";
const USAGE_DEFER =
  "Usage: /defer <prompt>. Example: /defer | pruefe in 2 minuten erneut";
const USAGE_STOP =
  "Usage: /at stop [all|<id>] or /defer stop [all|<id>].";
const USAGE_QUOTA =
  "Usage: /quota";

const TWO_MINUTES_MS = 2 * 60 * 1000;
const MAX_RATE_LIMIT_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_AVAILABLE_QUOTA_SNAPSHOT_AGE_MS = 2 * 60 * 60 * 1000;

function pad2(value) {
  return String(value).padStart(2, "0");
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
  const match = trimmed.match(/^\/(?:at|defer)\s+stop(?:\s+([^\s]+))?\s*$/i);
  if (!match) {
    return null;
  }

  const rawScope = String(match[1] || "").trim();
  if (!rawScope) {
    return { kind: "stop", scope: "last" };
  }

  if (/^all$/i.test(rawScope)) {
    return { kind: "stop", scope: "all" };
  }

  return { kind: "stop", scope: "id", automationId: rawScope };
}

function parseQuotaPrompt(promptText) {
  const trimmed = String(promptText || "").trim();
  if (!/^\/quota\b/i.test(trimmed)) {
    return null;
  }

  const body = trimmed.replace(/^\/quota\b/i, "").trim();
  if (body) {
    return { error: USAGE_QUOTA };
  }

  return { kind: "quota" };
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

  const quotaCommand = parseQuotaPrompt(promptText);
  if (quotaCommand) {
    return quotaCommand;
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
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
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
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric > 1e12) {
      return Math.floor(numeric);
    }
    return Math.floor(numeric * 1000);
  }

  return parseIsoDateMs(value);
}

function parseWindowMinutesMs(windowData) {
  if (!windowData || typeof windowData !== "object") {
    return null;
  }

  const minutes = Number(windowData.window_minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }

  return Math.floor(minutes * 60 * 1000);
}

function hasUsableWindowData(windowData) {
  if (!windowData || typeof windowData !== "object") {
    return false;
  }

  const hasUsedPercent = normalizePercentToFraction(windowData.used_percent) !== null;
  const hasRemainingPercent = normalizePercentToFraction(windowData.remaining_percent) !== null;
  const hasUsed = normalizePercentToFraction(windowData.used) !== null;
  const hasReset = parseResetMs(windowData.resets_at) !== null;

  return hasUsedPercent || hasRemainingPercent || hasUsed || hasReset;
}

function isUsableRateLimits(rateLimits) {
  if (!rateLimits || typeof rateLimits !== "object") {
    return false;
  }

  // Skip snapshots that contain only null placeholders (common in API-only chats).
  return (
    hasUsableWindowData(rateLimits.primary) ||
    hasUsableWindowData(rateLimits.secondary)
  );
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

function quotaWindows(rateLimits) {
  return [
    { label: "5h", type: "primary", data: rateLimits && rateLimits.primary },
    { label: "7d", type: "secondary", data: rateLimits && rateLimits.secondary },
  ];
}

function describeLimitState(rateLimits, freeAtMs, nowMs) {
  if (freeAtMs <= nowMs) {
    return "Quota currently available";
  }

  const exhausted = quotaWindows(rateLimits)
    .filter((window) => isWindowExhausted(window.data))
    .map((window) => window.label);

  if (exhausted.length > 0) {
    return `Quota currently exhausted (${exhausted.join(" + ")})`;
  }

  const reachedType = String(rateLimits && rateLimits.rate_limit_reached_type ? rateLimits.rate_limit_reached_type : "").trim();
  if (reachedType) {
    return `Quota currently exhausted (${reachedType})`;
  }

  return "Quota currently exhausted";
}

function formatDebugValue(value) {
  if (value === null || typeof value === "undefined") {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

function formatResetDebug(windowData) {
  if (!windowData || typeof windowData !== "object") {
    return "null";
  }

  const rawReset = windowData.resets_at;
  const resetMs = parseResetMs(rawReset);
  if (resetMs === null) {
    return formatDebugValue(rawReset);
  }

  return `${formatDebugValue(rawReset)} (${formatLocalDisplay(new Date(resetMs))})`;
}

function formatWindowQuotaDebug(label, windowData) {
  if (!windowData || typeof windowData !== "object") {
    return `${label}: null`;
  }

  const normalizedUsed = getUsedFraction(windowData);
  const normalizedText =
    normalizedUsed === null ? "n/a" : `${(normalizedUsed * 100).toFixed(2)}%`;

  return (
    `${label}: used_percent=${formatDebugValue(windowData.used_percent)}, ` +
    `remaining_percent=${formatDebugValue(windowData.remaining_percent)}, ` +
    `used=${formatDebugValue(windowData.used)}, ` +
    `used_norm=${normalizedText}, exhausted=${isWindowExhausted(windowData)}, ` +
    `resets_at=${formatResetDebug(windowData)}`
  );
}

function getExhaustedWindowResetCandidateMs(windowData, nowMs) {
  if (!isWindowExhausted(windowData)) {
    return null;
  }

  const resetMs = parseResetMs(windowData && windowData.resets_at);
  if (resetMs !== null && resetMs > nowMs) {
    return resetMs;
  }

  const windowMs = parseWindowMinutesMs(windowData);
  if (windowMs === null) {
    return null;
  }

  if (resetMs !== null) {
    let projectedMs = resetMs;
    for (let step = 0; step < 10000 && projectedMs <= nowMs; step += 1) {
      projectedMs += windowMs;
    }
    if (projectedMs > nowMs) {
      return projectedMs;
    }
  }

  return nowMs + windowMs;
}

function resolveQuotaState(rateLimits, nowMs) {
  const resets = [];
  const unresolvedExhausted = [];

  for (const window of quotaWindows(rateLimits)) {
    const reset = getExhaustedWindowResetCandidateMs(window.data, nowMs);
    if (isWindowExhausted(window.data)) {
      if (reset !== null) {
        resets.push(reset);
      } else {
        unresolvedExhausted.push(window.label);
      }
    }
  }

  if (resets.length === 0) {
    const reachedType = String(rateLimits && rateLimits.rate_limit_reached_type ? rateLimits.rate_limit_reached_type : "").toLowerCase();
    for (const window of quotaWindows(rateLimits)) {
      if (reachedType.includes(window.type)) {
        const fallbackReset = parseResetMs(window.data && window.data.resets_at);
        if (fallbackReset !== null) {
          resets.push(Math.max(nowMs, fallbackReset));
        }
      }
    }
  }

  if (resets.length === 0) {
    return {
      freeAtMs: nowMs,
      unresolvedExhausted,
    };
  }

  return {
    freeAtMs: Math.max(nowMs, ...resets),
    unresolvedExhausted,
  };
}

function evaluateDeferScheduling(rateLimits, snapshotMs, nowMs) {
  const quotaState = resolveQuotaState(rateLimits, nowMs);
  const freeAtMs = quotaState.freeAtMs;
  const stateText = describeLimitState(rateLimits, freeAtMs, nowMs);

  if (quotaState.unresolvedExhausted.length > 0) {
    return {
      ok: false,
      reason:
        `defer_unresolved_reset:${quotaState.unresolvedExhausted.join("+")}`,
      freeAtMs,
      stateText,
    };
  }

  if (snapshotMs !== null && nowMs - snapshotMs > MAX_RATE_LIMIT_SNAPSHOT_AGE_MS) {
    return {
      ok: false,
      reason: "defer_snapshot_stale",
      freeAtMs,
      stateText,
    };
  }

  if (freeAtMs <= nowMs) {
    if (snapshotMs === null) {
      return {
        ok: false,
        reason: "defer_snapshot_timestamp_missing_for_available_quota",
        freeAtMs,
        stateText,
      };
    }

    if (nowMs - snapshotMs > MAX_AVAILABLE_QUOTA_SNAPSHOT_AGE_MS) {
      return {
        ok: false,
        reason: "defer_available_snapshot_too_old",
        freeAtMs,
        stateText,
      };
    }
  }

  return {
    ok: true,
    reason: "ok",
    freeAtMs,
    stateText,
  };
}

function buildQuotaDebugMessage(snapshot, snapshotRole, nowDate) {
  if (!snapshot || !snapshot.rateLimits) {
    return "/quota: no token_count snapshot found in local sessions.";
  }

  const rateLimits = snapshot.rateLimits;
  const nowMsValue = nowDate.getTime();
  const snapshotMs = parseIsoDateMs(snapshot.timestamp);
  const deferEval = evaluateDeferScheduling(rateLimits, snapshotMs, nowMsValue);
  const freeAtMs = deferEval.freeAtMs;
  const stateText = deferEval.stateText;
  const freeAtText = formatLocalDisplay(new Date(Math.max(nowMsValue, freeAtMs)));
  const freshnessText =
    snapshotMs === null
      ? "snapshot_age_min=unknown, stale_for_defer=unknown. "
      : `snapshot_age_min=${Math.max(0, Math.floor((nowMsValue - snapshotMs) / 60000))}, ` +
        `stale_for_defer=${nowMsValue - snapshotMs > MAX_RATE_LIMIT_SNAPSHOT_AGE_MS}, ` +
        `stale_for_available=${nowMsValue - snapshotMs > MAX_AVAILABLE_QUOTA_SNAPSHOT_AGE_MS}. `;

  return (
    `/quota ${snapshotRole}. ` +
    `snapshot_ts=${formatDebugValue(snapshot.timestamp)}, ` +
    `source=${snapshot.filePath}. ` +
    `${formatWindowQuotaDebug("primary", rateLimits.primary)}. ` +
    `${formatWindowQuotaDebug("secondary", rateLimits.secondary)}. ` +
    `rate_limit_reached_type=${formatDebugValue(rateLimits.rate_limit_reached_type)}. ` +
    freshnessText +
    `decision=${stateText}; free_at=${freeAtText}; defer_ready=${deferEval.ok}; defer_reason=${deferEval.reason}.`
  );
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

function extractLatestTokenCountSnapshotFromJsonl(filePath) {
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
        usable: isUsableRateLimits(record.payload.rate_limits),
      };
    }
  }

  return null;
}

function getMostRecentRateLimitSnapshots(codexHome, sessionId) {
  const sessionRoots = [
    path.join(codexHome, "sessions"),
    path.join(codexHome, "archived_sessions"),
  ];
  const candidates = [];
  const seen = new Set();
  const sessionSuffix = sessionId ? `-${sessionId}.jsonl`.toLowerCase() : null;

  function addCandidate(filePath) {
    if (!filePath || seen.has(filePath)) {
      return;
    }
    seen.add(filePath);
    candidates.push(filePath);
  }

  const sessionFiles = sessionRoots.flatMap((rootDir) => collectJsonlFiles(rootDir));
  for (const filePath of sessionFiles) {
    if (sessionSuffix && path.basename(filePath).toLowerCase().endsWith(sessionSuffix)) {
      addCandidate(filePath);
    }
  }

  const recentSessions = sessionFiles
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
    .slice(0, 50);
  for (const item of recentSessions) {
    addCandidate(item.filePath);
  }

  function getOrderingMs(snapshot, filePath) {
    const timestampMs = parseIsoDateMs(snapshot && snapshot.timestamp);
    if (timestampMs !== null) {
      return timestampMs;
    }

    try {
      return Number(fs.statSync(filePath).mtimeMs || 0);
    } catch (error) {
      return 0;
    }
  }

  let latestSnapshot = null;
  let latestSnapshotMs = -1;
  let latestUsableSnapshot = null;
  let latestUsableSnapshotMs = -1;

  for (const filePath of candidates) {
    const snapshot = extractLatestTokenCountSnapshotFromJsonl(filePath);
    if (!snapshot) {
      continue;
    }

    const orderingMs = getOrderingMs(snapshot, filePath);
    if (!latestSnapshot || orderingMs >= latestSnapshotMs) {
      latestSnapshot = snapshot;
      latestSnapshotMs = orderingMs;
    }

    if (snapshot.usable && (!latestUsableSnapshot || orderingMs >= latestUsableSnapshotMs)) {
      latestUsableSnapshot = snapshot;
      latestUsableSnapshotMs = orderingMs;
    }
  }

  return {
    usableSnapshot: latestUsableSnapshot,
    latestSnapshot,
  };
}

function describeSnapshotSelection(snapshots) {
  if (!snapshots || !snapshots.latestSnapshot) {
    return "no snapshot";
  }

  if (!snapshots.usableSnapshot) {
    return "latest snapshot unusable";
  }

  if (snapshots.usableSnapshot === snapshots.latestSnapshot) {
    return "using latest usable snapshot";
  }

  return "using latest usable snapshot; newest snapshot unusable";
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

function makeAutomationId(scheduledAt) {
  return `at-${toLocalIdStamp(scheduledAt)}-${crypto.randomUUID().slice(0, 8)}`;
}

function writeHeartbeatAutomation(sessionId, scheduledAt, scheduledPrompt) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const automationsRoot = path.join(codexHome, "automations");
  fs.mkdirSync(automationsRoot, { recursive: true });

  const automationId = makeAutomationId(scheduledAt);
  const automationDir = path.join(automationsRoot, automationId);
  fs.mkdirSync(automationDir, { recursive: false });

  const utcStart = toUtcTimestamp(scheduledAt);
  const rruleValue = `DTSTART:${utcStart}\nRRULE:FREQ=MINUTELY;COUNT=1`;
  const timestampMs = Date.now();

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
      if (fs.existsSync(target.automationDir)) {
        fs.rmSync(target.automationDir, { recursive: true, force: true });
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

  if (parsedCommand.kind === "quota") {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    const snapshots = getMostRecentRateLimitSnapshots(codexHome, sessionId);
    const debugSnapshot = snapshots.usableSnapshot || snapshots.latestSnapshot;
    const role = describeSnapshotSelection(snapshots);
    emitBlock(buildQuotaDebugMessage(debugSnapshot, role, now));
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
    const snapshots = getMostRecentRateLimitSnapshots(codexHome, sessionId);
    const snapshot = snapshots.usableSnapshot;
    if (!snapshot || !snapshot.rateLimits) {
      emitBlock(
        "/defer failed: no local quota snapshot found. Run one prompt in a quota-backed Codex chat and retry.",
      );
      return;
    }

    const nowMs = now.getTime();
    const snapshotMs = parseIsoDateMs(snapshot.timestamp);
    const deferEval = evaluateDeferScheduling(snapshot.rateLimits, snapshotMs, nowMs);
    if (!deferEval.ok && deferEval.reason === "defer_snapshot_stale" && snapshotMs !== null) {
      const snapshotAt = new Date(snapshotMs);
      emitBlock(
        `/defer failed: local quota snapshot is stale (${formatLocalDisplay(snapshotAt)}). Run one prompt in a quota-backed Codex chat and retry.`,
      );
      return;
    }

    if (!deferEval.ok && deferEval.reason === "defer_available_snapshot_too_old" && snapshotMs !== null) {
      const snapshotAt = new Date(snapshotMs);
      emitBlock(
        `/defer failed: local quota snapshot is too old to confirm currently available quota (${formatLocalDisplay(snapshotAt)}). Run /quota in a quota-backed Codex chat and retry.`,
      );
      return;
    }

    if (!deferEval.ok && deferEval.reason === "defer_snapshot_timestamp_missing_for_available_quota") {
      emitBlock(
        "/defer failed: local quota snapshot has no usable timestamp while quota appears available. Run /quota in a quota-backed Codex chat and retry.",
      );
      return;
    }

    if (!deferEval.ok && deferEval.reason.startsWith("defer_unresolved_reset:")) {
      emitBlock(
        "/defer failed: exhausted quota window has no usable reset timestamp. Run /quota in a quota-backed Codex chat and retry.",
      );
      return;
    }

    if (!deferEval.ok) {
      emitBlock(
        `/defer failed: quota evaluation returned '${deferEval.reason}'. Run /quota and retry.`,
      );
      return;
    }

    const freeAtMs = deferEval.freeAtMs;
    const scheduledAt = new Date(Math.max(nowMs, freeAtMs) + TWO_MINUTES_MS);
    const automationId = writeHeartbeatAutomation(
      sessionId,
      scheduledAt,
      parsedCommand.scheduledPrompt,
    );

    const stateText = deferEval.stateText;
    const snapshotText = snapshot.timestamp ? ` Snapshot: ${snapshot.timestamp}.` : "";
    emitBlock(
      `/defer scheduled locally for ${formatLocalDisplay(scheduledAt)} as ${automationId}. ${stateText}.${snapshotText} Prompt will run later in this same thread.`,
    );
  }
}

try {
  const input = fs.readFileSync(0, "utf8").trim();
  if (input) {
    processPayload(input);
  }
} catch (error) {
  const message =
    error && typeof error.message === "string" && error.message.trim()
      ? error.message.trim()
      : "unknown error";
  emitBlock(`/at failed: ${message}`);
}
