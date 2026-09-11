// 帧语 · 真实 Node 后端（零外部依赖：数据库用 Node 内置的 node:sqlite，鉴权用
// Node 内置的 crypto，没有引入任何 npm 包）
//
// 提供静态文件服务 + 一套真实的项目/流水线 REST + SSE 接口，外加真实的账号系统
// （注册/登录/会话 cookie），项目按登录用户归属、持久化在 SQLite 里（见 db.js）。
//
// 生成逻辑本身仍是【占位规则】，不是真实 AI —— 脚本/大纲/配音选择等都由确定性规则
// 从 prompt 里粗略推导出来，用来验证前后端的真实交互链路（创建项目 -> 服务端异步跑
// 流水线 -> SSE 推送每一步 -> 落盘持久化 -> 刷新后可从磁盘恢复）。接入真实文生图 /
// LLM / TTS 时，只需要替换 buildContent() 和各阶段 run() 里“生成”的那一行。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dbLayer = require('./db');
const zhipu = require('./zhipu');
const aliyun = require('./aliyun');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PORT = process.env.PORT || 5173;
// Set COOKIE_SECURE=1 once this is served over HTTPS in production — the
// session cookie must NOT be marked Secure while testing over plain
// http://localhost, or the browser silently refuses to store it.
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wav': 'audio/wav'
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

// ---------- persistence (SQLite via db.js; see that file for the schema) ----------

function findProject(id) { return dbLayer.getProject(id); }
function saveDb(project) { dbLayer.saveProject(project); }

// ---------- auth: cookies + sessions ----------

const SESSION_COOKIE = 'zy_session';

function parseCookies(req) {
  var header = req.headers.cookie;
  var out = {};
  if (!header) return out;
  header.split(';').forEach(function (part) {
    var idx = part.indexOf('=');
    if (idx === -1) return;
    var k = part.slice(0, idx).trim();
    var v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function getCurrentUser(req) {
  var token = parseCookies(req)[SESSION_COOKIE];
  return dbLayer.getUserBySessionToken(token);
}

function setSessionCookie(res, token) {
  var attrs = [
    SESSION_COOKIE + '=' + encodeURIComponent(token),
    'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + (30 * 24 * 60 * 60)
  ];
  if (COOKIE_SECURE) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  var attrs = [SESSION_COOKIE + '=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (COOKIE_SECURE) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function isValidEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }

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
  return shots.map(function (s) {
    return {
      status: s.status, hue: s.hue, caption: s.caption,
      imageUrl: s.imageUrl, imageError: s.imageError,
      audioUrl: s.audioUrl, audioError: s.audioError
    };
  });
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

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

// ---------- pipeline timer registry (so a "cancel" can actually stop a live
// run — kept out of the project object itself since setTimeout handles
// aren't JSON-serializable and project objects get persisted via saveDb) ----------

var pipelineTimers = {}; // projectId -> array of Timeout handles (placeholder/simulated pipeline only)
// The real AI pipeline runs on async/await, not setTimeout, so it can't be
// stopped by clearing timers — it cooperatively checks this flag between
// steps (after each awaited API call) and bails out once it's set.
var pipelineCancelled = {}; // projectId -> true once cancel has been requested

function cancelPipeline(project) {
  pipelineCancelled[project.id] = true;
  var timers = pipelineTimers[project.id];
  var hadTimers = !!(timers && timers.length);
  if (timers) { timers.forEach(clearTimeout); delete pipelineTimers[project.id]; }
  if (project.doneSteps.indexOf('preview') !== -1) { delete pipelineCancelled[project.id]; return false; } // already finished
  if (!hadTimers && project.status !== 'running') { delete pipelineCancelled[project.id]; return false; } // nothing in flight
  project.currentStep = null;
  project.status = 'cancelled';
  project.meta = '已取消';
  pushEntry(project, { type: 'ai_message', text: '已取消生成。你可以重新输入提示词开始一个新项目，或者继续和我说说想怎么调整。' });
  pushEntry(project, { type: 'status', text: '已取消，等待新的指令', active: false });
  return true;
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

function pushEntry(project, entry) {
  entry.at = new Date().toISOString();
  project.timeline.push(entry);
  project.updatedAt = entry.at;
  saveDb(project);
  broadcast(project.id, entry);
}

// ---------- pipeline runner (shared by "live" new projects and "instant" seed generation) ----------

function runPipelineSteps(project, content, live) {
  var shotCount = content.shotCount;

  function at(delay, fn) {
    if (live) {
      var t = setTimeout(fn, delay);
      if (!pipelineTimers[project.id]) pipelineTimers[project.id] = [];
      pipelineTimers[project.id].push(t);
    } else {
      fn();
    }
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
    delete pipelineTimers[project.id]; // pipeline finished on its own — nothing left to ever cancel
  });
}

// ---------- real pipeline (used once ZHIPU_API_KEY is set) ----------
//
// Same timeline shape/entry types as the placeholder pipeline above (so none
// of the client-side rendering needs to change), but every step actually
// waits on a real network call instead of a fixed setTimeout. Narration audio
// (GLM-TTS) isn't wired in yet — the account's voice resource package is
// still empty — so voice/bgm stay picked from the same fixed label list as
// the placeholder pipeline; only script + per-shot images are real.

function buildScriptPrompt(userPrompt, mode) {
  var modeDesc = mode === 'html'
    ? 'HTML 动态网页视频（每个分镜之后会做成一段网页动效画面）'
    : '图片轮播视频（每个分镜是一张静态画面，多张图片按顺序轮播成片）';
  return '你是一名短视频编导，请根据下面的创作需求，直接输出一份可直接使用的短视频方案。\n\n' +
    '创作需求：' + userPrompt + '\n' +
    '视频类型：' + modeDesc + '\n\n' +
    '严格只输出一个 JSON 对象，不要输出任何其他文字、不要用 ``` 代码块包裹。JSON 结构如下：\n' +
    '{\n' +
    '  "title": "视频标题，不超过16个字",\n' +
    '  "script": "完整的开场-正文-结尾解说词全文，200到400字",\n' +
    '  "shots": ["第1个分镜的旁白/字幕文案", "第2个分镜的旁白/字幕文案"]\n' +
    '}\n\n' +
    '要求：shots 数组长度在 4 到 8 之间，根据内容量自行决定；每条分镜文案 15 到 40 字，口语化、适合朗读并配合画面展示。';
}

async function runRealPipeline(project, prompt, mode) {
  function cancelled() { return !!pipelineCancelled[project.id]; }

  pushEntry(project, { type: 'ai_message', text: '收到！我会调用真实的 AI 模型生成脚本和分镜画面，全程无需你确认，请稍候～', kickoff: true });

  var plan;
  try {
    var raw = await zhipu.chatComplete([{ role: 'user', content: buildScriptPrompt(prompt, mode) }]);
    plan = zhipu.parseJsonReply(raw);
    if (!Array.isArray(plan.shots) || !plan.shots.length) throw new Error('模型没有返回有效的分镜列表');
  } catch (e) {
    pushEntry(project, { type: 'ai_message', text: '脚本生成失败：' + e.message + '。可以换一种说法重新输入提示词试试。' });
    pushEntry(project, { type: 'status', text: '生成失败', active: false });
    project.status = 'failed';
    project.meta = '生成失败';
    saveDb(project);
    return;
  }
  if (cancelled()) return;

  var shotCount = plan.shots.length;
  var vb = pickVoiceBgm(prompt);
  var totalDuration = shotCount * 5;

  project.doneSteps.push('script');
  project.currentStep = 'outline';
  if (plan.title) project.title = String(plan.title).trim().slice(0, 40);
  pushEntry(project, { type: 'process_card', id: 'script', title: '脚本已生成', meta: (plan.script || '').length + ' 字 · 时长约 ' + totalDuration + ' 秒', done: true });
  pushEntry(project, { type: 'stepper', currentStep: project.currentStep, doneSteps: project.doneSteps.slice() });
  pushEntry(project, { type: 'status', text: '大纲生成中…', active: true });

  await sleep(300);
  if (cancelled()) return;
  project.doneSteps.push('outline');
  project.currentStep = 'storyboard';
  pushEntry(project, { type: 'process_card', id: 'outline', title: '大纲已生成', meta: '开场 → 核心内容 → 结尾，共 ' + shotCount + ' 个段落', done: true });
  pushEntry(project, { type: 'stepper', currentStep: project.currentStep, doneSteps: project.doneSteps.slice() });
  pushEntry(project, { type: 'status', text: '拆分分镜中…', active: true });

  await sleep(300);
  if (cancelled()) return;
  project.shots = plan.shots.map(function (caption, i) {
    return { status: 'pending', hue: SHOT_HUES[i % SHOT_HUES.length], caption: String(caption).trim() };
  });
  project.doneSteps.push('storyboard');
  project.currentStep = 'frames';
  pushEntry(project, { type: 'shots', shots: cloneShots(project.shots) });
  pushEntry(project, { type: 'process_card', id: 'storyboard', title: '已拆分为 ' + shotCount + ' 个分镜', meta: '每个大纲段落对应 1 个分镜', done: true });
  pushEntry(project, { type: 'process_card', id: 'frames', title: '分镜画面生成中', meta: '', progress: 0 });
  pushEntry(project, { type: 'stepper', currentStep: project.currentStep, doneSteps: project.doneSteps.slice() });
  pushEntry(project, { type: 'status', text: '分镜画面生成中 (0/' + shotCount + ')', active: true });
  pushEntry(project, { type: 'duration', total: totalDuration, done: 0, totalShots: shotCount });

  var assetDir = path.join(DATA_DIR, 'assets', project.id);
  fs.mkdirSync(assetDir, { recursive: true });
  var styleSuffix = mode === 'html'
    ? '，扁平网页风格插画，简洁几何图形，鲜艳配色，不含文字水印'
    : '，插画风格，鲜艳配色，构图饱满，不含文字水印';

  for (var i = 0; i < shotCount; i++) {
    if (cancelled()) return;
    try {
      var img = await zhipu.generateImage(project.shots[i].caption + styleSuffix);
      var ext = img.contentType.indexOf('png') !== -1 ? '.png' : '.jpg';
      var fileName = 'shot-' + i + ext;
      fs.writeFileSync(path.join(assetDir, fileName), img.buffer);
      project.shots[i].status = 'ready';
      project.shots[i].imageUrl = '/data/assets/' + project.id + '/' + fileName;
    } catch (e) {
      // Keep the shot usable even if this one image call failed — it just
      // falls back to the gradient look on the client — rather than blocking
      // the rest of the video over one bad shot.
      project.shots[i].status = 'ready';
      project.shots[i].imageError = e.message;
    }
    var doneCount = i + 1;
    pushEntry(project, { type: 'shots', shots: cloneShots(project.shots) });
    pushEntry(project, { type: 'process_card_progress', id: 'frames', progress: Math.round((doneCount / shotCount) * 100) });
    pushEntry(project, { type: 'status', text: '分镜画面生成中 (' + doneCount + '/' + shotCount + ')', active: true });
    pushEntry(project, { type: 'duration', total: totalDuration, done: doneCount, totalShots: shotCount });
  }
  if (cancelled()) return;

  var failedCount = project.shots.filter(function (s) { return s.imageError; }).length;
  project.doneSteps.push('frames');
  project.currentStep = 'voice';
  pushEntry(project, {
    type: 'process_card_done', id: 'frames', title: '分镜画面已生成',
    meta: failedCount ? (shotCount - failedCount) + '/' + shotCount + ' 张生成成功，' + failedCount + ' 张生成失败已用占位色块代替' : shotCount + ' 个分镜全部完成'
  });
  pushEntry(project, { type: 'stepper', currentStep: project.currentStep, doneSteps: project.doneSteps.slice() });
  project.voice = vb.voice;
  project.bgm = vb.bgm;

  if (aliyun.hasApiKey()) {
    pushEntry(project, { type: 'status', text: '配音生成中 (0/' + shotCount + ')', active: true });
    var voiceId = aliyun.voiceIdFor(vb.voice);
    var voiceFailCount = 0;
    for (var vi = 0; vi < shotCount; vi++) {
      if (cancelled()) return;
      try {
        var audio = await aliyun.synthesizeSpeech(project.shots[vi].caption, { voice: voiceId });
        var audioFileName = 'shot-' + vi + '.wav';
        fs.writeFileSync(path.join(assetDir, audioFileName), audio.buffer);
        project.shots[vi].audioUrl = '/data/assets/' + project.id + '/' + audioFileName;
      } catch (e) {
        voiceFailCount++;
        project.shots[vi].audioError = e.message;
      }
      pushEntry(project, { type: 'shots', shots: cloneShots(project.shots) });
      pushEntry(project, { type: 'status', text: '配音生成中 (' + (vi + 1) + '/' + shotCount + ')', active: true });
    }
    if (cancelled()) return;
    project.doneSteps.push('voice');
    pushEntry(project, {
      type: 'process_card', id: 'voice', title: '分镜配音已生成',
      meta: voiceFailCount
        ? (shotCount - voiceFailCount) + '/' + shotCount + ' 条配音生成成功，' + voiceFailCount + ' 条失败 · 音色：' + vb.voice + ' · 配乐：' + vb.bgm
        : '已生成 ' + shotCount + ' 条真实配音 · 音色：' + vb.voice + ' · 配乐：' + vb.bgm,
      done: true
    });
  } else {
    pushEntry(project, { type: 'status', text: '配音音色匹配中…', active: true });
    await sleep(300);
    if (cancelled()) return;
    project.doneSteps.push('voice');
    pushEntry(project, { type: 'process_card', id: 'voice', title: '配音音色已选定', meta: '旁白：' + vb.voice + ' · 配乐：' + vb.bgm + '（语音合成服务未配置，当前仅为音色标签）', done: true });
  }
  pushEntry(project, { type: 'stepper', currentStep: project.currentStep, doneSteps: project.doneSteps.slice() });
  pushEntry(project, { type: 'status', text: '生成字幕中…', active: true });

  await sleep(300);
  if (cancelled()) return;
  pushEntry(project, { type: 'process_card', id: 'subtitle', title: '字幕已生成', meta: '已根据分镜文案生成 ' + shotCount + ' 条字幕，可随时开关或编辑', done: true });
  pushEntry(project, { type: 'status', text: '剪辑合成中…', active: true });

  await sleep(300);
  if (cancelled()) return;
  project.currentStep = 'preview';
  pushEntry(project, { type: 'process_card', id: 'editing', title: '剪辑合成已完成', meta: '画面、文案与字幕已合成为完整分镜序列', done: true });
  pushEntry(project, { type: 'stepper', currentStep: project.currentStep, doneSteps: project.doneSteps.slice() });
  pushEntry(project, { type: 'status', text: '准备预览…', active: true });

  await sleep(200);
  if (cancelled()) return;
  project.doneSteps.push('preview');
  project.currentStep = 'export';
  project.status = 'ready';
  project.meta = '刚刚生成';
  project.totalDuration = totalDuration;
  project.script = plan.script || project.shots.map(function (s) { return s.caption; }).join('\n');
  var hasRealVoice = aliyun.hasApiKey();
  pushEntry(project, { type: 'stepper', currentStep: project.currentStep, doneSteps: project.doneSteps.slice() });
  pushEntry(project, {
    type: 'summary_card',
    items: ['脚本生成（真实 AI）', '分镜拆分（' + shotCount + ' 个分镜）', '画面生成（真实文生图）', hasRealVoice ? '配音生成（真实语音合成）' : '配音音色选定', '字幕生成', '剪辑合成']
  });
  pushEntry(project, {
    type: 'ai_message',
    text: hasRealVoice
      ? '已经用真实 AI 为你生成好脚本、全部 ' + shotCount + ' 个分镜画面和配音啦。可以点击中间播放预览；如果哪个分镜不满意，直接告诉我要怎么改～'
      : '已经用真实 AI 为你生成好脚本和全部 ' + shotCount + ' 个分镜画面啦，配音暂时还是音色标签（语音合成服务未配置）。可以点击中间播放预览；如果哪个分镜不满意，直接告诉我要怎么改～'
  });
  pushEntry(project, { type: 'script_link', script: project.script });
  pushEntry(project, { type: 'suggestions', items: ['换一个背景音乐', '重新生成第 1 个分镜', '调整分镜顺序'] });
  pushEntry(project, { type: 'status', text: '预览确认中，随时可以导出', active: false });
  delete pipelineCancelled[project.id];
}

function createProject(mode, prompt, userId) {
  var normalizedMode = mode === 'html' ? 'html' : 'slideshow';
  var useRealPipeline = zhipu.hasApiKey();
  // The placeholder pipeline needs its fake content up front (it drives
  // shotCount/totalDuration for the very first save); the real pipeline
  // builds all of that itself from the model's response as it goes, so a
  // generic starting duration is fine until the storyboard step corrects it.
  var content = useRealPipeline ? null : buildContent(prompt);
  var project = {
    id: crypto.randomUUID(),
    userId: userId,
    mode: normalizedMode,
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
    totalDuration: useRealPipeline ? 30 : content.totalDuration,
    exported: false,
    script: '',
    timeline: [{ type: 'user_message', text: prompt, at: new Date().toISOString() }]
  };
  saveDb(project);
  if (useRealPipeline) {
    runRealPipeline(project, prompt, normalizedMode).catch(function (e) {
      pushEntry(project, { type: 'ai_message', text: '生成过程中出现意外错误：' + e.message });
      pushEntry(project, { type: 'status', text: '生成失败', active: false });
      project.status = 'failed';
      saveDb(project);
    });
  } else {
    runPipelineSteps(project, content, true);
  }
  return project;
}

// Demo/showcase projects (user_id = NULL) — seeded once, the first time the
// database is empty, so every fresh install has something in the sidebar to
// look at. They're public and read-only (see the ownership check in the
// route handlers below): anyone can open and preview one, but only a real
// project you created can be edited, exported, or deleted.
function buildSeedProjects() {
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
      userId: null,
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

function publicProject(p, viewer) {
  return {
    id: p.id, mode: p.mode, title: p.title, prompt: p.prompt, meta: p.meta,
    thumbHue: p.thumbHue, status: p.status, doneSteps: p.doneSteps, currentStep: p.currentStep,
    shots: p.shots, voice: p.voice, bgm: p.bgm, totalDuration: p.totalDuration,
    exported: p.exported, timeline: p.timeline, updatedAt: p.updatedAt, script: p.script || '',
    isDemo: p.userId === null,
    isOwner: !!(viewer && p.userId === viewer.id)
  };
}

// A demo/seed project (userId === null) is public and read-only: anyone can
// open and preview it, but only its owner may mutate it. A real project's
// owner is the only one who may do anything with it at all — there's no
// "shared with other users" concept here.
function canMutate(project, user) { return !!user && project.userId === user.id; }

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

  // ---------- auth ----------

  if (m === 'POST' && pathname === '/api/auth/register') {
    return readJsonBody(req).then(function (body) {
      var email = (body.email || '').toString().trim().toLowerCase();
      var password = (body.password || '').toString();
      var displayName = (body.displayName || '').toString().trim().slice(0, 40);
      if (!isValidEmail(email)) return sendJson(res, 400, { error: '邮箱格式不对' });
      if (password.length < 6) return sendJson(res, 400, { error: '密码至少 6 位' });
      var result = dbLayer.createUser(email, password, displayName);
      if (result.error === 'EMAIL_TAKEN') return sendJson(res, 409, { error: '这个邮箱已经注册过了，直接登录吧' });
      var token = dbLayer.createSession(result.user.id);
      setSessionCookie(res, token);
      sendJson(res, 201, { user: result.user });
    }).catch(function () { sendJson(res, 400, { error: '请求体不是合法 JSON' }); });
  }

  if (m === 'POST' && pathname === '/api/auth/login') {
    return readJsonBody(req).then(function (body) {
      var email = (body.email || '').toString().trim().toLowerCase();
      var password = (body.password || '').toString();
      var user = dbLayer.verifyLogin(email, password);
      if (!user) return sendJson(res, 401, { error: '邮箱或密码不对' });
      var token = dbLayer.createSession(user.id);
      setSessionCookie(res, token);
      sendJson(res, 200, { user: user });
    }).catch(function () { sendJson(res, 400, { error: '请求体不是合法 JSON' }); });
  }

  if (m === 'POST' && pathname === '/api/auth/logout') {
    dbLayer.destroySession(parseCookies(req)[SESSION_COOKIE]);
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  if (m === 'GET' && pathname === '/api/auth/me') {
    var me = getCurrentUser(req);
    if (!me) return sendJson(res, 401, { error: '未登录' });
    return sendJson(res, 200, { user: me });
  }

  // ---------- projects ----------

  var currentUser = getCurrentUser(req);

  // GET /api/projects — sidebar list: your own projects + the public demos
  if (m === 'GET' && pathname === '/api/projects') {
    var list = dbLayer.listProjectsFor(currentUser ? currentUser.id : null);
    return sendJson(res, 200, list.map(function (p) {
      return {
        id: p.id, mode: p.mode, title: p.title, meta: p.meta, thumbHue: p.thumbHue,
        status: p.status, updatedAt: p.updatedAt, isDemo: p.userId === null
      };
    }));
  }

  // POST /api/projects {mode, prompt} — create + kick off live pipeline.
  // Requires login: generation calls real (paid) AI services once those are
  // wired in, so an anonymous visitor must not be able to trigger one.
  if (m === 'POST' && pathname === '/api/projects') {
    if (!currentUser) return sendJson(res, 401, { error: '请先登录再创建项目' });
    return readJsonBody(req).then(function (body) {
      var prompt = (body.prompt || '').toString().trim();
      if (!prompt) return sendJson(res, 400, { error: 'prompt 不能为空' });
      var project = createProject(body.mode, prompt, currentUser.id);
      sendJson(res, 201, publicProject(project, currentUser));
    }).catch(function () { sendJson(res, 400, { error: '请求体不是合法 JSON' }); });
  }

  var m1 = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (m1 && m === 'GET') {
    var proj = findProject(m1[1]);
    if (!proj) return sendJson(res, 404, { error: '项目不存在' });
    if (proj.userId !== null && !canMutate(proj, currentUser)) return sendJson(res, 403, { error: '没有权限查看这个项目' });
    return sendJson(res, 200, publicProject(proj, currentUser));
  }
  if (m1 && m === 'PATCH') {
    var proj2 = findProject(m1[1]);
    if (!proj2) return sendJson(res, 404, { error: '项目不存在' });
    if (!canMutate(proj2, currentUser)) return sendJson(res, 403, { error: proj2.userId === null ? '演示项目不可编辑，新建一个属于你自己的项目吧' : '没有权限修改这个项目' });
    return readJsonBody(req).then(function (body) {
      if (body.bgm) proj2.bgm = body.bgm;
      if (body.voice) proj2.voice = body.voice;
      if (body.title) proj2.title = body.title.toString().trim().slice(0, 40) || proj2.title;
      if (Array.isArray(body.shots)) {
        // Client-driven edits (add/delete/reorder/re-caption a shot) — the
        // client already applied the change locally and just asks us to
        // persist the resulting list so a reload doesn't lose it.
        proj2.shots = body.shots.map(function (s) {
          return {
            status: s.status, hue: s.hue, caption: s.caption,
            imageUrl: s.imageUrl, imageError: s.imageError,
            audioUrl: s.audioUrl, audioError: s.audioError
          };
        });
      }
      if (typeof body.totalDuration === 'number') proj2.totalDuration = body.totalDuration;
      proj2.updatedAt = new Date().toISOString();
      saveDb(proj2);
      sendJson(res, 200, publicProject(proj2, currentUser));
    }).catch(function () { sendJson(res, 400, { error: '请求体不是合法 JSON' }); });
  }
  if (m1 && m === 'DELETE') {
    var toDelete = findProject(m1[1]);
    if (!toDelete) return sendJson(res, 404, { error: '项目不存在' });
    if (!canMutate(toDelete, currentUser)) return sendJson(res, 403, { error: toDelete.userId === null ? '演示项目不可删除' : '没有权限删除这个项目' });
    dbLayer.deleteProject(m1[1]);
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/projects/:id/events — SSE live updates
  var m2 = pathname.match(/^\/api\/projects\/([^/]+)\/events$/);
  if (m2 && m === 'GET') {
    var proj3 = findProject(m2[1]);
    if (!proj3) { res.writeHead(404); return res.end(); }
    if (proj3.userId !== null && !canMutate(proj3, currentUser)) { res.writeHead(403); return res.end(); }
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
    if (!canMutate(proj4, currentUser)) return sendJson(res, 403, { error: proj4.userId === null ? '演示项目不可编辑，新建一个属于你自己的项目吧' : '没有权限修改这个项目' });
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
    if (!canMutate(proj5, currentUser)) return sendJson(res, 403, { error: '没有权限导出这个项目' });
    if (!proj5.doneSteps.indexOf) proj5.doneSteps = proj5.doneSteps || [];
    if (proj5.doneSteps.indexOf('preview') === -1) return sendJson(res, 409, { error: '还没有生成完成，无法导出' });
    proj5.exported = true;
    proj5.updatedAt = new Date().toISOString();
    saveDb(proj5);
    return sendJson(res, 200, { ok: true, note: '演示模式：这里会触发录屏导出真实视频文件（后台未接入真实渲染）' });
  }

  // POST /api/projects/:id/cancel — stop a still-running generation
  var m5 = pathname.match(/^\/api\/projects\/([^/]+)\/cancel$/);
  if (m5 && m === 'POST') {
    var proj6 = findProject(m5[1]);
    if (!proj6) return sendJson(res, 404, { error: '项目不存在' });
    if (!canMutate(proj6, currentUser)) return sendJson(res, 403, { error: '没有权限操作这个项目' });
    var cancelled = cancelPipeline(proj6);
    saveDb(proj6);
    return sendJson(res, 200, { ok: true, cancelled: cancelled });
  }

  if (pathname.indexOf('/api/') === 0) return sendJson(res, 404, { error: 'not found' });
  return serveStatic(req, res, pathname);
});

// Seed the public demo projects once, the first time this app runs with an
// empty database — or migrate them in from the pre-SQLite data/projects.json
// if one is sitting there from an older run of this project.
dbLayer.migrateLegacyJsonIfNeeded();
if (dbLayer.listProjectsFor(null).length === 0) {
  buildSeedProjects().forEach(function (p) { dbLayer.saveProject(p); });
}

server.listen(PORT, function () {
  console.log('帧语后端运行在 http://localhost:' + PORT + '（数据库：video-agent/data/app.db）');
});
