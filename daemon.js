#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.env.AG_PANEL_PORT || '4747', 10);
const HOME = os.homedir();
const BRAIN_DIR = path.join(HOME, '.gemini', 'antigravity', 'brain');

function resolveDevToolsPortFiles() {
  const candidates = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    candidates.push(path.join(appData, 'Antigravity', 'DevToolsActivePort'));
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(HOME, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'));
  } else {
    const cfg = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
    candidates.push(path.join(cfg, 'Antigravity', 'DevToolsActivePort'));
  }
  return candidates;
}

const PORT_FILES = resolveDevToolsPortFiles();
const WINDOW_LIMIT = 1_000_000;
const IDLE_AUTO_HIDE_MS = 20 * 60 * 1000;
const WEEK_MS = 7 * 24 * 3600 * 1000;
// Weekly reference budget in USD (configurable via AG_WEEKLY_BUDGET_USD, default $150/week pro tier equivalent)
const WEEKLY_BUDGET_USD = parseFloat(process.env.AG_WEEKLY_BUDGET_USD || '150');

const PRICES = [
  [/argon|pro|opus/i, 2.5, 10.0],
  [/flash-lite|haiku/i, 0.25, 1.25],
  [/flash|sonnet/i, 0.5, 2.5],
];

const ROLE_COLORS = {
  architect: { fg: '#A78BFA', bg: 'rgba(167,139,250,0.14)' },
  developer: { fg: '#4A9FD9', bg: 'rgba(74,159,217,0.14)' },
  reviewer:  { fg: '#D99A3B', bg: 'rgba(217,154,59,0.14)' },
  shipper:   { fg: '#3BB873', bg: 'rgba(59,184,115,0.14)' },
  scout:     { fg: '#22D3EE', bg: 'rgba(34,211,238,0.14)' },
  explore:   { fg: '#38BDF8', bg: 'rgba(56,189,248,0.14)' },
};

function getPrice(model, inputTokens, outputTokens, cacheReadTokens) {
  const entry = PRICES.find(([re]) => re.test(model || '')) || PRICES[0];
  const inRate = entry[1] / 1e6;
  const outRate = entry[2] / 1e6;
  return (
    (inputTokens || 0) * inRate +
    (cacheReadTokens || 0) * inRate * 0.1 +
    (outputTokens || 0) * outRate
  );
}

function parseModelAndEffort(rawModelStr) {
  if (!rawModelStr) return { model: 'Gemini 4 Argon', effort: 'medium', effortColor: '#4A9FD9', effortBg: 'rgba(74,159,217,0.15)' };
  let effort = 'medium';
  let effortColor = '#4A9FD9';
  let effortBg = 'rgba(74,159,217,0.15)';

  const m = rawModelStr.match(/\b(Low|Medium|High|Max|Heavy|Light|Careful)\b/i);
  if (m) {
    const e = m[1].toLowerCase();
    if (e === 'high' || e === 'careful') {
      effort = 'careful';
      effortColor = '#D99A3B';
      effortBg = 'rgba(217,154,59,0.16)';
    } else if (e === 'max' || e === 'heavy') {
      effort = 'heavy';
      effortColor = '#D9553B';
      effortBg = 'rgba(217,85,59,0.16)';
    } else if (e === 'low' || e === 'light') {
      effort = 'light';
      effortColor = '#3BB8A0';
      effortBg = 'rgba(59,184,160,0.16)';
    } else {
      effort = 'medium';
      effortColor = '#4A9FD9';
      effortBg = 'rgba(74,159,217,0.15)';
    }
  }
  const cleanModel = rawModelStr
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\b(Low|Medium|High|Max|Heavy|Light|Careful)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { model: cleanModel || 'Gemini 4 Argon', effort, effortColor, effortBg };
}

function resolveSubagentModelName(rawSubModel, parentModel) {
  if (!rawSubModel || rawSubModel === 'inherit') return parentModel;
  const s = String(rawSubModel).toLowerCase().trim();
  if (s === 'flash') return 'Gemini 3.8 Flash';
  if (s === 'flash_lite' || s === 'flash-lite') return 'Gemini 3.8 Flash-Lite';
  if (s === 'pro') return 'Gemini 4 Argon Pro';
  return parseModelAndEffort(rawSubModel).model;
}

function roleOf(type, description) {
  const s = `${type || ''} ${description || ''}`.toLowerCase();
  if (/architect|plan|structure/.test(s)) return 'architect';
  if (/develop|build|code|edit|project/.test(s)) return 'developer';
  if (/review|verify|critic|check|audit|principle|identity/.test(s)) return 'reviewer';
  if (/ship|deploy|career|vault/.test(s)) return 'shipper';
  if (/scout|skill|catalog/.test(s)) return 'scout';
  if (/explore|research|search/.test(s)) return 'explore';
  return 'explore';
}

// ============================================================================
// Weekly Usage Computation (cached every 15 seconds)
// Matches claude-agent-panel: "Usage █░░░░░░░░░ 11% / 15% Week, Under Pace"
// ============================================================================
let cachedWeek = null;
let lastWeekCalcMs = 0;

function getWeeklyUsage() {
  const now = Date.now();
  if (cachedWeek && (now - lastWeekCalcMs) < 15000) {
    return cachedWeek;
  }
  lastWeekCalcMs = now;

  // Calculate current 7-day window (anchored to Monday 00:00 local time)
  const dNow = new Date(now);
  const dayOfWeek = (dNow.getDay() + 6) % 7; // Monday = 0 .. Sunday = 6
  const mondayStart = new Date(dNow.getFullYear(), dNow.getMonth(), dNow.getDate() - dayOfWeek, 0, 0, 0, 0).getTime();
  const elapsedMs = Math.max(1, now - mondayStart);
  const elapsedFraction = Math.min(1, Math.max(0.01, elapsedMs / WEEK_MS));
  const elapsedPct = Math.max(1, Math.min(100, Math.round(elapsedFraction * 100)));

  let weekCostUsd = 0;
  const cutoffMs = now - WEEK_MS;

  if (fs.existsSync(BRAIN_DIR)) {
    try {
      const dirs = fs.readdirSync(BRAIN_DIR, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const tPath = path.join(BRAIN_DIR, d.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (!fs.existsSync(tPath)) continue;
        const st = fs.statSync(tPath);
        if (st.mtimeMs < cutoffMs) continue;
        const lines = fs.readFileSync(tPath, 'utf8').trim().split('\n');
        let curModel = 'Gemini 4 Argon';
        for (const line of lines) {
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'USER_INPUT' && typeof obj.content === 'string') {
              const m = obj.content.match(/Model Selection` from [^\n]+? to ([^\n.]+?)\./);
              if (m && m[1]) curModel = m[1].trim();
            } else if (obj.type === 'PLANNER_RESPONSE') {
              const tMs = obj.created_at ? new Date(obj.created_at).getTime() : st.mtimeMs;
              if (tMs >= mondayStart) {
                weekCostUsd += getPrice(curModel, obj.input_tokens || 0, obj.output_tokens || 0, obj.cache_read_tokens || 0);
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  const usedPct = Math.min(100, Math.max(1, Math.round((weekCostUsd / WEEKLY_BUDGET_USD) * 100)));
  const pace = usedPct / elapsedPct;
  let verdict = 'On Pace';
  let color = '#9AA0A6';
  if (pace > 1.15) {
    verdict = 'Over Pace';
    color = '#C0392B';
  } else if (pace > 1.0) {
    verdict = 'Ahead Of Pace';
    color = '#D99A3B';
  } else if (pace < 0.85) {
    verdict = 'Under Pace';
    color = '#3BA55C';
  }

  cachedWeek = {
    used: usedPct,
    elapsed: elapsedPct,
    verdict,
    color,
    weekCostUsd,
  };
  return cachedWeek;
}

function inspectFirstLine(tPath) {
  try {
    const fd = fs.openSync(tPath, 'r');
    const buf = Buffer.alloc(2048);
    const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
    fs.closeSync(fd);
    const firstLine = buf.toString('utf8', 0, bytesRead).split('\n')[0];
    const d = JSON.parse(firstLine);
    if (d.type === 'SYSTEM_MESSAGE' && typeof d.content === 'string') {
      const m = d.content.match(/sender=([0-9a-f-]{36})/i);
      if (m) return { isSubagent: true, parentId: m[1] };
    }
    return { isSubagent: d.type !== 'USER_INPUT', parentId: null };
  } catch {
    return { isSubagent: false, parentId: null };
  }
}

function findActiveParentConversation(forcedId) {
  if (!fs.existsSync(BRAIN_DIR)) return null;

  if (forcedId) {
    const tPath = path.join(BRAIN_DIR, forcedId, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(tPath)) {
      const st = fs.statSync(tPath);
      return { conversationId: forcedId, transcriptPath: tPath, mtimeMs: st.mtimeMs };
    }
    return null;
  }

  let newestAny = null;
  const parentMap = new Map();

  try {
    const dirs = fs.readdirSync(BRAIN_DIR, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const tPath = path.join(BRAIN_DIR, d.name, '.system_generated', 'logs', 'transcript.jsonl');
      if (!fs.existsSync(tPath)) continue;
      const st = fs.statSync(tPath);
      const info = inspectFirstLine(tPath);
      const entry = {
        conversationId: d.name,
        transcriptPath: tPath,
        mtimeMs: st.mtimeMs,
        isSubagent: info.isSubagent,
        parentId: info.parentId,
      };
      if (!newestAny || st.mtimeMs > newestAny.mtimeMs) newestAny = entry;
      if (!info.isSubagent) parentMap.set(d.name, entry);
    }
  } catch {}

  if (!newestAny) return null;
  if (newestAny.isSubagent && newestAny.parentId && parentMap.has(newestAny.parentId)) {
    const p = parentMap.get(newestAny.parentId);
    return { ...p, mtimeMs: Math.max(p.mtimeMs, newestAny.mtimeMs) };
  }
  return newestAny;
}

function parseSubagentTranscript(subId, modelName) {
  const tPath = path.join(BRAIN_DIR, subId, '.system_generated', 'logs', 'transcript.jsonl');
  if (!fs.existsSync(tPath)) return null;
  try {
    const st = fs.statSync(tPath);
    const lines = fs.readFileSync(tPath, 'utf8').trim().split('\n').filter(Boolean);
    let tokens = 0;
    let ctx = 0;
    let cost = 0;
    let lastTool = 'Thinking...';
    let sentReplyToParent = false;
    let lastStep = null;
    let prevStepMs = null;
    let activeSec = 0;
    let lastStepMs = st.mtimeMs;

    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        lastStep = d;
        const tMs = d.created_at ? new Date(d.created_at).getTime() : null;
        if (tMs) {
          if (prevStepMs) {
            const deltaSec = (tMs - prevStepMs) / 1000;
            if (deltaSec > 0 && deltaSec <= 120) activeSec += deltaSec;
          }
          prevStepMs = tMs;
          lastStepMs = tMs;
        }
        if (d.type === 'PLANNER_RESPONSE') {
          const inp = d.input_tokens || 0;
          const out = d.output_tokens || 0;
          const cache = d.cache_read_tokens || 0;
          ctx = inp + cache + out;
          tokens += ctx;
          cost += getPrice(modelName, inp, out, cache);
          if (Array.isArray(d.tool_calls) && d.tool_calls.length > 0) {
            const names = d.tool_calls.map(t => t.name);
            lastTool = names.join(', ');
            if (names.includes('send_message')) {
              sentReplyToParent = true;
            }
          }
        }
      } catch {}
    }

    const ageMs = Date.now() - st.mtimeMs;
    const endedWithoutTools =
      lastStep &&
      lastStep.type === 'PLANNER_RESPONSE' &&
      (!Array.isArray(lastStep.tool_calls) || lastStep.tool_calls.length === 0);
    const isFinished = sentReplyToParent || endedWithoutTools || ageMs > 90000;
    const isRunning = !isFinished;
    if (isRunning && lastStepMs) {
      const liveDelta = Math.max(0, (Date.now() - lastStepMs) / 1000);
      if (liveDelta <= 90) activeSec += liveDelta;
    }
    const elapsedSec = Math.max(1, Math.round(activeSec));

    return {
      status: isRunning ? 'running' : 'done',
      tokens,
      ctx,
      cost,
      activeTool: isRunning ? lastTool : 'done',
      elapsedSec,
      mtimeMs: st.mtimeMs,
    };
  } catch {
    return null;
  }
}

function analyzeConversation(forcedId, uiModelLabel) {
  const target = findActiveParentConversation(forcedId);
  if (!target) return null;

  let content = '';
  try {
    content = fs.readFileSync(target.transcriptPath, 'utf8');
  } catch {
    return null;
  }

  const lines = content.trim().split('\n').filter(Boolean);
  let rawModel = uiModelLabel || 'Gemini 4 Argon (Medium)';
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCost = 0;
  let latestCtx = 0;
  let stepsCount = 0;
  let lastStep = null;
  let prevStepMs = null;
  let lastStepMs = null;
  let activeElapsedSec = 0;
  const subagentsList = [];
  let pendingSubagentIdx = 0;

  // Also track completed task turns so even if no subagent was spawned in a chat,
  // the user can click "Show" on "N done · ≈$X.XX [Show]" to inspect each task run!
  const turnRuns = [];
  let currentTurn = null;

  for (let i = 0; i < lines.length; i++) {
    let d;
    try {
      d = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    lastStep = d;
    const stepTime = d.created_at ? new Date(d.created_at).getTime() : null;
    if (stepTime) {
      if (prevStepMs) {
        const deltaSec = (stepTime - prevStepMs) / 1000;
        if (deltaSec > 0 && deltaSec <= 120) {
          activeElapsedSec += deltaSec;
          if (currentTurn) currentTurn.elapsedSec += deltaSec;
        }
      }
      prevStepMs = stepTime;
      lastStepMs = stepTime;
    }

    if (d.type === 'USER_INPUT' && typeof d.content === 'string') {
      if (!uiModelLabel) {
        const mMatch = d.content.match(/Model Selection` from [^\n]+? to ([^\n.]+?)\./);
        if (mMatch && mMatch[1]) {
          rawModel = mMatch[1].trim();
        }
      }
      // Extract clean prompt title for turn summary
      const reqMatch = d.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
      const rawPrompt = (reqMatch ? reqMatch[1] : d.content).replace(/\s+/g, ' ').trim();
      const shortPrompt = rawPrompt.slice(0, 42) + (rawPrompt.length > 42 ? '…' : '');
      if (currentTurn && currentTurn.steps > 0) {
        currentTurn.status = 'done';
        turnRuns.push(currentTurn);
      }
      const pm = parseModelAndEffort(rawModel);
      currentTurn = {
        key: `turn-${turnRuns.length + 1}`,
        index: turnRuns.length + 1,
        description: shortPrompt || `Task #${turnRuns.length + 1}`,
        role: 'developer',
        effort: pm.effort,
        effortColor: pm.effortColor,
        model: pm.model,
        status: 'running',
        tokens: 0,
        ctx: 0,
        cost: 0,
        elapsedSec: 1,
        steps: 0,
      };
    }

    if (d.type === 'PLANNER_RESPONSE') {
      stepsCount++;
      const inp = d.input_tokens || 0;
      const out = d.output_tokens || 0;
      const cache = d.cache_read_tokens || 0;
      totalInput += inp;
      totalOutput += out;
      totalCacheRead += cache;
      latestCtx = inp + cache + out;
      const stepCost = getPrice(rawModel, inp, out, cache);
      totalCost += stepCost;

      if (currentTurn) {
        currentTurn.steps++;
        currentTurn.tokens += latestCtx;
        currentTurn.ctx = latestCtx;
        currentTurn.cost += stepCost;
        const pm = parseModelAndEffort(rawModel);
        currentTurn.model = pm.model;
        currentTurn.effort = pm.effort;
        currentTurn.effortColor = pm.effortColor;
      }

      const tools = Array.isArray(d.tool_calls) ? d.tool_calls : [];
      for (const tc of tools) {
        if (tc.name === 'invoke_subagent' && tc.args) {
          const roleTitle = tc.args.Role || tc.args.TypeName || `Subagent ${subagentsList.length + 1}`;
          const role = roleOf(tc.args.TypeName, roleTitle);
          const parentParsed = parseModelAndEffort(rawModel);
          const resolvedModel = resolveSubagentModelName(tc.args.Model, parentParsed.model);
          const subEffort = /flash/i.test(resolvedModel) ? 'light' : parentParsed.effort;
          const subEffortColor = /flash/i.test(resolvedModel) ? '#3BB8A0' : parentParsed.effortColor;
          const invokedAtMs = stepTime || Date.now();
          subagentsList.push({
            key: `sub-${d.step_index}-${subagentsList.length}`,
            index: subagentsList.length + 1,
            subId: null,
            description: roleTitle,
            role,
            effort: subEffort,
            effortColor: subEffortColor,
            roleColor: ROLE_COLORS[role] || ROLE_COLORS.explore,
            model: resolvedModel,
            status: 'running',
            tokens: 0,
            ctx: 0,
            cost: 0,
            elapsedSec: 1,
            activeTool: 'Starting...',
            invokedAtMs,
          });
        }
      }
    }

    if (d.type === 'GENERIC' && typeof d.content === 'string' && d.content.includes('Created the following subagent:')) {
      const idMatch = d.content.match(/"conversationId":\s*"([0-9a-f-]{36})"/i);
      if (idMatch && idMatch[1] && pendingSubagentIdx < subagentsList.length) {
        subagentsList[pendingSubagentIdx].subId = idMatch[1];
        pendingSubagentIdx++;
      }
    }
  }

  let subTokensTotal = 0;
  let subCostTotal = 0;
  let anySubRunning = false;
  let latestActivityMs = target.mtimeMs;

  for (const sa of subagentsList) {
    if (sa.subId) {
      const subStats = parseSubagentTranscript(sa.subId, sa.model);
      if (subStats) {
        sa.status = subStats.status;
        sa.tokens = subStats.tokens;
        sa.ctx = subStats.ctx;
        sa.cost = subStats.cost;
        sa.elapsedSec = subStats.elapsedSec;
        sa.activeTool = subStats.activeTool;
        subTokensTotal += subStats.tokens;
        subCostTotal += subStats.cost;
        if (subStats.mtimeMs > latestActivityMs) latestActivityMs = subStats.mtimeMs;
        if (subStats.status === 'running') anySubRunning = true;
      } else {
        const ageSinceInvoke = Date.now() - (sa.invokedAtMs || 0);
        sa.status = ageSinceInvoke < 30000 ? 'running' : 'done';
        if (sa.status === 'running') anySubRunning = true;
      }
    } else {
      const ageSinceInvoke = Date.now() - (sa.invokedAtMs || 0);
      sa.status = ageSinceInvoke < 15000 ? 'running' : 'done';
      if (sa.status === 'running') anySubRunning = true;
    }
  }

  const now = Date.now();
  const fileAgeMs = now - latestActivityMs;
  let isRunning = anySubRunning;
  let activeTool = 'Idle';

  if (lastStep) {
    if (lastStep.type === 'USER_INPUT' && fileAgeMs < 90000) {
      isRunning = true;
      activeTool = 'Thinking...';
    } else if (lastStep.type === 'PLANNER_RESPONSE') {
      const hasTools = Array.isArray(lastStep.tool_calls) && lastStep.tool_calls.length > 0;
      if (hasTools && fileAgeMs < 90000) {
        isRunning = true;
        activeTool = lastStep.tool_calls.map(t => t.name).join(', ');
      } else if (!anySubRunning) {
        isRunning = false;
        activeTool = 'Idle';
      }
    } else if (lastStep.type === 'GENERIC' && fileAgeMs < 45000) {
      isRunning = true;
      activeTool = 'Analyzing...';
    } else if (lastStep.type === 'SYSTEM_MESSAGE' && fileAgeMs < 45000) {
      isRunning = true;
      activeTool = 'Receiving subagent output...';
    }
  }

  if (currentTurn && currentTurn.steps > 0 && !isRunning) {
    currentTurn.status = 'done';
    turnRuns.push(currentTurn);
  }

  if (isRunning && lastStepMs) {
    const liveDelta = Math.max(0, (now - lastStepMs) / 1000);
    if (liveDelta <= 90) activeElapsedSec += liveDelta;
  }

  const runningSubagents = subagentsList.filter(sa => sa.status === 'running');
  // Completed subagents (or completed task turns if no subagents were invoked in this chat)
  const finishedSubagents = subagentsList.length > 0
    ? subagentsList.filter(sa => sa.status !== 'running').reverse()
    : turnRuns.map(t => ({ ...t, elapsedSec: Math.max(1, Math.round(t.elapsedSec)) })).reverse();

  const doneCost = finishedSubagents.reduce((sum, item) => sum + (item.cost || 0), 0);

  const parsedModel = parseModelAndEffort(rawModel);
  const ctxPct = Math.min(100, Math.round((latestCtx / WINDOW_LIMIT) * 100));
  const elapsedSec = Math.max(1, Math.round(activeElapsedSec));
  const week = getWeeklyUsage();

  return {
    conversationId: target.conversationId,
    hasActivity: lines.length > 0,
    idleMs: fileAgeMs,
    shouldAutoHide: !isRunning && fileAgeMs > IDLE_AUTO_HIDE_MS,
    status: isRunning ? 'running' : 'done',
    model: parsedModel.model,
    effort: parsedModel.effort,
    effortColor: parsedModel.effortColor,
    effortBg: parsedModel.effortBg,
    activeTool,
    ctxTokens: latestCtx,
    ctxPct,
    windowLimit: WINDOW_LIMIT,
    mainTokens: totalInput + totalOutput + totalCacheRead,
    totalTokens: totalInput + totalOutput + totalCacheRead + subTokensTotal,
    mainCost: totalCost,
    cost: totalCost + subCostTotal,
    elapsedSec,
    stepsCount,
    subagents: runningSubagents,
    finishedSubagents,
    doneCount: finishedSubagents.length,
    doneCost,
    week,
    updatedAt: now,
  };
}

// ============================================================================
// Native DOM Injection Script (Exact claude-agent-panel layout + Antigravity branding)
// ============================================================================
function buildInjectorScript() {
  return `(() => {
    const oldStyle = document.getElementById('ag-native-panel-style');
    if (oldStyle) oldStyle.remove();

    const styleEl = document.createElement('style');
    styleEl.id = 'ag-native-panel-style';
    styleEl.textContent = \`
      #ag-native-agent-panel {
        width: 100%;
        box-sizing: border-box;
        margin-bottom: 6px;
        border-radius: 12px;
        background: #171717;
        border: 1px solid #282828;
        color: #E5E5E5;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12.5px;
        line-height: 1.35;
        user-select: none;
        position: relative;
        z-index: 1;
        overflow: hidden;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.28);
        padding: 8px 12px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      #ag-native-agent-panel.ag-hidden {
        display: none !important;
      }
      #ag-native-agent-panel.ag-menu-open {
        pointer-events: none;
      }
      .ag-ap-header {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        min-width: 0;
      }
      #ag-native-agent-panel.ag-collapsed .ag-ap-body {
        display: none !important;
      }
      .ag-ap-title {
        font-weight: 700;
        font-size: 12.5px;
        color: #F3F4F6;
        white-space: nowrap;
      }
      .ag-ap-summary {
        font-size: 12px;
        color: #8E8E93;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .ag-ap-spacer {
        flex: 1 1 auto;
        min-width: 8px;
      }
      .ag-ap-week-wrap {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: #8E8E93;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .ag-ap-week-bar {
        font-family: "Consolas", "SF Mono", "Courier New", monospace;
        font-size: 12px;
        letter-spacing: 0.5px;
        line-height: 1;
        display: inline-flex;
        align-items: center;
      }
      .ag-ap-week-empty {
        color: #6E6E73;
      }
      .ag-ap-pill-btn {
        background: #2C2C30;
        border: 1px solid #3A3A3E;
        color: #E5E5E5;
        font-size: 11.5px;
        font-weight: 500;
        cursor: pointer;
        padding: 2px 9px;
        border-radius: 5px;
        line-height: 1.3;
        transition: background 0.12s ease, border-color 0.12s ease;
        flex-shrink: 0;
      }
      .ag-ap-pill-btn:hover {
        background: #38383D;
        border-color: #4A4A50;
      }
      .ag-ap-body {
        display: flex;
        flex-direction: column;
        gap: 5px;
      }
      .ag-ap-row {
        display: flex;
        align-items: center;
        gap: 7px;
        min-height: 24px;
        width: 100%;
      }
      .ag-ap-icon-wrap {
        width: 22px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .ag-ap-brand-svg {
        width: 19px;
        height: 19px;
        display: block;
      }
      .ag-ap-mark {
        font-size: 12px;
        font-weight: 700;
        line-height: 1;
        flex-shrink: 0;
      }
      .ag-ap-agent-name {
        font-weight: 700;
        font-size: 12.5px;
        color: #F0F0F0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 240px;
      }
      .ag-ap-effort {
        font-size: 12px;
        font-weight: 500;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .ag-ap-model {
        font-size: 12px;
        color: #8E8E93;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ag-ap-line-bar {
        font-family: "Consolas", "SF Mono", monospace;
        font-size: 12px;
        letter-spacing: -0.5px;
        display: inline-flex;
        align-items: center;
        flex-shrink: 0;
      }
      .ag-ap-line-dim {
        color: #3E3E42;
      }
      .ag-ap-metric {
        font-size: 12px;
        color: #8E8E93;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .ag-ap-done-bar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding-top: 2px;
      }
      .ag-ap-done-text {
        font-size: 12px;
        color: #8E8E93;
        font-variant-numeric: tabular-nums;
      }
      .ag-ap-done-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding-left: 4px;
        border-left: 2px solid #28282C;
        margin-top: 2px;
      }
      @keyframes agSpin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      .ag-ap-gemini-sub-icon {
        width: 17px;
        height: 17px;
        flex-shrink: 0;
      }
      .ag-ap-gemini-sub-icon.running {
        animation: agSpin 3s linear infinite;
      }
    \`;
    document.head.appendChild(styleEl);

    if (typeof window.__agPanelCollapsed === 'undefined') {
      window.__agPanelCollapsed = false;
    }
    if (typeof window.__agDoneOpen === 'undefined') {
      window.__agDoneOpen = false;
    }
    if (typeof window.__agUserTypedMs === 'undefined') {
      window.__agUserTypedMs = 0;
    }

    function fmtTokens(n) {
      if (!n || n <= 0) return '0';
      if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
      if (n >= 1e3) return Math.round(n / 1e3) + 'k';
      return String(n);
    }

    function fmtTime(sec) {
      const s = Math.max(0, Math.floor(sec || 0));
      const h = Math.floor(s / 3600);
      const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
      const ss = String(s % 60).padStart(2, '0');
      return h ? (h + ':' + mm + ':' + ss) : (mm + ':' + ss);
    }

    function fmtCost(c) {
      const val = Number(c || 0);
      return '≈$' + val.toFixed(2);
    }

    function renderLineBar(pct, color) {
      const w = 6;
      const fill = Math.min(w, Math.max(1, Math.round(((pct || 0) / 100) * w)));
      return \`<span class="ag-ap-line-bar"><span style="color:\${color}">\${'━'.repeat(fill)}</span><span class="ag-ap-line-dim">\${'━'.repeat(w - fill)}</span></span>\`;
    }

    const ANTIGRAVITY_BRAND_SVG = \`
      <svg class="ag-ap-brand-svg" viewBox="0 0 180 180" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="agOfficialBrandGrad" x1="35" y1="28" x2="145" y2="152" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="#F59E0B"/>
            <stop offset="28%" stop-color="#EF4444"/>
            <stop offset="62%" stop-color="#3B82F6"/>
            <stop offset="100%" stop-color="#2563EB"/>
          </linearGradient>
        </defs>
        <path d="M144.248 149.062C151.748 154.688 162.998 150.938 152.685 140.625C121.748 110.625 128.31 28.125 89.8727 28.125C51.4352 28.125 57.9977 110.625 27.0602 140.625C15.8102 151.875 27.9977 154.688 35.4977 149.062C64.5602 129.375 62.6852 94.6875 89.8727 94.6875C117.06 94.6875 115.185 129.375 144.248 149.062Z" fill="url(#agOfficialBrandGrad)"/>
      </svg>
    \`;

    const GEMINI_SUB_SVG = (isRun) => \`
      <svg class="ag-ap-gemini-sub-icon \${isRun ? 'running' : ''}" viewBox="0 0 24 24" fill="none">
        <path d="M12 2C12 7.52 16.48 12 22 12C16.48 12 12 16.48 12 22C12 16.48 7.52 12 2 12C7.52 12 12 7.52 12 2Z" fill="url(#agGemGrad)" />
        <defs>
          <linearGradient id="agGemGrad" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="#4A9FD9" />
            <stop offset="50%" stop-color="#A78BFA" />
            <stop offset="100%" stop-color="#F472B6" />
          </linearGradient>
        </defs>
      </svg>
    \`;

    const WORKING_DOTS_SVG = (color) => \`
      <svg width="18" height="9" viewBox="0 0 16 8" xmlns="http://www.w3.org/2000/svg">
        <circle cx="3" cy="4" r="1.6" fill="\${color}">
          <animate attributeName="opacity" values="1;0.35;1;1" keyTimes="0;0.25;0.5;1" dur="0.8s" begin="0s" repeatCount="indefinite"/>
        </circle>
        <circle cx="8" cy="4" r="1.6" fill="\${color}">
          <animate attributeName="opacity" values="1;0.35;1;1" keyTimes="0;0.25;0.5;1" dur="0.8s" begin="0.13s" repeatCount="indefinite"/>
        </circle>
        <circle cx="13" cy="4" r="1.6" fill="\${color}">
          <animate attributeName="opacity" values="1;0.35;1;1" keyTimes="0;0.25;0.5;1" dur="0.8s" begin="0.26s" repeatCount="indefinite"/>
        </circle>
      </svg>
    \`;

    function ensurePanelElement() {
      const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
      if (!inputBox || !inputBox.parentElement) return null;

      let panel = document.getElementById('ag-native-agent-panel');
      if (panel && !panel.querySelector('#ag-ap-week-wrap')) {
        panel.remove();
        panel = null;
      }
      if (!panel) {
        panel = document.createElement('div');
        panel.id = 'ag-native-agent-panel';
        panel.className = 'ag-hidden';
        panel.innerHTML = \`
          <div class="ag-ap-header">
            <span class="ag-ap-title" id="ag-ap-title">Agents</span>
            <span class="ag-ap-summary" id="ag-ap-header-summary"></span>
            <div class="ag-ap-spacer"></div>
            <div class="ag-ap-week-wrap" id="ag-ap-week-wrap"></div>
            <button type="button" class="ag-ap-pill-btn" id="ag-ap-toggle-btn">Hide</button>
          </div>
          <div class="ag-ap-body" id="ag-ap-body"></div>
        \`;
        inputBox.parentElement.insertBefore(panel, inputBox);

        const toggleBtn = panel.querySelector('#ag-ap-toggle-btn');
        if (toggleBtn) {
          toggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.__agPanelCollapsed = !window.__agPanelCollapsed;
            panel.classList.toggle('ag-collapsed', window.__agPanelCollapsed);
            toggleBtn.textContent = window.__agPanelCollapsed ? 'Show agents' : 'Hide';
          });
        }

        // Delegate click for the bottom "Show" / "Hide" completed subagents button
        panel.addEventListener('click', (e) => {
          const btn = e.target.closest('#ag-ap-done-toggle-btn');
          if (btn) {
            e.preventDefault();
            e.stopPropagation();
            window.__agDoneOpen = !window.__agDoneOpen;
            if (window.__agLastData) renderPanel(window.__agLastData);
          }
        });

        inputBox.addEventListener('keydown', () => {
          window.__agUserTypedMs = Date.now();
          if (window.__agLastData) renderPanel(window.__agLastData);
        }, true);
      } else if (panel.nextElementSibling !== inputBox) {
        inputBox.parentElement.insertBefore(panel, inputBox);
      }

      const anyMenuOpen =
        !!inputBox.querySelector('[aria-expanded="true"], [data-state="open"]') ||
        !!document.querySelector('[data-radix-popper-content-wrapper]');
      panel.classList.toggle('ag-menu-open', anyMenuOpen);

      return panel;
    }

    function renderAgentRow(item, isMain) {
      const isRunning = item.status === 'running';
      const effColor = item.effortColor || '#4A9FD9';
      const pct = Math.min(100, Math.round(((item.ctx || 0) / 1000000) * 100));
      const markHtml = isRunning
        ? WORKING_DOTS_SVG(effColor)
        : isMain
          ? '<span class="ag-ap-mark" style="color:#9AA0A6">◦</span>'
          : '<span class="ag-ap-mark" style="color:#3BA55C">✓</span>';

      return \`
        <div class="ag-ap-row">
          <div class="ag-ap-icon-wrap">\${isMain ? ANTIGRAVITY_BRAND_SVG : GEMINI_SUB_SVG(isRunning)}</div>
          \${markHtml}
          <span class="ag-ap-agent-name">\${item.description || 'Main agent'}</span>
          <span class="ag-ap-effort" style="color:\${effColor}">\${item.effort || 'medium'}</span>
          <span class="ag-ap-model">\${item.model || 'Gemini 4 Argon'}</span>
          <div class="ag-ap-spacer"></div>
          \${renderLineBar(pct, effColor)}
          <span class="ag-ap-metric">\${fmtTokens(item.ctx || item.tokens)}</span>
          <span class="ag-ap-metric">\${fmtTime(item.elapsedSec)}</span>
          <span class="ag-ap-metric">\${fmtCost(item.cost)}</span>
        </div>
      \`;
    }

    function renderPanel(data) {
      window.__agLastData = data;
      const panel = ensurePanelElement();
      if (!panel) return;

      const typedRecently = (Date.now() - (window.__agUserTypedMs || 0)) < 60000;
      if (!data || (!data.hasActivity && !typedRecently) || (data.shouldAutoHide && !typedRecently)) {
        panel.classList.add('ag-hidden');
        return;
      }

      panel.classList.remove('ag-hidden');
      panel.classList.toggle('ag-collapsed', !!window.__agPanelCollapsed);

      const runningSubs = Array.isArray(data.subagents) ? data.subagents : [];
      const finishedSubs = Array.isArray(data.finishedSubagents) ? data.finishedSubagents : [];

      const titleEl = panel.querySelector('#ag-ap-title');
      if (titleEl) {
        titleEl.textContent = (window.__agPanelCollapsed && runningSubs.length > 0)
          ? \`Agents · \${runningSubs.length} running\`
          : 'Agents';
      }

      const summaryEl = panel.querySelector('#ag-ap-header-summary');
      if (summaryEl) {
        summaryEl.textContent = \`\${fmtCost(data.cost)} · \${fmtTokens(data.totalTokens)} · \${fmtTime(data.elapsedSec)}\`;
      }

      // Render Weekly Usage Bar in Header (matches claude-agent-panel: "Usage █░░░░░░░░░ 11% / 15% Week, Under Pace")
      const weekWrap = panel.querySelector('#ag-ap-week-wrap');
      if (weekWrap && data.week) {
        const w = 10;
        const fill = Math.min(w, Math.max(1, Math.round((data.week.used / 100) * w)));
        const barHtml = \`<span class="ag-ap-week-bar"><span style="color:\${data.week.color}">\${'█'.repeat(fill)}</span><span class="ag-ap-week-empty">\${'░'.repeat(w - fill)}</span></span>\`;
        weekWrap.innerHTML = \`
          <span>Usage</span>
          \${barHtml}
          <span>\${data.week.used}% / \${data.week.elapsed}% Week, \${data.week.verdict}</span>
        \`;
      }

      const bodyEl = panel.querySelector('#ag-ap-body');
      if (!bodyEl) return;

      // 1. Main Agent Row
      let html = renderAgentRow({
        description: 'Main agent',
        status: data.status,
        effort: data.effort,
        effortColor: data.effortColor,
        model: data.model,
        ctx: data.ctxTokens,
        tokens: data.mainTokens,
        elapsedSec: data.elapsedSec,
        cost: data.mainCost,
      }, true);

      // 2. Currently Running Subagent Rows
      for (const sa of runningSubs) {
        html += renderAgentRow(sa, false);
      }

      // 3. Bottom Completed Subagents / Runs Row ("8 done · ≈$4.82 [Show]")
      if (finishedSubs.length > 0) {
        const doneOpen = !!window.__agDoneOpen;
        html += \`
          <div class="ag-ap-done-bar">
            <span class="ag-ap-done-text">\${finishedSubs.length} done · \${fmtCost(data.doneCost)}</span>
            <button type="button" class="ag-ap-pill-btn" id="ag-ap-done-toggle-btn">\${doneOpen ? 'Hide' : 'Show'}</button>
          </div>
        \`;
        if (doneOpen) {
          html += '<div class="ag-ap-done-list">';
          for (const doneItem of finishedSubs) {
            html += renderAgentRow(doneItem, false);
          }
          html += '</div>';
        }
      }

      bodyEl.innerHTML = html;
    }

    window.__agPollStateAndUpdate = function(serverPayload) {
      if (serverPayload) {
        renderPanel(serverPayload);
      } else if (window.__agLastData) {
        ensurePanelElement();
      }
      const m = (window.location.pathname || '').match(/\\/c\\/([0-9a-f-]{36})/i);
      const cid = m ? m[1] : '';
      let uiModel = '';
      const box = document.getElementById('antigravity.agentSidePanelInputBox');
      if (box) {
        const modelBtn = box.querySelector('button[aria-label^="Select model"]');
        if (modelBtn) uiModel = (modelBtn.innerText || '').trim();
      }
      return JSON.stringify({ cid, uiModel });
    };

    window.__agNativePanelInstalled = true;
    return 'installed';
  })()`;
}

// ============================================================================
// CDP WebSocket Manager
// ============================================================================
const activeConnections = new Map();
const INJECTOR_CODE = buildInjectorScript();

function findActiveDevToolsPort() {
  for (const pf of PORT_FILES) {
    if (fs.existsSync(pf)) {
      try {
        const raw = fs.readFileSync(pf, 'utf8').trim().split(/\r?\n/)[0];
        const port = parseInt(raw, 10);
        if (port > 0) return port;
      } catch {}
    }
  }
  return 0;
}

function syncCdpTargets() {
  const port = findActiveDevToolsPort();
  if (!port) return;

  const req = http.get(`http://127.0.0.1:${port}/json`, { timeout: 1200 }, res => {
    let body = '';
    res.on('data', chunk => { body += chunk; });
    res.on('end', () => {
      let targets = [];
      try {
        targets = JSON.parse(body);
      } catch {
        return;
      }
      for (const t of targets) {
        if (t.type !== 'page' || !t.webSocketDebuggerUrl) continue;
        if (activeConnections.has(t.id)) continue;
        connectToTarget(t);
      }
    });
  });
  req.on('error', () => {});
}

function connectToTarget(target) {
  let ws;
  try {
    ws = new WebSocket(target.webSocketDebuggerUrl);
  } catch {
    return;
  }

  const conn = {
    id: target.id,
    ws,
    cid: null,
    uiModel: '',
    msgId: 10,
    ready: false,
  };

  const m = (target.url || '').match(/\/c\/([0-9a-f-]{36})/i);
  if (m) conn.cid = m[1];

  activeConnections.set(target.id, conn);

  ws.onopen = () => {
    conn.ready = true;
    ws.send(JSON.stringify({ id: 1, method: 'Page.enable', params: {} }));
    ws.send(JSON.stringify({
      id: 2,
      method: 'Page.addScriptToEvaluateOnNewDocument',
      params: { source: INJECTOR_CODE },
    }));
    ws.send(JSON.stringify({
      id: 3,
      method: 'Runtime.evaluate',
      params: { expression: INJECTOR_CODE, returnByValue: true },
    }));
    pushUpdateToConnection(conn);
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Page.frameNavigated' || msg.method === 'Page.loadEventFired') {
        ws.send(JSON.stringify({
          id: ++conn.msgId,
          method: 'Runtime.evaluate',
          params: { expression: INJECTOR_CODE, returnByValue: true },
        }));
      } else if (msg.result && msg.result.result && typeof msg.result.result.value === 'string') {
        const val = msg.result.result.value;
        if (val.startsWith('{')) {
          const parsed = JSON.parse(val);
          if (parsed.cid !== undefined) conn.cid = parsed.cid || null;
          if (parsed.uiModel !== undefined) conn.uiModel = parsed.uiModel || '';
        }
      }
    } catch {}
  };

  ws.onclose = () => {
    activeConnections.delete(target.id);
  };

  ws.onerror = () => {
    activeConnections.delete(target.id);
  };
}

function pushUpdateToConnection(conn) {
  if (!conn.ready || conn.ws.readyState !== 1) return;
  const stats = conn.cid
    ? analyzeConversation(conn.cid, conn.uiModel)
    : { hasActivity: false, shouldAutoHide: true };

  const payloadJson = JSON.stringify(stats || { hasActivity: false, shouldAutoHide: true });
  const expr = `(typeof window.__agPollStateAndUpdate === 'function' ? window.__agPollStateAndUpdate(${payloadJson}) : (${INJECTOR_CODE}, window.__agPollStateAndUpdate && window.__agPollStateAndUpdate(${payloadJson})))`;

  try {
    conn.ws.send(JSON.stringify({
      id: ++conn.msgId,
      method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true },
    }));
  } catch {}
}

setInterval(() => {
  syncCdpTargets();
  for (const conn of activeConnections.values()) {
    pushUpdateToConnection(conn);
  }
}, 900);

syncCdpTargets();

// ============================================================================
// HTTP Telemetry Server
// ============================================================================
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const urlObj = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (urlObj.pathname === '/api/live') {
    const cid = urlObj.searchParams.get('cid') || null;
    const model = urlObj.searchParams.get('model') || '';
    const stats = analyzeConversation(cid, model);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify(stats || { status: 'empty' }));
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    service: 'antigravity-native-agent-panel',
    status: 'ok',
    connectedPages: activeConnections.size,
  }));
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') process.exit(0);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Antigravity Native DOM Agent Panel daemon listening on http://127.0.0.1:${PORT}`);
});
