const fs = require('fs');
const path = require('path');

/** Directory with data.json, server.js, etc. */
function resolveProjectRoot() {
  const candidates = [
    __dirname,
    path.join(__dirname, '..'),
    process.cwd(),
  ];
  const seen = new Set();
  for (const dir of candidates) {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (fs.existsSync(path.join(resolved, 'data.json'))) {
      return resolved;
    }
  }
  return path.resolve(__dirname);
}

/** Directory with HTML pages (public/ on disk, bundled on Vercel). */
function resolvePublicDir(root) {
  const candidates = [
    path.join(root, 'public'),
    root,
    path.join(__dirname, 'public'),
    path.join(__dirname, '..', 'public'),
    process.cwd(),
    path.join(process.cwd(), 'public'),
  ];
  const seen = new Set();
  for (const dir of candidates) {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (fs.existsSync(path.join(resolved, 'login.html'))) {
      return resolved;
    }
  }
  return path.join(root, 'public');
}

module.exports = { resolveProjectRoot, resolvePublicDir };
