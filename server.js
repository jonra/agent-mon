const express = require('express');
const path = require('path');
const fs = require('fs');
const { scanProjects, CLAUDE_DIR } = require('./lib/scanner');
const { parseSessionOverview } = require('./lib/parser');
const { detectActiveProcesses, getActiveSessions } = require('./lib/process-detector');
const { buildGraph } = require('./lib/graph-builder');
const { createWatcher } = require('./lib/watcher');

const app = express();
const PORT = process.env.PORT || 3000;

// SSE clients
const sseClients = new Set();

// Cached state
let cachedProjects = [];
let cachedProcesses = [];
let cachedActiveSessionIds = new Set();

function refreshData() {
  cachedProjects = scanProjects();
  cachedProcesses = detectActiveProcesses();
  cachedActiveSessionIds = getActiveSessions(cachedProjects, cachedProcesses);
}

// Initial scan
refreshData();

// Periodic refresh — re-detect processes and re-check active status
setInterval(() => {
  const oldActive = [...cachedActiveSessionIds];
  cachedProcesses = detectActiveProcesses();
  cachedActiveSessionIds = getActiveSessions(cachedProjects, cachedProcesses);
  const newActive = [...cachedActiveSessionIds];

  if (JSON.stringify(oldActive.sort()) !== JSON.stringify(newActive.sort())) {
    // Broadcast full graph update so nodes get re-colored
    const graph = buildGraph(cachedProjects, cachedActiveSessionIds, { maxSessionsPerProject: 15 });
    broadcast('graph-update', graph);
  }
}, 5000);

// Full re-scan every 30s to pick up new sessions
setInterval(() => {
  refreshData();
}, 30000);

// File watcher
createWatcher((event) => {
  // Re-scan on any change
  refreshData();
  const graph = buildGraph(cachedProjects, cachedActiveSessionIds, { maxSessionsPerProject: 15 });
  broadcast('graph-update', graph);
});

function broadcast(eventType, data) {
  const msg = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(msg);
  }
}

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// API: Full graph
app.get('/api/graph', (req, res) => {
  const showTools = req.query.tools !== 'false';
  const maxSessions = parseInt(req.query.maxSessions) || 15;
  const graph = buildGraph(cachedProjects, cachedActiveSessionIds, { showTools, maxSessionsPerProject: maxSessions });
  res.json(graph);
});

// API: Session detail (returns HTML fragment for HTMX)
app.get('/api/session/:id', (req, res) => {
  const sessionId = req.params.id;

  for (const project of cachedProjects) {
    const session = project.sessions.find(s => s.sessionId === sessionId);
    if (session) {
      const parsed = parseSessionOverview(session.jsonlPath);
      const active = cachedActiveSessionIds.has(sessionId);

      const html = `
        <div class="detail-card">
          <div class="detail-status ${active ? 'status-active' : 'status-inactive'}">
            ${active ? '● Active' : '○ Inactive'}
          </div>
          <h3>${escapeHtml(parsed.slug || sessionId.substring(0, 8))}</h3>
          <div class="detail-field">
            <span class="field-label">Project</span>
            <span class="field-value">${escapeHtml(project.projectPath)}</span>
          </div>
          <div class="detail-field">
            <span class="field-label">Session ID</span>
            <span class="field-value mono">${escapeHtml(sessionId)}</span>
          </div>
          ${parsed.model ? `<div class="detail-field">
            <span class="field-label">Model</span>
            <span class="field-value">${escapeHtml(parsed.model)}</span>
          </div>` : ''}
          ${parsed.gitBranch ? `<div class="detail-field">
            <span class="field-label">Branch</span>
            <span class="field-value mono">${escapeHtml(parsed.gitBranch)}</span>
          </div>` : ''}
          ${parsed.cwd ? `<div class="detail-field">
            <span class="field-label">CWD</span>
            <span class="field-value mono">${escapeHtml(parsed.cwd)}</span>
          </div>` : ''}
          ${parsed.permissionMode ? `<div class="detail-field">
            <span class="field-label">Permission</span>
            <span class="field-value">${escapeHtml(parsed.permissionMode)}</span>
          </div>` : ''}
          <div class="detail-field">
            <span class="field-label">Messages</span>
            <span class="field-value">${parsed.userMessageCount} user / ${parsed.assistantMessageCount} assistant</span>
          </div>
          <div class="detail-field">
            <span class="field-label">Tool Calls</span>
            <span class="field-value">${parsed.toolCallCount}</span>
          </div>
          ${parsed.totalInputTokens ? `
          <div class="detail-section">
            <h4>Token Usage</h4>
            <div class="detail-field">
              <span class="field-label">Input</span>
              <span class="field-value">${formatTokens(parsed.totalInputTokens)}</span>
            </div>
            <div class="detail-field">
              <span class="field-label">Output</span>
              <span class="field-value">${formatTokens(parsed.totalOutputTokens)}</span>
            </div>
            <div class="detail-field">
              <span class="field-label">Cache Write</span>
              <span class="field-value">${formatTokens(parsed.cacheCreationTokens)}</span>
            </div>
            <div class="detail-field">
              <span class="field-label">Cache Read</span>
              <span class="field-value">${formatTokens(parsed.cacheReadTokens)}</span>
            </div>
            <div class="detail-field">
              <span class="field-label">Cache Hit Rate</span>
              <span class="field-value">${(parsed.cacheHitRate * 100).toFixed(1)}%</span>
            </div>
          </div>` : ''}
          ${parsed.durationMs ? `<div class="detail-field">
            <span class="field-label">Duration</span>
            <span class="field-value">${formatDuration(parsed.durationMs)}</span>
          </div>` : ''}
          ${parsed.avgTurnLatencyMs ? `<div class="detail-field">
            <span class="field-label">Avg Turn Time</span>
            <span class="field-value">${formatDuration(parsed.avgTurnLatencyMs)}</span>
          </div>` : ''}
          ${parsed.firstTimestamp ? `<div class="detail-field">
            <span class="field-label">Started</span>
            <span class="field-value">${new Date(parsed.firstTimestamp).toLocaleString()}</span>
          </div>` : ''}
          ${parsed.lastTimestamp ? `<div class="detail-field">
            <span class="field-label">Last Activity</span>
            <span class="field-value">${new Date(parsed.lastTimestamp).toLocaleString()}</span>
          </div>` : ''}
          ${parsed.version ? `<div class="detail-field">
            <span class="field-label">CLI Version</span>
            <span class="field-value">${escapeHtml(parsed.version)}</span>
          </div>` : ''}
          ${Object.keys(parsed.stopReasons).length ? `
          <div class="detail-section">
            <h4>Stop Reasons</h4>
            <div class="tag-list">
              ${Object.entries(parsed.stopReasons).map(([reason, count]) =>
                `<span class="tag tag-stop-${reason}">${escapeHtml(reason)} (${count})</span>`
              ).join('')}
            </div>
          </div>` : ''}
          ${Object.keys(parsed.toolResults).length ? `
          <div class="detail-section">
            <h4>Tool Success Rates</h4>
            ${Object.entries(parsed.toolResults)
              .sort((a, b) => (b[1].success + b[1].failure) - (a[1].success + a[1].failure))
              .map(([tool, c]) => {
                const total = c.success + c.failure;
                const rate = total > 0 ? ((c.success / total) * 100).toFixed(0) : '100';
                return `<div class="detail-field">
                  <span class="field-label">${escapeHtml(tool)}</span>
                  <span class="field-value ${c.failure > 0 ? 'has-failures' : ''}">${rate}% (${c.success}/${total})</span>
                </div>`;
              }).join('')}
          </div>` : ''}
          ${parsed.filesModified.length ? `
          <div class="detail-section">
            <h4>Files Modified (${parsed.filesModified.length})</h4>
            <div class="file-list">
              ${parsed.filesModified.slice(0, 10).map(f =>
                `<div class="file-item">${escapeHtml(f.split('/').slice(-2).join('/'))}</div>`
              ).join('')}
              ${parsed.filesModified.length > 10 ? `<div class="muted">+${parsed.filesModified.length - 10} more</div>` : ''}
            </div>
          </div>` : ''}
          ${parsed.toolsUsed.length ? `
          <div class="detail-section">
            <h4>Tools Used</h4>
            <div class="tag-list">
              ${parsed.toolsUsed.map(t => `<span class="tag tag-tool">${escapeHtml(t)}</span>`).join('')}
            </div>
          </div>` : ''}
          ${parsed.skillsUsed.length ? `
          <div class="detail-section">
            <h4>Skills / Agent Types</h4>
            <div class="tag-list">
              ${parsed.skillsUsed.map(s => `<span class="tag tag-skill">${escapeHtml(s)}</span>`).join('')}
            </div>
          </div>` : ''}
          <div class="detail-section">
            <h4>Subagents (${session.subagents.length})</h4>
            ${session.subagents.length ? `<div class="tag-list">
              ${session.subagents.map(a => `<span class="tag tag-agent">${escapeHtml(a.agentType)}</span>`).join('')}
            </div>` : '<p class="muted">None</p>'}
          </div>
          ${session.summary ? `
          <div class="detail-section">
            <h4>Summary</h4>
            <p class="summary-text">${escapeHtml(session.summary)}</p>
          </div>` : ''}
        </div>
      `;

      res.send(html);
      return;
    }
  }

  res.status(404).send('<div class="detail-card"><p>Session not found</p></div>');
});

// API: Aggregate metrics across all sessions
app.get('/api/metrics', (req, res) => {
  const metrics = {
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      toolCalls: 0,
      messages: 0,
      sessions: 0,
    },
    cacheHitRate: 0,
    toolBreakdown: {},       // { toolName: count }
    toolSuccessRates: {},    // { toolName: { success, failure, rate } }
    stopReasons: {},
    modelUsage: {},          // { model: sessionCount }
    topFiles: [],            // [{ path, accessCount }]
    topModifiedFiles: [],
    tokensByProject: [],     // [{ project, tokens }]
    sessions: [],            // per-session metrics for charts
  };

  const fileAccessCounts = {};
  const fileModifyCounts = {};

  for (const project of cachedProjects) {
    let projectTokens = 0;
    const sessionsToScan = project.sessions.slice(0, 20); // cap for perf

    for (const session of sessionsToScan) {
      let parsed;
      try {
        parsed = parseSessionOverview(session.jsonlPath);
      } catch { continue; }

      metrics.totals.inputTokens += parsed.totalInputTokens;
      metrics.totals.outputTokens += parsed.totalOutputTokens;
      metrics.totals.cacheCreationTokens += parsed.cacheCreationTokens;
      metrics.totals.cacheReadTokens += parsed.cacheReadTokens;
      metrics.totals.toolCalls += parsed.toolCallCount;
      metrics.totals.messages += parsed.messageCount;
      metrics.totals.sessions++;

      projectTokens += parsed.totalInputTokens + parsed.totalOutputTokens;

      // Tool breakdown
      for (const tool of parsed.toolsUsed) {
        metrics.toolBreakdown[tool] = (metrics.toolBreakdown[tool] || 0) + 1;
      }

      // Tool success rates
      for (const [tool, counts] of Object.entries(parsed.toolResults)) {
        if (!metrics.toolSuccessRates[tool]) {
          metrics.toolSuccessRates[tool] = { success: 0, failure: 0 };
        }
        metrics.toolSuccessRates[tool].success += counts.success;
        metrics.toolSuccessRates[tool].failure += counts.failure;
      }

      // Stop reasons
      for (const [reason, count] of Object.entries(parsed.stopReasons)) {
        metrics.stopReasons[reason] = (metrics.stopReasons[reason] || 0) + count;
      }

      // Model usage
      if (parsed.model) {
        metrics.modelUsage[parsed.model] = (metrics.modelUsage[parsed.model] || 0) + 1;
      }

      // File access
      for (const f of parsed.filesAccessed) {
        fileAccessCounts[f] = (fileAccessCounts[f] || 0) + 1;
      }
      for (const f of parsed.filesModified) {
        fileModifyCounts[f] = (fileModifyCounts[f] || 0) + 1;
      }

      // Per-session summary
      metrics.sessions.push({
        sessionId: session.sessionId,
        slug: parsed.slug,
        model: parsed.model,
        inputTokens: parsed.totalInputTokens,
        outputTokens: parsed.totalOutputTokens,
        totalTokens: parsed.totalInputTokens + parsed.totalOutputTokens,
        cacheCreationTokens: parsed.cacheCreationTokens,
        cacheReadTokens: parsed.cacheReadTokens,
        toolCalls: parsed.toolCallCount,
        messages: parsed.messageCount,
        userMessages: parsed.userMessageCount,
        durationMs: parsed.durationMs,
        cacheHitRate: parsed.cacheHitRate,
        avgTurnLatencyMs: parsed.avgTurnLatencyMs,
        created: session.created || parsed.firstTimestamp,
        active: cachedActiveSessionIds.has(session.sessionId),
      });
    }

    if (projectTokens > 0) {
      const projectLabel = project.projectPath.split('/').filter(Boolean).slice(-2).join('/');
      metrics.tokensByProject.push({ project: projectLabel, tokens: projectTokens });
    }
  }

  // Cache hit rate
  const totalCache = metrics.totals.cacheCreationTokens + metrics.totals.cacheReadTokens;
  metrics.cacheHitRate = totalCache > 0 ? metrics.totals.cacheReadTokens / totalCache : 0;

  // Compute success rates
  for (const [tool, counts] of Object.entries(metrics.toolSuccessRates)) {
    const total = counts.success + counts.failure;
    counts.rate = total > 0 ? counts.success / total : 1;
  }

  // Top files
  metrics.topFiles = Object.entries(fileAccessCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([path, count]) => ({ path, count }));

  metrics.topModifiedFiles = Object.entries(fileModifyCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([path, count]) => ({ path, count }));

  // Sort
  metrics.tokensByProject.sort((a, b) => b.tokens - a.tokens);
  metrics.sessions.sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0));

  res.json(metrics);
});

// API: Stats
app.get('/api/stats', (req, res) => {
  const statsPath = path.join(CLAUDE_DIR, 'stats-cache.json');
  try {
    const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    res.json(stats);
  } catch {
    res.json({});
  }
});

// API: Summary counts
app.get('/api/summary', (req, res) => {
  res.json({
    totalProjects: cachedProjects.length,
    totalSessions: cachedProjects.reduce((sum, p) => sum + p.sessions.length, 0),
    activeSessions: cachedActiveSessionIds.size,
    activeProcesses: cachedProcesses.length,
  });
});

// Debug endpoint - live detection
app.get('/api/debug', (req, res) => {
  const procs = detectActiveProcesses();
  const active = getActiveSessions(cachedProjects, procs);
  const now = Date.now();

  const agentMon = cachedProjects.find(p => p.dirName === '-Users-jon-repo-agent-mon');
  const sessionMtimes = agentMon?.sessions.map(s => ({
    id: s.sessionId.substring(0, 8),
    ageSeconds: Math.round((now - s.mtime) / 1000),
  }));

  res.json({
    processes: procs.map(p => ({ pid: p.pid, cwd: p.cwd })),
    activeSessionIds: [...active],
    cachedActiveSessionIds: [...cachedActiveSessionIds],
    agentMonSessionMtimes: sessionMtimes,
  });
});

// SSE endpoint
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  res.write('event: connected\ndata: {}\n\n');
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function formatDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const remainS = s % 60;
  if (m < 60) return `${m}m ${remainS}s`;
  const h = Math.floor(m / 60);
  const remainM = m % 60;
  return `${h}h ${remainM}m`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

app.listen(PORT, () => {
  console.log(`Agent-Mon running at http://localhost:${PORT}`);
  console.log(`Monitoring ${cachedProjects.length} projects, ${cachedProjects.reduce((s, p) => s + p.sessions.length, 0)} sessions`);
  console.log(`Active sessions: ${cachedActiveSessionIds.size}`);
});
