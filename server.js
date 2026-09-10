// 帧语 · 真实 Node 后端（零外部依赖）
//
// 提供静态文件服务 + 一套真实的项目/流水线 REST + SSE 接口。
// 生成逻辑本身是【占位规则】，不是真实 AI —— 脚本/大纲/配音选择等都由确定性规则
// 从 prompt 里粗略推导出来，用来验证前后端的真实交互链路（创建项目 -> 服务端异步跑
// 流水线 -> SSE 推送每一步 -> 落盘持久化 -> 刷新后可从磁盘恢复）。接入真实文生图 /
// LLM / TTS 时，只需要替换 buildContent() 和各阶段 run() 里“生成”的那一行。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'projects.json');
const PORT = process.env.PORT || 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const STEP_ORDER = ['script', 'outline', 'storyboard', 'frames', 'voice', 'preview', 'export'];
const SHOT_HUES = [220, 340, 160, 90, 280, 40, 200, 120];
const VOICE_BGM_RULES = [
  { test: /儿童|童声|小朋友|科普.{0,4}可爱/, voice: '活泼童声', bgm: '阳光电子流行' },
  { test: /培训|安全|严谨|流程|企业/, voice: '沉稳男声', bgm: '探索感管弦乐' },
  { test: /情怀|品牌故事|温暖|车库|历程/, voice: '温柔姐姐音', bgm: '温柔钢琴独奏' },
  { test: /种草|小红书|网感|好物|安利/, voice: '活泼童声', bgm: '阳光电子流行' }
];
const DEFAULT_VOICE_BGM = { voice: '知性女声', bgm: '海风轻快民谣' };

// ---------- persistence ----------

let db = { projects: [] };

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadDb() {
  ensureDataDir();
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (!Array.isArray(db.projects)) db.projects = [];
      return;
    } catch (e) {
      console.error('projects.json 解析失败，将重新播种示例数据：', e.message);
    }
  }
  db = { projects: seedProjects() };
  saveDb();
}

let saveScheduled = false;
function saveDb() {
  // 简单去抖：同一个事件循环 tick 内的多次修改只落盘一次
  if (saveScheduled) return;
  saveScheduled = true;
  setImmediate(function () {
    saveScheduled = false;
    ensureDataDir();
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  });
}

// ---------- placeholder generation "brain" ----------

function pickShotCount(prompt) {
  var n = Math.round(prompt.length / 8);
  return Math.max(4, Math.min(8, n || 6));
}

function pickVoiceBgm(prompt) {
  for (var i = 0; i < VOICE_BGM_RULES.length; i++) {
    if (VOICE_BGM_RULES[i].test.test(prompt)) return { voice: VOICE_BGM_RULES[i].voice, bgm: VOICE_BGM_RULES[i].bgm };
  }
  return DEFAULT_VOICE_BGM;
}

function deriveTitle(text) {
  return text.length > 16 ? text.slice(0, 16) + '…' : text;
}

function cloneShots(shots) {
  // Timeline entries must snapshot shots by value — project.shots is mutated
  // in place as generation progresses, so embedding the live array reference
  // would silently rewrite every past 'shots' timeline entry to the current
  // (eventually final) state.
  return shots.map(function (s) { return { status: s.status, hue: s.hue, caption: s.caption }; });
}

// Splits the prompt into rough clauses to stand in for per-shot narration
// captions/subtitles — a real script-writing LLM would produce one narration
// line per shot instead of this placeholder heuristic.
function splitCaptions(prompt, shotCount) {
  var parts = prompt.split(/[，。！？,.!?、~]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (!parts.length) parts = [prompt];
  var out = [];
  for (var i = 0; i < shotCount; i++) out.push(parts[i % parts.length]);
  return out;
}

function hueForText(text) {
  var h = 0;
  for (var i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return SHOT_HUES[h % SHOT_HUES.length];
}

// Pure function: prompt -> all the deterministic "generation" facts used to
// build the timeline. This is the one place a real LLM/文生图/TTS call would
// replace placeholder logic.
function buildContent(prompt) {
  var shotCount = pickShotCount(prompt);
  var vb = pickVoiceBgm(prompt);
  var totalDuration = shotCount * 5;
  var captions = splitCaptions(prompt, shotCount);
  var shots = [];
  for (var i = 0; i < shotCount; i++) shots.push({ status: 'pending', hue: SHOT_HUES[i % SHOT_HUES.length], caption: captions[i] });
  return {
    shotCount: shotCount,
    totalDuration: totalDuration,
    voice: vb.voice,
    bgm: vb.bgm,
    shots: shots,
    scriptMeta: Math.max(60, prompt.length * 6) + ' 字 · 时长约 ' + totalDuration + ' 秒',
    outlineMeta: '开场 → 核心内容 → 结尾，共 ' + shotCount + ' 个段落',
    storyboardMeta: '每个大纲段落对应 1 个分镜',
    completionText: '已经为你生成好全部 ' + shotCount + ' 个分镜的画面和声音啦，画面时长也按配音重新对齐过了。可以点击中间播放预览；如果哪个分镜不满意，直接告诉我要怎么改～',
    summaryItems: ['脚本生成', '分镜拆分（' + shotCount + ' 个分镜）', '画面生成', '旁白配音', '字幕生成', '背景音乐选择', '剪辑合成'],
    scriptText: '【开场】\n' + prompt +
      '\n\n【正文】围绕以上主题自动扩写为 ' + shotCount + ' 个分镜的解说词，每个分镜约 ' + Math.round(totalDuration / shotCount) + ' 秒，配合' + vb.voice + '旁白与《' + vb.bgm + '》背景音乐。' +
      '\n\n【结尾】总结核心信息，引导观众记住重点，字幕与画面同步呈现。'
  };
}

// ---------- SSE subscriber registry ----------

var subscribers = {}; // projectId -> Set<res>

function subscribe(id, res) {
  if (!subscribers[id]) subscribers[id] = new Set();
  subscribers[id].add(res);
}
function unsubscribe(id, res) {
  if (subscribers[id]) subscribers[id].delete(res);
}
function broadcast(id, entry) {
  if (!subscribers[id]) return;
  var payload = 'data: ' + JSON.stringify(entry) + '\n\n';
  subscribers[id].forEach(function (res) { res.write(payload); });
}

function findProject(id) {
  return db.projects.filter(function (p) { return p.id === id; })[0] || null;
}

function pushEntry(project, entry) {
  entry.at = new Date().toISOString();
  project.timeline.push(entry);
  project.updatedAt = entry.at;
  saveDb();
  broadcast(project.id, entry);
}

// ---------- pipeline runner (shared by "live" new projects and "instant" seed generation) ----------

function runPipelineSteps(project, content, live) {
  var shotCount = content.shotCount;

  function at(delay, fn) {
    if (live) setTimeout(fn, delay);
    else fn();
  }

  at(150, function () {
    // Marked kickoff:true so the 'ocean' seed's mid-pipeline freeze below
    // (which stops replaying the timeline at the first ai_message) doesn't
    // mistake this early acknowledgement for the completion message.
    pushEntry(project, { type: 'ai_message', text: '收到！我会自动完成脚本、分镜、画面、配音、字幕、剪辑并导出成片，全程无需你确认，请稍候～', kickoff: true });
  });

  at(500, function () {
    project.doneSteps.push('script');
    project.currentStep = 'outline';
    pushEntry(project, { type: 'process_card', id: 'script', title: '脚本已生成', meta: content.scriptMeta, done: true });
    pushEntry(project, { type: 'stepper', currentStep: project.currentStep, doneSteps: project.doneSteps.slice() });
    pushEntry(project, { type: 'status', text: '大纲生成中…', active: true });
  });

  at(1000, function () {
    project.doneSteps.push('outline');
    project.currentStep = 'storyboard';
    pushEntry(project, { type: 'process_card', id: 'outline', title: '大纲已生成', meta: content.outlineMeta, done: true });
    pushEntry(project, { type: 'stepper', currentStep: project.currentStep, doneSteps: project.doneSteps.slice() });
    pushEntry(project, { type: 'status', text: '拆分分镜中…', active: true });
  });

  at(1600, function () {
    project.shots = content.shots.map(function (s) { return { status: 'pending', hue: s.hue, caption: s.caption }; });
    project.doneSteps.push('storyboard');
    project.currentStep = 'frames';
    pushEntry(project, { type: 'shots', shots: cloneShots(project.shots) });
    pushEntry(project, { type: 'process_card', id: 'storyboard', title: '已拆分为 ' + shotCount + ' 个分镜', meta: content.storyboardMeta, done: true });
    pushEntry(project, { type: 'process_card', id: 'frames', title: '分镜画面生成中', meta: '', progress: 0 });
    pushEntry(project, { type: 'stepper', currentStep: project.currentStep, doneSteps: project.doneSteps.slice() });
    pushEntry(project, { type: 'status', text: '分镜画面生成中 (0/' + shotCount + ')', active: true });
    pushEntry(project, { type: 'duration', total: content.totalDuration, done: 0, totalShots: shotCount });
  });

  for (var i = 0; i < shotCount; i++) {
    (function (idx) {
      at(1600 + 500 * (idx + 1), function () {
        project.shots[idx].status = 'ready';
        var doneCount = idx + 1;
        pushEntry(project, { type: 'shots', shots: cloneShots(project.shots) });
        pushEntry(project, { type: 'process_card_progress', id: 'frames', progress: Math.round((doneCount / shotCount) * 100) });
        pushEntry(project, { type: 'status', text: '分镜画面生成中 (' + doneCount + '/' + shotCount + ')', active: true });
        pushEntry(project, { type: 'duration', total: content.totalDuration, done: doneCount, totalShots: shotCount });
        if (doneCount === shotCount) {
          project.doneSteps.push('frames');
          project.currentStep = 'voice';
          pushEntry(project, { type: 'process_card_done', id: 'frames', title: '分镜画面已生成', meta: shotCount + ' 个分镜全部完成' });
          pushEntry(project, { type: 'stepper', currentStep: project.currentStep, doneSteps: project.doneSteps.slice() });
          pushEntry(project, { type: 'status', text: '分镜声音生成中…', active: true });
        }
      });
    })(i);
  }

  var afterFrames = 1600 + 500 * shotCount;

  at(afterFrames + 700, function () {
    project.doneSteps.push('voice');
    project.voice = content.voice;
    project.bgm = content.bgm;
    pushEntry(project, { type: 'process_card', id: 'voice', title: '分镜声音已生成', meta: '旁白：' + content.voice + ' · 配乐：' + content.bgm, done: true });
    pushEntry(project, { type: 'stepper', currentStep: project.currentStep, doneSteps: project.doneSteps.slice() });
    pushEntry(project, { type: 'status', text: '生成字幕中…', active: true });
  });

  at(afterFrames + 1100, function () {
    pushEntry(project, { type: 'process_card', id: 'subtitle', title: '字幕已生成', meta: '已根据配音文本生成 ' + shotCount + ' 条字幕，可随时开关或编辑', done: true });
    pushEntry(project, { type: 'status', text: '按配音时长回调画面时长…', active: true });
  });

  at(afterFrames + 1600, function () {
    project.currentStep = 'preview';
    pushEntry(project, { type: 'process_card', id: 'sync', title: '已回调分镜画面时长', meta: '已按配音时长重新同步 ' + shotCount + ' 个分镜的展示时长', done: true });
    pushEntry(project, { type: 'stepper', currentStep: project.currentStep, doneSteps: project.doneSteps.slice() });
    pushEntry(project, { type: 'status', text: '剪辑合成中…', active: true });
  });

  at(afterFrames + 2000, function () {
    pushEntry(project, { type: 'process_card', id: 'editing', title: '剪辑合成已完成', meta: '画面、配音、字幕与背景音乐已合成为完整视频轨道', done: true });
    pushEntry(project, { type: 'status', text: '准备预览…', active: true });
  });

  at(afterFrames + 2500, function () {
    project.doneSteps.push('preview');
    project.currentStep = 'export';
    project.status = 'ready';
    project.script = content.scriptText;
    pushEntry(project, { type: 'stepper', currentStep: project.currentStep, doneSteps: project.doneSteps.slice() });
    pushEntry(project, { type: 'summary_card', items: content.summaryItems });
    pushEntry(project, { type: 'ai_message', text: content.completionText });
    pushEntry(project, { type: 'script_link', script: content.scriptText });
    pushEntry(project, { type: 'suggestions', items: ['调整分镜顺序', '换一个背景音乐', '修改旁白音色', '重新生成第 3 个分镜'] });
    pushEntry(project, { type: 'status', text: '预览确认中，随时可以导出', active: false });
  });
}

function createProject(mode, prompt) {
  var content = buildContent(prompt);
  var project = {
    id: crypto.randomUUID(),
    mode: mode === 'html' ? 'html' : 'slideshow',
    title: deriveTitle(prompt),
    prompt: prompt,
    meta: '刚刚创建',
    thumbHue: hueForText(prompt),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'running',
    doneSteps: [],
    currentStep: 'script',
    shots: [],
    voice: DEFAULT_VOICE_BGM.voice,
    bgm: DEFAULT_VOICE_BGM.bgm,
    totalDuration: content.totalDuration,
    exported: false,
    timeline: [{ type: 'user_message', text: prompt, at: new Date().toISOString() }]
  };
  db.projects.unshift(project);
  saveDb();
  runPipelineSteps(project, content, true);
  return project;
}

function seedProjects() {
  var seeds = [
    { id: 'ocean', title: '海洋生物科普·儿童向', mode: 'slideshow', meta: '编辑中',
      prompt: '帮我做一支 30 秒的儿童科普视频，讲海洋生物，风格活泼可爱，配欢快背景音乐' },
    { id: 'autumn', title: '秋季新品发布预告片', mode: 'html', meta: '2 小时前',
      prompt: '做一支 20 秒的秋季新品发布预告片，突出温暖色调和限时优惠，风格干净有质感' },
    { id: 'training', title: '内部培训引导视频', mode: 'slideshow', meta: '昨天',
      prompt: '做一支面向新员工的安全生产培训引导视频，语气严谨但不生硬，40 秒左右' },
    { id: 'skincare', title: '小红书种草·护肤新品', mode: 'slideshow', meta: '3 天前',
      prompt: '帮我做一条小红书种草视频脚本，主打一款保湿精华，15 秒内，节奏要快、有网感' },
    { id: 'case', title: '客户案例讲解 Demo', mode: 'html', meta: '上周',
      prompt: '用一支 25 秒的动态视频讲解一个客户成功案例，突出前后数据对比' },
    { id: 'brand', title: '品牌故事 30 秒版', mode: 'html', meta: '上周',
      prompt: '做一支 30 秒的品牌故事短片，讲讲我们从车库创业到现在的历程，风格要有情怀' }
  ];

  return seeds.map(function (seed) {
    var content = buildContent(seed.prompt);
    var project = {
      id: seed.id,
      mode: seed.mode,
      title: seed.title,
      prompt: seed.prompt,
      meta: seed.meta,
      thumbHue: hueForText(seed.id),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'ready',
      doneSteps: [],
      currentStep: 'script',
      shots: [],
      voice: DEFAULT_VOICE_BGM.voice,
      bgm: DEFAULT_VOICE_BGM.bgm,
      totalDuration: content.totalDuration,
      exported: false,
      timeline: [{ type: 'user_message', text: seed.prompt, at: new Date().toISOString() }]
    };
    // Instant (non-live) run: fills the whole timeline synchronously.
    runPipelineSteps(project, content, false);

    if (seed.id === 'ocean') {
      // Freeze this one seed mid-pipeline so the sidebar always has one
      // "still running" example alongside the finished ones. Leave exactly
      // 2 shots "still loading" regardless of shotCount, so the narrative
      // text below always matches reality.
      var readyTarget = Math.max(1, content.shotCount - 2);
      var remaining = content.shotCount - readyTarget;
      var kept = [];
      var framesReady = 0;
      for (var i = 0; i < project.timeline.length; i++) {
        var e = project.timeline[i];
        if (e.type === 'shots') {
          var readyCount = e.shots.filter(function (s) { return s.status === 'ready'; }).length;
          if (readyCount > readyTarget) break;
          kept.push(e);
          framesReady = readyCount;
          continue;
        }
        if (e.type === 'process_card_progress' && e.id === 'frames') {
          kept.push(e);
          if (framesReady >= readyTarget) break; // captured the frozen ready count; stop before the next shot starts
          continue;
        }
        if (e.type === 'process_card_done' || (e.type === 'ai_message' && !e.kickoff) || (e.type === 'suggestions')) break;
        kept.push(e);
      }
      project.timeline = kept;
      project.doneSteps = ['script', 'outline', 'storyboard'];
      project.currentStep = 'frames';
      project.status = 'running';
      project.shots = content.shots.map(function (s, i2) { return { status: i2 < readyTarget ? 'ready' : 'loading', hue: s.hue, caption: s.caption }; });
      project.voice = DEFAULT_VOICE_BGM.voice;
      project.bgm = DEFAULT_VOICE_BGM.bgm;
      project.timeline.push({ type: 'ai_message', text: '已经为前 ' + readyTarget + ' 个分镜生成好画面啦，还剩 ' + remaining + ' 个在生成中，大概 20 秒，之后会接着生成配音和配乐。你可以先预览已完成的部分，如果不满意某个分镜的画风，直接告诉我要怎么改～', at: new Date().toISOString() });
      project.timeline.push({ type: 'suggestions', items: ['重新生成第 ' + content.shotCount + ' 个分镜', '换一个背景音乐', '语速再快一点'], at: new Date().toISOString() });
    }
    return project;
  });
}

// ---------- HTTP plumbing ----------

function readJsonBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  if (urlPath === '/') urlPath = '/index.html';
  var filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, function (err, data) {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    var ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function publicProject(p) {
  return {
    id: p.id, mode: p.mode, title: p.title, prompt: p.prompt, meta: p.meta,
    thumbHue: p.thumbHue, status: p.status, doneSteps: p.doneSteps, currentStep: p.currentStep,
    shots: p.shots, voice: p.voice, bgm: p.bgm, totalDuration: p.totalDuration,
    exported: p.exported, timeline: p.timeline, updatedAt: p.updatedAt, script: p.script || ''
  };
}

var server = http.createServer(function (req, res) {
  var u = new URL(req.url, 'http://localhost');
  var pathname = u.pathname;
  var m = req.method;

  if (m === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // GET /api/projects — sidebar list
  if (m === 'GET' && pathname === '/api/projects') {
    return sendJson(res, 200, db.projects.map(function (p) {
      return { id: p.id, mode: p.mode, title: p.title, meta: p.meta, thumbHue: p.thumbHue, status: p.status, updatedAt: p.updatedAt };
    }));
  }

  // POST /api/projects {mode, prompt} — create + kick off live pipeline
  if (m === 'POST' && pathname === '/api/projects') {
    return readJsonBody(req).then(function (body) {
      var prompt = (body.prompt || '').toString().trim();
      if (!prompt) return sendJson(res, 400, { error: 'prompt 不能为空' });
      var project = createProject(body.mode, prompt);
      sendJson(res, 201, publicProject(project));
    }).catch(function () { sendJson(res, 400, { error: '请求体不是合法 JSON' }); });
  }

  var m1 = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (m1 && m === 'GET') {
    var proj = findProject(m1[1]);
    if (!proj) return sendJson(res, 404, { error: '项目不存在' });
    return sendJson(res, 200, publicProject(proj));
  }
  if (m1 && m === 'PATCH') {
    var proj2 = findProject(m1[1]);
    if (!proj2) return sendJson(res, 404, { error: '项目不存在' });
    return readJsonBody(req).then(function (body) {
      if (body.bgm) proj2.bgm = body.bgm;
      if (body.voice) proj2.voice = body.voice;
      if (body.title) proj2.title = body.title.toString().trim().slice(0, 40) || proj2.title;
      if (Array.isArray(body.shots)) {
        // Client-driven edits (add/delete/reorder/re-caption a shot) — the
        // client already applied the change locally and just asks us to
        // persist the resulting list so a reload doesn't lose it.
        proj2.shots = body.shots.map(function (s) { return { status: s.status, hue: s.hue, caption: s.caption }; });
      }
      if (typeof body.totalDuration === 'number') proj2.totalDuration = body.totalDuration;
      proj2.updatedAt = new Date().toISOString();
      saveDb();
      sendJson(res, 200, publicProject(proj2));
    }).catch(function () { sendJson(res, 400, { error: '请求体不是合法 JSON' }); });
  }
  if (m1 && m === 'DELETE') {
    var delIdx = db.projects.findIndex(function (p) { return p.id === m1[1]; });
    if (delIdx === -1) return sendJson(res, 404, { error: '项目不存在' });
    db.projects.splice(delIdx, 1);
    saveDb();
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/projects/:id/events — SSE live updates
  var m2 = pathname.match(/^\/api\/projects\/([^/]+)\/events$/);
  if (m2 && m === 'GET') {
    var proj3 = findProject(m2[1]);
    if (!proj3) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('retry: 3000\n\n');
    subscribe(proj3.id, res);
    req.on('close', function () { unsubscribe(proj3.id, res); });
    return;
  }

  // POST /api/projects/:id/message {text} — chat-driven actions (regen shot / swap bgm / faster voice)
  var m3 = pathname.match(/^\/api\/projects\/([^/]+)\/message$/);
  if (m3 && m === 'POST') {
    var proj4 = findProject(m3[1]);
    if (!proj4) return sendJson(res, 404, { error: '项目不存在' });
    return readJsonBody(req).then(function (body) {
      var text = (body.text || '').toString();
      pushEntry(proj4, { type: 'user_message', text: text });
      var shotMatch = text.match(/第\s*(\d+)\s*个分镜/);
      if (shotMatch) {
        var idx = parseInt(shotMatch[1], 10) - 1;
        if (proj4.shots[idx]) {
          proj4.shots[idx].status = 'loading';
          pushEntry(proj4, { type: 'shots', shots: cloneShots(proj4.shots) });
          pushEntry(proj4, { type: 'status', text: '重新生成第 ' + (idx + 1) + ' 个分镜…', active: true });
          setTimeout(function () {
            proj4.shots[idx].status = 'ready';
            proj4.shots[idx].hue = (proj4.shots[idx].hue + 40) % 360;
            pushEntry(proj4, { type: 'shots', shots: cloneShots(proj4.shots) });
            pushEntry(proj4, { type: 'ai_message', text: '第 ' + (idx + 1) + ' 个分镜已经重新生成啦，风格调得更活泼了一些～' });
            pushEntry(proj4, { type: 'status', text: '预览确认中，随时可以导出', active: false });
          }, 1100);
        }
      } else if (text.indexOf('背景音乐') !== -1) {
        var candidates = ['海风轻快民谣', '阳光电子流行', '温柔钢琴独奏', '探索感管弦乐'];
        var next = candidates[(candidates.indexOf(proj4.bgm) + 1) % candidates.length];
        proj4.bgm = next;
        pushEntry(proj4, { type: 'ai_message', text: '已经换成「' + next + '」啦，感觉怎么样？' });
      } else if (text.indexOf('音色') !== -1 || text.indexOf('旁白') !== -1) {
        var voiceCandidates = ['知性女声', '活泼童声', '沉稳男声', '温柔姐姐音'];
        var nextVoice = voiceCandidates[(voiceCandidates.indexOf(proj4.voice) + 1) % voiceCandidates.length];
        proj4.voice = nextVoice;
        pushEntry(proj4, { type: 'ai_message', text: '已经把旁白音色换成「' + nextVoice + '」啦。' });
      } else if (text.indexOf('分镜顺序') !== -1) {
        pushEntry(proj4, { type: 'ai_message', text: '已经调整了分镜顺序，你可以在下方分镜列表里查看最新排列。' });
      } else if (text.indexOf('语速') !== -1) {
        pushEntry(proj4, { type: 'ai_message', text: '好的，已经把旁白语速调快了一档。' });
      }
      sendJson(res, 200, { ok: true });
    }).catch(function () { sendJson(res, 400, { error: '请求体不是合法 JSON' }); });
  }

  // POST /api/projects/:id/export — placeholder export
  var m4 = pathname.match(/^\/api\/projects\/([^/]+)\/export$/);
  if (m4 && m === 'POST') {
    var proj5 = findProject(m4[1]);
    if (!proj5) return sendJson(res, 404, { error: '项目不存在' });
    if (!proj5.doneSteps.indexOf) proj5.doneSteps = proj5.doneSteps || [];
    if (proj5.doneSteps.indexOf('preview') === -1) return sendJson(res, 409, { error: '还没有生成完成，无法导出' });
    proj5.exported = true;
    proj5.updatedAt = new Date().toISOString();
    saveDb();
    return sendJson(res, 200, { ok: true, note: '演示模式：这里会触发录屏导出真实视频文件（后台未接入真实渲染）' });
  }

  if (pathname.indexOf('/api/') === 0) return sendJson(res, 404, { error: 'not found' });
  return serveStatic(req, res, pathname);
});

loadDb();
server.listen(PORT, function () {
  console.log('帧语后端运行在 http://localhost:' + PORT + '（数据文件：' + DB_FILE + '）');
});
