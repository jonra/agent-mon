// ===== Lego City Workspace — Isometric 2.5D =====
// SimCity-style isometric view with project buildings, environmental features

const canvas = document.getElementById('workspace-canvas');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
const emptyState = document.getElementById('workspace-empty');
const workerCountEl = document.getElementById('worker-count');

// ===== Isometric Configuration =====
// 2:1 isometric: tile drawn as diamond, width = 2 * height
const TILE = 64;                 // base tile size in world units
const ISO_X_SCALE = 1.0;        // horizontal squeeze
const ISO_Y_SCALE = 0.5;        // vertical squeeze (creates the 2:1 diamond)
const ISO_ROTATE = Math.PI / 4; // 45° rotation

const DESK_WIDTH = 80;
const DESK_HEIGHT = 50;
const MINIFIG_SCALE = 2.5;
const FRAME_DURATION = 300; // slower frame changes = less visual jitter
const WALK_SPEED = 2.5;
const BUILDING_PADDING = 60;
const BUILDING_DESK_COLS = 3;
const BUILDING_DESK_SPACING_X = 280;
const BUILDING_DESK_SPACING_Y = 300;

// ===== World-to-Screen Projection =====
// Converts world (flat 2D layout) coords into isometric screen coords.
// World coords: regular x,y grid. Screen coords: isometric diamond view.
function worldToScreen(wx, wy) {
  // Rotate 45° then squash Y by 50%
  const rx = (wx - wy) * 0.866;   // cos(30°) ≈ 0.866
  const ry = (wx + wy) * 0.433;   // sin(30°) * stretch → 0.5 * cos(30°) ≈ 0.433
  return { x: rx, y: ry };
}

// ===== State =====
let workers = [];
let desks = [];   // world coords
let buildings = [];
let waterCooler = { wx: 0, wy: 0 };
let whiteboard = { wx: 0, wy: 0 };
let lastTime = 0;
let hoveredWorker = null;
let mouseX = 0, mouseY = 0;
let dpr = window.devicePixelRatio || 1;
let camX = 0, camY = 0; // camera offset (screen space)
let isDragging = false, dragStartX = 0, dragStartY = 0, camStartX = 0, camStartY = 0;

// Floor cache — avoids redrawing 100+ thin grid lines every frame
let floorCache = null;       // offscreen canvas
let floorCacheCamX = null;
let floorCacheCamY = null;
let floorCacheW = 0;
let floorCacheH = 0;

// Screen position cache (updated each frame)
function toScreen(wx, wy) {
  const iso = worldToScreen(wx, wy);
  return {
    x: iso.x + camX + (canvas.width / dpr) / 2,
    y: iso.y + camY + 120,
  };
}

// ===== Canvas Setup =====
function resizeCanvas() {
  const container = canvas.parentElement;
  const w = container.clientWidth;
  const h = container.clientHeight;
  dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  floorCache = null; // invalidate floor cache on resize
  rebuildLayout();
}
window.addEventListener('resize', resizeCanvas);

// ===== City Layout (in world coords) =====
function rebuildLayout() {
  const projectGroups = {};
  for (const w of workers) {
    const key = w.projectLabel || 'unknown';
    if (!projectGroups[key]) projectGroups[key] = [];
    projectGroups[key].push(w);
  }

  const projectNames = Object.keys(projectGroups);
  if (projectNames.length === 0) {
    projectNames.push('workspace');
    projectGroups['workspace'] = [];
  }

  buildings = [];
  desks = [];

  let buildingIndex = 0;
  for (const projectName of projectNames) {
    const projectWorkers = projectGroups[projectName];
    const deskCount = Math.max(projectWorkers.length, 2);
    const cols = Math.min(deskCount, BUILDING_DESK_COLS);
    const rows = Math.ceil(deskCount / cols);

    const bw = cols * BUILDING_DESK_SPACING_X + BUILDING_PADDING * 2;
    const bh = rows * BUILDING_DESK_SPACING_Y + BUILDING_PADDING * 2 + 40;

    // Stagger buildings diagonally in world space for nice iso layout
    const bx = buildingIndex * (bw + 120);
    const by = buildingIndex * 200;

    const buildingHue = hashCode(projectName) % 360;
    const buildingDesks = [];

    for (let i = 0; i < deskCount; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const desk = {
        wx: bx + BUILDING_PADDING + col * BUILDING_DESK_SPACING_X + 30,
        wy: by + BUILDING_PADDING + 50 + row * BUILDING_DESK_SPACING_Y,
        workerId: null,
        buildingIndex: buildings.length,
      };
      buildingDesks.push(desk);
      desks.push(desk);
    }

    buildings.push({
      projectLabel: projectName,
      wx: bx, wy: by, w: bw, h: bh,
      desks: buildingDesks,
      color: buildingHue,
    });
    buildingIndex++;
  }

  // Shared areas — positioned below/beside buildings in world space
  const maxWy = buildings.length > 0 ? Math.max(...buildings.map(b => b.wy + b.h)) + 80 : 300;
  waterCooler.wx = 50;
  waterCooler.wy = maxWy;
  whiteboard.wx = 350;
  whiteboard.wy = maxWy;

  // Assign workers to desks
  for (const worker of workers) {
    const building = buildings.find(b => b.projectLabel === (worker.projectLabel || 'workspace'));
    if (!building) continue;

    if (worker.sprite.deskIndex >= 0 && worker.sprite.deskIndex < desks.length) {
      const existingDesk = desks[worker.sprite.deskIndex];
      if (existingDesk.buildingIndex === buildings.indexOf(building)) {
        existingDesk.workerId = worker.id;
        continue;
      }
    }

    const freeDesk = building.desks.find(d => d.workerId === null);
    if (freeDesk) {
      const deskIdx = desks.indexOf(freeDesk);
      worker.sprite.deskIndex = deskIdx;
      freeDesk.workerId = worker.id;
      worker.sprite.targetWx = freeDesk.wx + DESK_WIDTH / 2;
      worker.sprite.targetWy = freeDesk.wy + DESK_HEIGHT + 25;
    }
  }
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

// ===== Sprite State =====
function createSprite(worker) {
  return {
    wx: 200, wy: 200,       // world position
    targetWx: 0, targetWy: 0,
    deskIndex: -1,
    animFrame: 0,
    animTimer: 0,
    state: worker.state || 'IDLE',
    prevState: null,
    spawnTimer: 0.5,
  };
}

// ===== Isometric Drawing Primitives =====

// Draw an isometric diamond (flat ground tile/surface)
function drawIsoDiamond(wx, wy, ww, wh, fillColor, strokeColor) {
  const tl = toScreen(wx, wy);
  const tr = toScreen(wx + ww, wy);
  const br = toScreen(wx + ww, wy + wh);
  const bl = toScreen(wx, wy + wh);

  ctx.fillStyle = fillColor;
  ctx.beginPath();
  ctx.moveTo(tl.x, tl.y);
  ctx.lineTo(tr.x, tr.y);
  ctx.lineTo(br.x, br.y);
  ctx.lineTo(bl.x, bl.y);
  ctx.closePath();
  ctx.fill();

  if (strokeColor) {
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// Draw an isometric box (3D extruded rectangle)
function drawIsoBox(wx, wy, ww, wh, height, topColor, leftColor, rightColor) {
  const tl = toScreen(wx, wy);
  const tr = toScreen(wx + ww, wy);
  const br = toScreen(wx + ww, wy + wh);
  const bl = toScreen(wx, wy + wh);

  // Offset top face by height
  const tlT = { x: tl.x, y: tl.y - height };
  const trT = { x: tr.x, y: tr.y - height };
  const brT = { x: br.x, y: br.y - height };
  const blT = { x: bl.x, y: bl.y - height };

  // Right face
  ctx.fillStyle = rightColor;
  ctx.beginPath();
  ctx.moveTo(tr.x, tr.y);
  ctx.lineTo(br.x, br.y);
  ctx.lineTo(brT.x, brT.y);
  ctx.lineTo(trT.x, trT.y);
  ctx.closePath();
  ctx.fill();

  // Left face
  ctx.fillStyle = leftColor;
  ctx.beginPath();
  ctx.moveTo(bl.x, bl.y);
  ctx.lineTo(br.x, br.y);
  ctx.lineTo(brT.x, brT.y);
  ctx.lineTo(blT.x, blT.y);
  ctx.closePath();
  ctx.fill();

  // Top face
  ctx.fillStyle = topColor;
  ctx.beginPath();
  ctx.moveTo(tlT.x, tlT.y);
  ctx.lineTo(trT.x, trT.y);
  ctx.lineTo(brT.x, brT.y);
  ctx.lineTo(blT.x, blT.y);
  ctx.closePath();
  ctx.fill();
}

// ===== Drawing: Isometric Floor =====
function drawFloorToCache() {
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;

  if (!floorCache) {
    floorCache = document.createElement('canvas');
  }
  floorCache.width = canvas.width;
  floorCache.height = canvas.height;
  const fctx = floorCache.getContext('2d');
  fctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const isDark = !document.documentElement.classList.contains('light');
  fctx.fillStyle = isDark ? '#0e1118' : '#e4e7ed';
  fctx.fillRect(0, 0, w, h);

  // Draw isometric grid with integer-snapped coordinates
  fctx.strokeStyle = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.05)';
  fctx.lineWidth = 1;
  const gridStep = 80;
  const gridRange = 2000;
  fctx.beginPath();
  for (let i = -gridRange; i <= gridRange; i += gridStep) {
    const a = toScreen(i, -gridRange);
    const b = toScreen(i, gridRange);
    fctx.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5);
    fctx.lineTo(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5);
    const c = toScreen(-gridRange, i);
    const d = toScreen(gridRange, i);
    fctx.moveTo(Math.round(c.x) + 0.5, Math.round(c.y) + 0.5);
    fctx.lineTo(Math.round(d.x) + 0.5, Math.round(d.y) + 0.5);
  }
  fctx.stroke();

  floorCacheCamX = camX;
  floorCacheCamY = camY;
  floorCacheW = canvas.width;
  floorCacheH = canvas.height;
}

function drawFloor() {
  // Only regenerate when camera moves or canvas resizes
  if (!floorCache ||
      floorCacheCamX !== camX ||
      floorCacheCamY !== camY ||
      floorCacheW !== canvas.width ||
      floorCacheH !== canvas.height) {
    drawFloorToCache();
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(floorCache, 0, 0);
  ctx.restore();
}

// ===== Drawing: Building =====
function drawBuilding(building) {
  const { wx: bx, wy: by, w: bw, h: bh, projectLabel, color } = building;
  const isDark = !document.documentElement.classList.contains('light');

  // Building floor as isometric box with low walls
  const wallHeight = 12;
  const topColor = isDark
    ? `hsla(${color}, 20%, 14%, 0.85)`
    : `hsla(${color}, 18%, 90%, 0.9)`;
  const leftColor = isDark
    ? `hsla(${color}, 22%, 10%, 0.7)`
    : `hsla(${color}, 15%, 80%, 0.7)`;
  const rightColor = isDark
    ? `hsla(${color}, 18%, 8%, 0.7)`
    : `hsla(${color}, 12%, 75%, 0.7)`;

  drawIsoBox(bx, by, bw, bh, wallHeight, topColor, leftColor, rightColor);

  // Border on top face
  const tl = toScreen(bx, by);
  const tr = toScreen(bx + bw, by);
  const br = toScreen(bx + bw, by + bh);
  const bl = toScreen(bx, by + bh);
  ctx.strokeStyle = isDark
    ? `hsla(${color}, 30%, 28%, 0.6)`
    : `hsla(${color}, 25%, 65%, 0.6)`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(tl.x, tl.y - wallHeight);
  ctx.lineTo(tr.x, tr.y - wallHeight);
  ctx.lineTo(br.x, br.y - wallHeight);
  ctx.lineTo(bl.x, bl.y - wallHeight);
  ctx.closePath();
  ctx.stroke();

  // Building label at the top-left corner of the top face
  const labelPos = toScreen(bx + 30, by + 10);
  ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  // Building icon (little house)
  const iconX = labelPos.x - 16;
  const iconY = labelPos.y - wallHeight - 2;
  ctx.fillStyle = `hsla(${color}, 50%, 55%, 0.7)`;
  ctx.fillRect(iconX, iconY + 3, 10, 8);
  ctx.beginPath();
  ctx.moveTo(iconX - 1, iconY + 3);
  ctx.lineTo(iconX + 5, iconY - 2);
  ctx.lineTo(iconX + 11, iconY + 3);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = isDark ? '#2a3a55' : '#c5d5e8';
  ctx.fillRect(iconX + 3, iconY + 5, 4, 3);

  ctx.fillStyle = isDark
    ? `hsla(${color}, 50%, 70%, 0.9)`
    : `hsla(${color}, 40%, 35%, 0.9)`;
  const label = projectLabel.length > 30 ? projectLabel.substring(0, 30) + '...' : projectLabel;
  ctx.fillText(label, labelPos.x, iconY);

  // Worker count
  const workerCount = building.desks.filter(d => d.workerId !== null).length;
  if (workerCount > 0) {
    const countPos = toScreen(bx + bw - 60, by + 10);
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillStyle = isDark ? 'rgba(80, 200, 120, 0.7)' : 'rgba(22, 163, 74, 0.8)';
    ctx.fillText(workerCount + ' active', countPos.x, countPos.y - wallHeight);
  }
}

// ===== Drawing: Desk (isometric) =====
function drawDesk(desk, worker) {
  const { wx, wy } = desk;
  const w = DESK_WIDTH;
  const h = DESK_HEIGHT;
  const isOccupied = worker !== null;
  const state = worker?.sprite?.state;
  const lastTool = worker?.lastTool;

  // Desk as isometric box
  const deskHeight = isOccupied ? 8 : 5;
  drawIsoBox(wx, wy, w, h, deskHeight,
    isOccupied ? 'hsl(30, 40%, 32%)' : 'hsl(30, 20%, 22%)',
    isOccupied ? 'hsl(30, 35%, 24%)' : 'hsl(30, 15%, 16%)',
    isOccupied ? 'hsl(30, 30%, 20%)' : 'hsl(30, 12%, 14%)',
  );

  // Monitor (drawn as small iso box on desk surface)
  const monWx = wx + w / 2 - 12;
  const monWy = wy + 5;
  const monW = 24;
  const monH = 8;
  const monHeight = isOccupied ? 16 : 10;

  // Monitor screen (front face = right side in iso)
  const monTR = toScreen(monWx + monW, monWy);
  const monBR = toScreen(monWx + monW, monWy + monH);
  ctx.fillStyle = isOccupied ? '#1a2332' : '#151a22';
  ctx.beginPath();
  ctx.moveTo(monTR.x, monTR.y - deskHeight - monHeight);
  ctx.lineTo(monBR.x, monBR.y - deskHeight - monHeight);
  ctx.lineTo(monBR.x, monBR.y - deskHeight);
  ctx.lineTo(monTR.x, monTR.y - deskHeight);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = isOccupied ? '#4a5568' : '#2a3040';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Monitor content on screen face
  if (isOccupied) {
    drawMonitorContentIso(monTR, monBR, monHeight, deskHeight, state, lastTool);
  }

  // Monitor top
  drawIsoBox(monWx, monWy, monW, monH, monHeight + deskHeight,
    '#3a3f4a', '#2a2f38', '#222630');

  // Stand
  const standPos = toScreen(wx + w / 2, wy + 10);
  ctx.fillStyle = '#4a5568';
  ctx.fillRect(standPos.x - 2, standPos.y - deskHeight, 4, deskHeight);

  // Keyboard area (flat on desk)
  const kbPos = toScreen(wx + w / 2 - 10, wy + h - 15);
  const kbPos2 = toScreen(wx + w / 2 + 10, wy + h - 15);
  const kbPos3 = toScreen(wx + w / 2 + 10, wy + h - 8);
  const kbPos4 = toScreen(wx + w / 2 - 10, wy + h - 8);
  ctx.fillStyle = isOccupied ? '#374151' : '#2a2f3a';
  ctx.beginPath();
  ctx.moveTo(kbPos.x, kbPos.y - deskHeight);
  ctx.lineTo(kbPos2.x, kbPos2.y - deskHeight);
  ctx.lineTo(kbPos3.x, kbPos3.y - deskHeight);
  ctx.lineTo(kbPos4.x, kbPos4.y - deskHeight);
  ctx.closePath();
  ctx.fill();

  // Desk props (drawn in screen space near desk)
  if (isOccupied) {
    const deskCenter = toScreen(wx + w / 2, wy + h / 2);
    drawDeskPropsIso(deskCenter.x, deskCenter.y - deskHeight, state, lastTool, worker);

    // Token meter
    const meterPos = toScreen(wx + w + 10, wy + h / 2);
    drawTokenMeter(meterPos.x, meterPos.y - deskHeight - 20, worker.totalTokens);

    // File cabinet
    const cabPos = toScreen(wx - 20, wy + h / 2);
    drawFileCabinet(cabPos.x, cabPos.y - deskHeight, worker.filesModified);
  }
}

// Monitor content on the isometric screen face
function drawMonitorContentIso(monTR, monBR, monHeight, deskH, state, lastTool) {
  // We draw content in the rectangular area of the monitor's right face
  const sx = monTR.x + 2;
  const sy = monTR.y - deskH - monHeight + 2;
  const sw = (monBR.x - monTR.x) - 4;
  const sh = monHeight - 4;

  if (sh < 2 || sw < 2) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(monTR.x + 1, monTR.y - deskH - monHeight + 1,
    monBR.x - monTR.x - 2, monHeight - 2);
  ctx.clip();

  if (state === 'CODING') {
    const colors = ['rgba(80, 200, 120, 0.7)', 'rgba(74, 158, 255, 0.6)', 'rgba(245, 158, 11, 0.6)'];
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(sx + 1, sy + 1 + i * 4, 3 + (i * 2), 2);
    }
  } else if (state === 'READING') {
    ctx.fillStyle = 'rgba(74, 158, 255, 0.3)';
    ctx.fillRect(sx, sy, sw, 3);
    ctx.fillStyle = 'rgba(209, 213, 219, 0.3)';
    ctx.fillRect(sx + 1, sy + 5, sw - 2, 1.5);
    ctx.fillRect(sx + 1, sy + 8, sw - 4, 1.5);
  } else if (state === 'THINKING') {
    const dotPhase = (Date.now() / 400) % 3;
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = `rgba(245, 158, 11, ${Math.floor(dotPhase) === i ? 0.8 : 0.2})`;
      ctx.beginPath();
      ctx.arc(sx + sw / 2 - 3 + i * 3, sy + sh / 2, 1, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (state === 'SPAWNING') {
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.4)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(sx + sw / 2, sy);
    ctx.lineTo(sx + sw / 2, sy + sh);
    ctx.stroke();
    const pulse = (Date.now() / 300) % 3;
    ctx.fillStyle = `rgba(80, 200, 120, ${0.3 + (pulse < 1 ? 0.4 : 0)})`;
    ctx.fillRect(sx + 1, sy + 2, 3, 1.5);
    ctx.fillRect(sx + sw / 2 + 1, sy + 2, 3, 1.5);
  } else if (state === 'WAITING') {
    if (Math.floor(Date.now() / 600) % 2 === 0) {
      ctx.fillStyle = 'rgba(167, 139, 250, 0.5)';
      ctx.fillRect(sx + sw / 2 - 1, sy + sh / 2 - 2, 2, 4);
    }
  }

  ctx.restore();
}

// ===== Desk Props (screen-space, near desk) =====
function drawDeskPropsIso(cx, cy, state, lastTool, worker) {
  if (state === 'IDLE' || state === 'WAITING') {
    drawCoffeeCup(cx + 30, cy + 5);
  }
  if (state === 'READING') {
    drawDocumentStack(cx - 35, cy + 5, lastTool);
  }
  if (lastTool === 'Bash' && (state === 'CODING' || state === 'SPAWNING')) {
    drawTerminalIcon(cx + 28, cy - 18);
  }
  if (lastTool === 'WebFetch' || lastTool === 'WebSearch') {
    drawGlobeIcon(cx + 28, cy - 18);
  }
  if (lastTool === 'Skill') {
    drawLightningIcon(cx - 30, cy - 18);
  }
}

// ===== Token Meter =====
function drawTokenMeter(x, y, totalTokens) {
  if (!totalTokens || totalTokens <= 0) return;
  const meterH = 28, meterW = 7;

  ctx.fillStyle = 'rgba(30, 30, 45, 0.6)';
  ctx.beginPath();
  ctx.roundRect(x, y, meterW, meterH, 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(100, 100, 130, 0.4)';
  ctx.lineWidth = 0.5;
  ctx.stroke();

  const logTokens = Math.log10(Math.max(totalTokens, 1));
  const fill = Math.min(1, Math.max(0, (logTokens - 3) / 3));
  const fillH = fill * (meterH - 2);

  let meterColor;
  if (fill < 0.4) meterColor = '#50c878';
  else if (fill < 0.7) meterColor = '#f59e0b';
  else meterColor = '#ef4444';

  ctx.fillStyle = meterColor;
  ctx.beginPath();
  ctx.roundRect(x + 1, y + meterH - 1 - fillH, meterW - 2, fillH, 1);
  ctx.fill();

  // Pulse glow
  if (fill > 0.05) {
    ctx.save();
    ctx.globalAlpha = 0.4 + Math.sin(Date.now() / 500) * 0.2;
    ctx.fillStyle = meterColor;
    ctx.fillRect(x + 1, y + meterH - 1 - fillH, meterW - 2, 2);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  ctx.font = '7px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(180, 180, 200, 0.6)';
  const label = totalTokens >= 1000000 ? (totalTokens / 1000000).toFixed(1) + 'M'
    : totalTokens >= 1000 ? Math.floor(totalTokens / 1000) + 'K'
    : String(totalTokens);
  ctx.fillText(label, x + meterW / 2, y + meterH + 9);
}

// ===== File Cabinet =====
function drawFileCabinet(x, y, filesModified) {
  const fileCount = filesModified ? filesModified.length : 0;
  if (fileCount === 0) return;

  const drawers = Math.min(fileCount, 5);
  const cabinetW = 12, drawerH = 5;
  const cabinetH = drawers * (drawerH + 1) + 4;
  const cy = y - cabinetH;

  ctx.fillStyle = '#5a5040';
  ctx.beginPath();
  ctx.roundRect(x, cy, cabinetW, cabinetH, 2);
  ctx.fill();
  ctx.strokeStyle = '#6a6050';
  ctx.lineWidth = 0.5;
  ctx.stroke();

  for (let i = 0; i < drawers; i++) {
    const dy = cy + 2 + i * (drawerH + 1);
    ctx.fillStyle = '#7a7060';
    ctx.fillRect(x + 1, dy, cabinetW - 2, drawerH);
    ctx.strokeStyle = '#8a8070';
    ctx.lineWidth = 0.3;
    ctx.strokeRect(x + 1, dy, cabinetW - 2, drawerH);
    ctx.fillStyle = '#aaa';
    ctx.fillRect(x + cabinetW / 2 - 2, dy + drawerH / 2 - 0.5, 4, 1);
  }

  // Top drawer peeking open
  const openAmount = 2 + Math.sin(Date.now() / 800) * 0.5;
  ctx.fillStyle = '#8a8070';
  ctx.fillRect(x + 1, cy + 2 - openAmount, cabinetW - 2, drawerH);
  ctx.fillStyle = '#f0f0e8';
  ctx.fillRect(x + 3, cy + 2 - openAmount - 2, 3, 3);

  ctx.font = '7px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(180, 180, 200, 0.5)';
  ctx.fillText(fileCount + 'f', x + cabinetW / 2, y + 8);
}

// ===== Water Cooler =====
function drawWaterCooler() {
  const pos = toScreen(waterCooler.wx, waterCooler.wy);
  const x = pos.x, y = pos.y;
  const isDark = !document.documentElement.classList.contains('light');

  // Ground area (iso diamond)
  drawIsoDiamond(waterCooler.wx - 30, waterCooler.wy - 20, 160, 100,
    isDark ? 'rgba(74, 158, 255, 0.04)' : 'rgba(74, 158, 255, 0.05)',
    isDark ? 'rgba(74, 158, 255, 0.1)' : 'rgba(74, 158, 255, 0.15)');

  // Cooler body (screen space)
  const cx = x + 15, cy = y - 20;

  // Jug
  ctx.fillStyle = 'rgba(100, 180, 255, 0.3)';
  ctx.beginPath();
  ctx.roundRect(cx - 5, cy - 14, 10, 16, 3);
  ctx.fill();
  ctx.strokeStyle = 'rgba(100, 180, 255, 0.5)';
  ctx.lineWidth = 0.8;
  ctx.stroke();

  // Water level
  const waterLevel = 0.5 + Math.sin(Date.now() / 2000) * 0.15;
  ctx.fillStyle = 'rgba(60, 140, 220, 0.4)';
  const waterH = 16 * waterLevel;
  ctx.fillRect(cx - 4, cy - 14 + (16 - waterH), 8, waterH);

  // Stand
  ctx.fillStyle = isDark ? '#3a4050' : '#b0b8c4';
  ctx.fillRect(cx - 6, cy + 2, 12, 18);
  ctx.strokeStyle = isDark ? '#4a5060' : '#9aa0ac';
  ctx.lineWidth = 0.8;
  ctx.strokeRect(cx - 6, cy + 2, 12, 18);

  // Tap
  ctx.fillStyle = '#888';
  ctx.fillRect(cx + 3, cy + 4, 5, 2.5);

  // Bubbles
  const bubblePhase = (Date.now() / 800) % 4;
  ctx.fillStyle = 'rgba(200, 230, 255, 0.4)';
  for (let i = 0; i < 2; i++) {
    const bx = cx - 1 + i * 3;
    const by = cy - 4 - ((bubblePhase + i * 1.5) % 3) * 3;
    ctx.beginPath();
    ctx.arc(bx, by, 1 + i * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Label
  ctx.font = '9px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = isDark ? 'rgba(74, 158, 255, 0.5)' : 'rgba(37, 99, 235, 0.5)';
  ctx.fillText('Water Cooler', cx, cy + 28);

  const idleCount = workers.filter(w =>
    (w.sprite.state === 'IDLE' || w.sprite.state === 'WAITING') && w.sprite.state !== 'WALKING'
  ).length;
  if (idleCount > 0) {
    ctx.fillText(idleCount + ' chatting', cx, cy + 38);
  }
}

// ===== Whiteboard =====
function drawWhiteboard() {
  const pos = toScreen(whiteboard.wx, whiteboard.wy);
  const x = pos.x, y = pos.y;
  const isDark = !document.documentElement.classList.contains('light');

  // Ground area
  drawIsoDiamond(whiteboard.wx - 20, whiteboard.wy - 15, 180, 100,
    isDark ? 'rgba(245, 158, 11, 0.03)' : 'rgba(245, 158, 11, 0.04)',
    isDark ? 'rgba(245, 158, 11, 0.08)' : 'rgba(245, 158, 11, 0.12)');

  // Board (screen space)
  const bx = x - 10, by = y - 50;
  const bw = 90, bh = 45;

  ctx.fillStyle = isDark ? '#f5f5f0' : '#ffffff';
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 3);
  ctx.fill();
  ctx.strokeStyle = isDark ? '#666' : '#999';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Content
  const thinkingWorkers = workers.filter(w =>
    w.sprite.state === 'THINKING' || w.sprite.state === 'SPAWNING'
  );

  if (thinkingWorkers.length > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(bx + 2, by + 2, bw - 4, bh - 4);
    ctx.clip();

    const colors = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6'];
    for (let i = 0; i < Math.min(thinkingWorkers.length, 3); i++) {
      const tw = thinkingWorkers[i];
      const tools = tw.recentTools || [];
      const flowY = by + 8 + i * 12;
      const flowColor = colors[i % colors.length];

      ctx.fillStyle = flowColor;
      ctx.font = '6px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      let fx = bx + 6;
      for (let t = 0; t < Math.min(tools.length, 3); t++) {
        ctx.fillText(tools[t].name.substring(0, 4), fx, flowY);
        fx += 20;
        if (t < tools.length - 1) {
          ctx.strokeStyle = flowColor;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(fx - 5, flowY);
          ctx.lineTo(fx - 2, flowY);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  } else {
    ctx.font = '8px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(150, 150, 150, 0.3)';
    ctx.fillText('No active planning', bx + bw / 2, by + bh / 2);
  }

  // Marker tray
  ctx.fillStyle = isDark ? '#555' : '#ccc';
  ctx.fillRect(bx + 10, by + bh + 1, bw - 20, 3);
  const markerColors = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b'];
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = markerColors[i];
    ctx.beginPath();
    ctx.roundRect(bx + 14 + i * 16, by + bh - 1, 7, 5, 1);
    ctx.fill();
  }

  // Legs (isometric — two vertical lines going down)
  ctx.strokeStyle = isDark ? '#555' : '#999';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(bx + 8, by + bh + 4);
  ctx.lineTo(bx + 8, by + bh + 30);
  ctx.moveTo(bx + bw - 8, by + bh + 4);
  ctx.lineTo(bx + bw - 8, by + bh + 30);
  ctx.stroke();

  ctx.font = '9px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = isDark ? 'rgba(245, 158, 11, 0.5)' : 'rgba(217, 119, 6, 0.5)';
  ctx.fillText('Whiteboard', bx + bw / 2, by + bh + 36);
}

// ===== Collaboration Lines =====
function drawCollaborationLines() {
  const fileWorkerMap = {};
  for (const w of workers) {
    if (!w.filesModified) continue;
    for (const f of w.filesModified) {
      if (!fileWorkerMap[f]) fileWorkerMap[f] = [];
      fileWorkerMap[f].push(w);
    }
  }

  const drawnPairs = new Set();
  for (const file of Object.keys(fileWorkerMap)) {
    const collabWorkers = fileWorkerMap[file];
    if (collabWorkers.length < 2) continue;

    for (let i = 0; i < collabWorkers.length; i++) {
      for (let j = i + 1; j < collabWorkers.length; j++) {
        const a = collabWorkers[i];
        const b = collabWorkers[j];
        const pairKey = [a.id, b.id].sort().join(':');
        if (drawnPairs.has(pairKey)) continue;
        drawnPairs.add(pairKey);

        const sa = toScreen(a.sprite.wx, a.sprite.wy);
        const sb = toScreen(b.sprite.wx, b.sprite.wy);
        const ax = sa.x, ay = sa.y - 30;
        const bx = sb.x, by = sb.y - 30;

        ctx.save();
        ctx.strokeStyle = 'rgba(167, 139, 250, 0.25)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.lineDashOffset = -(Date.now() / 100) % 10;
        const midX = (ax + bx) / 2;
        const midY = Math.min(ay, by) - 25;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo(midX, midY, bx, by);
        ctx.stroke();
        ctx.setLineDash([]);

        // File icon
        ctx.fillStyle = 'rgba(167, 139, 250, 0.4)';
        ctx.fillRect(midX - 3, midY + 3, 6, 8);
        ctx.strokeStyle = 'rgba(167, 139, 250, 0.6)';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(midX - 3, midY + 3, 6, 8);
        ctx.restore();
      }
    }
  }
}

// ===== Conveyor Belt =====
function drawConveyorBelt(worker) {
  if (!worker.subagents || worker.subagents.length === 0) return;
  if (worker.sprite.state !== 'SPAWNING' && worker.sprite.state !== 'CODING') return;

  const sp = worker.sprite;
  const start = toScreen(sp.wx + 50, sp.wy);
  const beltLen = Math.min(worker.subagents.length, 3) * 45 + 25;
  const sy = start.y - 10;
  const sx = start.x;

  // Belt track
  ctx.strokeStyle = 'rgba(245, 158, 11, 0.2)';
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(sx + beltLen, sy);
  ctx.stroke();

  // Rollers
  const rollerPhase = (Date.now() / 200) % 10;
  for (let rx = sx + 5; rx < sx + beltLen; rx += 10) {
    ctx.fillStyle = ((rx + rollerPhase) % 10) < 5
      ? 'rgba(245, 158, 11, 0.12)' : 'rgba(245, 158, 11, 0.22)';
    ctx.fillRect(rx, sy - 2.5, 5, 5);
  }

  // Belt edges
  ctx.strokeStyle = 'rgba(100, 100, 100, 0.4)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(sx, sy - 3.5);
  ctx.lineTo(sx + beltLen, sy - 3.5);
  ctx.moveTo(sx, sy + 3.5);
  ctx.lineTo(sx + beltLen, sy + 3.5);
  ctx.stroke();

  // Moving packages
  const maxItems = Math.min(worker.subagents.length, 3);
  for (let i = 0; i < maxItems; i++) {
    const sa = worker.subagents[i];
    const phase = ((Date.now() / 1500) + i * 0.3) % 1;
    const itemX = sx + 12 + phase * (beltLen - 24);

    ctx.fillStyle = `hsla(${sa.color}, 60%, 45%, 0.7)`;
    ctx.beginPath();
    ctx.roundRect(itemX - 4, sy - 5, 8, 8, 2);
    ctx.fill();
    ctx.strokeStyle = `hsla(${sa.color}, 70%, 60%, 0.5)`;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(itemX, sy - 5);
    ctx.lineTo(itemX, sy + 3);
    ctx.moveTo(itemX - 4, sy - 1);
    ctx.lineTo(itemX + 4, sy - 1);
    ctx.stroke();
  }

  // Subagent receivers
  for (let i = 0; i < maxItems; i++) {
    const sa = worker.subagents[i];
    const saX = sx + beltLen + 8 + i * 24;
    const saY = sy + 10;

    ctx.strokeStyle = 'rgba(245, 158, 11, 0.2)';
    ctx.lineWidth = 0.8;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(sx + beltLen, sy);
    ctx.lineTo(saX, saY - 10);
    ctx.stroke();
    ctx.setLineDash([]);

    drawMiniMinifig(saX, saY, sa.color, i);

    ctx.font = '7px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(245, 158, 11, 0.7)';
    ctx.fillText(sa.type.substring(0, 8), saX, saY + 3);
  }

  if (worker.subagents.length > 3) {
    ctx.font = '8px -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(245, 158, 11, 0.5)';
    ctx.textAlign = 'left';
    ctx.fillText('+' + (worker.subagents.length - 3), sx + beltLen + 8 + 3 * 24, sy);
  }
}

// ===== Small Props (screen-space) =====
function drawCoffeeCup(x, y) {
  ctx.fillStyle = '#f0f0f0';
  ctx.beginPath();
  ctx.roundRect(x, y, 8, 9, 1);
  ctx.fill();
  ctx.strokeStyle = '#999';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.strokeStyle = '#ccc';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x + 9, y + 4.5, 2.5, -0.5 * Math.PI, 0.5 * Math.PI);
  ctx.stroke();
  const phase = (Date.now() / 500) % 6;
  ctx.strokeStyle = 'rgba(200, 200, 200, 0.3)';
  ctx.lineWidth = 0.6;
  for (let i = 0; i < 2; i++) {
    const sx = x + 2 + i * 4;
    const sway = Math.sin((phase + i) * 1.2) * 1.5;
    ctx.beginPath();
    ctx.moveTo(sx, y - 1);
    ctx.quadraticCurveTo(sx + sway, y - 4, sx - sway * 0.5, y - 7);
    ctx.stroke();
  }
}

function drawDocumentStack(x, y, tool) {
  for (let i = 2; i >= 0; i--) {
    const px = x + i * 1.5, py = y - i * 2;
    ctx.fillStyle = i === 0 ? '#f5f5f5' : '#e0e0e0';
    ctx.fillRect(px, py, 10, 12);
    ctx.strokeStyle = '#bbb';
    ctx.lineWidth = 0.4;
    ctx.strokeRect(px, py, 10, 12);
    if (i === 0) {
      ctx.fillStyle = 'rgba(100, 100, 120, 0.4)';
      for (let l = 0; l < 3; l++) ctx.fillRect(px + 2, py + 2 + l * 3, 5 + (l % 2) * 2, 1);
    }
  }
  if (tool === 'Grep' || tool === 'Glob') {
    ctx.strokeStyle = 'rgba(74, 158, 255, 0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x + 8, y + 2, 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 10.2, y + 4.2);
    ctx.lineTo(x + 12, y + 6);
    ctx.stroke();
  }
}

function drawTerminalIcon(x, y) {
  ctx.fillStyle = '#1a1a2e';
  ctx.beginPath();
  ctx.roundRect(x, y, 12, 9, 2);
  ctx.fill();
  ctx.strokeStyle = '#50c878';
  ctx.lineWidth = 0.8;
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 3, y + 2.5);
  ctx.lineTo(x + 5.5, y + 4.5);
  ctx.lineTo(x + 3, y + 6.5);
  ctx.stroke();
  ctx.fillStyle = '#50c878';
  ctx.fillRect(x + 6.5, y + 5.5, 3, 1);
}

function drawGlobeIcon(x, y) {
  ctx.strokeStyle = 'rgba(74, 158, 255, 0.7)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.arc(x + 5, y + 5, 4.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + 0.5, y + 5);
  ctx.lineTo(x + 9.5, y + 5);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(x + 5, y + 5, 2, 4.5, 0, 0, Math.PI * 2);
  ctx.stroke();
}

function drawLightningIcon(x, y) {
  ctx.fillStyle = '#f59e0b';
  ctx.beginPath();
  ctx.moveTo(x + 5, y);
  ctx.lineTo(x + 2, y + 5);
  ctx.lineTo(x + 4.5, y + 5);
  ctx.lineTo(x + 3, y + 10);
  ctx.lineTo(x + 8, y + 4);
  ctx.lineTo(x + 5.5, y + 4);
  ctx.lineTo(x + 7, y);
  ctx.closePath();
  ctx.fill();
}

function drawMiniMinifig(x, y, hue) {
  ctx.fillStyle = '#FFCC00';
  ctx.fillRect(x - 3, y - 10, 6, 5);
  ctx.fillRect(x - 2, y - 12, 4, 2);
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(x - 1.5, y - 8.5, 1, 1);
  ctx.fillRect(x + 0.5, y - 8.5, 1, 1);
  ctx.fillStyle = `hsl(${hue}, 70%, 50%)`;
  ctx.fillRect(x - 4, y - 5, 8, 6);
  ctx.fillRect(x - 5.5, y - 4, 2, 5);
  ctx.fillStyle = `hsl(${hue}, 65%, 40%)`;
  ctx.fillRect(x + 3.5, y - 4, 2, 5);
  ctx.fillStyle = `hsl(${hue}, 60%, 35%)`;
  ctx.fillRect(x - 3, y + 1, 3, 4);
  ctx.fillStyle = `hsl(${hue}, 55%, 28%)`;
  ctx.fillRect(x, y + 1, 3, 4);
}

// ===== Drawing: Lego Minifigure (screen-space, upright) =====
function drawMinifig(x, y, hue, state, frame, scale) {
  const s = scale || MINIFIG_SCALE;
  const headW = 10 * s, headH = 8 * s;
  const studW = 6 * s, studH = 3 * s;
  const torsoW = 12 * s, torsoH = 10 * s;
  const armW = 3 * s, armH = 10 * s;
  const legW = 5 * s, legH = 8 * s;
  const legGap = 1 * s;
  const totalH = studH + headH + torsoH + legH;
  const baseY = y;
  const topY = baseY - totalH;

  const skinColor = '#FFCC00';
  const torsoColor = `hsl(${hue}, 70%, 50%)`;
  const torsoDark = `hsl(${hue}, 65%, 40%)`;
  const legColor = `hsl(${hue}, 60%, 35%)`;
  const legDark = `hsl(${hue}, 55%, 28%)`;

  ctx.save();

  // Stud
  ctx.fillStyle = skinColor;
  ctx.beginPath();
  ctx.roundRect(x - studW / 2, topY, studW, studH, 2 * s);
  ctx.fill();
  ctx.strokeStyle = '#E6B800';
  ctx.lineWidth = 0.5 * s;
  ctx.stroke();

  // Head
  const headX = x - headW / 2, headY = topY + studH;
  ctx.fillStyle = skinColor;
  ctx.beginPath();
  ctx.roundRect(headX, headY, headW, headH, 2 * s);
  ctx.fill();
  ctx.strokeStyle = '#E6B800';
  ctx.stroke();

  // Eyes
  const eyeY = headY + headH * 0.4;
  ctx.fillStyle = '#1a1a1a';
  ctx.beginPath(); ctx.arc(x - 2.5 * s, eyeY, 0.8 * s, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(x + 2.5 * s, eyeY, 0.8 * s, 0, Math.PI * 2); ctx.fill();

  // Mouth
  const mouthY = headY + headH * 0.7;
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 0.6 * s;
  ctx.beginPath();
  if (state === 'WAITING') {
    ctx.arc(x, mouthY, 1.5 * s, 0, Math.PI * 2); ctx.stroke();
  } else if (state === 'THINKING') {
    ctx.moveTo(x - 2 * s, mouthY); ctx.lineTo(x + 2 * s, mouthY); ctx.stroke();
  } else {
    ctx.arc(x, mouthY - 1 * s, 2.5 * s, 0.2 * Math.PI, 0.8 * Math.PI); ctx.stroke();
  }

  // Torso
  const torsoX = x - torsoW / 2, torsoY = headY + headH;
  ctx.fillStyle = torsoColor;
  ctx.fillRect(torsoX, torsoY, torsoW, torsoH);
  ctx.strokeStyle = torsoDark;
  ctx.lineWidth = 0.5 * s;
  ctx.beginPath(); ctx.moveTo(x, torsoY + 2 * s); ctx.lineTo(x, torsoY + torsoH); ctx.stroke();

  // Arms
  drawArms(x, torsoX, torsoW, torsoY + 1 * s, armW, armH, torsoColor, torsoDark, state, frame, s);

  // Legs
  const legTopY = torsoY + torsoH;
  const leftLegX = x - legW - legGap / 2, rightLegX = x + legGap / 2;
  if (state === 'WALKING') {
    const lo = Math.sin(Date.now() / 150) * 2 * s;
    ctx.fillStyle = legColor; ctx.fillRect(leftLegX, legTopY + lo, legW, legH - Math.abs(lo));
    ctx.fillStyle = legDark; ctx.fillRect(rightLegX, legTopY - lo, legW, legH - Math.abs(lo));
  } else if (state === 'CODING' || state === 'READING' || state === 'SPAWNING') {
    ctx.fillStyle = legColor; ctx.fillRect(leftLegX + s, legTopY, legW, legH * 0.6);
    ctx.fillStyle = legDark; ctx.fillRect(rightLegX + s, legTopY, legW, legH * 0.6);
  } else {
    const bob = (state === 'IDLE') ? Math.sin(Date.now() / 600) * 1 : 0;
    ctx.fillStyle = legColor; ctx.fillRect(leftLegX, legTopY + bob, legW, legH);
    ctx.fillStyle = legDark; ctx.fillRect(rightLegX, legTopY + bob, legW, legH);
  }
  ctx.restore();

  // Bubbles
  if (state === 'WAITING') drawSpeechBubble(x, topY - 8 * s, '?');
  else if (state === 'THINKING') drawThoughtBubble(x, topY - 8 * s, '...');
  else if (state === 'SPAWNING') drawThoughtBubble(x, topY - 8 * s, '++');

  return { left: x - torsoW / 2 - armW, top: topY, right: x + torsoW / 2 + armW, bottom: baseY };
}

function drawArms(x, torsoX, torsoW, armTopY, armW, armH, color, darkColor, state, frame, s) {
  ctx.save();
  if (state === 'CODING' || state === 'SPAWNING') {
    // Smooth sinusoidal typing motion instead of 2-frame flicker
    const t = Date.now() / 400;
    const angle = -0.5 + Math.sin(t) * 0.08;
    ctx.fillStyle = color;
    ctx.save(); ctx.translate(torsoX, armTopY); ctx.rotate(angle);
    ctx.fillRect(-armW, 0, armW, armH * 0.7); ctx.restore();
    ctx.fillStyle = darkColor;
    ctx.save(); ctx.translate(torsoX + torsoW, armTopY); ctx.rotate(-angle - Math.sin(t + 1.5) * 0.06);
    ctx.fillRect(0, 0, armW, armH * 0.7); ctx.restore();
  } else if (state === 'READING') {
    ctx.fillStyle = color;
    ctx.save(); ctx.translate(torsoX, armTopY); ctx.rotate(-0.8);
    ctx.fillRect(-armW, 0, armW, armH * 0.8); ctx.restore();
    ctx.fillStyle = darkColor;
    ctx.fillRect(torsoX + torsoW, armTopY, armW, armH * 0.7);
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(torsoX - armW - 5 * s, armTopY - 3 * s, 4 * s, 5 * s);
  } else if (state === 'THINKING') {
    ctx.fillStyle = color;
    ctx.save(); ctx.translate(torsoX, armTopY); ctx.rotate(-1.0);
    ctx.fillRect(-armW, 0, armW, armH * 0.6); ctx.restore();
    ctx.fillStyle = darkColor;
    ctx.fillRect(torsoX + torsoW, armTopY, armW, armH * 0.85);
  } else {
    const swing = state === 'WALKING' ? Math.sin(Date.now() / 200) * 0.3 : 0;
    ctx.fillStyle = color;
    ctx.save(); ctx.translate(torsoX, armTopY); ctx.rotate(swing);
    ctx.fillRect(-armW, 0, armW, armH * 0.85); ctx.restore();
    ctx.fillStyle = darkColor;
    ctx.save(); ctx.translate(torsoX + torsoW, armTopY); ctx.rotate(-swing);
    ctx.fillRect(0, 0, armW, armH * 0.85); ctx.restore();
  }
  ctx.restore();
}

function drawSpeechBubble(x, y, text) {
  const pulse = Math.sin(Date.now() / 500) * 2;
  const bw = 20, bh = 16, bx = x - bw / 2, by = y - bh + pulse;
  ctx.fillStyle = 'white'; ctx.strokeStyle = '#333'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 4); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'white'; ctx.beginPath();
  ctx.moveTo(x - 3, by + bh); ctx.lineTo(x, by + bh + 6); ctx.lineTo(x + 3, by + bh); ctx.fill();
  ctx.strokeStyle = '#333'; ctx.beginPath();
  ctx.moveTo(x - 3, by + bh); ctx.lineTo(x, by + bh + 6); ctx.lineTo(x + 3, by + bh); ctx.stroke();
  ctx.fillStyle = '#a78bfa'; ctx.font = 'bold 12px -apple-system, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x, by + bh / 2);
}

function drawThoughtBubble(x, y, text) {
  const pulse = Math.sin(Date.now() / 600) * 1.5;
  const bw = 28, bh = 16, bx = x - bw / 2 + 10, by = y - bh + pulse;
  ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.strokeStyle = '#999'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 6); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.beginPath(); ctx.arc(x + 2, by + bh + 5, 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.arc(x - 1, by + bh + 10, 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#f59e0b'; ctx.font = 'bold 10px -apple-system, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, bx + bw / 2, by + bh / 2);
}

// ===== Worker Label =====
function drawWorkerLabel(worker) {
  const sp = worker.sprite;
  const pos = toScreen(sp.wx, sp.wy);
  const labelX = pos.x, labelY = pos.y + 10;

  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillStyle = 'rgba(150, 160, 180, 0.7)';
  ctx.fillText(worker.projectLabel, labelX, labelY);

  ctx.fillStyle = 'rgba(200, 210, 225, 0.9)';
  ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, sans-serif';
  const name = worker.label.length > 24 ? worker.label.substring(0, 24) + '...' : worker.label;
  ctx.fillText(name, labelX, labelY + 13);

  const stateColors = {
    CODING: '#50c878', READING: '#4a9eff', THINKING: '#f59e0b',
    WAITING: '#a78bfa', IDLE: '#6b7280', SPAWNING: '#f59e0b', WALKING: '#6b7280',
  };
  const desc = worker.activityDescription || sp.state;
  ctx.font = '10px -apple-system, sans-serif';
  ctx.fillStyle = stateColors[sp.state] || '#6b7280';
  ctx.fillText(desc.length > 30 ? desc.substring(0, 30) + '...' : desc, labelX, labelY + 27);

  if (worker.lastToolDetail && worker.activityDescription && !worker.activityDescription.includes(worker.lastToolDetail)) {
    ctx.font = '9px "SF Mono", "Fira Code", monospace';
    ctx.fillStyle = 'rgba(150, 160, 180, 0.6)';
    const detail = worker.lastToolDetail.length > 35 ? worker.lastToolDetail.substring(0, 35) + '...' : worker.lastToolDetail;
    ctx.fillText(detail, labelX, labelY + 39);
  }
}

// ===== State Glow =====
function drawStateGlow(worker) {
  const sp = worker.sprite;
  const pos = toScreen(sp.wx, sp.wy);
  const glowColors = {
    CODING: 'rgba(80, 200, 120, 0.15)', READING: 'rgba(74, 158, 255, 0.12)',
    THINKING: 'rgba(245, 158, 11, 0.12)', WAITING: 'rgba(167, 139, 250, 0.1)',
    IDLE: 'rgba(107, 114, 128, 0.05)', SPAWNING: 'rgba(245, 158, 11, 0.18)',
  };
  const color = glowColors[sp.state];
  if (!color) return;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y - 20 * MINIFIG_SCALE, 35, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ===== Update =====
function update(dt) {
  for (const worker of workers) {
    const sp = worker.sprite;
    if (sp.spawnTimer > 0) sp.spawnTimer -= dt;

    sp.animTimer += dt * 1000;
    if (sp.animTimer >= FRAME_DURATION) {
      sp.animTimer -= FRAME_DURATION;
      sp.animFrame++;
    }

    // Idle workers drift to water cooler
    if ((worker.state === 'IDLE' || worker.state === 'WAITING') && sp.state !== 'WALKING') {
      sp.targetWx = waterCooler.wx + 40 + hashCode(worker.id + 'wc') % 80;
      sp.targetWy = waterCooler.wy + 10 + hashCode(worker.id + 'wy') % 40;
    } else if (sp.deskIndex >= 0 && desks[sp.deskIndex]) {
      const desk = desks[sp.deskIndex];
      sp.targetWx = desk.wx + DESK_WIDTH / 2;
      sp.targetWy = desk.wy + DESK_HEIGHT + 25;
    }

    const dx = sp.targetWx - sp.wx;
    const dy = sp.targetWy - sp.wy;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Hysteresis: start walking at >8px, stop at <2px — prevents oscillation
    const startThreshold = 8;
    const stopThreshold = 2;

    if (sp.state === 'WALKING') {
      if (dist < stopThreshold) {
        sp.wx = sp.targetWx;
        sp.wy = sp.targetWy;
        sp.state = worker.state || 'IDLE';
      } else {
        const speed = WALK_SPEED * (dt * 60);
        sp.wx += (dx / dist) * Math.min(speed, dist);
        sp.wy += (dy / dist) * Math.min(speed, dist);
      }
    } else if (dist > startThreshold) {
      sp.prevState = sp.state;
      sp.state = 'WALKING';
    }
  }
}

// ===== Render =====
function render() {
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;

  ctx.clearRect(0, 0, w, h);
  drawFloor();

  // Draw buildings (sorted by depth = wy for proper iso overlap)
  const sortedBuildings = [...buildings].sort((a, b) => a.wy - b.wy);
  for (const b of sortedBuildings) drawBuilding(b);

  // Environmental features
  drawWaterCooler();
  drawWhiteboard();
  drawCollaborationLines();

  // Draw desks sorted by depth
  const sortedDesks = [...desks].sort((a, b) => (a.wx + a.wy) - (b.wx + b.wy));
  for (const desk of sortedDesks) {
    const worker = desk.workerId ? workers.find(w => w.id === desk.workerId) : null;
    drawDesk(desk, worker);
  }

  // Conveyor belts
  for (const worker of workers) {
    if (worker.subagents?.length > 0 &&
      (worker.sprite.state === 'SPAWNING' || worker.sprite.state === 'CODING')) {
      drawConveyorBelt(worker);
    }
  }

  // Workers (sorted by iso depth)
  const sortedWorkers = [...workers].sort((a, b) =>
    (a.sprite.wx + a.sprite.wy) - (b.sprite.wx + b.sprite.wy));

  for (const worker of sortedWorkers) {
    const sp = worker.sprite;
    if (sp.spawnTimer > 0) ctx.globalAlpha = 1 - sp.spawnTimer / 0.5;

    const pos = toScreen(sp.wx, sp.wy);
    drawStateGlow(worker);
    worker._bounds = drawMinifig(pos.x, pos.y, worker.color, sp.state, sp.animFrame, MINIFIG_SCALE);
    drawWorkerLabel(worker);
    ctx.globalAlpha = 1;
  }

  if (hoveredWorker) updateTooltipUI(hoveredWorker);
}

// ===== Game Loop =====
function gameLoop(timestamp) {
  const dt = Math.min((timestamp - lastTime) / 1000, 0.1);
  lastTime = timestamp;
  update(dt);
  render();
  requestAnimationFrame(gameLoop);
}

// ===== Tooltip =====
let lastTooltipWorkerId = null;
let lastTooltipState = null;

function updateTooltipUI(worker) {
  const tt = tooltip;
  tt.style.display = 'block';
  tt.style.left = (mouseX + 16) + 'px';
  tt.style.top = (mouseY - 10) + 'px';

  // Only rebuild DOM when worker or state changes, not every frame
  const tooltipKey = worker.id + ':' + worker.sprite.state + ':' + worker.activityDescription;
  if (lastTooltipWorkerId === tooltipKey) return;
  lastTooltipWorkerId = tooltipKey;

  tt.textContent = '';

  const add = (cls, text) => {
    const div = document.createElement('div');
    div.className = cls;
    div.textContent = text;
    tt.appendChild(div);
    return div;
  };

  add('tt-label', worker.label);
  add('tt-project', worker.projectLabel);
  const actDiv = add('tt-state', worker.activityDescription || worker.sprite.state);
  actDiv.style.color = stateColor(worker.sprite.state);

  if (worker.lastToolDetail) add('tt-detail', worker.lastToolDetail);
  if (worker.recentTools?.length > 1)
    add('tt-history', 'Recent: ' + worker.recentTools.map(t => t.name).join(' > '));
  if (worker.totalTokens > 0) {
    const tk = worker.totalTokens >= 1e6 ? (worker.totalTokens / 1e6).toFixed(1) + 'M'
      : worker.totalTokens >= 1e3 ? Math.floor(worker.totalTokens / 1e3) + 'K'
      : String(worker.totalTokens);
    add('tt-detail', 'Tokens: ' + tk);
  }
  if (worker.filesModified?.length > 0) add('tt-detail', 'Files modified: ' + worker.filesModified.length);
  if (worker.model) add('tt-model', worker.model.split('-').slice(-2).join('-'));
  if (worker.subagents?.length) {
    for (const sa of worker.subagents)
      add('tt-subs', 'Subagent: ' + sa.type + ' - ' + (sa.description || ''));
  }
}

function stateColor(state) {
  return { CODING: '#50c878', READING: '#4a9eff', THINKING: '#f59e0b', WAITING: '#a78bfa', IDLE: '#6b7280' }[state] || '#6b7280';
}

// ===== Hit Testing & Panning =====
canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  mouseX = e.clientX - rect.left;
  mouseY = e.clientY - rect.top;

  if (isDragging) {
    camX = camStartX + (mouseX - dragStartX);
    camY = camStartY + (mouseY - dragStartY);
    return;
  }

  const prevHovered = hoveredWorker;
  hoveredWorker = null;
  for (const worker of workers) {
    const b = worker._bounds;
    if (b && mouseX >= b.left && mouseX <= b.right && mouseY >= b.top && mouseY <= b.bottom) {
      hoveredWorker = worker;
      canvas.style.cursor = 'pointer';
      break;
    }
  }
  if (!hoveredWorker) {
    tooltip.style.display = 'none';
    canvas.style.cursor = 'default';
    lastTooltipWorkerId = null;
  } else if (hoveredWorker !== prevHovered) {
    lastTooltipWorkerId = null; // force rebuild on new hover
  }
});

canvas.addEventListener('mousedown', (e) => {
  if (!hoveredWorker) {
    isDragging = true;
    dragStartX = e.clientX - canvas.getBoundingClientRect().left;
    dragStartY = e.clientY - canvas.getBoundingClientRect().top;
    camStartX = camX;
    camStartY = camY;
    canvas.style.cursor = 'grabbing';
  }
});

canvas.addEventListener('mouseup', () => { isDragging = false; canvas.style.cursor = 'default'; });
canvas.addEventListener('mouseleave', () => {
  hoveredWorker = null; isDragging = false;
  tooltip.style.display = 'none'; canvas.style.cursor = 'default';
});

// ===== Data Integration =====
let pendingSyncData = null;
let syncDebounceTimer = null;

function scheduleSyncWorkers(data) {
  // Debounce rapid SSE updates — only process the latest one
  pendingSyncData = data;
  if (!syncDebounceTimer) {
    syncDebounceTimer = setTimeout(() => {
      syncDebounceTimer = null;
      if (pendingSyncData) {
        syncWorkers(pendingSyncData);
        pendingSyncData = null;
      }
    }, 500);
  }
}

function syncWorkers(data) {
  const incoming = data.workers || [];
  const existingMap = new Map(workers.map(w => [w.id, w]));
  const newWorkers = [];
  let structureChanged = false;

  for (const w of incoming) {
    const existing = existingMap.get(w.id);
    if (existing) {
      existing.label = w.label;
      existing.projectLabel = w.projectLabel;
      existing.state = w.state;
      existing.lastTool = w.lastTool;
      existing.lastToolDetail = w.lastToolDetail;
      existing.activityDescription = w.activityDescription;
      existing.recentTools = w.recentTools || [];
      existing.model = w.model;
      existing.isWaitingForUser = w.isWaitingForUser;
      existing.subagents = w.subagents || [];
      existing.totalTokens = w.totalTokens || 0;
      existing.filesModified = w.filesModified || [];
      existing.filesAccessed = w.filesAccessed || [];
      if (existing.sprite.state !== 'WALKING') existing.sprite.state = w.state;
      newWorkers.push(existing);
    } else {
      structureChanged = true;
      newWorkers.push({ ...w, sprite: createSprite(w) });
    }
  }

  // Check if workers were removed
  if (newWorkers.length !== workers.length) structureChanged = true;

  workers = newWorkers;
  workerCountEl.textContent = workers.length;
  emptyState.style.display = workers.length === 0 ? 'flex' : 'none';

  // Only rebuild layout when workers are added/removed, not on state changes
  if (structureChanged) rebuildLayout();
}

// ===== SSE =====
function connectSSE() {
  const evtSource = new EventSource('/events');
  evtSource.addEventListener('workspace-update', (e) => {
    try { scheduleSyncWorkers(JSON.parse(e.data)); } catch {}
  });
  evtSource.addEventListener('connected', () => console.log('SSE connected'));
  evtSource.onerror = () => console.log('SSE reconnecting...');
}

// ===== Init =====
async function init() {
  resizeCanvas();
  try {
    const res = await fetch('/api/workspace');
    syncWorkers(await res.json());
  } catch (e) {
    console.error('Failed to load workspace:', e);
  }
  connectSSE();
  lastTime = performance.now();
  requestAnimationFrame(gameLoop);
}

init();
