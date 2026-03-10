const { parseSessionQuick } = require('./parser');

const COLORS = {
  project: '#4a9eff',
  session: '#50c878',
  sessionInactive: '#6b7280',
  subagent: '#f59e0b',
  tool: '#a78bfa',
};

const SIZES = {
  project: 22,
  session: 14,
  subagent: 10,
  tool: 6,
};

/**
 * Build a D3-compatible graph from scanned project data.
 */
function buildGraph(projects, activeSessionIds, options = {}) {
  const nodes = [];
  const edges = [];
  const toolNodeIds = new Set();
  const maxSessions = options.maxSessionsPerProject || 10;

  for (const project of projects) {
    const projectId = `proj:${project.dirName}`;
    const projectLabel = project.projectPath.split('/').filter(Boolean).slice(-2).join('/');

    nodes.push({
      id: projectId,
      type: 'project',
      label: projectLabel,
      fullPath: project.projectPath,
      color: COLORS.project,
      size: SIZES.project,
      sessionCount: project.sessions.length,
    });

    const sessionsToShow = project.sessions.slice(0, maxSessions);

    for (const session of sessionsToShow) {
      const sessionId = `sess:${session.sessionId}`;
      const active = activeSessionIds.has(session.sessionId);

      // Quick parse for tool/skill data
      let parsed = { toolsUsed: [], skillsUsed: [], model: null, slug: null };
      try {
        parsed = parseSessionQuick(session.jsonlPath);
      } catch {}

      const label = session.summary
        || parsed.slug
        || session.firstPrompt?.substring(0, 50)
        || session.sessionId.substring(0, 8);

      nodes.push({
        id: sessionId,
        type: 'session',
        label,
        active,
        color: active ? COLORS.session : COLORS.sessionInactive,
        size: active ? SIZES.session + 2 : SIZES.session,
        sessionId: session.sessionId,
        model: parsed.model,
        toolsUsed: parsed.toolsUsed,
        skillsUsed: parsed.skillsUsed,
        messageCount: session.messageCount || parsed.messageCount,
        created: session.created,
        modified: session.modified,
        gitBranch: session.gitBranch || parsed.gitBranch,
        slug: parsed.slug,
        cwd: parsed.cwd,
      });

      edges.push({ source: projectId, target: sessionId, type: 'has-session' });

      // Subagent nodes
      for (const agent of session.subagents) {
        const agentNodeId = `agent:${agent.agentId}`;
        nodes.push({
          id: agentNodeId,
          type: 'subagent',
          label: agent.agentType,
          agentType: agent.agentType,
          color: COLORS.subagent,
          size: SIZES.subagent,
        });
        edges.push({ source: sessionId, target: agentNodeId, type: 'spawned' });
      }

      // Tool nodes (shared across sessions)
      if (options.showTools !== false) {
        for (const tool of parsed.toolsUsed) {
          const toolNodeId = `tool:${tool}`;
          if (!toolNodeIds.has(toolNodeId)) {
            toolNodeIds.add(toolNodeId);
            nodes.push({
              id: toolNodeId,
              type: 'tool',
              label: tool,
              color: COLORS.tool,
              size: SIZES.tool,
            });
          }
          edges.push({ source: sessionId, target: toolNodeId, type: 'uses-tool' });
        }
      }
    }
  }

  // Propagate connectedToActive flag
  const connectedIds = new Set();
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  // Seed with active sessions
  for (const n of nodes) {
    if (n.type === 'session' && n.active) connectedIds.add(n.id);
  }

  // BFS: walk edges to find all reachable nodes from active sessions
  let frontier = [...connectedIds];
  while (frontier.length > 0) {
    const next = [];
    for (const id of frontier) {
      for (const e of edges) {
        const src = typeof e.source === 'object' ? e.source.id : e.source;
        const tgt = typeof e.target === 'object' ? e.target.id : e.target;
        if (src === id && !connectedIds.has(tgt)) {
          connectedIds.add(tgt);
          next.push(tgt);
        }
        if (tgt === id && !connectedIds.has(src)) {
          connectedIds.add(src);
          next.push(src);
        }
      }
    }
    frontier = next;
  }

  // Set flag and brighten connected nodes
  for (const n of nodes) {
    n.connectedToActive = connectedIds.has(n.id);
  }
  for (const e of edges) {
    const src = typeof e.source === 'object' ? e.source.id : e.source;
    const tgt = typeof e.target === 'object' ? e.target.id : e.target;
    e.connectedToActive = connectedIds.has(src) && connectedIds.has(tgt);
  }

  return { nodes, edges };
}

module.exports = { buildGraph, COLORS, SIZES };
