// Builds a single self-contained HTML file (index.html + styles.css + app.js
// inlined) for sharing as a static preview link — e.g. publishing to a
// platform that only accepts one HTML file, such as an Artifact. The bundle
// still works standalone: app.js detects there's no /api/projects backend to
// talk to and falls back to its built-in local demo simulation.
//
// Usage: node bundle.js  (run from inside video-agent/)
// Output: ../_video_agent_bundle.html
'use strict';
const fs = require('fs');
const path = require('path');

const root = __dirname;
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

let out = html.replace(
  '<link rel="stylesheet" href="styles.css">',
  '<style>\n' + css + '\n</style>'
);
out = out.replace(
  '<script src="app.js"></script>',
  '<script>\n' + js + '\n</script>'
);

const outPath = path.join(root, '..', '_video_agent_bundle.html');
fs.writeFileSync(outPath, out, 'utf8');
console.log('wrote', outPath, out.length, 'bytes');
