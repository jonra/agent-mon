// State
let registryData = null;
let allItems = [];
let expandedId = null;

// Init
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(currentTheme);
  loadRegistry();
  // Debounced search
  const searchInput = document.getElementById('search');
  let debounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(applyFilters, 150);
  });
});

async function loadRegistry() {
  const res = await fetch('/api/registry');
  registryData = await res.json();
  document.getElementById('loading').style.display = 'none';

  // Flatten all items into a unified list for search/filter
  allItems = [];

  for (const p of registryData.plugins) {
    allItems.push({ itemType: 'plugin', ...p });
  }
  for (const c of registryData.commands) {
    allItems.push({ itemType: 'command', ...c });
  }
  for (const a of registryData.agents) {
    allItems.push({ itemType: 'agent', ...a });
  }
  for (const m of registryData.mcpServers) {
    allItems.push({ itemType: 'mcp', ...m });
  }
  for (const c of registryData.claudeMdFiles) {
    allItems.push({ itemType: 'claudemd', name: c.projectLabel, ...c });
  }

  // Populate source dropdown
  const sourceSelect = document.getElementById('filter-source');
  const sources = new Set();
  for (const item of allItems) {
    if (item.source?.type === 'plugin') sources.add('plugin:' + item.source.marketplace);
    if (item.source?.type === 'project') sources.add('project:' + item.source.projectLabel);
    if (item.itemType === 'plugin') sources.add('plugin:' + item.marketplace);
    if (item.itemType === 'claudemd') sources.add('project:' + item.projectLabel);
  }
  for (const src of [...sources].sort()) {
    const opt = document.createElement('option');
    opt.value = src;
    opt.textContent = src.replace('plugin:', '').replace('project:', '');
    sourceSelect.appendChild(opt);
  }

  renderStats();
  applyFilters();
}

function renderStats() {
  const stats = document.getElementById('stats');
  while (stats.firstChild) stats.removeChild(stats.firstChild);

  const counts = [
    ['Plugins', registryData.plugins.length, 'blue'],
    ['Commands', registryData.commands.length, 'purple'],
    ['Agents', registryData.agents.length, 'orange'],
    ['MCP Servers', registryData.mcpServers.length, 'green'],
    ['CLAUDE.md', registryData.claudeMdFiles.length, 'blue'],
  ];

  for (const [label, count, color] of counts) {
    const card = el('div', 'metric-card metric-' + color);
    const v = el('div', 'metric-value');
    v.textContent = count;
    const l = el('div', 'metric-label');
    l.textContent = label;
    card.appendChild(v);
    card.appendChild(l);
    stats.appendChild(card);
  }
}

function applyFilters() {
  const query = document.getElementById('search').value.toLowerCase();
  const typeFilter = document.getElementById('filter-type').value;
  const sourceFilter = document.getElementById('filter-source').value;

  const filtered = allItems.filter(item => {
    // Type filter
    if (typeFilter && item.itemType !== typeFilter) return false;

    // Source filter
    if (sourceFilter) {
      const [sType, sVal] = sourceFilter.split(':');
      if (sType === 'plugin') {
        const itemMkt = item.source?.marketplace || item.marketplace || '';
        if (itemMkt !== sVal) return false;
      } else if (sType === 'project') {
        const itemProj = item.source?.projectLabel || item.projectLabel || '';
        if (itemProj !== sVal) return false;
      }
    }

    // Search
    if (query) {
      const searchable = [
        item.name, item.title, item.description, item.preview,
        item.source?.marketplace, item.source?.projectLabel,
        item.marketplace, item.projectLabel, item.key,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!searchable.includes(query)) return false;
    }

    return true;
  });

  renderGrid(filtered);
}

function renderGrid(items) {
  const grid = document.getElementById('grid');
  while (grid.firstChild) grid.removeChild(grid.firstChild);

  if (items.length === 0) {
    const empty = el('div', 'registry-empty');
    empty.textContent = 'No items match your filters';
    grid.appendChild(empty);
    return;
  }

  for (const item of items) {
    grid.appendChild(renderCard(item));
  }
}

function renderCard(item) {
  const card = el('div', 'registry-card');
  const itemId = item.itemType + ':' + (item.key || item.name || item.filePath || Math.random());
  const isExpanded = expandedId === itemId;
  if (isExpanded) card.classList.add('registry-card-expanded');

  // Header row
  const header = el('div', 'registry-card-header');

  // Type badge
  const badge = el('span', 'registry-badge registry-badge-' + item.itemType);
  const badgeLabels = { plugin: 'PLUGIN', command: 'CMD', agent: 'AGENT', mcp: 'MCP', claudemd: 'CLAUDE.MD' };
  badge.textContent = badgeLabels[item.itemType] || item.itemType;
  header.appendChild(badge);

  // Status badges for plugins
  if (item.itemType === 'plugin') {
    if (item.enabled) {
      const en = el('span', 'registry-status registry-status-enabled');
      en.textContent = 'Enabled';
      header.appendChild(en);
    }
    if (item.blocked) {
      const bl = el('span', 'registry-status registry-status-blocked');
      bl.textContent = 'Blocked';
      header.appendChild(bl);
    }
  }

  card.appendChild(header);

  // Name
  const name = el('div', 'registry-card-name');
  name.textContent = item.title || item.name || '';
  card.appendChild(name);

  // Description
  const desc = el('div', 'registry-card-desc');
  if (item.itemType === 'plugin') {
    desc.textContent = item.description || '';
  } else if (item.itemType === 'command' || item.itemType === 'agent') {
    desc.textContent = item.description || item.body?.substring(0, 150) || '';
  } else if (item.itemType === 'mcp') {
    desc.textContent = (item.type === 'stdio' ? 'Command: ' + item.command : 'URL: ' + (item.url || ''));
  } else if (item.itemType === 'claudemd') {
    desc.textContent = item.preview?.substring(0, 150) || '';
  }
  card.appendChild(desc);

  // Meta row
  const meta = el('div', 'registry-card-meta');

  // Source
  const sourceTag = el('span', 'registry-tag');
  if (item.source?.type === 'plugin') {
    sourceTag.textContent = item.source.marketplace;
    sourceTag.classList.add('registry-tag-plugin');
  } else if (item.source?.type === 'project') {
    sourceTag.textContent = item.source.projectLabel;
    sourceTag.classList.add('registry-tag-project');
  } else if (item.itemType === 'plugin') {
    sourceTag.textContent = item.marketplace;
    sourceTag.classList.add('registry-tag-plugin');
  } else if (item.itemType === 'claudemd') {
    sourceTag.textContent = item.projectLabel;
    sourceTag.classList.add('registry-tag-project');
  }
  meta.appendChild(sourceTag);

  // Version for plugins
  if (item.itemType === 'plugin' && item.version) {
    const ver = el('span', 'registry-tag');
    ver.textContent = 'v' + item.version;
    meta.appendChild(ver);
  }

  // Scope for plugins
  if (item.itemType === 'plugin') {
    const scope = el('span', 'registry-tag');
    scope.textContent = item.scope;
    meta.appendChild(scope);
  }

  // Argument hint for commands
  if (item.argumentHint) {
    const hint = el('span', 'registry-tag registry-tag-hint');
    hint.textContent = item.argumentHint;
    hint.title = item.argumentHint;
    meta.appendChild(hint);
  }

  card.appendChild(meta);

  // Expanded details
  if (isExpanded) {
    const details = el('div', 'registry-card-details');

    if (item.itemType === 'plugin') {
      if (item.projects?.length) {
        const proj = el('div', 'registry-detail-row');
        proj.textContent = 'Projects: ' + item.projects.map(p => p.split('/').slice(-2).join('/')).join(', ');
        details.appendChild(proj);
      }
      const counts = el('div', 'registry-detail-row');
      counts.textContent = item.commandCount + ' commands, ' + item.agentCount + ' agents';
      details.appendChild(counts);
    }

    if (item.body) {
      const body = el('pre', 'registry-detail-body');
      body.textContent = item.body;
      details.appendChild(body);
    }

    if (item.itemType === 'claudemd' && item.preview) {
      const body = el('pre', 'registry-detail-body');
      body.textContent = item.preview;
      details.appendChild(body);
    }

    if (item.itemType === 'claudemd') {
      const info = el('div', 'registry-detail-row');
      info.textContent = item.lineCount + ' lines';
      details.appendChild(info);
    }

    card.appendChild(details);
  }

  // Click to expand/collapse
  card.addEventListener('click', () => {
    expandedId = expandedId === itemId ? null : itemId;
    applyFilters(); // re-render
  });

  return card;
}

// View toggle (grid vs tree)
let viewMode = 'grid';

function toggleView() {
  viewMode = viewMode === 'grid' ? 'tree' : 'grid';
  const btn = document.getElementById('btn-view');
  btn.textContent = viewMode === 'grid' ? 'Tree' : 'Grid';
  btn.classList.toggle('active', viewMode === 'tree');
  document.getElementById('grid').classList.toggle('hidden', viewMode === 'tree');
  document.getElementById('tree').classList.toggle('hidden', viewMode === 'grid');
  if (viewMode === 'tree') renderTree();
}

function renderTree() {
  const container = document.getElementById('tree');
  while (container.firstChild) container.removeChild(container.firstChild);
  if (!registryData) return;

  // --- Global section ---
  const globalSection = treeSection('Global', 'blue');

  // Global plugins (scope=user or enabled globally)
  const globalPlugins = registryData.plugins.filter(p => p.scope === 'user');
  if (globalPlugins.length) {
    const pluginsNode = treeGroup('Plugins', globalPlugins.length, 'blue');
    for (const p of globalPlugins) {
      const pNode = treeLeaf(p.name, 'PLUGIN', 'plugin', p.description);
      // Nested commands/agents for this plugin
      const pluginCmds = registryData.commands.filter(c => c.source?.pluginKey === p.key);
      const pluginAgts = registryData.agents.filter(a => a.source?.pluginKey === p.key);
      if (pluginCmds.length || pluginAgts.length) {
        const children = el('div', 'rtree-children');
        for (const cmd of pluginCmds) {
          children.appendChild(treeLeaf('/' + cmd.name, 'CMD', 'command', cmd.description));
        }
        for (const agt of pluginAgts) {
          children.appendChild(treeLeaf(agt.name, 'AGENT', 'agent', agt.title || ''));
        }
        pNode.appendChild(children);
      }
      pluginsNode.querySelector('.rtree-children').appendChild(pNode);
    }
    globalSection.querySelector('.rtree-children').appendChild(pluginsNode);
  }

  container.appendChild(globalSection);

  // --- Per-project sections ---
  // Collect all unique projects
  const projectMap = new Map(); // projectLabel → { commands, agents, mcpServers, claudeMd, hooks, plugins }

  // Project-scoped plugins
  for (const p of registryData.plugins.filter(p => p.scope === 'project')) {
    for (const projPath of p.projects) {
      const label = projPath.split('/').filter(Boolean).slice(-2).join('/');
      if (!projectMap.has(label)) projectMap.set(label, { commands: [], agents: [], mcpServers: [], claudeMd: null, hooks: [], plugins: [] });
      projectMap.get(label).plugins.push(p);
    }
  }

  // Project commands/agents
  for (const c of registryData.commands.filter(c => c.source?.type === 'project')) {
    const label = c.source.projectLabel;
    if (!projectMap.has(label)) projectMap.set(label, { commands: [], agents: [], mcpServers: [], claudeMd: null, hooks: [], plugins: [] });
    projectMap.get(label).commands.push(c);
  }
  for (const a of registryData.agents.filter(a => a.source?.type === 'project')) {
    const label = a.source.projectLabel;
    if (!projectMap.has(label)) projectMap.set(label, { commands: [], agents: [], mcpServers: [], claudeMd: null, hooks: [], plugins: [] });
    projectMap.get(label).agents.push(a);
  }

  // MCP servers
  for (const m of registryData.mcpServers) {
    const label = m.source?.projectLabel;
    if (!label) continue;
    if (!projectMap.has(label)) projectMap.set(label, { commands: [], agents: [], mcpServers: [], claudeMd: null, hooks: [], plugins: [] });
    projectMap.get(label).mcpServers.push(m);
  }

  // CLAUDE.md
  for (const c of registryData.claudeMdFiles) {
    if (!projectMap.has(c.projectLabel)) projectMap.set(c.projectLabel, { commands: [], agents: [], mcpServers: [], claudeMd: null, hooks: [], plugins: [] });
    projectMap.get(c.projectLabel).claudeMd = c;
  }

  // Hooks
  for (const h of registryData.hooks) {
    const label = h.source?.projectLabel;
    if (!label) continue;
    if (!projectMap.has(label)) projectMap.set(label, { commands: [], agents: [], mcpServers: [], claudeMd: null, hooks: [], plugins: [] });
    projectMap.get(label).hooks.push(h);
  }

  // Render each project
  const sortedProjects = [...projectMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [label, data] of sortedProjects) {
    const totalItems = data.commands.length + data.agents.length + data.mcpServers.length
      + data.hooks.length + data.plugins.length + (data.claudeMd ? 1 : 0);

    const section = treeSection(label, 'green');
    const sectionChildren = section.querySelector('.rtree-children');

    // Project plugins
    if (data.plugins.length) {
      const group = treeGroup('Plugins', data.plugins.length, 'blue');
      const groupChildren = group.querySelector('.rtree-children');
      for (const p of data.plugins) {
        const leaf = treeLeaf(p.name, 'PLUGIN', 'plugin', p.enabled ? 'Enabled' : '');
        // Nested commands/agents
        const pluginCmds = registryData.commands.filter(c => c.source?.pluginKey === p.key);
        const pluginAgts = registryData.agents.filter(a => a.source?.pluginKey === p.key);
        if (pluginCmds.length || pluginAgts.length) {
          const children = el('div', 'rtree-children');
          for (const cmd of pluginCmds) children.appendChild(treeLeaf('/' + cmd.name, 'CMD', 'command', cmd.description));
          for (const agt of pluginAgts) children.appendChild(treeLeaf(agt.name, 'AGENT', 'agent', agt.title || ''));
          leaf.appendChild(children);
        }
        groupChildren.appendChild(leaf);
      }
      sectionChildren.appendChild(group);
    }

    // Commands
    if (data.commands.length) {
      const group = treeGroup('Commands', data.commands.length, 'purple');
      const groupChildren = group.querySelector('.rtree-children');
      for (const c of data.commands) {
        groupChildren.appendChild(treeLeaf('/' + c.name, 'CMD', 'command', c.description || c.title || ''));
      }
      sectionChildren.appendChild(group);
    }

    // Agents
    if (data.agents.length) {
      const group = treeGroup('Agents', data.agents.length, 'orange');
      const groupChildren = group.querySelector('.rtree-children');
      for (const a of data.agents) {
        groupChildren.appendChild(treeLeaf(a.name, 'AGENT', 'agent', a.title || a.description || ''));
      }
      sectionChildren.appendChild(group);
    }

    // MCP Servers
    if (data.mcpServers.length) {
      const group = treeGroup('MCP Servers', data.mcpServers.length, 'green');
      const groupChildren = group.querySelector('.rtree-children');
      for (const m of data.mcpServers) {
        const detail = m.type === 'stdio' ? m.command : m.url || '';
        groupChildren.appendChild(treeLeaf(m.name, 'MCP', 'mcp', detail));
      }
      sectionChildren.appendChild(group);
    }

    // Hooks
    if (data.hooks.length) {
      const group = treeGroup('Hooks', data.hooks.length, 'orange');
      const groupChildren = group.querySelector('.rtree-children');
      for (const h of data.hooks) {
        groupChildren.appendChild(treeLeaf(h.name, 'HOOK', 'hook', ''));
      }
      sectionChildren.appendChild(group);
    }

    // CLAUDE.md
    if (data.claudeMd) {
      const leaf = treeLeaf('CLAUDE.md', 'MD', 'claudemd', data.claudeMd.lineCount + ' lines');
      sectionChildren.appendChild(leaf);
    }

    container.appendChild(section);
  }
}

// Tree building helpers
function treeSection(label, color) {
  const wrapper = el('div', 'rtree-section');
  const row = el('div', 'rtree-section-row');

  const toggle = el('span', 'rtree-toggle');
  toggle.textContent = '\u25BE';

  const dot = el('span', 'rtree-dot rtree-dot-' + color);

  const name = el('span', 'rtree-section-label');
  name.textContent = label;

  row.appendChild(toggle);
  row.appendChild(dot);
  row.appendChild(name);

  const children = el('div', 'rtree-children');

  toggle.addEventListener('click', () => {
    const hidden = children.classList.toggle('hidden');
    toggle.textContent = hidden ? '\u25B8' : '\u25BE';
  });

  wrapper.appendChild(row);
  wrapper.appendChild(children);
  return wrapper;
}

function treeGroup(label, count, color) {
  const wrapper = el('div', 'rtree-group');
  const row = el('div', 'rtree-group-row');

  const toggle = el('span', 'rtree-toggle');
  toggle.textContent = '\u25BE';

  const badge = el('span', 'rtree-group-badge rtree-group-badge-' + color);
  badge.textContent = label;

  const countEl = el('span', 'rtree-count');
  countEl.textContent = count;

  row.appendChild(toggle);
  row.appendChild(badge);
  row.appendChild(countEl);

  const children = el('div', 'rtree-children');

  toggle.addEventListener('click', () => {
    const hidden = children.classList.toggle('hidden');
    toggle.textContent = hidden ? '\u25B8' : '\u25BE';
  });

  wrapper.appendChild(row);
  wrapper.appendChild(children);
  return wrapper;
}

function treeLeaf(name, badgeText, badgeType, detail) {
  const wrapper = el('div', 'rtree-leaf');
  const row = el('div', 'rtree-leaf-row');

  const hasChildren = false; // set externally if needed
  const indent = el('span', 'rtree-indent');

  const badge = el('span', 'registry-badge registry-badge-' + badgeType);
  badge.textContent = badgeText;

  const label = el('span', 'rtree-leaf-label');
  label.textContent = name;
  label.title = name;

  const meta = el('span', 'rtree-leaf-meta');
  meta.textContent = detail || '';
  meta.title = detail || '';

  row.appendChild(indent);
  row.appendChild(badge);
  row.appendChild(label);
  row.appendChild(meta);

  wrapper.appendChild(row);
  return wrapper;
}

// DOM helper
function el(tag, className) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

// Theme (shared logic with app.js, reads same localStorage key)
const THEMES = ['dark', 'light', 'claude'];
let currentTheme = localStorage.getItem('agent-mon-theme') || 'dark';

function applyTheme(theme) {
  document.documentElement.classList.remove('light', 'claude');
  if (theme !== 'dark') document.documentElement.classList.add(theme);
  const btn = document.getElementById('btn-theme');
  const nextIdx = (THEMES.indexOf(theme) + 1) % THEMES.length;
  const labels = { dark: 'Dark', light: 'Light', claude: 'Claude' };
  btn.textContent = labels[THEMES[nextIdx]];
  btn.classList.toggle('active', theme !== 'dark');
}

function toggleTheme() {
  const nextIdx = (THEMES.indexOf(currentTheme) + 1) % THEMES.length;
  currentTheme = THEMES[nextIdx];
  localStorage.setItem('agent-mon-theme', currentTheme);
  applyTheme(currentTheme);
}
