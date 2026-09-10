(function () {
  'use strict';

  // ---------- pipeline shape (client-only; must mirror server.js STEP_ORDER) ----------

  var STEP_META = [
    { key: 'script', label: '脚本', full: '生成脚本' },
    { key: 'outline', label: '大纲', full: '生成大纲' },
    { key: 'storyboard', label: '分镜', full: '拆分分镜' },
    { key: 'frames', label: '画面', full: '生成分镜画面' },
    { key: 'voice', label: '声音', full: '生成分镜声音' },
    { key: 'preview', label: '预览', full: '预览 & 修改' },
    { key: 'export', label: '导出', full: '录屏输出' }
  ];
  var LOOP_AFTER_INDEX = 3; // connector between 'frames' (index 3) and 'voice' (index 4)

  // ---------- state (the backend is the source of truth for a project's
  // generation state when reachable; this mirrors whatever is currently
  // loaded for rendering, plus pure client-side concerns like playback
  // position) ----------

  var state = {
    mode: 'slideshow',
    activeProjectId: null,
    projectTitle: '未命名项目',
    doneSteps: new Set(),
    currentStep: null,
    shots: [],
    bgm: '海风轻快民谣',
    voice: '知性女声',
    isPlaying: false,
    playbackTimer: null,
    elapsedSeconds: 0,
    totalDuration: 30,
    subtitlesOn: true
  };

  var eventSource = null;
  // null = not yet checked; true = talking to a real node server.js;
  // false = no backend reachable (e.g. a static Artifact preview) -> fall
  // back to an in-browser demo simulation so the page still works.
  var backendAvailable = null;

  // ---------- small helpers ----------

  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function checkSvgSmall() {
    return '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--surface)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"></path></svg>';
  }
  function checkSvg() {
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--surface)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"></path></svg>';
  }
  function clockSvg() {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 6v6l4 2"></path></svg>';
  }
  function plusSvg() {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"></path></svg>';
  }
  function playSvgSmall() {
    return '<svg id="mini-play-icon" width="16" height="16" viewBox="0 0 24 24" fill="oklch(100% 0 0)" style="cursor:pointer"><path d="M8 5v14l11-7z"></path></svg>';
  }
  function pauseSvgSmall() {
    return '<svg id="mini-play-icon" width="16" height="16" viewBox="0 0 24 24" fill="oklch(100% 0 0)" style="cursor:pointer"><rect x="6" y="5" width="4" height="14"></rect><rect x="14" y="5" width="4" height="14"></rect></svg>';
  }
  function loopIconSvg() {
    return '<svg class="loop-icon" viewBox="0 0 64 26" preserveAspectRatio="none" aria-hidden="true">' +
      '<path d="M6 22 C 6 6, 58 6, 58 20" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"></path>' +
      '<path d="M58 20 L 50 15 M58 20 L 51 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>' +
      '</svg>';
  }

  var toastTimer = null;
  function showToast(msg) {
    var el = document.getElementById('toast');
    clearTimeout(toastTimer);
    el.textContent = msg;
    el.hidden = false;
    toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
  }

  function api(path, opts) {
    opts = opts || {};
    if (opts.body) {
      opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        return { ok: res.ok, status: res.status, body: body };
      });
    });
  }

  // ---------- stepper ----------

  function renderStepper() {
    var el = document.getElementById('stepper');
    el.innerHTML = '';
    STEP_META.forEach(function (step, i) {
      var isDone = state.doneSteps.has(step.key);
      var isCurrent = state.currentStep === step.key;
      var div = document.createElement('div');
      div.className = 'step' + (isDone ? ' is-done' : '') + (isCurrent ? ' is-current' : '');
      div.title = step.full;
      div.innerHTML =
        '<div class="step-circle">' + (isDone ? checkSvg() : '<span>' + (i + 1) + '</span>') + '</div>' +
        '<div class="step-label">' + step.label + '</div>';
      el.appendChild(div);
      if (i < STEP_META.length - 1) {
        var conn = document.createElement('div');
        conn.className = 'step-connector' + (i === LOOP_AFTER_INDEX ? ' step-connector--loop' : '');
        if (i === LOOP_AFTER_INDEX) conn.innerHTML = loopIconSvg();
        el.appendChild(conn);
      }
    });
  }

  // ---------- filmstrip ----------

  function renderFilmstrip() {
    var el = document.getElementById('filmstrip');
    el.innerHTML = '';
    state.shots.forEach(function (shot, i) {
      var btn = document.createElement('button');
      btn.type = 'button';
      var cls = 'filmstrip-item';
      if (shot.status === 'pending') cls += ' is-pending';
      if (shot.status === 'loading') cls += ' is-pending is-loading';
      if (shot.active) cls += ' is-active';
      btn.className = cls;
      if (shot.status === 'ready') {
        btn.style.background = 'linear-gradient(160deg, oklch(84% 0.07 ' + shot.hue + '), oklch(70% 0.08 ' + (shot.hue + 10) + '))';
      }
      var inner = '<span class="filmstrip-item__num">' + String(i + 1).padStart(2, '0') + '</span>';
      if (shot.status !== 'ready') inner += clockSvg();
      btn.innerHTML = inner;
      btn.addEventListener('click', function () { selectShot(i); });
      el.appendChild(btn);
    });
    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'filmstrip-add';
    addBtn.innerHTML = plusSvg();
    addBtn.setAttribute('aria-label', '新增分镜');
    addBtn.addEventListener('click', function () { showToast('演示原型：这里会新增一个分镜'); });
    el.appendChild(addBtn);
    document.getElementById('filmstrip-label').textContent = '分镜 · ' + state.shots.length + ' 个';
  }

  function selectShot(i) {
    state.shots.forEach(function (s, idx) { s.active = idx === i; });
    renderFilmstrip();
    var shot = state.shots[i];
    var scene = document.getElementById('player-scene');
    var msg = scene.querySelector('.player-empty-msg');
    if (shot && shot.status === 'ready') {
      scene.style.background = 'linear-gradient(165deg, oklch(80% 0.09 ' + shot.hue + '), oklch(58% 0.09 ' + (shot.hue + 20) + '))';
      if (msg) msg.hidden = true;
    }
    updateSubtitleUI(shot, i);
    resetPlaybackProgress();
  }

  function resetPlayerToEmpty() {
    var scene = document.getElementById('player-scene');
    scene.style.background = '';
    var msg = scene.querySelector('.player-empty-msg');
    if (msg) msg.hidden = false;
    updateSubtitleUI(null, -1);
    resetPlaybackProgress();
  }

  // ---------- subtitle toggle ----------

  function updateSubtitleUI(shot, index) {
    var el = document.getElementById('player-subtitle');
    if (!el) return;
    if (!state.subtitlesOn || !shot || shot.status !== 'ready') { el.hidden = true; return; }
    el.textContent = shot.caption || ('第 ' + (index + 1) + ' 段画面旁白');
    el.hidden = false;
  }

  function toggleSubtitles() {
    state.subtitlesOn = !state.subtitlesOn;
    var btn = document.getElementById('btn-subtitle');
    btn.classList.toggle('is-active', state.subtitlesOn);
    btn.setAttribute('aria-pressed', String(state.subtitlesOn));
    var activeIdx = state.shots.findIndex(function (s) { return s.active; });
    updateSubtitleUI(state.shots[activeIdx], activeIdx);
    showToast(state.subtitlesOn ? '字幕已开启' : '字幕已关闭');
  }

  // ---------- playback (purely client-side; no server concept of "now playing") ----------

  function resetPlaybackProgress() {
    stopPlaybackInterval();
    state.isPlaying = false;
    state.elapsedSeconds = 0;
    document.getElementById('player-play-btn').style.opacity = '1';
    document.getElementById('player-play-btn').style.pointerEvents = 'auto';
    var mini = document.getElementById('mini-play-icon');
    if (mini) mini.outerHTML = playSvgSmall();
    document.getElementById('progress-fill').style.width = '0%';
    document.getElementById('time-label').textContent = '00:00 / ' + formatTime(state.totalDuration);
  }

  function updatePlaybackUI() {
    var pct = state.totalDuration ? (state.elapsedSeconds / state.totalDuration * 100) : 0;
    document.getElementById('progress-fill').style.width = Math.min(100, pct) + '%';
    document.getElementById('time-label').textContent = formatTime(state.elapsedSeconds) + ' / ' + formatTime(state.totalDuration);
  }

  function stopPlaybackInterval() {
    if (state.playbackTimer) { clearInterval(state.playbackTimer); state.playbackTimer = null; }
  }

  function togglePlayback() {
    if (!state.shots.length) { showToast('还没有可播放的内容，先在右侧输入提示词试试吧'); return; }
    state.isPlaying = !state.isPlaying;
    var bigBtn = document.getElementById('player-play-btn');
    var mini = document.getElementById('mini-play-icon');
    if (state.isPlaying) {
      bigBtn.style.opacity = '0';
      bigBtn.style.pointerEvents = 'none';
      if (mini) mini.outerHTML = pauseSvgSmall();
      state.playbackTimer = setInterval(function () {
        state.elapsedSeconds += 0.5;
        if (state.elapsedSeconds >= state.totalDuration) {
          state.elapsedSeconds = state.totalDuration;
          stopPlaybackInterval();
          state.isPlaying = false;
          bigBtn.style.opacity = '1';
          bigBtn.style.pointerEvents = 'auto';
          var miniEl = document.getElementById('mini-play-icon');
          if (miniEl) miniEl.outerHTML = playSvgSmall();
        }
        updatePlaybackUI();
      }, 100);
    } else {
      bigBtn.style.opacity = '1';
      bigBtn.style.pointerEvents = 'auto';
      if (mini) mini.outerHTML = playSvgSmall();
      stopPlaybackInterval();
    }
  }

  // ---------- fullscreen preview ----------

  function enterFullscreen() {
    document.getElementById('player-wrap').classList.add('is-fullscreen');
    document.getElementById('player-close-btn').hidden = false;
    document.getElementById('backdrop').hidden = false;
  }
  function exitFullscreen() {
    document.getElementById('player-wrap').classList.remove('is-fullscreen');
    document.getElementById('player-close-btn').hidden = true;
    document.getElementById('backdrop').hidden = true;
  }

  // ---------- chat log ----------

  function chatLogEl() { return document.getElementById('chat-log'); }
  function scrollChatToBottom() { var el = chatLogEl(); el.scrollTop = el.scrollHeight; }
  function clearChatLogDom() { chatLogEl().innerHTML = ''; }

  function addUserMessage(text) {
    var wrap = document.createElement('div');
    wrap.className = 'msg msg-user';
    var bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);
    chatLogEl().appendChild(wrap);
    scrollChatToBottom();
  }

  function addAiText(text) {
    var wrap = document.createElement('div');
    wrap.className = 'msg msg-ai';
    var bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);
    chatLogEl().appendChild(wrap);
    scrollChatToBottom();
  }

  function addProcessCard(id, title, meta, opts) {
    opts = opts || {};
    var card = document.createElement('div');
    card.className = 'process-card ' + (opts.done ? 'is-done' : 'is-progress');
    card.dataset.id = id;
    var barHtml = (typeof opts.progress === 'number')
      ? '<div class="process-card__bar"><div class="process-card__bar-fill" style="width:' + opts.progress + '%"></div></div>'
      : '';
    card.innerHTML =
      '<div class="process-card__icon">' + (opts.done ? checkSvgSmall() : '') + '</div>' +
      '<div class="process-card__body">' +
        '<div class="process-card__title">' + escapeHtml(title) + '</div>' +
        '<div class="process-card__meta">' + escapeHtml(meta || '') + '</div>' +
        barHtml +
      '</div>';
    chatLogEl().appendChild(card);
    scrollChatToBottom();
    return card;
  }

  function updateProcessCardProgress(id, pct) {
    var card = chatLogEl().querySelector('[data-id="' + id + '"]');
    if (!card) return;
    var fill = card.querySelector('.process-card__bar-fill');
    if (fill) fill.style.width = pct + '%';
  }

  function markProcessCardDone(id, title, meta) {
    var card = chatLogEl().querySelector('[data-id="' + id + '"]');
    if (!card) return;
    card.classList.remove('is-progress');
    card.classList.add('is-done');
    card.querySelector('.process-card__icon').innerHTML = checkSvgSmall();
    card.querySelector('.process-card__title').textContent = title;
    card.querySelector('.process-card__meta').textContent = meta;
    var bar = card.querySelector('.process-card__bar');
    if (bar) bar.remove();
  }

  function showSuggestions(list) {
    var el = document.getElementById('suggestions');
    el.innerHTML = '';
    list.forEach(function (text) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'suggestion-chip';
      chip.textContent = text;
      chip.addEventListener('click', function () { handleSuggestionClick(text); });
      el.appendChild(chip);
    });
    el.hidden = false;
  }

  function handleSuggestionClick(text) {
    if (backendAvailable === false) { localHandleMessage(text); return; }
    if (!state.activeProjectId) return;
    postMessage(state.activeProjectId, text);
  }

  function setStatus(text, active) {
    document.getElementById('status-text').textContent = text;
    document.getElementById('status-dot').classList.toggle('is-active', !!active);
  }

  function updateDurationInfo(total, done, totalShots) {
    state.totalDuration = total || 30;
    document.getElementById('duration-info').textContent = '共 ' + total + ' 秒 · ' + done + '/' + totalShots + ' 分镜已生成';
  }

  // ---------- project title / mode UI ----------

  function updateProjectTitleUI() { document.getElementById('project-title').textContent = state.projectTitle; }

  function updateModeSwitchUI() {
    $all('.mode-switch__btn').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.dataset.mode === state.mode);
    });
  }

  function highlightActiveSidebar(id) {
    $all('.project-item').forEach(function (el) {
      el.classList.toggle('is-active', el.dataset.id === id);
    });
  }

  function deriveTitle(text) {
    return text.length > 16 ? text.slice(0, 16) + '…' : text;
  }

  // ---------- applying one timeline entry (shared by history replay, live
  // SSE from a real backend, AND the local no-backend simulation below) ----------

  function applyEntry(entry) {
    switch (entry.type) {
      case 'user_message':
        addUserMessage(entry.text);
        break;
      case 'ai_message':
        addAiText(entry.text);
        break;
      case 'process_card':
        addProcessCard(entry.id, entry.title, entry.meta, { done: entry.done, progress: entry.progress });
        break;
      case 'process_card_progress':
        updateProcessCardProgress(entry.id, entry.progress);
        break;
      case 'process_card_done':
        markProcessCardDone(entry.id, entry.title, entry.meta);
        break;
      case 'stepper':
        state.doneSteps = new Set(entry.doneSteps);
        state.currentStep = entry.currentStep;
        renderStepper();
        break;
      case 'shots':
        state.shots = entry.shots.map(function (s) { return { status: s.status, hue: s.hue, caption: s.caption }; });
        renderFilmstrip();
        if (!state.shots.some(function (s) { return s.active; })) {
          var readyIdx = state.shots.findIndex(function (s) { return s.status === 'ready'; });
          if (readyIdx !== -1) selectShot(readyIdx);
        }
        break;
      case 'status':
        setStatus(entry.text, entry.active);
        break;
      case 'duration':
        updateDurationInfo(entry.total, entry.done, entry.totalShots);
        break;
      case 'suggestions':
        showSuggestions(entry.items);
        break;
    }
  }

  // ---------- SSE (real backend only) ----------

  function closeEventSource() {
    if (eventSource) { eventSource.close(); eventSource = null; }
  }

  function subscribeToProject(id) {
    closeEventSource();
    eventSource = new EventSource('/api/projects/' + id + '/events');
    eventSource.onmessage = function (e) {
      try { applyEntry(JSON.parse(e.data)); } catch (err) { /* ignore malformed frame */ }
    };
    eventSource.onerror = function () {
      // Backend restarted or unreachable — surface it once, browser will keep retrying.
    };
  }

  // =====================================================================
  // Local, no-backend fallback simulation. Used only when no server.js is
  // reachable (e.g. this page was opened as a static preview link). Drives
  // the exact same render path as the real backend via applyEntry(), so
  // this is the only place backend-vs-local logic branches.
  // =====================================================================

  var LOCAL_SHOT_HUES = [220, 340, 160, 90, 280, 40, 200, 120];
  var LOCAL_VOICE_BGM_RULES = [
    { test: /儿童|童声|小朋友|科普.{0,4}可爱/, voice: '活泼童声', bgm: '阳光电子流行' },
    { test: /培训|安全|严谨|流程|企业/, voice: '沉稳男声', bgm: '探索感管弦乐' },
    { test: /情怀|品牌故事|温暖|车库|历程/, voice: '温柔姐姐音', bgm: '温柔钢琴独奏' },
    { test: /种草|小红书|网感|好物|安利/, voice: '活泼童声', bgm: '阳光电子流行' }
  ];
  var LOCAL_DEFAULT_VOICE_BGM = { voice: '知性女声', bgm: '海风轻快民谣' };

  var LOCAL_SEEDS = [
    { id: 'ocean', title: '海洋生物科普·儿童向', mode: 'slideshow', meta: '编辑中',
      prompt: '帮我做一支 30 秒的儿童科普视频，讲海洋生物，风格活泼可爱，配欢快背景音乐' },
    { id: 'autumn', title: '秋季新品发布预告片', mode: 'html', meta: '2 小时前',
      prompt: '做一支 20 秒的秋季新品发布预告片，突出温暖色调和限时优惠，风格干净有质感',
      reply: '预告片已经生成好啦，网页动效场景全部就绪，配的是电子流行风背景音乐，你可以直接预览～' },
    { id: 'training', title: '内部培训引导视频', mode: 'slideshow', meta: '昨天',
      prompt: '做一支面向新员工的安全生产培训引导视频，语气严谨但不生硬，40 秒左右',
      reply: '培训视频已生成，分镜按"流程讲解 + 案例提醒"的顺序排好了，配音用的是沉稳男声。' },
    { id: 'skincare', title: '小红书种草·护肤新品', mode: 'slideshow', meta: '3 天前',
      prompt: '帮我做一条小红书种草视频脚本，主打一款保湿精华，15 秒内，节奏要快、有网感',
      reply: '种草视频做好啦，分镜图配上了轻快电子乐，笔调也调成了小红书常见的口语化语气。' },
    { id: 'case', title: '客户案例讲解 Demo', mode: 'html', meta: '上周',
      prompt: '用一支 25 秒的动态视频讲解一个客户成功案例，突出前后数据对比',
      reply: '案例讲解视频已生成，用网页动效做了数据对比的动态图表。' },
    { id: 'brand', title: '品牌故事 30 秒版', mode: 'html', meta: '上周',
      prompt: '做一支 30 秒的品牌故事短片，讲讲我们从车库创业到现在的历程，风格要有情怀',
      reply: '品牌故事已生成，网页动效串起了时间线，配的是有情怀感的钢琴独奏背景音乐。' }
  ];

  function localHueForText(text) {
    var h = 0;
    for (var i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    return LOCAL_SHOT_HUES[h % LOCAL_SHOT_HUES.length];
  }
  function localPickShotCount(prompt) {
    var n = Math.round(prompt.length / 8);
    return Math.max(4, Math.min(8, n || 6));
  }
  function localPickVoiceBgm(prompt) {
    for (var i = 0; i < LOCAL_VOICE_BGM_RULES.length; i++) {
      if (LOCAL_VOICE_BGM_RULES[i].test.test(prompt)) return { voice: LOCAL_VOICE_BGM_RULES[i].voice, bgm: LOCAL_VOICE_BGM_RULES[i].bgm };
    }
    return LOCAL_DEFAULT_VOICE_BGM;
  }
  // Splits the prompt into rough clauses to stand in for per-shot narration
  // captions — a real backend would generate one narration line per shot
  // alongside the script, but the local demo has no such text to draw on.
  function localSplitCaptions(prompt, shotCount) {
    var parts = prompt.split(/[，。！？,.!?、~]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!parts.length) parts = [prompt];
    var out = [];
    for (var i = 0; i < shotCount; i++) out.push(parts[i % parts.length]);
    return out;
  }
  function localBuildContent(prompt) {
    var shotCount = localPickShotCount(prompt);
    var vb = localPickVoiceBgm(prompt);
    var totalDuration = shotCount * 5;
    var captions = localSplitCaptions(prompt, shotCount);
    var shots = [];
    for (var i = 0; i < shotCount; i++) shots.push({ status: 'pending', hue: LOCAL_SHOT_HUES[i % LOCAL_SHOT_HUES.length], caption: captions[i] });
    return {
      shotCount: shotCount, totalDuration: totalDuration, voice: vb.voice, bgm: vb.bgm, shots: shots,
      scriptMeta: Math.max(60, prompt.length * 6) + ' 字 · 时长约 ' + totalDuration + ' 秒',
      outlineMeta: '开场 → 核心内容 → 结尾，共 ' + shotCount + ' 个段落',
      storyboardMeta: '每个大纲段落对应 1 个分镜',
      completionText: '已经为你生成好全部 ' + shotCount + ' 个分镜的画面和声音啦，画面时长也按配音重新对齐过了。可以点击中间播放预览；如果哪个分镜不满意，直接告诉我要怎么改～'
    };
  }

  var localTimers = [];
  function localClearTimers() { localTimers.forEach(clearTimeout); localTimers = []; }
  function localAt(delay, fn, live) { if (live) { localTimers.push(setTimeout(fn, delay)); } else { fn(); } }

  function localRunPipeline(prompt, live) {
    var content = localBuildContent(prompt);
    var shotCount = content.shotCount;
    var doneSteps = [];

    localAt(500, function () {
      doneSteps.push('script');
      applyEntry({ type: 'process_card', id: 'script', title: '脚本已生成', meta: content.scriptMeta, done: true });
      applyEntry({ type: 'stepper', currentStep: 'outline', doneSteps: doneSteps.slice() });
      applyEntry({ type: 'status', text: '大纲生成中…', active: true });
    }, live);

    localAt(1000, function () {
      doneSteps.push('outline');
      applyEntry({ type: 'process_card', id: 'outline', title: '大纲已生成', meta: content.outlineMeta, done: true });
      applyEntry({ type: 'stepper', currentStep: 'storyboard', doneSteps: doneSteps.slice() });
      applyEntry({ type: 'status', text: '拆分分镜中…', active: true });
    }, live);

    localAt(1600, function () {
      var shots = content.shots.map(function (s) { return { status: 'pending', hue: s.hue, caption: s.caption }; });
      doneSteps.push('storyboard');
      applyEntry({ type: 'shots', shots: shots });
      applyEntry({ type: 'process_card', id: 'storyboard', title: '已拆分为 ' + shotCount + ' 个分镜', meta: content.storyboardMeta, done: true });
      applyEntry({ type: 'process_card', id: 'frames', title: '分镜画面生成中', meta: '', progress: 0 });
      applyEntry({ type: 'stepper', currentStep: 'frames', doneSteps: doneSteps.slice() });
      applyEntry({ type: 'status', text: '分镜画面生成中 (0/' + shotCount + ')', active: true });
      applyEntry({ type: 'duration', total: content.totalDuration, done: 0, totalShots: shotCount });
    }, live);

    for (var i = 0; i < shotCount; i++) {
      (function (idx) {
        localAt(1600 + 500 * (idx + 1), function () {
          var shots = state.shots.map(function (s) { return { status: s.status, hue: s.hue, caption: s.caption }; });
          shots[idx] = { status: 'ready', hue: content.shots[idx].hue, caption: content.shots[idx].caption };
          applyEntry({ type: 'shots', shots: shots });
          var doneCount = idx + 1;
          applyEntry({ type: 'process_card_progress', id: 'frames', progress: Math.round((doneCount / shotCount) * 100) });
          applyEntry({ type: 'status', text: '分镜画面生成中 (' + doneCount + '/' + shotCount + ')', active: true });
          applyEntry({ type: 'duration', total: content.totalDuration, done: doneCount, totalShots: shotCount });
          if (doneCount === shotCount) {
            doneSteps.push('frames');
            applyEntry({ type: 'process_card_done', id: 'frames', title: '分镜画面已生成', meta: shotCount + ' 个分镜全部完成' });
            applyEntry({ type: 'stepper', currentStep: 'voice', doneSteps: doneSteps.slice() });
            applyEntry({ type: 'status', text: '分镜声音生成中…', active: true });
          }
        }, live);
      })(i);
    }

    var afterFrames = 1600 + 500 * shotCount;

    localAt(afterFrames + 700, function () {
      doneSteps.push('voice');
      state.bgm = content.bgm;
      state.voice = content.voice;
      var bgmSel = document.getElementById('select-bgm'); if (bgmSel) bgmSel.value = content.bgm;
      var voiceSel = document.getElementById('select-voice'); if (voiceSel) voiceSel.value = content.voice;
      applyEntry({ type: 'process_card', id: 'voice', title: '分镜声音已生成', meta: '旁白：' + content.voice + ' · 配乐：' + content.bgm, done: true });
      applyEntry({ type: 'stepper', currentStep: 'voice', doneSteps: doneSteps.slice() });
      applyEntry({ type: 'status', text: '按配音时长回调画面时长…', active: true });
    }, live);

    localAt(afterFrames + 1300, function () {
      applyEntry({ type: 'process_card', id: 'sync', title: '已回调分镜画面时长', meta: '已按配音时长重新同步 ' + shotCount + ' 个分镜的展示时长', done: true });
      applyEntry({ type: 'stepper', currentStep: 'preview', doneSteps: doneSteps.slice() });
      applyEntry({ type: 'status', text: '准备预览…', active: true });
    }, live);

    localAt(afterFrames + 1900, function () {
      doneSteps.push('preview');
      applyEntry({ type: 'stepper', currentStep: 'export', doneSteps: doneSteps.slice() });
      applyEntry({ type: 'ai_message', text: content.completionText });
      applyEntry({ type: 'suggestions', items: ['重新生成第 3 个分镜', '换一个背景音乐', '语速再快一点'] });
      applyEntry({ type: 'status', text: '预览确认中，随时可以导出', active: false });
    }, live);
  }

  function localHandleMessage(text) {
    applyEntry({ type: 'user_message', text: text });
    var m = text.match(/第\s*(\d+)\s*个分镜/);
    if (m) {
      var idx = parseInt(m[1], 10) - 1;
      if (state.shots[idx]) {
        var shots = state.shots.map(function (s) { return { status: s.status, hue: s.hue, caption: s.caption }; });
        shots[idx] = { status: 'loading', hue: shots[idx].hue, caption: shots[idx].caption };
        applyEntry({ type: 'shots', shots: shots });
        applyEntry({ type: 'status', text: '重新生成第 ' + (idx + 1) + ' 个分镜…', active: true });
        localTimers.push(setTimeout(function () {
          var shots2 = state.shots.map(function (s) { return { status: s.status, hue: s.hue, caption: s.caption }; });
          shots2[idx] = { status: 'ready', hue: (shots2[idx].hue + 40) % 360, caption: shots2[idx].caption };
          applyEntry({ type: 'shots', shots: shots2 });
          applyEntry({ type: 'ai_message', text: '第 ' + (idx + 1) + ' 个分镜已经重新生成啦，风格调得更活泼了一些～' });
          applyEntry({ type: 'status', text: '预览确认中，随时可以导出', active: false });
        }, 1100));
      }
    } else if (text.indexOf('背景音乐') !== -1) {
      var candidates = ['海风轻快民谣', '阳光电子流行', '温柔钢琴独奏', '探索感管弦乐'];
      var next = candidates[(candidates.indexOf(state.bgm) + 1) % candidates.length];
      state.bgm = next;
      var bgmSel = document.getElementById('select-bgm'); if (bgmSel) bgmSel.value = next;
      applyEntry({ type: 'ai_message', text: '已经换成「' + next + '」啦，感觉怎么样？' });
    } else if (text.indexOf('语速') !== -1) {
      applyEntry({ type: 'ai_message', text: '好的，已经把旁白语速调快了一档。' });
    }
  }

  function loadLocalProject(id) {
    localClearTimers();
    var seed = LOCAL_SEEDS.filter(function (s) { return s.id === id; })[0];
    if (!seed) return;
    state.activeProjectId = id;
    state.mode = seed.mode;
    state.projectTitle = seed.title;
    state.bgm = LOCAL_DEFAULT_VOICE_BGM.bgm;
    state.voice = LOCAL_DEFAULT_VOICE_BGM.voice;
    updateModeSwitchUI();
    updateProjectTitleUI();
    highlightActiveSidebar(id);
    state.doneSteps = new Set();
    state.currentStep = null;
    state.shots = [];
    renderStepper();
    renderFilmstrip();
    resetPlayerToEmpty();
    clearChatLogDom();
    document.getElementById('suggestions').hidden = true;

    var content = localBuildContent(seed.prompt);
    applyEntry({ type: 'user_message', text: seed.prompt });
    applyEntry({ type: 'process_card', id: 'script', title: '脚本已生成', meta: content.scriptMeta, done: true });
    applyEntry({ type: 'process_card', id: 'outline', title: '大纲已生成', meta: content.outlineMeta, done: true });

    if (id === 'ocean') {
      var readyTarget = Math.max(1, content.shotCount - 2);
      var remaining = content.shotCount - readyTarget;
      var shots = content.shots.map(function (s, i) { return { status: i < readyTarget ? 'ready' : 'loading', hue: s.hue, caption: s.caption }; });
      applyEntry({ type: 'shots', shots: shots });
      applyEntry({ type: 'process_card', id: 'storyboard', title: '已拆分为 ' + content.shotCount + ' 个分镜', meta: content.storyboardMeta, done: true });
      applyEntry({ type: 'process_card', id: 'frames', title: '分镜画面生成中', meta: '', progress: Math.round((readyTarget / content.shotCount) * 100) });
      applyEntry({ type: 'stepper', currentStep: 'frames', doneSteps: ['script', 'outline', 'storyboard'] });
      applyEntry({ type: 'status', text: '分镜画面生成中 (' + readyTarget + '/' + content.shotCount + ')', active: true });
      applyEntry({ type: 'duration', total: content.totalDuration, done: readyTarget, totalShots: content.shotCount });
      applyEntry({ type: 'ai_message', text: '已经为前 ' + readyTarget + ' 个分镜生成好画面啦，还剩 ' + remaining + ' 个在生成中，大概 20 秒，之后会接着生成配音和配乐。你可以先预览已完成的部分，如果不满意某个分镜的画风，直接告诉我要怎么改～' });
      applyEntry({ type: 'suggestions', items: ['重新生成第 ' + content.shotCount + ' 个分镜', '换一个背景音乐', '语速再快一点'] });
    } else {
      state.bgm = content.bgm;
      state.voice = content.voice;
      var bgmSel = document.getElementById('select-bgm'); if (bgmSel) bgmSel.value = content.bgm;
      var voiceSel = document.getElementById('select-voice'); if (voiceSel) voiceSel.value = content.voice;
      var shots2 = content.shots.map(function (s) { return { status: 'ready', hue: s.hue, caption: s.caption }; });
      applyEntry({ type: 'shots', shots: shots2 });
      applyEntry({ type: 'process_card', id: 'storyboard', title: '已拆分为 ' + content.shotCount + ' 个分镜', meta: '', done: true });
      applyEntry({ type: 'process_card', id: 'frames', title: '分镜画面已生成', meta: content.shotCount + ' 个分镜全部完成', done: true });
      applyEntry({ type: 'process_card', id: 'voice', title: '分镜声音已生成', meta: '旁白：' + content.voice + ' · 配乐：' + content.bgm, done: true });
      applyEntry({ type: 'process_card', id: 'sync', title: '已回调分镜画面时长', meta: '已按配音时长重新同步展示时长', done: true });
      applyEntry({ type: 'stepper', currentStep: null, doneSteps: ['script', 'outline', 'storyboard', 'frames', 'voice', 'preview', 'export'] });
      applyEntry({ type: 'ai_message', text: seed.reply || content.completionText });
      applyEntry({ type: 'status', text: '创作完成', active: false });
      applyEntry({ type: 'duration', total: content.totalDuration, done: content.shotCount, totalShots: content.shotCount });
    }
  }

  function buildLocalProjectList() {
    var listEl = document.getElementById('project-list');
    listEl.innerHTML = '';
    LOCAL_SEEDS.forEach(function (seed) {
      var hue = localHueForText(seed.id);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'project-item';
      btn.dataset.id = seed.id;
      var thumb = 'linear-gradient(160deg, oklch(84% 0.07 ' + hue + '), oklch(70% 0.08 ' + (hue + 10) + '))';
      btn.innerHTML =
        '<div class="project-thumb" style="background:' + thumb + '"></div>' +
        '<div class="project-item-body">' +
          '<span class="project-item-title">' + escapeHtml(seed.title) + '</span>' +
          '<span class="project-item-meta">' + (seed.mode === 'slideshow' ? '图片轮播' : 'HTML 视频') + ' · ' + escapeHtml(seed.meta) + '</span>' +
        '</div>';
      btn.addEventListener('click', function () {
        loadLocalProject(seed.id);
        location.hash = '#/workspace';
      });
      listEl.appendChild(btn);
    });
  }

  // =====================================================================
  // Real-backend path
  // =====================================================================

  function renderSidebarFromList(list) {
    var listEl = document.getElementById('project-list');
    listEl.innerHTML = '';
    list.forEach(function (proj) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'project-item';
      btn.dataset.id = proj.id;
      var thumb = 'linear-gradient(160deg, oklch(84% 0.07 ' + proj.thumbHue + '), oklch(70% 0.08 ' + (proj.thumbHue + 10) + '))';
      btn.innerHTML =
        '<div class="project-thumb" style="background:' + thumb + '"></div>' +
        '<div class="project-item-body">' +
          '<span class="project-item-title">' + escapeHtml(proj.title) + '</span>' +
          '<span class="project-item-meta">' + (proj.mode === 'slideshow' ? '图片轮播' : 'HTML 视频') + ' · ' + escapeHtml(proj.status === 'running' ? '编辑中' : proj.meta) + '</span>' +
        '</div>';
      btn.addEventListener('click', function () {
        loadProjectFromServer(proj.id);
        location.hash = '#/workspace';
      });
      listEl.appendChild(btn);
      if (proj.id === state.activeProjectId) btn.classList.add('is-active');
    });
  }

  function refreshProjectList() {
    return api('/api/projects').then(function (res) {
      if (res.ok) renderSidebarFromList(res.body);
    });
  }

  function loadProjectFromServer(id) {
    closeEventSource();
    api('/api/projects/' + id).then(function (res) {
      if (!res.ok) { showToast('加载项目失败：' + (res.body.error || res.status)); return; }
      var proj = res.body;
      state.activeProjectId = proj.id;
      state.mode = proj.mode;
      state.projectTitle = proj.title;
      state.bgm = proj.bgm;
      state.voice = proj.voice;
      updateModeSwitchUI();
      updateProjectTitleUI();
      highlightActiveSidebar(id);
      var bgmSel = document.getElementById('select-bgm');
      var voiceSel = document.getElementById('select-voice');
      if (bgmSel) bgmSel.value = proj.bgm;
      if (voiceSel) voiceSel.value = proj.voice;
      state.doneSteps = new Set();
      state.currentStep = null;
      state.shots = [];
      renderStepper();
      renderFilmstrip();
      resetPlayerToEmpty();
      clearChatLogDom();
      document.getElementById('suggestions').hidden = true;
      proj.timeline.forEach(applyEntry);
      subscribeToProject(id);
    }).catch(function () {
      showToast('无法连接后端服务（' + location.origin + '），请确认 node video-agent/server.js 正在运行');
    });
  }

  function postMessage(id, text) {
    api('/api/projects/' + id + '/message', { method: 'POST', body: { text: text } }).then(function (res) {
      if (!res.ok) showToast('发送失败：' + (res.body.error || res.status));
    }).catch(function () {
      showToast('无法连接后端服务，请确认 node video-agent/server.js 正在运行');
    });
  }

  // ---------- unified entry points (branch on backendAvailable) ----------

  function openProject(id) {
    if (backendAvailable === false) loadLocalProject(id);
    else loadProjectFromServer(id);
  }

  function startNewProject(mode) {
    closeEventSource();
    localClearTimers();
    state.mode = mode || state.mode;
    state.activeProjectId = null;
    state.projectTitle = '未命名项目';
    state.doneSteps = new Set();
    state.currentStep = null;
    state.shots = [];
    updateModeSwitchUI();
    updateProjectTitleUI();
    highlightActiveSidebar(null);
    renderStepper();
    renderFilmstrip();
    resetPlayerToEmpty();
    clearChatLogDom();
    var empty = document.createElement('p');
    empty.id = 'chat-empty';
    empty.className = 'chat-empty';
    empty.textContent = '在下方输入你想拍的视频内容，比如："帮我做一支 30 秒的儿童科普视频，讲海洋生物，风格活泼可爱，配欢快背景音乐"。发送后，AI 会严格按照"脚本→大纲→分镜→画面→声音→预览&修改→导出"的顺序，在这里逐步展示生成过程。';
    chatLogEl().appendChild(empty);
    var sug = document.getElementById('suggestions');
    sug.hidden = true; sug.innerHTML = '';
    setStatus('等待你的创意提示词', false);
    updateDurationInfo(0, 0, 0);
    var input = document.getElementById('chat-input');
    input.value = '';
    input.focus();
  }

  function handleSend() {
    var input = document.getElementById('chat-input');
    var text = input.value.trim();
    if (!text) return;
    input.value = '';

    if (state.activeProjectId) {
      addUserMessage(text);
      if (backendAvailable === false) localHandleMessage(text);
      else postMessage(state.activeProjectId, text);
      return;
    }

    var emptyMsg = document.getElementById('chat-empty');
    if (emptyMsg) emptyMsg.remove();
    document.getElementById('suggestions').hidden = true;
    state.projectTitle = deriveTitle(text);
    updateProjectTitleUI();
    addUserMessage(text);
    setStatus('创建项目中…', true);

    if (backendAvailable === false) {
      state.activeProjectId = 'local-' + Date.now();
      localRunPipeline(text, true);
      return;
    }

    api('/api/projects', { method: 'POST', body: { mode: state.mode, prompt: text } }).then(function (res) {
      if (!res.ok) { showToast('创建项目失败：' + (res.body.error || res.status)); setStatus('创建失败', false); return; }
      var proj = res.body;
      state.activeProjectId = proj.id;
      subscribeToProject(proj.id);
      refreshProjectList();
    }).catch(function () {
      showToast('无法连接后端服务（' + location.origin + '），请确认 node video-agent/server.js 正在运行');
      setStatus('创建失败', false);
    });
  }

  // ---------- routing ----------

  function render() {
    var isWorkspace = location.hash === '#/workspace';
    document.getElementById('view-home').hidden = isWorkspace;
    document.getElementById('view-workspace').hidden = !isWorkspace;
  }

  // ---------- wiring ----------

  function attachStaticHandlers() {
    $all('.mode-card').forEach(function (card) {
      card.addEventListener('click', function () {
        startNewProject(card.dataset.mode);
        location.hash = '#/workspace';
      });
    });

    document.getElementById('btn-back').addEventListener('click', function () { location.hash = ''; });
    document.getElementById('btn-new-project').addEventListener('click', function () { startNewProject(state.mode); });

    $all('.mode-switch__btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.dataset.mode === state.mode) return;
        startNewProject(btn.dataset.mode);
      });
    });

    document.getElementById('player-play-btn').addEventListener('click', togglePlayback);
    document.addEventListener('click', function (e) {
      if (e.target && e.target.id === 'mini-play-icon') togglePlayback();
      if (e.target && (e.target.id === 'fullscreen-icon-btn' || (e.target.closest && e.target.closest('#fullscreen-icon-btn')))) enterFullscreen();
    });

    document.getElementById('btn-preview').addEventListener('click', enterFullscreen);
    document.getElementById('btn-fullscreen-toolbar').addEventListener('click', enterFullscreen);
    document.getElementById('player-close-btn').addEventListener('click', exitFullscreen);
    document.getElementById('backdrop').addEventListener('click', exitFullscreen);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') exitFullscreen();
    });

    document.getElementById('btn-subtitle').addEventListener('click', toggleSubtitles);

    function runExport() {
      if (!state.activeProjectId) { showToast('还没有项目可以导出'); return; }
      if (backendAvailable === false) {
        if (!state.doneSteps.has('preview')) { showToast('先完成分镜生成，再导出视频吧'); return; }
        showToast('🎬 演示模式：这里会触发录屏导出真实视频文件（当前是静态预览，未连接后台）');
        return;
      }
      api('/api/projects/' + state.activeProjectId + '/export', { method: 'POST' }).then(function (res) {
        showToast(res.body.note || res.body.error || (res.ok ? '导出成功' : '导出失败'));
      }).catch(function () {
        showToast('无法连接后端服务，请确认 node video-agent/server.js 正在运行');
      });
    }
    document.getElementById('btn-export').addEventListener('click', runExport);
    document.getElementById('btn-record-export').addEventListener('click', runExport);

    $all('[data-toast]').forEach(function (el) {
      el.addEventListener('click', function () { showToast(el.dataset.toast); });
    });

    document.getElementById('select-bgm').addEventListener('change', function (e) {
      state.bgm = e.target.value;
      if (state.activeProjectId && backendAvailable !== false) api('/api/projects/' + state.activeProjectId, { method: 'PATCH', body: { bgm: e.target.value } }).catch(function () {});
      showToast('背景音乐已切换为「' + state.bgm + '」');
    });
    document.getElementById('select-voice').addEventListener('change', function (e) {
      state.voice = e.target.value;
      if (state.activeProjectId && backendAvailable !== false) api('/api/projects/' + state.activeProjectId, { method: 'PATCH', body: { voice: e.target.value } }).catch(function () {});
      showToast('旁白语音已切换为「' + state.voice + '」');
    });

    document.getElementById('btn-send').addEventListener('click', handleSend);
    document.getElementById('chat-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });

    window.addEventListener('hashchange', render);
  }

  function boot() {
    attachStaticHandlers();
    renderStepper();
    renderFilmstrip();

    api('/api/projects').then(function (res) {
      if (!res.ok) throw new Error('backend responded but not ok');
      backendAvailable = true;
      renderSidebarFromList(res.body);
      if (location.hash === '#/workspace') openProject('ocean');
    }).catch(function () {
      backendAvailable = false;
      buildLocalProjectList();
      showToast('静态预览模式：未连接真实后台，创作流程为本地模拟演示');
      if (location.hash === '#/workspace') openProject('ocean');
    }).then(render);
  }

  // DOMContentLoaded never fires if this script runs after the document has
  // already finished parsing (e.g. a bundled single-file page loaded in some
  // preview contexts) — guard against that instead of assuming a fresh load.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
