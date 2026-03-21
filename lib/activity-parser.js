const fs = require('fs');
const path = require('path');

const ACTIVITY_STATES = {
  CODING: 'CODING',
  READING: 'READING',
  IDLE: 'IDLE',
  WAITING: 'WAITING',
  THINKING: 'THINKING',
  SPAWNING: 'SPAWNING',
};

const CODING_TOOLS = new Set(['Edit', 'Write', 'Bash', 'Skill', 'NotebookEdit', 'TodoWrite']);
const READING_TOOLS = new Set(['Read', 'Grep', 'Glob', 'TodoRead', 'WebFetch', 'WebSearch']);

/**
 * Check if any subagent JSONL files have been recently modified.
 * The subagents directory is at: <sessionDir>/subagents/agent-*.jsonl
 * where sessionDir is derived from the session JSONL path.
 */
function checkSubagentActivity(jsonlPath) {
  try {
    // Session JSONL: /path/to/<sessionId>.jsonl
    // Subagents dir: /path/to/<sessionId>/subagents/
    const sessionId = path.basename(jsonlPath, '.jsonl');
    const sessionDir = path.join(path.dirname(jsonlPath), sessionId, 'subagents');

    if (!fs.existsSync(sessionDir)) return false;

    const now = Date.now();
    const entries = fs.readdirSync(sessionDir);
    for (const entry of entries) {
      if (entry.endsWith('.jsonl')) {
        const stat = fs.statSync(path.join(sessionDir, entry));
        // If any subagent file modified in last 30 seconds, subagents are active
        if (now - stat.mtimeMs < 30000) return true;
      }
    }
  } catch {}
  return false;
}

/**
 * Build a human-readable description of what a tool is doing.
 */
function describeToolUse(toolName, input) {
  if (!input) return toolName;

  switch (toolName) {
    case 'Read':
      return input.file_path ? `Reading ${shortPath(input.file_path)}` : 'Reading file';
    case 'Edit':
      return input.file_path ? `Editing ${shortPath(input.file_path)}` : 'Editing file';
    case 'Write':
      return input.file_path ? `Writing ${shortPath(input.file_path)}` : 'Writing file';
    case 'Grep':
      return input.pattern ? `Searching: "${truncate(input.pattern, 25)}"` : 'Searching code';
    case 'Glob':
      return input.pattern ? `Finding: ${truncate(input.pattern, 25)}` : 'Finding files';
    case 'Bash':
      return input.command ? `Running: ${truncate(input.command, 30)}` : 'Running command';
    case 'Agent': {
      const desc = input.description || input.subagent_type || 'subagent';
      return `Spawning: ${truncate(desc, 30)}`;
    }
    case 'Skill':
      return input.skill ? `Skill: ${input.skill}` : 'Running skill';
    case 'TodoWrite':
      return 'Updating tasks';
    case 'WebFetch':
      return 'Fetching web page';
    case 'WebSearch':
      return input.query ? `Searching: "${truncate(input.query, 25)}"` : 'Web search';
    case 'NotebookEdit':
      return 'Editing notebook';
    default:
      return toolName;
  }
}

function shortPath(filePath) {
  if (!filePath) return '';
  const parts = filePath.split('/');
  return parts.slice(-2).join('/');
}

function truncate(str, len) {
  if (!str) return '';
  str = str.split('\n')[0]; // first line only
  return str.length > len ? str.substring(0, len) + '...' : str;
}

/**
 * Parse the last N lines of a session JSONL to determine current activity state.
 * Optionally checks subagent directories for activity when the parent session appears idle.
 */
function parseRecentActivity(jsonlPath, tailLines = 50) {
  const result = {
    lastToolName: null,
    lastToolTimestamp: null,
    lastToolDetail: null,
    lastToolDescription: null,
    activityState: ACTIVITY_STATES.IDLE,
    activityDescription: 'Idle',
    isWaitingForUser: false,
    subagentIds: [],
    model: null,
    slug: null,
    recentTools: [], // last few tool calls for context
    // Token & file metrics
    totalInputTokens: 0,
    totalOutputTokens: 0,
    filesModified: [],
    filesAccessed: [],
  };

  let content;
  try {
    content = fs.readFileSync(jsonlPath, 'utf8');
  } catch {
    return result;
  }

  // Check file freshness
  let fileMtimeMs;
  try {
    fileMtimeMs = fs.statSync(jsonlPath).mtimeMs;
  } catch {
    fileMtimeMs = 0;
  }
  const fileAgeMs = Date.now() - fileMtimeMs;

  const lines = content.split('\n').filter(Boolean);

  // Read first few lines for metadata
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.slug) result.slug = entry.slug;
    } catch {}
  }

  // Read tail for recent activity
  const start = Math.max(0, lines.length - tailLines);
  let lastAssistantEntry = null;
  let lastEntryType = null;
  let lastEntryTimestamp = null;
  let lastStopReason = null;
  const filesModifiedSet = new Set();
  const filesAccessedSet = new Set();

  for (let i = start; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    lastEntryType = entry.type;
    if (entry.timestamp) lastEntryTimestamp = entry.timestamp;

    if (entry.type === 'assistant' && entry.message) {
      lastAssistantEntry = entry;
      lastStopReason = entry.message.stop_reason;
      if (entry.message.model) result.model = entry.message.model;

      // Accumulate token usage
      if (entry.message.usage) {
        result.totalInputTokens += entry.message.usage.input_tokens || 0;
        result.totalOutputTokens += entry.message.usage.output_tokens || 0;
      }

      if (Array.isArray(entry.message.content)) {
        for (const block of entry.message.content) {
          if (block.type === 'tool_use') {
            const description = describeToolUse(block.name, block.input);
            result.lastToolName = block.name;
            result.lastToolTimestamp = entry.timestamp;
            result.lastToolDescription = description;

            // Track files
            if (block.input?.file_path) {
              filesAccessedSet.add(block.input.file_path);
              if (block.name === 'Edit' || block.name === 'Write') {
                filesModifiedSet.add(block.input.file_path);
              }
            }

            // Extract detail
            if (block.input?.file_path) {
              result.lastToolDetail = shortPath(block.input.file_path);
            } else if (block.input?.command) {
              result.lastToolDetail = truncate(block.input.command, 40);
            } else if (block.input?.pattern) {
              result.lastToolDetail = block.input.pattern;
            } else if (block.input?.description) {
              result.lastToolDetail = truncate(block.input.description, 40);
            }

            // Track recent tools (last 3)
            result.recentTools.push({ name: block.name, description });
            if (result.recentTools.length > 3) result.recentTools.shift();

            // Track subagent spawns
            if (block.name === 'Agent' && block.input) {
              result.subagentIds.push({
                id: block.id,
                type: block.input.subagent_type || 'general-purpose',
                description: block.input.description || 'subagent',
              });
            }
          }
        }
      }
    }
  }

  // ===== Determine activity state =====
  const isFileActive = fileAgeMs < 15000;

  // Check if subagents are actively running by looking at subagent JSONL files
  const hasActiveSubagents = checkSubagentActivity(jsonlPath);
  // If subagents spawned and are still active, the parent is supervising
  const hasRecentSubagents = result.subagentIds.length > 0;

  if (lastAssistantEntry) {
    if (lastStopReason === 'tool_use') {
      // Agent actively called a tool and is waiting for the result — it's WORKING
      if (result.lastToolName === 'Agent') {
        result.activityState = ACTIVITY_STATES.SPAWNING;
        result.activityDescription = result.lastToolDescription || 'Spawning subagent';
      } else if (CODING_TOOLS.has(result.lastToolName)) {
        result.activityState = ACTIVITY_STATES.CODING;
        result.activityDescription = result.lastToolDescription || 'Coding';
      } else if (READING_TOOLS.has(result.lastToolName)) {
        result.activityState = ACTIVITY_STATES.READING;
        result.activityDescription = result.lastToolDescription || 'Reading';
      } else {
        result.activityState = ACTIVITY_STATES.CODING;
        result.activityDescription = result.lastToolDescription || result.lastToolName;
      }
    } else if (lastStopReason === 'end_turn') {
      // Agent finished its turn — but subagents may still be running
      if (hasActiveSubagents) {
        // Subagent JSONL files are being written — parent is supervising
        result.activityState = ACTIVITY_STATES.SPAWNING;
        const saCount = result.subagentIds.length;
        const saTypes = [...new Set(result.subagentIds.map(s => s.type))].join(', ');
        result.activityDescription = `Running ${saCount} subagent${saCount > 1 ? 's' : ''}: ${saTypes}`;
      } else if (isFileActive) {
        // File was just written — user may have sent a new message
        result.activityState = ACTIVITY_STATES.THINKING;
        result.activityDescription = 'Processing new request...';
      } else {
        result.activityState = ACTIVITY_STATES.WAITING;
        result.activityDescription = 'Waiting for input';
        result.isWaitingForUser = true;
      }
    } else if (lastStopReason === 'max_tokens') {
      result.activityState = ACTIVITY_STATES.THINKING;
      result.activityDescription = 'Continuing (max tokens)...';
    } else {
      // No stop reason yet or other — check if file is active
      if (isFileActive || hasActiveSubagents) {
        result.activityState = ACTIVITY_STATES.THINKING;
        result.activityDescription = hasActiveSubagents ? 'Supervising subagents...' : 'Thinking...';
      } else if (result.lastToolName) {
        const toolAge = result.lastToolTimestamp ? Date.now() - new Date(result.lastToolTimestamp).getTime() : Infinity;
        if (toolAge < 60000) {
          if (CODING_TOOLS.has(result.lastToolName)) {
            result.activityState = ACTIVITY_STATES.CODING;
          } else if (READING_TOOLS.has(result.lastToolName)) {
            result.activityState = ACTIVITY_STATES.READING;
          } else {
            result.activityState = ACTIVITY_STATES.CODING;
          }
          result.activityDescription = result.lastToolDescription || result.lastToolName;
        } else {
          result.activityState = ACTIVITY_STATES.IDLE;
          result.activityDescription = 'Idle';
        }
      } else {
        result.activityState = ACTIVITY_STATES.IDLE;
        result.activityDescription = 'Idle';
      }
    }

    // Special case: last JSONL entry is a user message (tool_result being returned)
    if (lastEntryType === 'user' && (isFileActive || hasActiveSubagents)) {
      if (hasActiveSubagents) {
        result.activityState = ACTIVITY_STATES.SPAWNING;
        result.activityDescription = `Processing subagent results...`;
      } else {
        result.activityState = ACTIVITY_STATES.THINKING;
        result.activityDescription = result.lastToolDescription
          ? `Processing ${result.lastToolName} result...`
          : 'Processing...';
      }
    }
  } else if (isFileActive) {
    result.activityState = ACTIVITY_STATES.THINKING;
    result.activityDescription = 'Starting up...';
  }

  result.filesModified = [...filesModifiedSet];
  result.filesAccessed = [...filesAccessedSet];

  return result;
}

/**
 * Hash a string to a number for deterministic color assignment.
 */
function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/**
 * Build workspace state from active sessions.
 */
function getWorkspaceState(projects, activeSessionIds) {
  const workers = [];

  for (const project of projects) {
    const projectLabel = project.projectPath.split('/').filter(Boolean).slice(-2).join('/');

    for (const session of project.sessions) {
      if (!activeSessionIds.has(session.sessionId)) continue;

      const activity = parseRecentActivity(session.jsonlPath);
      const hue = hashCode(session.sessionId) % 360;

      workers.push({
        id: session.sessionId,
        label: activity.slug || session.summary || session.sessionId.substring(0, 8),
        projectLabel,
        state: activity.activityState,
        lastTool: activity.lastToolName,
        lastToolDetail: activity.lastToolDetail,
        activityDescription: activity.activityDescription,
        recentTools: activity.recentTools,
        color: hue,
        model: activity.model,
        isWaitingForUser: activity.isWaitingForUser,
        totalTokens: activity.totalInputTokens + activity.totalOutputTokens,
        filesModified: activity.filesModified,
        filesAccessed: activity.filesAccessed,
        subagents: activity.subagentIds.map(sa => ({
          id: sa.id,
          type: sa.type,
          description: sa.description,
          color: hashCode(sa.id) % 360,
        })),
      });

      // Parse active subagent JSONL files as separate workers
      const sessionId = path.basename(session.jsonlPath, '.jsonl');
      const subagentDir = path.join(path.dirname(session.jsonlPath), sessionId, 'subagents');
      try {
        if (fs.existsSync(subagentDir)) {
          const now = Date.now();
          const entries = fs.readdirSync(subagentDir);
          for (const entry of entries) {
            if (!entry.endsWith('.jsonl')) continue;
            const saPath = path.join(subagentDir, entry);
            const stat = fs.statSync(saPath);
            // Only show subagents active in the last 30 seconds
            if (now - stat.mtimeMs > 30000) continue;
            const saActivity = parseRecentActivity(saPath);
            const saId = path.basename(entry, '.jsonl');
            const saHue = hashCode(saId) % 360;
            // Find matching subagent info from parent's tracked spawns
            const saInfo = activity.subagentIds.find(s => s.id === saId) || {};
            workers.push({
              id: saId,
              label: saInfo.description || saActivity.slug || saId.substring(0, 12),
              projectLabel,
              state: saActivity.activityState,
              lastTool: saActivity.lastToolName,
              lastToolDetail: saActivity.lastToolDetail,
              activityDescription: saActivity.activityDescription,
              recentTools: saActivity.recentTools,
              color: saHue,
              model: saActivity.model || saInfo.type || 'subagent',
              isWaitingForUser: false,
              totalTokens: saActivity.totalInputTokens + saActivity.totalOutputTokens,
              filesModified: saActivity.filesModified,
              filesAccessed: saActivity.filesAccessed,
              subagents: [],
              parentId: session.sessionId,
              isSubagent: true,
            });
          }
        }
      } catch {}
    }
  }

  return { workers, timestamp: Date.now() };
}

module.exports = { parseRecentActivity, getWorkspaceState, ACTIVITY_STATES };
