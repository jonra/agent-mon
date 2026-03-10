const chokidar = require('chokidar');
const path = require('path');
const { PROJECTS_DIR } = require('./scanner');

/**
 * Watch ~/.claude/projects/ for changes and emit events.
 */
function createWatcher(onUpdate) {
  const watcher = chokidar.watch(PROJECTS_DIR, {
    ignored: /(^|[\/\\])\..|(tool-results|file-history|memory)/,
    persistent: true,
    depth: 4,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 },
  });

  watcher.on('change', (filePath) => {
    if (filePath.endsWith('.jsonl') || filePath.endsWith('.json')) {
      onUpdate({ type: 'change', path: filePath });
    }
  });

  watcher.on('add', (filePath) => {
    if (filePath.endsWith('.jsonl') || filePath.endsWith('.meta.json')) {
      onUpdate({ type: 'add', path: filePath });
    }
  });

  return watcher;
}

module.exports = { createWatcher };
