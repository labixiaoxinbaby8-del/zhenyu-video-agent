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

  // ---------- state (server is the source of truth for a project's generation
  // state; this just mirrors the currently-loaded project for rendering, plus
  // pure client-side concerns like playback position) ----------

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
    totalDuration: 30
  };

  var eventSource = null;

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
    resetPlaybackProgress();
  }

  function resetPlayerToEmpty() {
    var scene = document.getElementById('player-scene');
    scene.style.background = '';
    var msg = scene.querySelector('.player-empty-msg');
    if (msg) msg.hidden = false;
    resetPlaybackProgress();
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

  // ---------- applying one timeline entry (shared by history replay + live SSE) ----------

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
        state.shots = entry.shots.map(function (s) { return { status: s.status, hue: s.hue }; });
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

  // ---------- SSE ----------

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

  // ---------- new / reset project (local-only: no server call until first message) ----------

  function startNewProject(mode) {
    closeEventSource();
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

  // ---------- loading a project (history item, or the default ocean demo) ----------

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

  function refreshProjectList() {
    return api('/api/projects').then(function (res) {
      if (!res.ok) return;
      var listEl = document.getElementById('project-list');
      listEl.innerHTML = '';
      res.body.forEach(function (proj) {
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
    });
  }

  // ---------- sending a message: creates a project on the first send, posts a
  // follow-up message on any send after that ----------

  function postMessage(id, text) {
    api('/api/projects/' + id + '/message', { method: 'POST', body: { text: text } }).then(function (res) {
      if (!res.ok) showToast('发送失败：' + (res.body.error || res.status));
    }).catch(function () {
      showToast('无法连接后端服务，请确认 node video-agent/server.js 正在运行');
    });
  }

  function handleSend() {
    var input = document.getElementById('chat-input');
    var text = input.value.trim();
    if (!text) return;
    input.value = '';

    if (state.activeProjectId) {
      addUserMessage(text); // optimistic; server will also emit this back over SSE for other viewers
      postMessage(state.activeProjectId, text);
      return;
    }

    var emptyMsg = document.getElementById('chat-empty');
    if (emptyMsg) emptyMsg.remove();
    document.getElementById('suggestions').hidden = true;
    state.projectTitle = deriveTitle(text);
    updateProjectTitleUI();
    addUserMessage(text);
    setStatus('创建项目中…', true);

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
    document.getElementById('player-close-btn').addEventListener('click', exitFullscreen);
    document.getElementById('backdrop').addEventListener('click', exitFullscreen);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') exitFullscreen();
    });

    document.getElementById('btn-export').addEventListener('click', function () {
      if (!state.activeProjectId) { showToast('还没有项目可以导出'); return; }
      api('/api/projects/' + state.activeProjectId + '/export', { method: 'POST' }).then(function (res) {
        showToast(res.body.note || res.body.error || (res.ok ? '导出成功' : '导出失败'));
      }).catch(function () {
        showToast('无法连接后端服务，请确认 node video-agent/server.js 正在运行');
      });
    });

    $all('[data-toast]').forEach(function (el) {
      el.addEventListener('click', function () { showToast(el.dataset.toast); });
    });

    document.getElementById('select-bgm').addEventListener('change', function (e) {
      state.bgm = e.target.value;
      if (state.activeProjectId) api('/api/projects/' + state.activeProjectId, { method: 'PATCH', body: { bgm: e.target.value } }).catch(function () {});
      showToast('背景音乐已切换为「' + state.bgm + '」');
    });
    document.getElementById('select-voice').addEventListener('change', function (e) {
      state.voice = e.target.value;
      if (state.activeProjectId) api('/api/projects/' + state.activeProjectId, { method: 'PATCH', body: { voice: e.target.value } }).catch(function () {});
      showToast('旁白语音已切换为「' + state.voice + '」');
    });

    document.getElementById('btn-send').addEventListener('click', handleSend);
    document.getElementById('chat-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });

    window.addEventListener('hashchange', render);
  }

  document.addEventListener('DOMContentLoaded', function () {
    refreshProjectList();
    attachStaticHandlers();
    renderStepper();
    renderFilmstrip();
    if (location.hash === '#/workspace') {
      loadProjectFromServer('ocean');
    }
    render();
  });
})();
