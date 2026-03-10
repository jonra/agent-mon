const fs = require('fs');
const path = require('path');
const { PROJECTS_DIR, decodeDirName, CLAUDE_DIR } = require('./scanner');

const PLUGINS_DIR = path.join(CLAUDE_DIR, 'plugins');

/**
 * Parse simple YAML-ish frontmatter from markdown content.
 * Returns { frontmatter: {}, body: string, title: string|null }
 */
function parseFrontmatter(content) {
  const result = { frontmatter: {}, body: content, title: null };
  if (!content.startsWith('---')) return result;

  const end = content.indexOf('\n---', 3);
  if (end === -1) return result;

  const fmBlock = content.substring(4, end);
  for (const line of fmBlock.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.substring(0, idx).trim();
    let val = line.substring(idx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result.frontmatter[key] = val;
  }
  result.body = content.substring(end + 4).trim();

  // Extract first # Title
  const titleMatch = result.body.match(/^#\s+(.+)/m);
  if (titleMatch) result.title = titleMatch[1].trim();

  return result;
}

/**
 * Scan markdown files in a directory.
 */
function scanMarkdownDir(dirPath) {
  const items = [];
  if (!fs.existsSync(dirPath)) return items;
  try {
    for (const file of fs.readdirSync(dirPath)) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(dirPath, file);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = parseFrontmatter(content);
        items.push({
          fileName: file,
          name: file.replace('.md', ''),
          title: parsed.title,
          description: parsed.frontmatter.description || '',
          argumentHint: parsed.frontmatter['argument-hint'] || '',
          model: parsed.frontmatter.model || null,
          body: parsed.body.substring(0, 500),
          filePath,
        });
      } catch {}
    }
  } catch {}
  return items;
}

/**
 * Scan globally installed plugins.
 */
function scanGlobalPlugins() {
  const plugins = [];
  const commands = [];
  const agents = [];

  // Read installed plugins
  const installedPath = path.join(PLUGINS_DIR, 'installed_plugins.json');
  let installed = {};
  try {
    installed = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
  } catch { return { plugins, commands, agents }; }

  // Read enabled state
  let enabledPlugins = {};
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8'));
    enabledPlugins = settings.enabledPlugins || {};
  } catch {}

  // Read blocklist
  let blockedSet = new Set();
  try {
    const bl = JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, 'blocklist.json'), 'utf8'));
    if (Array.isArray(bl.plugins)) {
      for (const entry of bl.plugins) {
        if (entry.plugin) blockedSet.add(entry.plugin);
      }
    }
  } catch {}

  const pluginEntries = installed.plugins || {};
  for (const [pluginKey, installs] of Object.entries(pluginEntries)) {
    const atIdx = pluginKey.indexOf('@');
    const pluginName = atIdx > 0 ? pluginKey.substring(0, atIdx) : pluginKey;
    const marketplace = atIdx > 0 ? pluginKey.substring(atIdx + 1) : '';

    const enabled = enabledPlugins[pluginKey] === true;
    const blocked = blockedSet.has(pluginKey);

    // Gather unique projects this plugin is installed in
    const projects = [];
    let latestInstall = null;

    for (const inst of installs) {
      if (inst.projectPath) projects.push(inst.projectPath);
      if (!latestInstall || (inst.lastUpdated > latestInstall.lastUpdated)) {
        latestInstall = inst;
      }
    }

    // Read plugin metadata from installPath
    let description = '';
    if (latestInstall?.installPath) {
      try {
        const pjson = JSON.parse(fs.readFileSync(
          path.join(latestInstall.installPath, '.claude-plugin', 'plugin.json'), 'utf8'
        ));
        description = pjson.description || '';
      } catch {}

      // Scan commands
      const cmds = scanMarkdownDir(path.join(latestInstall.installPath, 'commands'));
      for (const cmd of cmds) {
        commands.push({
          ...cmd,
          source: { type: 'plugin', plugin: pluginName, marketplace, pluginKey },
        });
      }

      // Scan agents
      const agts = scanMarkdownDir(path.join(latestInstall.installPath, 'agents'));
      for (const agt of agts) {
        agents.push({
          ...agt,
          source: { type: 'plugin', plugin: pluginName, marketplace, pluginKey },
        });
      }
    }

    plugins.push({
      name: pluginName,
      key: pluginKey,
      marketplace,
      description,
      version: latestInstall?.version || '',
      scope: latestInstall?.scope || 'unknown',
      enabled,
      blocked,
      projects,
      installedAt: latestInstall?.installedAt || null,
      lastUpdated: latestInstall?.lastUpdated || null,
      commandCount: commands.filter(c => c.source.pluginKey === pluginKey).length,
      agentCount: agents.filter(a => a.source.pluginKey === pluginKey).length,
    });
  }

  return { plugins, commands, agents };
}

/**
 * Scan project-level .claude/ directories for commands, agents, MCP, CLAUDE.md, hooks.
 */
function scanProjectDirectories() {
  const commands = [];
  const agents = [];
  const mcpServers = [];
  const claudeMdFiles = [];
  const hooks = [];

  if (!fs.existsSync(PROJECTS_DIR)) return { commands, agents, mcpServers, claudeMdFiles, hooks };

  const seenPaths = new Set();

  for (const projDir of fs.readdirSync(PROJECTS_DIR)) {
    const projFullPath = path.join(PROJECTS_DIR, projDir);
    if (!fs.statSync(projFullPath).isDirectory()) continue;

    const projectPath = decodeDirName(projDir);
    if (seenPaths.has(projectPath)) continue;
    seenPaths.add(projectPath);

    const projectLabel = projectPath.split('/').filter(Boolean).slice(-2).join('/');

    // Project commands
    const cmdDir = path.join(projectPath, '.claude', 'commands');
    for (const cmd of scanMarkdownDir(cmdDir)) {
      commands.push({
        ...cmd,
        source: { type: 'project', project: projectPath, projectLabel },
      });
    }

    // Project agents
    const agentDir = path.join(projectPath, '.claude', 'agents');
    for (const agt of scanMarkdownDir(agentDir)) {
      agents.push({
        ...agt,
        source: { type: 'project', project: projectPath, projectLabel },
      });
    }

    // MCP configs
    for (const mcpFile of [
      path.join(projectPath, '.claude', 'mcp.json'),
      path.join(projectPath, '.mcp.json'),
    ]) {
      if (!fs.existsSync(mcpFile)) continue;
      try {
        const mcpConfig = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
        const servers = mcpConfig.mcpServers || {};
        for (const [serverName, config] of Object.entries(servers)) {
          mcpServers.push({
            name: serverName,
            type: config.type || 'stdio',
            command: config.command || null,
            url: config.url || null,
            source: { type: 'project', project: projectPath, projectLabel },
          });
        }
      } catch {}
    }

    // CLAUDE.md
    const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) {
      try {
        const content = fs.readFileSync(claudeMdPath, 'utf8');
        claudeMdFiles.push({
          project: projectPath,
          projectLabel,
          preview: content.substring(0, 300),
          lineCount: content.split('\n').length,
          filePath: claudeMdPath,
        });
      } catch {}
    }

    // Hooks
    const hooksDir = path.join(projectPath, '.claude', 'hooks');
    if (fs.existsSync(hooksDir)) {
      try {
        for (const hookFile of fs.readdirSync(hooksDir)) {
          hooks.push({
            name: hookFile,
            filePath: path.join(hooksDir, hookFile),
            source: { type: 'project', project: projectPath, projectLabel },
          });
        }
      } catch {}
    }
  }

  return { commands, agents, mcpServers, claudeMdFiles, hooks };
}

/**
 * Full registry scan — combines global plugins + project-level items.
 */
function scanRegistry() {
  const global = scanGlobalPlugins();
  const project = scanProjectDirectories();

  return {
    plugins: global.plugins,
    commands: [...global.commands, ...project.commands],
    agents: [...global.agents, ...project.agents],
    mcpServers: project.mcpServers,
    claudeMdFiles: project.claudeMdFiles,
    hooks: project.hooks,
    scannedAt: new Date().toISOString(),
  };
}

module.exports = { scanRegistry };
