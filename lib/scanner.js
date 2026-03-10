const fs = require('fs');
const path = require('path');

const CLAUDE_DIR = path.join(process.env.HOME, '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

function decodeDirName(dirName) {
  // The dir name encoding replaces / with -, but this is lossy for paths containing hyphens.
  // Try to find the actual path by checking if it exists on disk.
  const naive = dirName.replace(/^-/, '/').replace(/-/g, '/');
  const fs = require('fs');
  if (fs.existsSync(naive)) return naive;

  // Try to find matching path by checking parent dirs exist
  // e.g. "-Users-jon-repo-agent-mon" - we know /Users/jon/repo exists
  // so try different split points for the last segments
  const parts = dirName.replace(/^-/, '').split('-');
  for (let i = parts.length - 1; i >= 1; i--) {
    const prefix = '/' + parts.slice(0, i).join('/');
    const suffix = parts.slice(i).join('-');
    const candidate = prefix + '/' + suffix;
    if (fs.existsSync(candidate)) return candidate;
  }

  return naive;
}

function scanProjects() {
  const projects = [];
  if (!fs.existsSync(PROJECTS_DIR)) return projects;

  for (const projDir of fs.readdirSync(PROJECTS_DIR)) {
    const projPath = path.join(PROJECTS_DIR, projDir);
    if (!fs.statSync(projPath).isDirectory()) continue;

    const project = {
      dirName: projDir,
      projectPath: decodeDirName(projDir),
      fullPath: projPath,
      sessions: [],
      sessionsIndex: null,
    };

    // Read sessions-index.json if it exists
    const indexPath = path.join(projPath, 'sessions-index.json');
    if (fs.existsSync(indexPath)) {
      try {
        project.sessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      } catch {}
    }

    // Find session JSONL files and subagent dirs
    for (const entry of fs.readdirSync(projPath)) {
      const entryPath = path.join(projPath, entry);

      // Session JSONL files (UUID.jsonl)
      if (entry.endsWith('.jsonl') && entry.length > 10) {
        const sessionId = entry.replace('.jsonl', '');
        const session = {
          sessionId,
          jsonlPath: entryPath,
          subagents: [],
          mtime: fs.statSync(entryPath).mtimeMs,
        };

        // Look for subagent directory
        const sessionDir = path.join(projPath, sessionId);
        const subagentsDir = path.join(sessionDir, 'subagents');
        if (fs.existsSync(subagentsDir) && fs.statSync(subagentsDir).isDirectory()) {
          for (const subFile of fs.readdirSync(subagentsDir)) {
            if (subFile.endsWith('.meta.json')) {
              const agentId = subFile.replace('agent-', '').replace('.meta.json', '');
              let agentType = 'unknown';
              try {
                const meta = JSON.parse(fs.readFileSync(path.join(subagentsDir, subFile), 'utf8'));
                agentType = meta.agentType || 'unknown';
              } catch {}

              const agentJsonl = path.join(subagentsDir, `agent-${agentId}.jsonl`);
              session.subagents.push({
                agentId,
                agentType,
                metaPath: path.join(subagentsDir, subFile),
                jsonlPath: fs.existsSync(agentJsonl) ? agentJsonl : null,
              });
            }
          }
        }

        // Enrich from sessions-index
        if (project.sessionsIndex?.entries) {
          const indexEntry = project.sessionsIndex.entries.find(e => e.sessionId === sessionId);
          if (indexEntry) {
            session.summary = indexEntry.summary;
            session.firstPrompt = indexEntry.firstPrompt;
            session.messageCount = indexEntry.messageCount;
            session.created = indexEntry.created;
            session.modified = indexEntry.modified;
            session.gitBranch = indexEntry.gitBranch;
          }
        }

        project.sessions.push(session);
      }
    }

    // Sort sessions newest first
    project.sessions.sort((a, b) => b.mtime - a.mtime);
    projects.push(project);
  }

  // Sort projects by most recently active session
  projects.sort((a, b) => {
    const aMax = a.sessions[0]?.mtime || 0;
    const bMax = b.sessions[0]?.mtime || 0;
    return bMax - aMax;
  });

  return projects;
}

module.exports = { scanProjects, CLAUDE_DIR, PROJECTS_DIR, decodeDirName };
