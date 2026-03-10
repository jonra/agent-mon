const { execFileSync } = require('child_process');

/**
 * Find running Claude CLI processes and their working directories.
 */
function detectActiveProcesses() {
  const processes = [];

  try {
    const psOutput = execFileSync('ps', ['aux'], { encoding: 'utf8', timeout: 5000 });
    const lines = psOutput.split('\n');

    for (const line of lines) {
      if (!line.includes('claude') || line.includes('Claude.app') || line.includes('grep')) continue;
      if (line.includes('Helper') || line.includes('GPU') || line.includes('Renderer')) continue;

      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;

      const pid = parseInt(parts[1]);
      const cpu = parseFloat(parts[2]);
      const mem = parseFloat(parts[3]);
      const command = parts.slice(10).join(' ');

      if (command.includes('/claude') || command.match(/\bclaude\b/)) {
        let cwd = null;
        try {
          const lsofOutput = execFileSync('lsof', ['-p', String(pid)], {
            encoding: 'utf8',
            timeout: 3000,
          });
          for (const lsofLine of lsofOutput.split('\n')) {
            if (lsofLine.includes('cwd')) {
              const match = lsofLine.match(/\s(\/\S+)$/);
              if (match) cwd = match[1];
              break;
            }
          }
        } catch {}

        processes.push({ pid, cpu, mem, command, cwd });
      }
    }
  } catch {}

  return processes;
}

/**
 * Encode a filesystem path the same way Claude Code does for project dir names.
 */
function encodePath(fsPath) {
  return fsPath.replace(/\//g, '-');
}

/**
 * Determine which sessions are likely active based on process list and file mtimes.
 */
function getActiveSessions(projects, processes) {
  const fs = require('fs');
  const activeSessionIds = new Set();
  const now = Date.now();
  const ACTIVE_THRESHOLD_MS = 600_000; // 10 minutes — sessions may not write frequently

  const activeCwds = processes.map(p => p.cwd).filter(Boolean);

  for (const project of projects) {
    // Match by encoding the CWD and checking if it matches the project dir name
    const projectActive = activeCwds.some(cwd => {
      const encoded = encodePath(cwd);
      return project.dirName === encoded || project.dirName.startsWith(encoded);
    });

    for (const session of project.sessions) {
      // Re-read mtime fresh (cached mtime may be stale)
      let mtime = session.mtime;
      try {
        mtime = fs.statSync(session.jsonlPath).mtimeMs;
        session.mtime = mtime; // update cached value
      } catch {}

      const recentlyModified = (now - mtime) < ACTIVE_THRESHOLD_MS;
      if (projectActive && recentlyModified) {
        activeSessionIds.add(session.sessionId);
      }
    }
  }

  // Fallback: any session modified recently (within 5 min) is likely active
  for (const project of projects) {
    for (const session of project.sessions) {
      let mtime = session.mtime;
      try {
        mtime = fs.statSync(session.jsonlPath).mtimeMs;
        session.mtime = mtime;
      } catch {}
      if ((now - mtime) < 300_000) {
        activeSessionIds.add(session.sessionId);
      }
    }
  }

  return activeSessionIds;
}

module.exports = { detectActiveProcesses, getActiveSessions };
