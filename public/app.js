// State
let simulation = null;
let svg = null;
let g = null; // zoom group
let graphData = { nodes: [], edges: [] };
let showTools = true;
let activeOnly = false;
let selectedNodeId = null;

// Init
document.addEventListener('DOMContentLoaded', () => {
  initGraph();
  loadGraph();
  loadSummary();
  initSSE();
});

function initGraph() {
  const container = document.getElementById('graph-container');
  const rect = container.getBoundingClientRect();

  svg = d3.select('#graph-container')
    .append('svg')
    .attr('width', rect.width)
    .attr('height', rect.height);

  // Zoom group
  g = svg.append('g');

  // Zoom behavior
  const zoom = d3.zoom()
    .scaleExtent([0.1, 4])
    .on('zoom', (event) => {
      g.attr('transform', event.transform);
    });

  svg.call(zoom);

  // Handle resize
  window.addEventListener('resize', () => {
    const r = container.getBoundingClientRect();
    svg.attr('width', r.width).attr('height', r.height);
    if (simulation) {
      simulation.force('center', d3.forceCenter(r.width / 2, r.height / 2));
      simulation.alpha(0.1).restart();
    }
  });

  document.getElementById('loading').style.display = 'none';
}

async function loadGraph() {
  const params = new URLSearchParams();
  params.set('tools', showTools);
  params.set('maxSessions', '15');

  const res = await fetch(`/api/graph?${params}`);
  graphData = await res.json();

  if (activeOnly) {
    graphData = filterActive(graphData);
  }

  renderGraph(graphData);
}

async function loadSummary() {
  const res = await fetch('/api/summary');
  const data = await res.json();
  document.getElementById('stat-active').textContent = data.activeSessions;
  document.getElementById('stat-processes').textContent = data.activeProcesses;
  document.getElementById('stat-total').textContent = data.totalSessions;
  document.getElementById('stat-projects').textContent = data.totalProjects;
}

function filterActive(data) {
  const activeNodes = new Set();

  // Find active sessions and their connected nodes
  for (const node of data.nodes) {
    if (node.type === 'session' && node.active) {
      activeNodes.add(node.id);
    }
    if (node.type === 'project') {
      const hasActive = data.edges.some(e =>
        e.source === node.id &&
        data.nodes.find(n => n.id === e.target)?.active
      );
      if (hasActive) activeNodes.add(node.id);
    }
  }

  // Add subagents and tools connected to active sessions
  for (const edge of data.edges) {
    const sourceId = typeof edge.source === 'object' ? edge.source.id : edge.source;
    const targetId = typeof edge.target === 'object' ? edge.target.id : edge.target;
    if (activeNodes.has(sourceId)) activeNodes.add(targetId);
    if (activeNodes.has(targetId)) activeNodes.add(sourceId);
  }

  return {
    nodes: data.nodes.filter(n => activeNodes.has(n.id)),
    edges: data.edges.filter(e => {
      const sId = typeof e.source === 'object' ? e.source.id : e.source;
      const tId = typeof e.target === 'object' ? e.target.id : e.target;
      return activeNodes.has(sId) && activeNodes.has(tId);
    }),
  };
}

function renderGraph(data) {
  const container = document.getElementById('graph-container');
  const rect = container.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;

  // Clear previous
  g.selectAll('*').remove();

  if (data.nodes.length === 0) {
    g.append('text')
      .attr('x', width / 2)
      .attr('y', height / 2)
      .attr('text-anchor', 'middle')
      .attr('fill', '#6b7280')
      .text(activeOnly ? 'No active sessions' : 'No sessions found');
    return;
  }

  // Create simulation
  simulation = d3.forceSimulation(data.nodes)
    .force('link', d3.forceLink(data.edges)
      .id(d => d.id)
      .distance(d => {
        if (d.type === 'has-session') return 80;
        if (d.type === 'spawned') return 50;
        if (d.type === 'uses-tool') return 60;
        return 70;
      })
    )
    .force('charge', d3.forceManyBody()
      .strength(d => {
        if (d.type === 'project') return -300;
        if (d.type === 'tool') return -30;
        return -120;
      })
    )
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide(d => d.size + 4));

  // Links
  const linkGroup = g.append('g');
  const link = linkGroup
    .selectAll('line')
    .data(data.edges)
    .join('line')
    .attr('class', d => {
      const sourceNode = data.nodes.find(n => n.id === (typeof d.source === 'object' ? d.source.id : d.source));
      if (sourceNode?.active) return 'link link-active link-flowing';
      if (d.connectedToActive) return 'link link-connected';
      return 'link link-dim';
    })
    .attr('stroke-width', d => {
      const sourceNode = data.nodes.find(n => n.id === (typeof d.source === 'object' ? d.source.id : d.source));
      if (sourceNode?.active) return 2;
      if (d.connectedToActive) return 1.5;
      return 1;
    });

  // Flowing particles on active edges
  const activeEdges = data.edges.filter(d => {
    const sourceNode = data.nodes.find(n => n.id === (typeof d.source === 'object' ? d.source.id : d.source));
    return sourceNode?.active || d.connectedToActive;
  });

  const particleGroup = g.append('g').attr('class', 'particles');
  const particles = particleGroup.selectAll('circle')
    .data(activeEdges)
    .join('circle')
    .attr('r', 2)
    .attr('fill', d => {
      const sourceNode = data.nodes.find(n => n.id === (typeof d.source === 'object' ? d.source.id : d.source));
      return sourceNode?.active ? '#50c878' : 'rgba(80, 200, 120, 0.5)';
    })
    .attr('opacity', 0);

  // Animate particles along edges
  function animateParticles() {
    particles.each(function(d) {
      const particle = d3.select(this);
      const delay = Math.random() * 2000;
      function flow() {
        particle
          .attr('opacity', 0)
          .transition()
          .delay(delay)
          .duration(0)
          .attr('opacity', 0.8)
          .transition()
          .duration(1200 + Math.random() * 800)
          .ease(d3.easeLinear)
          .attrTween('cx', function() {
            return function(t) {
              return d.source.x + (d.target.x - d.source.x) * t;
            };
          })
          .attrTween('cy', function() {
            return function(t) {
              return d.source.y + (d.target.y - d.source.y) * t;
            };
          })
          .attr('opacity', 0)
          .on('end', flow);
      }
      flow();
    });
  }
  if (activeEdges.length > 0) animateParticles();

  // Nodes
  const node = g.append('g')
    .selectAll('g')
    .data(data.nodes)
    .join('g')
    .attr('class', d => {
      if (d.active) return 'node node-active';
      if (d.connectedToActive) return 'node node-connected node-connected-' + d.type;
      return 'node node-dim';
    })
    .call(d3.drag()
      .on('start', dragStarted)
      .on('drag', dragged)
      .on('end', dragEnded)
    );

  // Node circles
  node.append('circle')
    .attr('r', d => d.size)
    .attr('fill', d => d.color)
    .attr('stroke', d => selectedNodeId === d.id ? 'var(--text)' : 'none')
    .attr('stroke-width', 2)
    .attr('opacity', d => {
      if (d.active || d.connectedToActive) return 1;
      return 0.3;
    });

  // Labels for projects, active sessions, and all connected nodes
  node.filter(d => d.type === 'project' || d.active || d.connectedToActive)
    .append('text')
    .attr('class', 'node-label')
    .attr('dy', d => d.size + 14)
    .text(d => truncate(d.label, 25));

  // Hover tooltip
  const tooltip = document.getElementById('tooltip');
  const tooltipLabel = document.getElementById('tooltip-label');
  const tooltipMeta = document.getElementById('tooltip-meta');

  node.on('mouseenter', (event, d) => {
    tooltipLabel.textContent = d.label;
    tooltipMeta.textContent = getTooltipMeta(d);
    tooltip.classList.add('visible');
  })
  .on('mousemove', (event) => {
    tooltip.style.left = (event.clientX + 12) + 'px';
    tooltip.style.top = (event.clientY - 10) + 'px';
  })
  .on('mouseleave', () => {
    tooltip.classList.remove('visible');
  });

  // Click to show detail
  node.on('click', (event, d) => {
    selectedNodeId = d.id;
    // Update selection visual
    g.selectAll('circle')
      .attr('stroke', n => n.id === d.id ? 'var(--text)' : 'none');

    if (d.type === 'session') {
      htmx.ajax('GET', `/api/session/${encodeURIComponent(d.sessionId)}`, '#detail-panel');
    } else {
      showNodeDetail(d);
    }
  });

  // Tick
  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });
}

/**
 * Build detail panel for non-session nodes using safe DOM methods.
 */
function showNodeDetail(d) {
  const panel = document.getElementById('detail-panel');
  // Clear panel safely
  while (panel.firstChild) panel.removeChild(panel.firstChild);

  const card = document.createElement('div');
  card.className = 'detail-card';

  const status = document.createElement('div');
  status.className = 'detail-status';
  status.style.color = d.color;
  status.textContent = d.type.toUpperCase();
  card.appendChild(status);

  const title = document.createElement('h3');
  title.textContent = d.label;
  card.appendChild(title);

  if (d.type === 'project') {
    addDetailField(card, 'Path', d.fullPath || '', true);
    addDetailField(card, 'Sessions', String(d.sessionCount || 0));
  }

  if (d.type === 'subagent') {
    addDetailField(card, 'Agent Type', d.agentType || '');
  }

  if (d.type === 'tool') {
    addDetailField(card, 'Type', 'Built-in Tool');
  }

  panel.appendChild(card);
}

function addDetailField(parent, label, value, mono) {
  const field = document.createElement('div');
  field.className = 'detail-field';

  const labelEl = document.createElement('span');
  labelEl.className = 'field-label';
  labelEl.textContent = label;

  const valueEl = document.createElement('span');
  valueEl.className = 'field-value' + (mono ? ' mono' : '');
  valueEl.textContent = value;

  field.appendChild(labelEl);
  field.appendChild(valueEl);
  parent.appendChild(field);
}

function getTooltipMeta(d) {
  switch (d.type) {
    case 'project': return `${d.sessionCount} sessions`;
    case 'session': {
      const parts = [];
      if (d.model) parts.push(d.model.replace('claude-', ''));
      if (d.messageCount) parts.push(`${d.messageCount} msgs`);
      if (d.active) parts.push('ACTIVE');
      return parts.join(' | ');
    }
    case 'subagent': return d.agentType;
    case 'tool': return 'Tool';
    default: return '';
  }
}

// Drag handlers
function dragStarted(event, d) {
  if (!event.active) simulation.alphaTarget(0.3).restart();
  d.fx = d.x;
  d.fy = d.y;
}

function dragged(event, d) {
  d.fx = event.x;
  d.fy = event.y;
}

function dragEnded(event, d) {
  if (!event.active) simulation.alphaTarget(0);
  d.fx = null;
  d.fy = null;
}

// Controls
function toggleTools() {
  showTools = !showTools;
  document.getElementById('btn-tools').classList.toggle('active', showTools);
  loadGraph();
}

function toggleActiveOnly() {
  activeOnly = !activeOnly;
  document.getElementById('btn-active-only').classList.toggle('active', activeOnly);
  loadGraph();
}

function refreshGraph() {
  loadGraph();
  loadSummary();
}

// SSE real-time updates
function initSSE() {
  const source = new EventSource('/events');

  source.addEventListener('graph-update', (e) => {
    let data = JSON.parse(e.data);
    graphData = data;
    if (activeOnly) data = filterActive(data);
    if (treeVisible) {
      renderTree(data);
    } else {
      renderGraph(data);
    }
    loadSummary();
  });

  source.addEventListener('process-status', (e) => {
    loadSummary();
    loadGraph();
  });

  source.onerror = () => {
    console.warn('SSE connection lost, retrying...');
  };
}

// Metrics dashboard
let metricsVisible = false;

// Tree view
let treeVisible = false;

function toggleTreeView() {
  treeVisible = !treeVisible;
  const treeContainer = document.getElementById('tree-container');
  const graphContainer = document.getElementById('graph-container');
  const btn = document.getElementById('btn-tree');
  treeContainer.classList.toggle('hidden', !treeVisible);
  graphContainer.classList.toggle('hidden', treeVisible);
  btn.classList.toggle('active', treeVisible);
  if (treeVisible) renderTree(graphData);
}

function renderTree(data) {
  const container = document.getElementById('tree-container');
  while (container.firstChild) container.removeChild(container.firstChild);

  // Build hierarchy: projects → sessions → (subagents + tools)
  const nodeMap = new Map(data.nodes.map(n => [n.id, n]));
  const children = new Map(); // parentId → [childNode]

  for (const edge of data.edges) {
    const srcId = typeof edge.source === 'object' ? edge.source.id : edge.source;
    const tgtId = typeof edge.target === 'object' ? edge.target.id : edge.target;
    if (!children.has(srcId)) children.set(srcId, []);
    children.get(srcId).push(nodeMap.get(tgtId));
  }

  // Find root project nodes
  const projects = data.nodes.filter(n => n.type === 'project');
  if (projects.length === 0) {
    const empty = el('div', 'tree-empty');
    empty.textContent = 'No data';
    container.appendChild(empty);
    return;
  }

  for (const proj of projects) {
    container.appendChild(buildTreeNode(proj, children, 0));
  }
}

function buildTreeNode(node, childrenMap, depth) {
  const kids = childrenMap.get(node.id) || [];
  const hasKids = kids.length > 0;
  const isExpanded = depth < 2 || node.active || node.connectedToActive;

  const wrapper = el('div', 'tree-item');

  const row = el('div', 'tree-row');
  row.style.paddingLeft = (depth * 20 + 8) + 'px';

  // Expand toggle
  const toggle = el('span', 'tree-toggle');
  if (hasKids) {
    toggle.textContent = isExpanded ? '\u25BE' : '\u25B8';
    toggle.addEventListener('click', () => {
      const childContainer = wrapper.querySelector('.tree-children');
      if (!childContainer) return;
      const visible = !childContainer.classList.contains('hidden');
      childContainer.classList.toggle('hidden', visible);
      toggle.textContent = visible ? '\u25B8' : '\u25BE';
    });
  } else {
    toggle.textContent = ' ';
  }
  row.appendChild(toggle);

  // Color dot
  const dot = el('span', 'tree-dot');
  dot.style.background = node.color;
  if (node.active) dot.classList.add('tree-dot-active');
  row.appendChild(dot);

  // Type badge
  const badge = el('span', 'tree-badge tree-badge-' + node.type);
  const badgeLabels = { project: 'PRJ', session: 'SES', subagent: 'AGT', tool: 'TL' };
  badge.textContent = badgeLabels[node.type] || node.type;
  row.appendChild(badge);

  // Label
  const label = el('span', 'tree-label');
  label.textContent = node.label || node.id;
  label.title = node.label || node.id;
  row.appendChild(label);

  // Meta info
  const meta = el('span', 'tree-meta');
  if (node.type === 'project') {
    meta.textContent = (node.sessionCount || 0) + ' sessions';
  } else if (node.type === 'session') {
    const parts = [];
    if (node.active) parts.push('ACTIVE');
    if (node.model) parts.push(node.model.replace('claude-', ''));
    if (node.messageCount) parts.push(node.messageCount + ' msgs');
    meta.textContent = parts.join(' | ');
    if (node.active) meta.classList.add('tree-meta-active');
  } else if (node.type === 'subagent') {
    meta.textContent = node.agentType || '';
  }
  row.appendChild(meta);

  // Click to show detail
  row.addEventListener('click', (e) => {
    if (e.target === toggle) return;
    selectedNodeId = node.id;
    // Highlight
    document.querySelectorAll('.tree-row-selected').forEach(r => r.classList.remove('tree-row-selected'));
    row.classList.add('tree-row-selected');
    if (node.type === 'session' && node.sessionId) {
      htmx.ajax('GET', '/api/session/' + encodeURIComponent(node.sessionId), '#detail-panel');
    } else {
      showNodeDetail(node);
    }
  });

  wrapper.appendChild(row);

  // Children
  if (hasKids) {
    // Sort: active sessions first, then by type
    const sortOrder = { session: 0, subagent: 1, tool: 2 };
    kids.sort((a, b) => {
      if (a.active && !b.active) return -1;
      if (!a.active && b.active) return 1;
      return (sortOrder[a.type] || 3) - (sortOrder[b.type] || 3);
    });

    const childContainer = el('div', 'tree-children');
    if (!isExpanded) childContainer.classList.add('hidden');
    for (const child of kids) {
      childContainer.appendChild(buildTreeNode(child, childrenMap, depth + 1));
    }
    wrapper.appendChild(childContainer);
  }

  return wrapper;
}

// Theme toggle
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

// Apply saved theme on load
applyTheme(currentTheme);

function toggleMetrics() {
  metricsVisible = !metricsVisible;
  const overlay = document.getElementById('metrics-overlay');
  const btn = document.getElementById('btn-metrics');
  overlay.classList.toggle('hidden', !metricsVisible);
  btn.classList.toggle('active', metricsVisible);
  if (metricsVisible) loadMetrics();
}

async function loadMetrics() {
  const body = document.getElementById('metrics-body');
  while (body.firstChild) body.removeChild(body.firstChild);
  const loadingEl = el('div', 'metrics-loading');
  loadingEl.textContent = 'Loading metrics...';
  body.appendChild(loadingEl);

  const res = await fetch('/api/metrics');
  const m = await res.json();
  renderMetrics(m);
}

function renderMetrics(m) {
  const body = document.getElementById('metrics-body');
  while (body.firstChild) body.removeChild(body.firstChild);

  const container = el('div', 'metrics-grid');

  // --- Summary Cards ---
  const totalTokens = m.totals.inputTokens + m.totals.outputTokens;
  const summaryRow = el('div', 'metrics-cards');
  summaryRow.appendChild(metricCard('Total Tokens', fmtTokens(totalTokens), 'green'));
  summaryRow.appendChild(metricCard('Input Tokens', fmtTokens(m.totals.inputTokens), 'blue'));
  summaryRow.appendChild(metricCard('Output Tokens', fmtTokens(m.totals.outputTokens), 'purple'));
  summaryRow.appendChild(metricCard('Cache Hit Rate', (m.cacheHitRate * 100).toFixed(1) + '%', 'green'));
  summaryRow.appendChild(metricCard('Tool Calls', m.totals.toolCalls.toLocaleString(), 'orange'));
  summaryRow.appendChild(metricCard('Sessions', m.totals.sessions.toLocaleString(), 'blue'));
  container.appendChild(summaryRow);

  // --- Tool Usage Breakdown ---
  const toolEntries = Object.entries(m.toolBreakdown).sort((a, b) => b[1] - a[1]);
  if (toolEntries.length) {
    const toolSection = el('div', 'metrics-section');
    toolSection.appendChild(sectionTitle('Tool Usage'));
    const maxToolCount = toolEntries[0][1];
    const toolList = el('div', 'metrics-bar-list');
    for (const [tool, count] of toolEntries.slice(0, 12)) {
      toolList.appendChild(barRow(tool, String(count), count / maxToolCount, 'var(--purple)'));
    }
    toolSection.appendChild(toolList);
    container.appendChild(toolSection);
  }

  // --- Tool Success Rates ---
  const sortedTools = Object.entries(m.toolSuccessRates)
    .sort((a, b) => (a[1].rate - b[1].rate) || ((b[1].success + b[1].failure) - (a[1].success + a[1].failure)));
  if (sortedTools.length) {
    const successSection = el('div', 'metrics-section');
    successSection.appendChild(sectionTitle('Tool Reliability'));
    const successList = el('div', 'metrics-bar-list');
    for (const [tool, c] of sortedTools.slice(0, 12)) {
      const pct = (c.rate * 100).toFixed(0);
      const color = c.rate >= 0.95 ? 'var(--green)' : c.rate >= 0.8 ? 'var(--orange)' : 'var(--red)';
      successList.appendChild(barRow(tool, pct + '% (' + c.failure + ' fails)', c.rate, color));
    }
    successSection.appendChild(successList);
    container.appendChild(successSection);
  }

  // --- Stop Reasons ---
  const stopEntries = Object.entries(m.stopReasons).sort((a, b) => b[1] - a[1]);
  if (stopEntries.length) {
    const stopSection = el('div', 'metrics-section');
    stopSection.appendChild(sectionTitle('Stop Reasons'));
    const stopList = el('div', 'metrics-bar-list');
    const maxStop = stopEntries[0][1];
    for (const [reason, count] of stopEntries) {
      const color = reason === 'end_turn' ? 'var(--green)' : reason === 'max_tokens' ? 'var(--red)' : 'var(--orange)';
      stopList.appendChild(barRow(reason, String(count), count / maxStop, color));
    }
    stopSection.appendChild(stopList);
    container.appendChild(stopSection);
  }

  // --- Model Usage ---
  const modelEntries = Object.entries(m.modelUsage).sort((a, b) => b[1] - a[1]);
  if (modelEntries.length) {
    const modelSection = el('div', 'metrics-section');
    modelSection.appendChild(sectionTitle('Model Usage'));
    const modelList = el('div', 'metrics-bar-list');
    const maxModel = modelEntries[0][1];
    for (const [model, count] of modelEntries) {
      const shortModel = model.replace('claude-', '').replace(/-\d{8}$/, '');
      modelList.appendChild(barRow(shortModel, count + ' sessions', count / maxModel, 'var(--blue)'));
    }
    modelSection.appendChild(modelList);
    container.appendChild(modelSection);
  }

  // --- Tokens by Project ---
  if (m.tokensByProject.length) {
    const tokSection = el('div', 'metrics-section');
    tokSection.appendChild(sectionTitle('Tokens by Project'));
    const tokList = el('div', 'metrics-bar-list');
    const maxTok = m.tokensByProject[0].tokens || 1;
    for (const p of m.tokensByProject.slice(0, 10)) {
      tokList.appendChild(barRow(p.project, fmtTokens(p.tokens), p.tokens / maxTok, 'var(--green)'));
    }
    tokSection.appendChild(tokList);
    container.appendChild(tokSection);
  }

  // --- Top Files ---
  if (m.topFiles.length) {
    const fileSection = el('div', 'metrics-section');
    fileSection.appendChild(sectionTitle('Most Accessed Files'));
    const fileList = el('div', 'metrics-bar-list');
    const maxFile = m.topFiles[0].count;
    for (const f of m.topFiles.slice(0, 10)) {
      const short = f.path.split('/').slice(-2).join('/');
      fileList.appendChild(barRow(short, f.count + 'x', f.count / maxFile, 'var(--blue)'));
    }
    fileSection.appendChild(fileList);
    container.appendChild(fileSection);
  }

  // --- Top Modified Files ---
  if (m.topModifiedFiles.length) {
    const modSection = el('div', 'metrics-section');
    modSection.appendChild(sectionTitle('Most Modified Files'));
    const modList = el('div', 'metrics-bar-list');
    const maxMod = m.topModifiedFiles[0].count;
    for (const f of m.topModifiedFiles.slice(0, 10)) {
      const short = f.path.split('/').slice(-2).join('/');
      modList.appendChild(barRow(short, f.count + 'x', f.count / maxMod, 'var(--orange)'));
    }
    modSection.appendChild(modList);
    container.appendChild(modSection);
  }

  // --- Top Sessions by Token Usage ---
  if (m.sessions.length) {
    const sessSection = el('div', 'metrics-section');
    sessSection.appendChild(sectionTitle('Heaviest Sessions'));
    const sessList = el('div', 'metrics-bar-list');
    const maxSessTok = m.sessions[0].totalTokens || 1;
    for (const s of m.sessions.filter(s => s.totalTokens > 0).slice(0, 10)) {
      const label = s.slug || s.sessionId.substring(0, 8);
      const detail = fmtTokens(s.totalTokens) + ' tok | ' + s.toolCalls + ' tools';
      sessList.appendChild(barRow(label, detail, s.totalTokens / maxSessTok, s.active ? 'var(--green)' : 'var(--text-muted)'));
    }
    sessSection.appendChild(sessList);
    container.appendChild(sessSection);
  }

  body.appendChild(container);
}

// DOM helpers for metrics
function el(tag, className) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function sectionTitle(text) {
  const h = el('h3', 'metrics-section-title');
  h.textContent = text;
  return h;
}

function metricCard(label, value, color) {
  const card = el('div', 'metric-card metric-' + color);
  const valEl = el('div', 'metric-value');
  valEl.textContent = value;
  const labEl = el('div', 'metric-label');
  labEl.textContent = label;
  card.appendChild(valEl);
  card.appendChild(labEl);
  return card;
}

function barRow(label, valueText, fraction, color) {
  const row = el('div', 'bar-row');
  const labelEl = el('span', 'bar-label');
  labelEl.textContent = label;
  labelEl.title = label;
  const barWrap = el('div', 'bar-wrap');
  const bar = el('div', 'bar-fill');
  bar.style.width = (Math.max(fraction, 0.02) * 100) + '%';
  bar.style.background = color;
  barWrap.appendChild(bar);
  const valEl = el('span', 'bar-value');
  valEl.textContent = valueText;
  row.appendChild(labelEl);
  row.appendChild(barWrap);
  row.appendChild(valEl);
  return row;
}

function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

// Utility
function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.substring(0, max) + '...' : str;
}
