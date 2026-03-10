const fs = require('fs');

/**
 * Parse the tail of a JSONL file for overview data.
 * Reads the entire file but only processes what we need.
 */
function parseSessionOverview(jsonlPath) {
  const result = {
    sessionId: null,
    slug: null,
    cwd: null,
    gitBranch: null,
    model: null,
    permissionMode: null,
    version: null,
    toolsUsed: new Set(),
    skillsUsed: new Set(),
    firstTimestamp: null,
    lastTimestamp: null,
    messageCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    toolCallCount: 0,
    // Token metrics
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    // Tool success/failure
    toolResults: {},       // { toolName: { success: N, failure: N } }
    // Stop reasons
    stopReasons: {},       // { reason: count }
    // File access
    filesAccessed: new Set(),
    filesModified: new Set(),
    // Conversation flow
    turnTimestamps: [],    // timestamps of each user message for latency calc
  };

  let content;
  try {
    content = fs.readFileSync(jsonlPath, 'utf8');
  } catch {
    return result;
  }

  const lines = content.split('\n').filter(Boolean);
  const pendingToolCalls = new Map(); // id -> toolName, for matching results

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === 'file-history-snapshot') continue;

    // Extract metadata from any message
    if (entry.sessionId) result.sessionId = entry.sessionId;
    if (entry.slug) result.slug = entry.slug;
    if (entry.cwd) result.cwd = entry.cwd;
    if (entry.gitBranch) result.gitBranch = entry.gitBranch;
    if (entry.permissionMode) result.permissionMode = entry.permissionMode;
    if (entry.version) result.version = entry.version;

    const ts = entry.timestamp;
    if (ts) {
      if (!result.firstTimestamp || ts < result.firstTimestamp) result.firstTimestamp = ts;
      if (!result.lastTimestamp || ts > result.lastTimestamp) result.lastTimestamp = ts;
    }

    if (entry.type === 'user') {
      result.messageCount++;
      result.userMessageCount++;
      if (ts) result.turnTimestamps.push(ts);

      // Check for tool results in user messages (tool_result blocks)
      if (Array.isArray(entry.message?.content)) {
        for (const block of entry.message.content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const toolName = pendingToolCalls.get(block.tool_use_id);
            if (toolName) {
              if (!result.toolResults[toolName]) {
                result.toolResults[toolName] = { success: 0, failure: 0 };
              }
              const isError = block.is_error === true;
              result.toolResults[toolName][isError ? 'failure' : 'success']++;
              pendingToolCalls.delete(block.tool_use_id);
            }
          }
        }
      }
    }

    if (entry.type === 'assistant' && entry.message) {
      result.messageCount++;
      result.assistantMessageCount++;
      const msg = entry.message;
      if (msg.model) result.model = msg.model;

      // Token usage
      if (msg.usage) {
        result.totalInputTokens += msg.usage.input_tokens || 0;
        result.totalOutputTokens += msg.usage.output_tokens || 0;
        result.cacheCreationTokens += msg.usage.cache_creation_input_tokens || 0;
        result.cacheReadTokens += msg.usage.cache_read_input_tokens || 0;
      }

      // Stop reason
      if (msg.stop_reason) {
        result.stopReasons[msg.stop_reason] = (result.stopReasons[msg.stop_reason] || 0) + 1;
      }

      // Extract tool usage
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use') {
            result.toolCallCount++;
            result.toolsUsed.add(block.name);
            pendingToolCalls.set(block.id, block.name);

            // Extract subagent types from Agent tool calls
            if (block.name === 'Agent' && block.input?.subagent_type) {
              result.skillsUsed.add(block.input.subagent_type);
            }
            if (block.name === 'Skill' && block.input?.skill) {
              result.skillsUsed.add(block.input.skill);
            }

            // File access tracking
            if (block.name === 'Read' && block.input?.file_path) {
              result.filesAccessed.add(block.input.file_path);
            }
            if ((block.name === 'Edit' || block.name === 'Write') && block.input?.file_path) {
              result.filesModified.add(block.input.file_path);
              result.filesAccessed.add(block.input.file_path);
            }
            if (block.name === 'Glob' && block.input?.pattern) {
              // Track search patterns as pseudo-access
            }
          }
        }
      }
    }
  }

  // Calculate duration
  if (result.firstTimestamp && result.lastTimestamp) {
    result.durationMs = new Date(result.lastTimestamp) - new Date(result.firstTimestamp);
  }

  // Cache hit rate
  const totalCacheTokens = result.cacheCreationTokens + result.cacheReadTokens;
  result.cacheHitRate = totalCacheTokens > 0
    ? result.cacheReadTokens / totalCacheTokens
    : 0;

  // Average turn latency (time between consecutive user messages)
  if (result.turnTimestamps.length > 1) {
    const deltas = [];
    for (let i = 1; i < result.turnTimestamps.length; i++) {
      deltas.push(new Date(result.turnTimestamps[i]) - new Date(result.turnTimestamps[i - 1]));
    }
    result.avgTurnLatencyMs = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  }

  return {
    ...result,
    toolsUsed: [...result.toolsUsed],
    skillsUsed: [...result.skillsUsed],
    filesAccessed: [...result.filesAccessed],
    filesModified: [...result.filesModified],
    turnTimestamps: undefined, // don't send raw timestamps
  };
}

/**
 * Quick parse — only reads last N lines for speed on large files.
 * Now also extracts token counts for graph-level metrics.
 */
function parseSessionQuick(jsonlPath, tailLines = 150) {
  let content;
  try {
    content = fs.readFileSync(jsonlPath, 'utf8');
  } catch {
    return { toolsUsed: [], skillsUsed: [], messageCount: 0, toolCallCount: 0 };
  }

  const lines = content.split('\n').filter(Boolean);
  const totalMessages = lines.length;

  const result = {
    sessionId: null,
    slug: null,
    cwd: null,
    gitBranch: null,
    model: null,
    toolsUsed: new Set(),
    skillsUsed: new Set(),
    messageCount: 0,
    toolCallCount: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };

  // Read first few lines for session metadata
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.sessionId) result.sessionId = entry.sessionId;
      if (entry.slug) result.slug = entry.slug;
      if (entry.cwd) result.cwd = entry.cwd;
      if (entry.gitBranch) result.gitBranch = entry.gitBranch;
      if (entry.timestamp && !result.firstTimestamp) result.firstTimestamp = entry.timestamp;
    } catch {}
  }

  // Read tail for recent activity
  const start = Math.max(0, lines.length - tailLines);
  for (let i = start; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.timestamp) result.lastTimestamp = entry.timestamp;
      if (entry.message?.model) result.model = entry.message.model;

      if (entry.type === 'user' || entry.type === 'assistant') result.messageCount++;

      if (entry.type === 'assistant' && entry.message) {
        // Token usage
        if (entry.message.usage) {
          result.totalInputTokens += entry.message.usage.input_tokens || 0;
          result.totalOutputTokens += entry.message.usage.output_tokens || 0;
          result.cacheCreationTokens += entry.message.usage.cache_creation_input_tokens || 0;
          result.cacheReadTokens += entry.message.usage.cache_read_input_tokens || 0;
        }

        if (Array.isArray(entry.message.content)) {
          for (const block of entry.message.content) {
            if (block.type === 'tool_use') {
              result.toolCallCount++;
              result.toolsUsed.add(block.name);
              if (block.name === 'Agent' && block.input?.subagent_type) {
                result.skillsUsed.add(block.input.subagent_type);
              }
              if (block.name === 'Skill' && block.input?.skill) {
                result.skillsUsed.add(block.input.skill);
              }
            }
          }
        }
      }
    } catch {}
  }

  result.messageCount = totalMessages;

  return {
    ...result,
    toolsUsed: [...result.toolsUsed],
    skillsUsed: [...result.skillsUsed],
  };
}

module.exports = { parseSessionOverview, parseSessionQuick };
