(function () {
  'use strict';

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
    playbackShotIndex: -1,
    totalDuration: 30,
    subtitlesOn: true,
    muted: false,
    ratio: '16:9',
    chatExpanded: false,
    batchEdit: false,
    scriptText: '',
    exporting: false,
    currentUser: null,
    isDemo: false
  };

  var lastProjectList = []; // cached most-recent sidebar list, for client-side search filtering
  var localDeletedIds = new Set(); // seed ids removed via the sidebar "⋮" menu in local (no-backend) mode
  var openProjectMenuEl = null; // the currently-open sidebar "⋮" dropdown, if any

  var BGM_CANDIDATES = ['海风轻快民谣', '阳光电子流行', '温柔钢琴独奏', '探索感管弦乐'];
  var VOICE_CANDIDATES = ['知性女声', '活泼童声', '沉稳男声', '温柔姐姐音'];

  var eventSource = null;
  // null = not yet checked; true = talking to a real node server.js;
  // false = no backend reachable (e.g. a static Artifact preview) -> fall
  // back to an in-browser demo simulation so the page still works.
  var backendAvailable = null;

  // ---------- small helpers ----------

  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function modeLabel(mode) {
    return mode === 'html' ? 'HTML 视频' : '图片轮播';
  }

  // Shown at the top of a fresh project's chat log so the mode you just
  // picked is explained in place, not just back on the home page cards.
  // (The mode name itself isn't repeated here — the tip is already
  // color-coded to match the mode, and the meta row states it too.)
  function modeIntro(mode) {
    if (mode === 'html') return 'AI 为每个分镜生成可动的网页动画，多段动画拼接成片';
    return 'AI 为每个分镜调用文生图模型生成静态画面，多张图片按节奏轮播剪辑成片';
  }

  // Small icon matching the mode's card on the home page, reused here so
  // the tip visually ties back to the card you just clicked.
  function modeTipIconSvg(mode) {
    if (mode === 'html') {
      return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6 L3 12 L8 18"></path><path d="M16 6 L21 12 L16 18"></path><path d="M13.5 4.5 L10.5 19.5"></path></svg>';
    }
    return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="13" height="10" rx="2"></rect><rect x="8" y="10" width="13" height="10" rx="2"></rect></svg>';
  }

  // A couple of ready-made prompts per mode, shown as clickable chips in the
  // empty chat log so starting from scratch isn't the only option.
  function modeExamplePrompts(mode) {
    if (mode === 'html') {
      return [
        '做一支 20 秒的新品发布预告片，突出温暖色调和限时优惠，风格干净有质感',
        '用一支 25 秒的动态视频讲解一个客户成功案例，突出前后数据对比'
      ];
    }
    return [
      '做一支 30 秒的儿童科普视频，介绍海洋生物，风格活泼可爱，配欢快背景音乐',
      '帮我做一条 15 秒的小红书种草视频，主打一款保湿精华，节奏要快、有网感'
    ];
  }

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
  function clockSvg() {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 6v6l4 2"></path></svg>';
  }
  function playSvgSmall() {
    return '<svg id="mini-play-icon" width="16" height="16" viewBox="0 0 24 24" fill="oklch(100% 0 0)" style="cursor:pointer"><path d="M8 5v14l11-7z"></path></svg>';
  }
  function pauseSvgSmall() {
    return '<svg id="mini-play-icon" width="16" height="16" viewBox="0 0 24 24" fill="oklch(100% 0 0)" style="cursor:pointer"><rect x="6" y="5" width="4" height="14"></rect><rect x="14" y="5" width="4" height="14"></rect></svg>';
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

  // ---------- filmstrip ----------

  // A shot with a real generated image (shot.imageUrl, from the real AI
  // pipeline) shows that photo; otherwise falls back to the hue-based
  // gradient placeholder used throughout the demo pipeline.
  function shotCssBackground(shot, variant) {
    if (!shot) return '';
    if (shot.imageUrl) return 'url(' + shot.imageUrl + ') center/cover no-repeat';
    if (variant === 'player') return 'linear-gradient(165deg, oklch(80% 0.09 ' + shot.hue + '), oklch(58% 0.09 ' + (shot.hue + 20) + '))';
    return 'linear-gradient(160deg, oklch(84% 0.07 ' + shot.hue + '), oklch(70% 0.08 ' + (shot.hue + 10) + '))';
  }

  function shotDurationLabel() {
    // Every shot occupies an equal slice of the total runtime in this demo
    // pipeline (totalDuration = shotCount * 5s) — there's no per-shot timing
    // data to draw a more precise label from.
    var per = state.shots.length ? state.totalDuration / state.shots.length : 0;
    return formatTime(per);
  }

  function renderFilmstrip() {
    var el = document.getElementById('filmstrip');
    el.innerHTML = '';
    if (!state.shots.length) {
      // Reserve the same row height empty as populated (4 dashed
      // placeholders) so generating a project doesn't shove the toolbar row
      // below it down the page.
      for (var p = 0; p < 4; p++) {
        var ph = document.createElement('div');
        ph.className = 'filmstrip-item is-pending is-placeholder';
        el.appendChild(ph);
      }
      document.getElementById('filmstrip-label').textContent = '分镜列表 · 共 0 个分镜';
      updatePlayerEmptyState();
      updateToolbarDisabledState();
      return;
    }
    var durationLabel = shotDurationLabel();
    state.shots.forEach(function (shot, i) {
      var col = document.createElement('div');
      col.className = 'filmstrip-col' + (shot.active ? ' is-active' : '') + (state.batchEdit ? ' is-batch' : '');
      if (state.batchEdit) {
        col.draggable = true;
        col.addEventListener('dragstart', function (e) { e.dataTransfer.setData('text/plain', String(i)); });
        col.addEventListener('dragover', function (e) { e.preventDefault(); });
        col.addEventListener('drop', function (e) {
          e.preventDefault();
          var from = parseInt(e.dataTransfer.getData('text/plain'), 10);
          if (!isNaN(from)) reorderShots(from, i);
        });
      }

      var btn = document.createElement('button');
      btn.type = 'button';
      var cls = 'filmstrip-item';
      if (shot.status === 'pending') cls += ' is-pending';
      if (shot.status === 'loading') cls += ' is-pending is-loading';
      if (shot.active) cls += ' is-active';
      btn.className = cls;
      if (shot.status === 'ready') {
        btn.style.background = shotCssBackground(shot, 'filmstrip');
      }
      var inner = '<span class="filmstrip-item__num">' + String(i + 1).padStart(2, '0') + '</span>';
      if (shot.status === 'ready') inner += '<span class="filmstrip-item__duration">' + durationLabel + '</span>';
      else inner += clockSvg();
      btn.innerHTML = inner;
      btn.addEventListener('click', function () { selectShot(i); });
      col.appendChild(btn);

      if (state.batchEdit) {
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'filmstrip-item-delete';
        del.setAttribute('aria-label', '删除分镜');
        del.textContent = '×';
        del.addEventListener('click', function (e) { e.stopPropagation(); deleteShot(i); });
        btn.appendChild(del);
      }

      var label = document.createElement('span');
      label.className = 'filmstrip-item-label';
      label.textContent = shot.caption ? shot.caption : ('分镜 ' + (i + 1));
      label.title = '点击编辑文案';
      label.addEventListener('click', function (e) {
        e.stopPropagation();
        if (state.batchEdit) return;
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'filmstrip-item-label-input';
        input.value = shot.caption || '';
        label.replaceWith(input);
        input.focus();
        input.select();
        var done = false;
        function commit() {
          if (done) return;
          done = true;
          commitShotCaption(shot, i, input.value);
        }
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', function (e2) {
          if (e2.key === 'Enter') { e2.preventDefault(); commit(); }
          if (e2.key === 'Escape') { done = true; renderFilmstrip(); }
        });
      });
      col.appendChild(label);

      el.appendChild(col);
    });
    document.getElementById('filmstrip-label').textContent = '分镜列表 · 共 ' + state.shots.length + ' 个分镜';
    updatePlayerEmptyState();
    updateToolbarDisabledState();
  }

  // The player looks like a fully "live" video (play button, scrubber,
  // volume/settings/fullscreen) even with nothing generated yet unless we
  // explicitly dial it back — toggled whenever the shot list changes.
  function updatePlayerEmptyState() {
    var hasReady = state.shots.some(function (s) { return s.status === 'ready'; });
    var wrap = document.getElementById('player-wrap');
    if (wrap) wrap.classList.toggle('is-empty', !hasReady);
  }

  function updateTitleOverlay(shot) {
    var overlay = document.getElementById('player-title-overlay');
    if (!overlay) return;
    // Slideshow frames double as title cards in this demo; HTML-video shots
    // are meant to be full animated scenes, so no text overlay is drawn.
    if (state.mode !== 'slideshow' || !shot || shot.status !== 'ready') { overlay.hidden = true; return; }
    document.getElementById('player-title-main').textContent = state.projectTitle;
    document.getElementById('player-title-sub').textContent = shot.caption || '';
    overlay.hidden = false;
  }

  // The decorative sun/wave SVG is drawn for the gradient-placeholder look —
  // it has no business sitting on top of a real generated photo.
  function updatePlayerDeco(shot) {
    var deco = document.querySelector('#player-scene .player-deco');
    if (deco) deco.style.display = (shot && shot.imageUrl) ? 'none' : '';
  }

  function selectShot(i) {
    state.shots.forEach(function (s, idx) { s.active = idx === i; });
    renderFilmstrip();
    var shot = state.shots[i];
    var scene = document.getElementById('player-scene');
    var msg = scene.querySelector('.player-empty-msg');
    if (shot && shot.status === 'ready') {
      scene.style.background = shotCssBackground(shot, 'player');
      if (msg) msg.hidden = true;
    }
    updatePlayerDeco(shot);
    updateSubtitleUI(shot, i);
    updateTitleOverlay(shot);
    resetPlaybackProgress();
  }

  function resetPlayerToEmpty() {
    var scene = document.getElementById('player-scene');
    scene.style.background = '';
    var msg = scene.querySelector('.player-empty-msg');
    if (msg) msg.hidden = false;
    updatePlayerDeco(null);
    updateSubtitleUI(null, -1);
    updateTitleOverlay(null);
    updatePlayerEmptyState();
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

  function toggleSubtitles(checked) {
    state.subtitlesOn = checked;
    var activeIdx = state.shots.findIndex(function (s) { return s.active; });
    updateSubtitleUI(state.shots[activeIdx], activeIdx);
    renderMetaRow();
    showToast(state.subtitlesOn ? '字幕已开启' : '字幕已关闭');
  }

  // ---------- playback (purely client-side; no server concept of "now playing") ----------

  function resetPlaybackProgress() {
    stopPlaybackInterval();
    state.isPlaying = false;
    state.elapsedSeconds = 0;
    state.playbackShotIndex = -1;
    document.getElementById('player-play-btn').style.opacity = '1';
    document.getElementById('player-play-btn').style.pointerEvents = 'auto';
    var mini = document.getElementById('mini-play-icon');
    if (mini) mini.outerHTML = playSvgSmall();
    document.getElementById('progress-fill').style.width = '0%';
    document.getElementById('time-label').textContent = '00:00 / ' + formatTime(state.totalDuration);
  }

  // Lightweight visual-only shot switch used while playback is running —
  // unlike selectShot() this must NOT call renderFilmstrip() (a full DOM
  // rebuild on every tick) or resetPlaybackProgress() (which would stop the
  // very playback driving it).
  function playbackSelectShot(i) {
    var shot = state.shots[i];
    if (!shot) return;
    state.shots.forEach(function (s, idx) { s.active = idx === i; });
    $all('.filmstrip-col').forEach(function (col, idx) { col.classList.toggle('is-active', idx === i); });
    $all('.filmstrip-item').forEach(function (btn, idx) { btn.classList.toggle('is-active', idx === i); });
    if (shot.status === 'ready') {
      document.getElementById('player-scene').style.background = shotCssBackground(shot, 'player');
    }
    updatePlayerDeco(shot);
    updateSubtitleUI(shot, i);
    updateTitleOverlay(shot);
  }

  function updatePlaybackUI() {
    var pct = state.totalDuration ? (state.elapsedSeconds / state.totalDuration * 100) : 0;
    document.getElementById('progress-fill').style.width = Math.min(100, pct) + '%';
    document.getElementById('time-label').textContent = formatTime(state.elapsedSeconds) + ' / ' + formatTime(state.totalDuration);
    // Advance the displayed shot in step with playback — each shot gets an
    // equal slice of the total runtime (matches shotDurationLabel()'s math).
    if (state.shots.length) {
      var per = state.totalDuration / state.shots.length;
      var idx = Math.min(state.shots.length - 1, Math.floor(state.elapsedSeconds / per));
      if (idx !== state.playbackShotIndex) {
        state.playbackShotIndex = idx;
        playbackSelectShot(idx);
      }
    }
  }

  function stopPlaybackInterval() {
    if (state.playbackTimer) { clearInterval(state.playbackTimer); state.playbackTimer = null; }
  }

  function togglePlayback() {
    if (!state.shots.some(function (s) { return s.status === 'ready'; })) {
      showToast('还没有可播放的内容，先在右侧输入提示词试试吧');
      return;
    }
    state.isPlaying = !state.isPlaying;
    var bigBtn = document.getElementById('player-play-btn');
    var mini = document.getElementById('mini-play-icon');
    if (state.isPlaying) {
      bigBtn.style.opacity = '0';
      bigBtn.style.pointerEvents = 'none';
      if (mini) mini.outerHTML = pauseSvgSmall();
      updatePlaybackUI(); // sync the displayed shot to the current position right away
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

  function toggleRatio() {
    state.ratio = state.ratio === '16:9' ? '9:16' : '16:9';
    var isPortrait = state.ratio === '9:16';
    document.getElementById('player-wrap').classList.toggle('is-portrait', isPortrait);
    document.getElementById('ratio-label').textContent = state.ratio;
    document.getElementById('btn-ratio').classList.toggle('is-active', isPortrait);
  }

  function speakerSvg() {
    return '<svg id="mute-icon-btn" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="oklch(100% 0 0)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="cursor:pointer"><path d="M11 5 6 9H2v6h4l5 4z"></path><path d="M15.5 8.5a5 5 0 0 1 0 7"></path></svg>';
  }
  function mutedSpeakerSvg() {
    return '<svg id="mute-icon-btn" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="oklch(100% 0 0)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="cursor:pointer"><path d="M11 5 6 9H2v6h4l5 4z"></path><path d="M23 9l-6 6M17 9l6 6"></path></svg>';
  }
  function toggleMute() {
    state.muted = !state.muted;
    var el = document.getElementById('mute-icon-btn');
    if (el) el.outerHTML = state.muted ? mutedSpeakerSvg() : speakerSvg();
    showToast(state.muted ? '已静音（原型演示，暂无实际音频）' : '已取消静音');
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

  function addSummaryCard(items) {
    var wrap = document.createElement('div');
    wrap.className = 'msg msg-ai';
    var bubble = document.createElement('div');
    bubble.className = 'msg-bubble msg-bubble--summary';
    var listHtml = items.map(function (text) {
      return '<div class="summary-item"><span class="summary-item__icon">' + checkSvgSmall() + '</span><span>' + escapeHtml(text) + '</span></div>';
    }).join('');
    bubble.innerHTML = '<div class="summary-list">' + listHtml + '</div>';
    wrap.appendChild(bubble);
    chatLogEl().appendChild(wrap);
    scrollChatToBottom();
  }

  function addScriptLink() {
    var wrap = document.createElement('div');
    wrap.className = 'msg msg-ai';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msg-ai-link-btn';
    btn.textContent = '查看脚本';
    btn.addEventListener('click', openScriptModal);
    wrap.appendChild(btn);
    chatLogEl().appendChild(wrap);
    scrollChatToBottom();
  }

  // ---------- login (real accounts: cookie session against server.js /
  // db.js — same-origin fetch sends the session cookie automatically, no
  // credentials:'include' needed) ----------

  var loginModalMode = 'login'; // 'login' | 'register'

  function isLoggedIn() { return !!state.currentUser; }

  // Pulls the real session state from the server on boot — a page reload
  // must not silently "log you out" just because nothing is cached client-side.
  function refreshAuthState() {
    return api('/api/auth/me').then(function (res) {
      state.currentUser = res.ok ? res.body.user : null;
      applyLoginUI(state.currentUser);
    }).catch(function () {
      // No backend at all (e.g. the static bundle/Artifact preview) — stay
      // logged out rather than leave an unhandled rejection in the console.
      state.currentUser = null;
      applyLoginUI(null);
    });
  }

  function applyLoginUI(user) {
    var chip = document.getElementById('user-chip');
    var loginBtn = document.getElementById('btn-login');
    if (user) {
      var label = user.displayName || user.email;
      document.getElementById('user-chip-name').textContent = label.length > 10 ? label.slice(0, 10) + '…' : label;
      chip.hidden = false;
      loginBtn.hidden = true;
    } else {
      chip.hidden = true;
      loginBtn.hidden = false;
    }
    var wsBtn = document.getElementById('workspace-user-btn');
    if (wsBtn) {
      wsBtn.textContent = user ? (user.displayName || user.email).charAt(0).toUpperCase() : '?';
      wsBtn.title = user ? '已登录：' + (user.displayName || user.email) + '（点击退出登录）' : '未登录（点击登录）';
    }
  }

  function logout() {
    return api('/api/auth/logout', { method: 'POST' }).then(function () {
      state.currentUser = null;
      applyLoginUI(null);
      showToast('已退出登录');
      if (state.activeProjectId && !state.isDemo) startNewProject(state.mode);
      if (backendAvailable !== false) refreshProjectList(); // sidebar must drop back to demo-only projects
    });
  }

  function setLoginModalMode(mode) {
    loginModalMode = mode;
    var isRegister = mode === 'register';
    document.getElementById('login-modal-title').textContent = isRegister ? '注册帐号' : '登录帐号';
    document.getElementById('login-form-submit').textContent = isRegister ? '注册' : '登录';
    document.getElementById('login-name-field').hidden = !isRegister;
    document.getElementById('login-mode-hint').textContent = isRegister ? '已有账号？' : '还没有账号？';
    document.getElementById('login-mode-toggle').textContent = isRegister ? '直接登录' : '立即注册';
    document.getElementById('login-password').setAttribute('autocomplete', isRegister ? 'new-password' : 'current-password');
    document.getElementById('login-form-error').hidden = true;
  }

  function openLoginModal() {
    setLoginModalMode('login');
    document.getElementById('login-modal').hidden = false;
    document.getElementById('login-account').focus();
  }
  function closeLoginModal() {
    document.getElementById('login-modal').hidden = true;
  }

  function openScriptModal() {
    document.getElementById('script-modal-body').textContent = state.scriptText || '暂无脚本内容';
    document.getElementById('script-modal').hidden = false;
  }
  function closeScriptModal() {
    document.getElementById('script-modal').hidden = true;
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
    // "active" already means exactly "the pipeline is still generating" —
    // reuse it to show/hide the cancel button instead of tracking that
    // separately.
    var cancelBtn = document.getElementById('btn-cancel-generation');
    if (cancelBtn) cancelBtn.hidden = !active || !state.activeProjectId;
  }

  function updateDurationInfo(total) {
    state.totalDuration = total || 30;
    renderMetaRow();
  }

  // ---------- meta row (read-only summary line under the filmstrip) ----------

  function renderMetaRow() {
    var el = document.getElementById('meta-row');
    if (!el) return;
    var hasProject = !!state.activeProjectId;
    var parts = [
      { label: '当前模式', value: modeLabel(state.mode) + '模式' },
      { label: '字幕', value: state.subtitlesOn ? '已开启' : '已关闭' },
      { label: '背景音乐', value: hasProject ? state.bgm : '生成后自动选择', field: hasProject ? 'bgm' : null },
      { label: '旁白', value: hasProject ? state.voice : '生成后自动选择', field: hasProject ? 'voice' : null },
      { label: '视频时长', value: hasProject ? formatTime(state.totalDuration) : '—' }
    ];
    el.innerHTML = parts.map(function (p, i) {
      var sep = i ? '<span class="meta-row__sep">|</span>' : '';
      var body = '<strong>' + escapeHtml(p.label) + '：</strong>' + escapeHtml(p.value);
      var tag = p.field
        ? '<button type="button" class="meta-row__item meta-row__item--editable" data-field="' + p.field + '" title="点击切换">' + body + '</button>'
        : '<span class="meta-row__item">' + body + '</span>';
      return sep + tag;
    }).join('');
    updateToolbarDisabledState();
  }

  // ---------- disable dead-end toolbar controls until there's something for them to act on ----------

  function updateToolbarDisabledState() {
    var hasProject = !!state.activeProjectId;
    var hasShots = state.shots.length > 0;
    ['btn-ratio', 'btn-fullscreen-toolbar'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.disabled = !hasProject;
    });
    ['btn-record-export', 'btn-export'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.disabled = !hasProject || state.exporting;
    });
    ['btn-add-shot', 'btn-batch-edit'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.disabled = !hasShots;
    });
  }

  // ---------- real client-side export: canvas + MediaRecorder ----------
  //
  // Recreates each ready shot's on-screen look (gradient background, the
  // slideshow title card, the subtitle bar) on an offscreen canvas, captures
  // that canvas as a MediaStream, and records it in real time into a
  // downloadable .webm — so "export" produces an actual file that matches
  // the preview, rather than a toast. Silent: there's no real narration/BGM
  // audio anywhere in this demo to mix in, only text labels for them.

  function exportCanvasSize() {
    return state.ratio === '9:16' ? { w: 720, h: 1280 } : { w: 1280, h: 720 };
  }

  function drawRoundedRect(ctx, x, y, w, h, r) {
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function truncateToFit(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    var out = text;
    while (out.length > 1 && ctx.measureText(out + '…').width > maxWidth) out = out.slice(0, -1);
    return out + '…';
  }

  // Loads every shot's real generated image (if any) up front, aligned by
  // index with snap.shots, so the per-frame draw loop can stay synchronous.
  // A shot with no imageUrl (placeholder pipeline, or a failed generation)
  // resolves to null and just keeps the gradient look.
  function preloadShotImages(shots) {
    return Promise.all(shots.map(function (s) {
      if (!s.imageUrl) return Promise.resolve(null);
      return new Promise(function (resolve) {
        var img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function () { resolve(img); };
        img.onerror = function () { resolve(null); };
        img.src = s.imageUrl;
      });
    }));
  }

  // object-fit: cover, drawn manually since canvas has no CSS background-size.
  function drawCoverImage(ctx, img, w, h) {
    var imgRatio = img.width / img.height, targetRatio = w / h;
    var sw, sh, sx, sy;
    if (imgRatio > targetRatio) { sh = img.height; sw = sh * targetRatio; sx = (img.width - sw) / 2; sy = 0; }
    else { sw = img.width; sh = sw / targetRatio; sx = 0; sy = (img.height - sh) / 2; }
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  }

  function drawExportFrame(ctx, w, h, shot, index, snap, img) {
    ctx.clearRect(0, 0, w, h);
    if (img) {
      drawCoverImage(ctx, img, w, h);
      ctx.fillStyle = 'rgba(0,0,0,0.15)'; // keep title/subtitle text legible over a real photo
      ctx.fillRect(0, 0, w, h);
    } else {
      var hue = shot ? shot.hue : 220;
      var grad = ctx.createLinearGradient(0, 0, w * 0.3, h);
      try {
        grad.addColorStop(0, 'oklch(80% 0.09 ' + hue + ')');
        grad.addColorStop(1, 'oklch(58% 0.09 ' + (hue + 20) + ')');
      } catch (e) {
        grad.addColorStop(0, '#7fb3d9'); grad.addColorStop(1, '#3d6b96'); // fallback if oklch() isn't parseable here
      }
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      ctx.globalAlpha = 0.9;
      ctx.fillStyle = 'oklch(96% 0.05 90)';
      ctx.beginPath();
      ctx.arc(w * 0.82, h * 0.16, w * 0.06, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    if (snap.mode === 'slideshow' && shot) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = w * 0.015;
      ctx.font = '700 ' + Math.round(w * 0.042) + 'px "Lexend", "Segoe UI", sans-serif';
      ctx.fillText(truncateToFit(ctx, snap.projectTitle || '未命名项目', w * 0.82), w / 2, h * 0.44);
      if (shot.caption) {
        ctx.font = '500 ' + Math.round(w * 0.017) + 'px "Public Sans", "Segoe UI", sans-serif';
        ctx.globalAlpha = 0.85;
        ctx.fillText(truncateToFit(ctx, shot.caption, w * 0.7), w / 2, h * 0.44 + w * 0.05);
        ctx.globalAlpha = 1;
      }
      ctx.shadowBlur = 0;
    }

    if (snap.subtitlesOn && shot && shot.caption) {
      var fontSize = Math.round(w * 0.016);
      ctx.font = '500 ' + fontSize + 'px "Public Sans", "Segoe UI", sans-serif';
      var text = truncateToFit(ctx, shot.caption, w * 0.8);
      var textW = ctx.measureText(text).width;
      var padX = w * 0.014, padY = fontSize * 0.6;
      var boxW = textW + padX * 2;
      var boxH = fontSize + padY * 2;
      var boxX = (w - boxW) / 2;
      var boxY = h - h * 0.12 - boxH;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      drawRoundedRect(ctx, boxX, boxY, boxW, boxH, boxH / 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.fillText(text, w / 2, boxY + boxH / 2 + fontSize * 0.35);
    }

    ctx.font = '600 ' + Math.round(w * 0.013) + 'px "Public Sans", "Segoe UI", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.textAlign = 'right';
    ctx.fillText((index + 1) + ' / ' + snap.totalShots, w - w * 0.02, h - h * 0.03);
  }

  // Saves a file two different ways depending on where this page is
  // running: a published Artifact has no direct filesystem/download access
  // (window.claude.use('downloads') mediates a real save there), while the
  // actual app (node server.js, opened as a normal page) has no
  // `window.claude` at all and just uses a plain <a download> blob link.
  function saveExportedFile(filename, blob) {
    if (window.claude && typeof window.claude.use === 'function') {
      return window.claude.use('downloads').then(function (downloads) {
        if (!downloads) return saveViaAnchor(filename, blob);
        return downloads.save({ filename: filename, data: blob }).then(function () {
          return true;
        }).catch(function (err) {
          if (err && err.code === 'declined') return false;
          return saveViaAnchor(filename, blob);
        });
      });
    }
    return Promise.resolve(saveViaAnchor(filename, blob));
  }

  function saveViaAnchor(filename, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
    return true;
  }

  function setExportBusyLabel(text) {
    var exportSpan = document.querySelector('#btn-export .btn-label');
    var recordSpan = document.querySelector('#btn-record-export .btn-label');
    if (exportSpan) exportSpan.textContent = text || '导出视频';
    if (recordSpan) recordSpan.textContent = text || '录屏导出';
  }

  async function startCanvasExport() {
    if (state.exporting) { showToast('正在录制中，请稍候…'); return; }
    if (!state.shots.some(function (s) { return s.status === 'ready'; })) { showToast('还没有可导出的分镜'); return; }
    if (typeof MediaRecorder === 'undefined' || !document.createElement('canvas').captureStream) {
      showToast('当前浏览器不支持录制导出，换个较新的桌面 Chrome/Edge 试试吧');
      return;
    }

    // Snapshot everything the recording needs up front — it runs in real
    // time (matches the video's own length) via requestAnimationFrame, so
    // it must not keep reading live state.* that the user could change
    // (switch projects, edit captions, toggle subtitles) mid-recording.
    var snap = {
      shots: state.shots.map(function (s) { return { status: s.status, hue: s.hue, caption: s.caption, imageUrl: s.imageUrl }; }),
      mode: state.mode,
      projectTitle: state.projectTitle,
      subtitlesOn: state.subtitlesOn,
      totalDuration: state.totalDuration,
      totalShots: state.shots.length
    };
    snap.images = await preloadShotImages(snap.shots);

    var size = exportCanvasSize();
    var canvas = document.createElement('canvas');
    canvas.width = size.w;
    canvas.height = size.h;
    var ctx = canvas.getContext('2d');
    var perShot = snap.totalDuration / snap.shots.length;
    var totalMs = Math.max(1000, snap.totalDuration * 1000);

    var mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].filter(function (t) {
      return window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(t);
    })[0] || '';

    var stream = canvas.captureStream(30);
    var recorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType: mimeType } : undefined);
    } catch (e) {
      showToast('录制初始化失败：' + e.message);
      return;
    }
    var chunks = [];
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };

    state.exporting = true;
    updateToolbarDisabledState();
    showToast('开始录制导出，请保持这个标签页在前台，别切走…');

    var startTime = performance.now();
    var tickTimer = setInterval(function () {
      var elapsed = Math.min(snap.totalDuration, (performance.now() - startTime) / 1000);
      setExportBusyLabel('录制中 ' + Math.round(elapsed) + '/' + Math.round(snap.totalDuration) + 's');
    }, 250);

    function frameLoop() {
      var elapsed = (performance.now() - startTime) / 1000;
      var clamped = Math.min(snap.totalDuration, elapsed);
      var idx = Math.min(snap.shots.length - 1, Math.floor(clamped / perShot));
      drawExportFrame(ctx, size.w, size.h, snap.shots[idx], idx, snap, snap.images[idx]);
      if (elapsed < snap.totalDuration && state.exporting) requestAnimationFrame(frameLoop);
    }

    recorder.onstop = function () {
      clearInterval(tickTimer);
      state.exporting = false;
      setExportBusyLabel(null);
      updateToolbarDisabledState();
      var blob = new Blob(chunks, { type: mimeType || 'video/webm' });
      var filename = (snap.projectTitle || '帧语导出') + '.webm';
      saveExportedFile(filename, blob).then(function (saved) {
        showToast(saved
          ? '导出完成，已保存（' + formatTime(snap.totalDuration) + '，暂无音频的演示版）'
          : '已取消保存');
      });
    };
    recorder.onerror = function (e) {
      clearInterval(tickTimer);
      state.exporting = false;
      setExportBusyLabel(null);
      updateToolbarDisabledState();
      showToast('录制出错：' + (e.error ? e.error.message : '未知错误'));
    };

    recorder.start();
    frameLoop();
    setTimeout(function () {
      if (recorder.state !== 'inactive') recorder.stop();
    }, totalMs + 200);
  }

  // ---------- direct edits (bgm/voice cycling, shot add/delete/reorder/caption) ----------

  // Demo/showcase projects (state.isDemo) are public and read-only server-side
  // (see server.js's canMutate()) — block edits at the UI layer too instead of
  // letting them look like they worked locally and then silently fail to save.
  function guardEditable() {
    if (state.isDemo) { showToast('这是一个演示项目，不能编辑——新建一个属于你自己的项目试试～'); return false; }
    return true;
  }

  function persistShots() {
    if (state.activeProjectId && backendAvailable !== false) {
      var payload = {
        shots: state.shots.map(function (s) { return { status: s.status, hue: s.hue, caption: s.caption, imageUrl: s.imageUrl, imageError: s.imageError }; }),
        totalDuration: state.totalDuration
      };
      api('/api/projects/' + state.activeProjectId, { method: 'PATCH', body: payload }).catch(function () {});
    }
  }

  function recalcDuration() {
    state.totalDuration = state.shots.length * 5;
    renderMetaRow();
  }

  function cycleBgm() {
    if (!guardEditable()) return;
    var next = BGM_CANDIDATES[(BGM_CANDIDATES.indexOf(state.bgm) + 1) % BGM_CANDIDATES.length];
    state.bgm = next;
    renderMetaRow();
    if (state.activeProjectId && backendAvailable !== false) {
      api('/api/projects/' + state.activeProjectId, { method: 'PATCH', body: { bgm: next } }).catch(function () {});
    }
    showToast('背景音乐已切换为「' + next + '」');
  }

  function cycleVoice() {
    if (!guardEditable()) return;
    var next = VOICE_CANDIDATES[(VOICE_CANDIDATES.indexOf(state.voice) + 1) % VOICE_CANDIDATES.length];
    state.voice = next;
    renderMetaRow();
    if (state.activeProjectId && backendAvailable !== false) {
      api('/api/projects/' + state.activeProjectId, { method: 'PATCH', body: { voice: next } }).catch(function () {});
    }
    showToast('旁白音色已切换为「' + next + '」');
  }

  function addShot() {
    if (!state.activeProjectId) { showToast('先在右侧输入提示词创建一个项目吧'); return; }
    if (!guardEditable()) return;
    var hue = LOCAL_SHOT_HUES[state.shots.length % LOCAL_SHOT_HUES.length];
    var shot = { status: 'loading', hue: hue, caption: '新分镜（点击可编辑文案）' };
    state.shots.push(shot);
    recalcDuration();
    renderFilmstrip();
    persistShots();
    showToast('正在生成新分镜画面…');
    setTimeout(function () {
      shot.status = 'ready';
      renderFilmstrip();
      persistShots();
      selectShot(state.shots.indexOf(shot));
    }, 900);
  }

  function deleteShot(i) {
    if (!guardEditable()) return;
    if (!window.confirm('确定要删除这个分镜吗？此操作不可撤销。')) return;
    var wasActive = !!(state.shots[i] && state.shots[i].active);
    state.shots.splice(i, 1);
    if (wasActive && state.shots.length) state.shots[Math.min(i, state.shots.length - 1)].active = true;
    recalcDuration();
    renderFilmstrip();
    persistShots();
    var activeIdx = state.shots.findIndex(function (s) { return s.active; });
    if (activeIdx !== -1) selectShot(activeIdx); else resetPlayerToEmpty();
  }

  function reorderShots(fromIndex, toIndex) {
    if (fromIndex === toIndex) return;
    if (!guardEditable()) return;
    var moved = state.shots.splice(fromIndex, 1)[0];
    state.shots.splice(toIndex, 0, moved);
    renderFilmstrip();
    persistShots();
  }

  function toggleBatchEdit() {
    if (!state.batchEdit && !guardEditable()) return;
    state.batchEdit = !state.batchEdit;
    document.getElementById('btn-batch-edit').classList.toggle('is-active', state.batchEdit);
    renderFilmstrip();
    showToast(state.batchEdit ? '批量编辑：拖动排序，点击 × 删除分镜' : '已退出批量编辑');
  }

  function commitShotCaption(shot, i, value) {
    if (!guardEditable()) { renderFilmstrip(); return; }
    shot.caption = value.trim() || shot.caption;
    renderFilmstrip();
    persistShots();
    if (shot.active) { updateSubtitleUI(shot, i); updateTitleOverlay(shot); }
  }

  // ---------- project title / mode UI ----------

  function updateProjectTitleUI() {
    document.getElementById('project-title').textContent = state.projectTitle;
    renderMetaRow();
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
        // No dedicated stepper UI — pipeline progress is communicated through
        // the process cards in the chat log instead. doneSteps is still
        // tracked (e.g. to gate export until 'preview' is reached).
        state.doneSteps = new Set(entry.doneSteps);
        state.currentStep = entry.currentStep;
        break;
      case 'summary_card':
        addSummaryCard(entry.items);
        break;
      case 'script_link':
        state.scriptText = entry.script || '';
        addScriptLink();
        break;
      case 'shots':
        state.shots = entry.shots.map(function (s) { return { status: s.status, hue: s.hue, caption: s.caption, imageUrl: s.imageUrl, imageError: s.imageError }; });
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
        updateDurationInfo(entry.total);
        break;
      case 'meta':
        if (entry.bgm) state.bgm = entry.bgm;
        if (entry.voice) state.voice = entry.voice;
        renderMetaRow();
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
      completionText: '已经为你生成好全部 ' + shotCount + ' 个分镜的画面和声音啦，画面时长也按配音重新对齐过了。可以点击中间播放预览；如果哪个分镜不满意，直接告诉我要怎么改～',
      summaryItems: ['脚本生成', '分镜拆分（' + shotCount + ' 个分镜）', '画面生成', '旁白配音', '字幕生成', '背景音乐选择', '剪辑合成'],
      scriptText: '【开场】\n' + prompt +
        '\n\n【正文】围绕以上主题自动扩写为 ' + shotCount + ' 个分镜的解说词，每个分镜约 ' + Math.round(totalDuration / shotCount) + ' 秒，配合' + vb.voice + '旁白与《' + vb.bgm + '》背景音乐。' +
        '\n\n【结尾】总结核心信息，引导观众记住重点，字幕与画面同步呈现。'
    };
  }

  var localTimers = [];
  function localClearTimers() { localTimers.forEach(clearTimeout); localTimers = []; }
  function localAt(delay, fn, live) { if (live) { localTimers.push(setTimeout(fn, delay)); } else { fn(); } }

  function localRunPipeline(prompt, live) {
    var content = localBuildContent(prompt);
    var shotCount = content.shotCount;
    var doneSteps = [];

    localAt(150, function () {
      applyEntry({ type: 'ai_message', text: '收到！我会自动完成脚本、分镜、画面、配音、字幕、剪辑并导出成片，全程无需你确认，请稍候～' });
    }, live);

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
      applyEntry({ type: 'meta', bgm: content.bgm, voice: content.voice });
      applyEntry({ type: 'process_card', id: 'voice', title: '分镜声音已生成', meta: '旁白：' + content.voice + ' · 配乐：' + content.bgm, done: true });
      applyEntry({ type: 'stepper', currentStep: 'voice', doneSteps: doneSteps.slice() });
      applyEntry({ type: 'status', text: '生成字幕中…', active: true });
    }, live);

    localAt(afterFrames + 1100, function () {
      applyEntry({ type: 'process_card', id: 'subtitle', title: '字幕已生成', meta: '已根据配音文本生成 ' + shotCount + ' 条字幕，可随时开关或编辑', done: true });
      applyEntry({ type: 'status', text: '按配音时长回调画面时长…', active: true });
    }, live);

    localAt(afterFrames + 1600, function () {
      applyEntry({ type: 'process_card', id: 'sync', title: '已回调分镜画面时长', meta: '已按配音时长重新同步 ' + shotCount + ' 个分镜的展示时长', done: true });
      applyEntry({ type: 'stepper', currentStep: 'preview', doneSteps: doneSteps.slice() });
      applyEntry({ type: 'status', text: '剪辑合成中…', active: true });
    }, live);

    localAt(afterFrames + 2000, function () {
      applyEntry({ type: 'process_card', id: 'editing', title: '剪辑合成已完成', meta: '画面、配音、字幕与背景音乐已合成为完整视频轨道', done: true });
      applyEntry({ type: 'status', text: '准备预览…', active: true });
    }, live);

    localAt(afterFrames + 2500, function () {
      doneSteps.push('preview');
      applyEntry({ type: 'stepper', currentStep: 'export', doneSteps: doneSteps.slice() });
      applyEntry({ type: 'summary_card', items: content.summaryItems });
      applyEntry({ type: 'ai_message', text: content.completionText });
      applyEntry({ type: 'script_link', script: content.scriptText });
      applyEntry({ type: 'suggestions', items: ['调整分镜顺序', '换一个背景音乐', '修改旁白音色', '重新生成第 3 个分镜'] });
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
      var next = BGM_CANDIDATES[(BGM_CANDIDATES.indexOf(state.bgm) + 1) % BGM_CANDIDATES.length];
      applyEntry({ type: 'meta', bgm: next });
      applyEntry({ type: 'ai_message', text: '已经换成「' + next + '」啦，感觉怎么样？' });
    } else if (text.indexOf('音色') !== -1 || text.indexOf('旁白') !== -1) {
      var nextVoice = VOICE_CANDIDATES[(VOICE_CANDIDATES.indexOf(state.voice) + 1) % VOICE_CANDIDATES.length];
      applyEntry({ type: 'meta', voice: nextVoice });
      applyEntry({ type: 'ai_message', text: '已经把旁白音色换成「' + nextVoice + '」啦。' });
    } else if (text.indexOf('分镜顺序') !== -1) {
      applyEntry({ type: 'ai_message', text: '已经调整了分镜顺序，你可以在下方分镜列表里查看最新排列。' });
    } else if (text.indexOf('语速') !== -1) {
      applyEntry({ type: 'ai_message', text: '好的，已经把旁白语速调快了一档。' });
    }
  }

  function loadLocalProject(id) {
    localClearTimers();
    if (localDeletedIds.has(id)) return;
    var seed = LOCAL_SEEDS.filter(function (s) { return s.id === id; })[0];
    if (!seed) return;
    state.activeProjectId = id;
    state.isDemo = false; // no ownership concept in local (no-backend) simulation — everything's editable
    state.mode = seed.mode;
    state.projectTitle = seed.title;
    state.bgm = LOCAL_DEFAULT_VOICE_BGM.bgm;
    state.voice = LOCAL_DEFAULT_VOICE_BGM.voice;
    updateProjectTitleUI();
    highlightActiveSidebar(id);
    state.doneSteps = new Set();
    state.currentStep = null;
    state.shots = [];
    renderFilmstrip();
    resetPlayerToEmpty();
    clearChatLogDom();
    document.getElementById('suggestions').hidden = true;

    var content = localBuildContent(seed.prompt);
    applyEntry({ type: 'user_message', text: seed.prompt });
    applyEntry({ type: 'ai_message', text: '收到！我会自动完成脚本、分镜、画面、配音、字幕、剪辑并导出成片，全程无需你确认，请稍候～' });
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
      applyEntry({ type: 'suggestions', items: ['重新生成第 ' + content.shotCount + ' 个分镜', '换一个背景音乐', '修改旁白音色'] });
    } else {
      applyEntry({ type: 'meta', bgm: content.bgm, voice: content.voice });
      var shots2 = content.shots.map(function (s) { return { status: 'ready', hue: s.hue, caption: s.caption }; });
      applyEntry({ type: 'shots', shots: shots2 });
      applyEntry({ type: 'process_card', id: 'storyboard', title: '已拆分为 ' + content.shotCount + ' 个分镜', meta: '', done: true });
      applyEntry({ type: 'process_card', id: 'frames', title: '分镜画面已生成', meta: content.shotCount + ' 个分镜全部完成', done: true });
      applyEntry({ type: 'process_card', id: 'voice', title: '分镜声音已生成', meta: '旁白：' + content.voice + ' · 配乐：' + content.bgm, done: true });
      applyEntry({ type: 'process_card', id: 'subtitle', title: '字幕已生成', meta: '已根据配音文本生成 ' + content.shotCount + ' 条字幕', done: true });
      applyEntry({ type: 'process_card', id: 'sync', title: '已回调分镜画面时长', meta: '已按配音时长重新同步展示时长', done: true });
      applyEntry({ type: 'process_card', id: 'editing', title: '剪辑合成已完成', meta: '画面、配音、字幕与背景音乐已合成为完整视频轨道', done: true });
      applyEntry({ type: 'stepper', currentStep: null, doneSteps: ['script', 'outline', 'storyboard', 'frames', 'voice', 'preview', 'export'] });
      applyEntry({ type: 'summary_card', items: content.summaryItems });
      applyEntry({ type: 'ai_message', text: seed.reply || content.completionText });
      applyEntry({ type: 'script_link', script: content.scriptText });
      applyEntry({ type: 'status', text: '创作完成', active: false });
      applyEntry({ type: 'duration', total: content.totalDuration, done: content.shotCount, totalShots: content.shotCount });
    }
  }

  // ---------- shared sidebar row (thumb + title/meta + "⋮" rename/delete menu) ----------

  function closeAnyProjectMenu() {
    if (openProjectMenuEl) { openProjectMenuEl.remove(); openProjectMenuEl = null; }
  }

  function renameProject(id, isLocal) {
    var current = isLocal
      ? (LOCAL_SEEDS.find(function (s) { return s.id === id; }) || {}).title
      : (lastProjectList.find(function (p) { return p.id === id; }) || {}).title;
    var next = window.prompt('重命名项目', current || '');
    if (next === null) return;
    next = next.trim();
    if (!next) return;
    if (isLocal) {
      var seed = LOCAL_SEEDS.find(function (s) { return s.id === id; });
      if (seed) seed.title = next;
      filterProjectList(document.getElementById('project-search').value);
    } else {
      api('/api/projects/' + id, { method: 'PATCH', body: { title: next } }).then(function () { refreshProjectList(); }).catch(function () {});
    }
    if (state.activeProjectId === id) { state.projectTitle = next; updateProjectTitleUI(); }
  }

  function deleteProject(id, isLocal) {
    if (!window.confirm('确定要删除这个项目吗？此操作不可撤销。')) return;
    if (isLocal) {
      localDeletedIds.add(id);
      filterProjectList(document.getElementById('project-search').value);
    } else {
      api('/api/projects/' + id, { method: 'DELETE' }).then(function () { refreshProjectList(); }).catch(function () {});
    }
    if (state.activeProjectId === id) startNewProject(state.mode);
  }

  function buildProjectRow(opts) {
    // opts: { id, title, metaText, thumbHue, onOpen, isLocal, isDemo }
    var row = document.createElement('div');
    row.className = 'project-item';
    row.dataset.id = opts.id;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    var thumb = 'linear-gradient(160deg, oklch(84% 0.07 ' + opts.thumbHue + '), oklch(70% 0.08 ' + (opts.thumbHue + 10) + '))';
    // Demo/showcase projects are read-only (server-enforced) — no point
    // offering a rename/delete menu that would just 403.
    var menuBtnHtml = opts.isDemo ? '' :
      '<button type="button" class="project-item-menu-btn" aria-label="更多操作">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle></svg>' +
      '</button>';
    row.innerHTML =
      '<div class="project-thumb" style="background:' + thumb + '"></div>' +
      '<div class="project-item-body">' +
        '<span class="project-item-title">' + escapeHtml(opts.title) + '</span>' +
        '<span class="project-item-meta">' + opts.metaText + '</span>' +
      '</div>' + menuBtnHtml;
    row.addEventListener('click', opts.onOpen);
    row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.onOpen(); } });
    var menuBtn = row.querySelector('.project-item-menu-btn');
    if (menuBtn) menuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (openProjectMenuEl && openProjectMenuEl.dataset.forId === opts.id) { closeAnyProjectMenu(); return; }
      closeAnyProjectMenu();
      var menu = document.createElement('div');
      menu.className = 'project-item-menu';
      menu.dataset.forId = opts.id;
      menu.innerHTML = '<button type="button" data-action="rename">重命名</button><button type="button" data-action="delete">删除项目</button>';
      row.appendChild(menu);
      openProjectMenuEl = menu;
      menu.addEventListener('click', function (e2) {
        e2.stopPropagation();
        var action = e2.target.closest('[data-action]') && e2.target.closest('[data-action]').dataset.action;
        if (action === 'rename') renameProject(opts.id, opts.isLocal);
        else if (action === 'delete') deleteProject(opts.id, opts.isLocal);
        closeAnyProjectMenu();
      });
      setTimeout(function () { document.addEventListener('click', closeAnyProjectMenu, { once: true }); }, 0);
    });
    if (opts.id === state.activeProjectId) row.classList.add('is-active');
    return row;
  }

  function renderLocalProjectItems(seeds) {
    var listEl = document.getElementById('project-list');
    listEl.innerHTML = '';
    seeds = seeds.filter(function (s) { return !localDeletedIds.has(s.id); });
    if (!seeds.length) {
      listEl.innerHTML = '<p class="project-empty">没有找到匹配的项目</p>';
      return;
    }
    seeds.forEach(function (seed) {
      var row = buildProjectRow({
        id: seed.id,
        title: seed.title,
        metaText: modeLabel(seed.mode) + ' · ' + escapeHtml(seed.meta),
        thumbHue: localHueForText(seed.id),
        isLocal: true,
        onOpen: function () { loadLocalProject(seed.id); location.hash = '#/workspace'; }
      });
      listEl.appendChild(row);
    });
  }
  function buildLocalProjectList() { renderLocalProjectItems(LOCAL_SEEDS); }

  // =====================================================================
  // Real-backend path
  // =====================================================================

  function renderSidebarFromList(list) {
    var listEl = document.getElementById('project-list');
    listEl.innerHTML = '';
    if (!list.length) {
      listEl.innerHTML = '<p class="project-empty">没有找到匹配的项目</p>';
      return;
    }
    list.forEach(function (proj) {
      var row = buildProjectRow({
        id: proj.id,
        title: proj.title,
        metaText: modeLabel(proj.mode) + ' · ' + escapeHtml(proj.isDemo ? '演示项目' : (proj.status === 'running' ? '编辑中' : proj.meta)),
        thumbHue: proj.thumbHue,
        isLocal: false,
        isDemo: proj.isDemo,
        onOpen: function () { loadProjectFromServer(proj.id); location.hash = '#/workspace'; }
      });
      listEl.appendChild(row);
    });
  }

  function refreshProjectList() {
    return api('/api/projects').then(function (res) {
      if (res.ok) { lastProjectList = res.body; renderSidebarFromList(res.body); }
    });
  }

  // ---------- sidebar search (works against whichever source is active) ----------

  function filterProjectList(query) {
    var q = (query || '').trim().toLowerCase();
    if (backendAvailable === false) {
      var localMatches = !q ? LOCAL_SEEDS : LOCAL_SEEDS.filter(function (s) { return s.title.toLowerCase().indexOf(q) !== -1; });
      renderLocalProjectItems(localMatches);
    } else {
      var matches = !q ? lastProjectList : lastProjectList.filter(function (p) { return p.title.toLowerCase().indexOf(q) !== -1; });
      renderSidebarFromList(matches);
    }
  }

  function loadProjectFromServer(id) {
    closeEventSource();
    api('/api/projects/' + id).then(function (res) {
      if (!res.ok) { showToast('加载项目失败：' + (res.body.error || res.status)); return; }
      var proj = res.body;
      state.activeProjectId = proj.id;
      state.isDemo = !!proj.isDemo;
      state.mode = proj.mode;
      state.projectTitle = proj.title;
      state.bgm = proj.bgm;
      state.voice = proj.voice;
      updateProjectTitleUI();
      highlightActiveSidebar(id);
      state.doneSteps = new Set();
      state.currentStep = null;
      state.shots = [];
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

  function cancelGeneration() {
    if (!state.activeProjectId) return;
    if (backendAvailable === false) {
      localClearTimers();
      applyEntry({ type: 'ai_message', text: '已取消生成。你可以重新输入提示词开始一个新项目，或者继续和我说说想怎么调整。' });
      applyEntry({ type: 'status', text: '已取消，等待新的指令', active: false });
      showToast('已取消生成');
      return;
    }
    api('/api/projects/' + state.activeProjectId + '/cancel', { method: 'POST' }).then(function (res) {
      if (!res.ok) showToast('取消失败：' + (res.body.error || res.status));
      // On success the server pushes its own ai_message/status entries over
      // the existing SSE connection — nothing else to do here.
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
    state.isDemo = false;
    state.projectTitle = '未命名项目';
    state.doneSteps = new Set();
    state.currentStep = null;
    state.shots = [];
    updateProjectTitleUI();
    highlightActiveSidebar(null);
    renderFilmstrip();
    resetPlayerToEmpty();
    clearChatLogDom();
    var empty = document.createElement('div');
    empty.id = 'chat-empty';
    empty.className = 'chat-empty';
    var tip = document.createElement('div');
    tip.className = 'mode-tip ' + (state.mode === 'html' ? 'mode-tip--b' : 'mode-tip--a');
    tip.innerHTML = modeTipIconSvg(state.mode) + '<span>' + escapeHtml(modeIntro(state.mode)) + '</span>';
    empty.appendChild(tip);
    var genericText = document.createElement('p');
    genericText.textContent = '输入一句创作提示词，也可以直接粘贴一段知识主题或长文档。发送后 AI 会自动完成脚本、分镜、画面、配音、字幕、剪辑并导出成片，全程无需你确认；过程会在这里逐步展示，生成后如需微调，随时在这里继续说就行。';
    empty.appendChild(genericText);
    var exWrap = document.createElement('div');
    exWrap.className = 'chat-empty-examples';
    var exLabel = document.createElement('span');
    exLabel.className = 'chat-empty-examples__label';
    exLabel.textContent = '试试这些：';
    exWrap.appendChild(exLabel);
    modeExamplePrompts(state.mode).forEach(function (text) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'suggestion-chip';
      chip.textContent = text;
      chip.addEventListener('click', function () {
        var input = document.getElementById('chat-input');
        input.value = text;
        input.dispatchEvent(new Event('input'));
        input.focus();
      });
      exWrap.appendChild(chip);
    });
    empty.appendChild(exWrap);
    chatLogEl().appendChild(empty);
    var sug = document.getElementById('suggestions');
    sug.hidden = true; sug.innerHTML = '';
    setStatus('等待你的创意提示词', false);
    updateDurationInfo(0, 0, 0);
    var input = document.getElementById('chat-input');
    input.value = '';
    input.style.height = '';
    input.focus();
  }

  function handleSend() {
    var input = document.getElementById('chat-input');
    var text = input.value.trim();
    if (!text) { showToast('请先输入一句提示词吧'); input.focus(); return; }

    if (state.activeProjectId) {
      if (!guardEditable()) return;
      input.value = '';
      input.style.height = '';
      addUserMessage(text);
      if (backendAvailable === false) localHandleMessage(text);
      else postMessage(state.activeProjectId, text);
      return;
    }

    // Creating a project requires login server-side (POST /api/projects
    // 401s otherwise) — check before any optimistic UI change so a
    // logged-out attempt doesn't look like it half-started a project.
    if (backendAvailable !== false && !isLoggedIn()) {
      showToast('请先登录再创建项目');
      openLoginModal();
      return;
    }

    input.value = '';
    input.style.height = '';
    var emptyMsg = document.getElementById('chat-empty');
    if (emptyMsg) emptyMsg.remove();
    document.getElementById('suggestions').hidden = true;
    state.projectTitle = deriveTitle(text);
    updateProjectTitleUI();
    addUserMessage(text);
    setStatus('创建项目中…', true);

    if (backendAvailable === false) {
      state.activeProjectId = 'local-' + Date.now();
      updateToolbarDisabledState();
      localRunPipeline(text, true);
      return;
    }

    api('/api/projects', { method: 'POST', body: { mode: state.mode, prompt: text } }).then(function (res) {
      if (!res.ok) { showToast('创建项目失败：' + (res.body.error || res.status)); setStatus('创建失败', false); return; }
      var proj = res.body;
      state.activeProjectId = proj.id;
      updateToolbarDisabledState();
      refreshProjectList();
      // The server already started the pipeline synchronously (its first
      // step fires ~150ms later), and opening the SSE connection below takes
      // its own round trip — easily enough for that first step or two to
      // fire before we're subscribed. Fetch the current snapshot and catch
      // up on whatever already happened (skipping the user_message we
      // already rendered optimistically above) before subscribing, so the
      // pipeline never appears to silently skip its first couple of steps.
      api('/api/projects/' + proj.id).then(function (snap) {
        if (snap.ok) snap.body.timeline.slice(1).forEach(applyEntry);
        subscribeToProject(proj.id);
      }).catch(function () { subscribeToProject(proj.id); });
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

    // Homepage showcase cards open the matching example project straight
    // into the workspace, reusing whichever path (real backend or local
    // demo simulation) is already active.
    $all('[data-open-project]').forEach(function (card) {
      card.addEventListener('click', function () {
        openProject(card.dataset.openProject);
        location.hash = '#/workspace';
      });
    });

    $all('[data-pricing-cta]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tier = btn.dataset.pricingCta;
        if (tier === 'free') {
          document.querySelector('.mode-grid').scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
        if (!isLoggedIn()) { showToast('请先登录再升级套餐'); openLoginModal(); return; }
        showToast('已收到升级申请，我们会尽快联系你（原型演示）');
      });
    });

    document.getElementById('btn-back').addEventListener('click', function () { location.hash = ''; });
    document.getElementById('btn-new-project').addEventListener('click', function () { startNewProject(state.mode); });

    document.getElementById('player-play-btn').addEventListener('click', togglePlayback);
    document.addEventListener('click', function (e) {
      if (e.target && e.target.id === 'mini-play-icon') togglePlayback();
      if (e.target && (e.target.id === 'fullscreen-icon-btn' || (e.target.closest && e.target.closest('#fullscreen-icon-btn')))) enterFullscreen();
      if (e.target && (e.target.id === 'mute-icon-btn' || (e.target.closest && e.target.closest('#mute-icon-btn')))) toggleMute();
    });

    document.getElementById('btn-fullscreen-toolbar').addEventListener('click', enterFullscreen);
    document.getElementById('player-close-btn').addEventListener('click', exitFullscreen);
    document.getElementById('backdrop').addEventListener('click', exitFullscreen);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { exitFullscreen(); closeScriptModal(); closeLoginModal(); }
    });

    document.getElementById('script-modal-close').addEventListener('click', closeScriptModal);
    document.getElementById('script-modal').addEventListener('click', function (e) {
      if (e.target.id === 'script-modal') closeScriptModal();
    });

    document.getElementById('btn-login').addEventListener('click', openLoginModal);
    document.getElementById('login-modal-close').addEventListener('click', closeLoginModal);
    document.getElementById('login-modal').addEventListener('click', function (e) {
      if (e.target.id === 'login-modal') closeLoginModal();
    });
    document.getElementById('login-mode-toggle').addEventListener('click', function () {
      setLoginModalMode(loginModalMode === 'login' ? 'register' : 'login');
    });
    document.getElementById('login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var errorEl = document.getElementById('login-form-error');
      errorEl.hidden = true;
      var email = document.getElementById('login-account').value.trim();
      var password = document.getElementById('login-password').value;
      var isRegister = loginModalMode === 'register';
      var submitBtn = document.getElementById('login-form-submit');
      submitBtn.disabled = true;
      var body = isRegister
        ? { email: email, password: password, displayName: document.getElementById('login-name').value.trim() }
        : { email: email, password: password };
      api(isRegister ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: body }).then(function (res) {
        submitBtn.disabled = false;
        if (!res.ok) { errorEl.textContent = res.body.error || '出错了，请重试'; errorEl.hidden = false; return; }
        state.currentUser = res.body.user;
        applyLoginUI(state.currentUser);
        closeLoginModal();
        document.getElementById('login-form').reset();
        showToast(isRegister ? '注册成功，欢迎～' : '登录成功');
        updateToolbarDisabledState();
        if (backendAvailable !== false) refreshProjectList(); // sidebar must now include this user's own projects
      }).catch(function () {
        submitBtn.disabled = false;
        errorEl.textContent = '无法连接后端服务，请确认 node video-agent/server.js 正在运行';
        errorEl.hidden = false;
      });
    });
    document.getElementById('user-chip').addEventListener('click', logout);
    document.getElementById('workspace-user-btn').addEventListener('click', function () {
      if (isLoggedIn()) logout(); else openLoginModal();
    });

    document.getElementById('chk-subtitle').addEventListener('change', function (e) { toggleSubtitles(e.target.checked); });

    document.getElementById('btn-ratio').addEventListener('click', toggleRatio);

    function runExport() {
      if (!state.activeProjectId) { showToast('还没有项目可以导出'); return; }
      if (!isLoggedIn()) { showToast('请先登录后再导出成片'); openLoginModal(); return; }
      if (!state.doneSteps.has('preview')) { showToast('先完成分镜生成，再导出视频吧'); return; }
      // Real client-side recording (canvas + MediaRecorder) produces the
      // actual downloadable file; the backend call below is just bookkeeping
      // (marks the project exported) and is best-effort — export still
      // proceeds locally even if it fails or there's no backend at all.
      if (backendAvailable !== false) {
        api('/api/projects/' + state.activeProjectId + '/export', { method: 'POST' }).catch(function () {});
      }
      startCanvasExport();
    }
    document.getElementById('btn-export').addEventListener('click', runExport);
    document.getElementById('btn-record-export').addEventListener('click', runExport);

    document.getElementById('btn-add-shot').addEventListener('click', addShot);
    document.getElementById('btn-batch-edit').addEventListener('click', toggleBatchEdit);
    document.getElementById('meta-row').addEventListener('click', function (e) {
      var target = e.target.closest('[data-field]');
      if (!target) return;
      if (target.dataset.field === 'bgm') cycleBgm();
      else if (target.dataset.field === 'voice') cycleVoice();
    });

    $all('[data-toast]').forEach(function (el) {
      el.addEventListener('click', function () { showToast(el.dataset.toast); });
    });

    // ---- breadcrumb project rename ----
    document.getElementById('btn-rename').addEventListener('click', function () {
      var display = document.getElementById('project-title');
      var input = document.getElementById('project-title-input');
      input.value = state.projectTitle;
      display.hidden = true;
      input.hidden = false;
      input.focus();
      input.select();
    });
    function commitRename() {
      var display = document.getElementById('project-title');
      var input = document.getElementById('project-title-input');
      var next = input.value.trim();
      if (next && guardEditable()) {
        state.projectTitle = next;
        updateProjectTitleUI();
        if (state.activeProjectId && backendAvailable !== false) {
          api('/api/projects/' + state.activeProjectId, { method: 'PATCH', body: { title: next } }).catch(function () {});
        }
      }
      display.hidden = false;
      input.hidden = true;
    }
    document.getElementById('project-title-input').addEventListener('blur', commitRename);
    document.getElementById('project-title-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
      if (e.key === 'Escape') { document.getElementById('project-title').hidden = false; e.target.hidden = true; }
    });

    // ---- sidebar search ----
    document.getElementById('project-search').addEventListener('input', function (e) {
      filterProjectList(e.target.value);
    });

    // ---- chat header actions ----
    document.getElementById('btn-chat-reset').addEventListener('click', function () {
      startNewProject(state.mode);
    });
    document.getElementById('btn-chat-expand').addEventListener('click', function () {
      state.chatExpanded = !state.chatExpanded;
      document.querySelector('.chat-panel').classList.toggle('is-expanded', state.chatExpanded);
    });

    document.getElementById('btn-cancel-generation').addEventListener('click', cancelGeneration);

    document.getElementById('btn-send').addEventListener('click', handleSend);
    document.getElementById('chat-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });
    // Auto-grow so pasting a whole knowledge document doesn't hide most of
    // it behind a single-line box; caps out and scrolls past ~8 lines.
    document.getElementById('chat-input').addEventListener('input', function (e) {
      e.target.style.height = 'auto';
      e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
    });

    window.addEventListener('hashchange', render);
  }

  function boot() {
    attachStaticHandlers();
    renderFilmstrip();
    renderMetaRow();
    refreshAuthState();

    api('/api/projects').then(function (res) {
      if (!res.ok) throw new Error('backend responded but not ok');
      backendAvailable = true;
      lastProjectList = res.body;
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
