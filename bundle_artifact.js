// Builds a fragment version of the single-file bundle for publishing as a
// Claude Artifact: same inlined index.html + styles.css + app.js as
// bundle.js produces, but without the outer <!doctype>/<html>/<head>/<body>
// wrapper — Artifact hosting supplies that shell itself and only wants a
// <title>, a <style> block, body content, and a <script> block.
//
// Usage: node bundle_artifact.js <outPath>
// Still works standalone: app.js detects there's no /api/projects backend
// to talk to (an Artifact has no Node server behind it) and falls back to
// its built-in local demo simulation.
'use strict';
const fs = require('fs');
const path = require('path');

const root = __dirname;
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
if (!bodyMatch) throw new Error('could not find <body>...</body> in index.html');
let body = bodyMatch[1];
// The script tag is inside <body> in index.html; pull it out so we control
// exactly where the inlined JS goes (right where it already was).
body = body.replace('<script src="app.js"></script>', '<script>\n' + js + '\n</script>');

const out =
  '<title>帧语 · AI 视频创作助手</title>\n' +
  '<style>\n' +
  "@import url('https://fonts.googleapis.com/css2?family=Lexend:wght@500;600;700&family=Public+Sans:wght@400;500;600&display=swap');\n" +
  css + '\n' +
  '</style>\n' +
  body;

const outPath = process.argv[2] || path.join(root, '..', '_video_agent_artifact.html');
fs.writeFileSync(outPath, out, 'utf8');
console.log('wrote', outPath, out.length, 'bytes');
