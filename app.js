(function () {
  'use strict';

  // ---------- static data ----------

  var STEP_META = [
    { key: 'script', label: '脚本' },
    { key: 'storyboard', label: '分镜' },
    { key: 'frames', label: '画面' },
    { key: 'voice', label: '配音' },
    { key: 'music', label: '配乐' },
    { key: 'preview', label: '预览' },
    { key: 'export', label: '导出' }
  ];

  var SHOT_HUES = [220, 340, 160, 90, 280, 40, 200, 120];

  var HISTORY = [
    {
      id: 'ocean', title: '海洋生物科普·儿童向', mode: 'slideshow', meta: '编辑中',
      thumb: 'linear-gradient(160deg, oklch(78% 0.09 220), oklch(70% 0.1 240))',
      prompt: '帮我做一支 30 秒的儿童科普视频，讲海洋生物，风格活泼可爱，配欢快背景音乐',
      duration: 30, shots: 6, voice: '知性女声', bgm: '海风轻快民谣'
    },
    {
      id: 'autumn', title: '秋季新品发布预告片', mode: 'html', meta: '2 小时前',
      thumb: 'linear-gradient(160deg, var(--accent-2-soft), var(--surface))',
      prompt: '做一支 20 秒的秋季新品发布预告片，突出温暖色调和限时优惠，风格干净有质感',
      reply: '预告片已经生成好啦，6 段网页动效场景全部就绪，配的是电子流行风背景音乐，你可以直接预览～',
      duration: 20, shots: 6, voice: '沉稳男声', bgm: '阳光电子流行'
    },
    {
      id: 'training', title: '内部培训引导视频', mode: 'slideshow', meta: '昨天',
      thumb: 'linear-gradient(160deg, var(--accent-soft), var(--surface))',
      prompt: '做一支面向新员工的安全生产培训引导视频，语气严谨但不生硬，40 秒左右',
      reply: '培训视频已生成，7 个分镜按“流程讲解 + 案例提醒”的顺序排好了，配音用的是沉稳男声。',
      duration: 40, shots: 7, voice: '沉稳男声', bgm: '探索感管弦乐'
    },
    {
      id: 'skincare', title: '小红书种草·护肤新品', mode: 'slideshow', meta: '3 天前',
      thumb: 'linear-gradient(160deg, oklch(88% 0.05 340), var(--surface))',
      prompt: '帮我做一条小红书种草视频脚本，主打一款保湿精华，15 秒内，节奏要快、有网感',
      reply: '种草视频做好啦，5 张分镜图配上了轻快电子乐，笔调也调成了小红书常见的口语化语气。',
      duration: 15, shots: 5, voice: '活泼童声', bgm: '阳光电子流行'
    },
    {
      id: 'case', title: '客户案例讲解 Demo', mode: 'html', meta: '上周',
      thumb: 'linear-gradient(160deg, var(--accent-2-soft), var(--surface))',
      prompt: '用一支 25 秒的动态视频讲解一个客户成功案例，突出前后数据对比',
      reply: '案例讲解视频已生成，用网页动效做了数据对比的动态图表，一共 6 段场景。',
      duration: 25, shots: 6, voice: '知性女声', bgm: '温柔钢琴独奏'
    },
    {
      id: 'brand', title: '品牌故事 30 秒版', mode: 'html', meta: '上周',
      thumb: 'linear-gradient(160deg, oklch(90% 0.04 90), var(--surface))',
      prompt: '做一支 30 秒的品牌故事短片，讲讲我们从车库创业到现在的历程，风格要有情怀',
      reply: '品牌故事已生成，6 段网页动效串起了时间线，配的是有情怀感的钢琴独奏背景音乐。',
      duration: 30, shots: 6, voice: '温柔姐姐音', bgm: '温柔钢琴独奏'
    }
  ];

  // ---------- state ----------

  var state = {
    mode: 'slideshow',
    activeProjectId: null,
    projectTitle: '未命名项目',
    doneSteps: new Set(),
    currentStep: null,
    shots: [],
    bgm: '海风轻快民谣',
    voice: '知性女声',
    timers: [],
    isPlaying: false,
    playbackTimer: null,
    elapsedSeconds: 0,
    totalDuration: 30
  };

  // ---------- small helpers ----------

  function $(sel) { return document.querySelector(sel); }
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

  var toastTimer = null;
  function showToast(msg) {
    var el = document.getElementById('toast');
    clearTimeout(toastTimer);
    el.textContent = msg;
    el.hidden = false;
    toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
  }

  function addTimer(delay, fn) {
    var id = setTimeout(fn, delay);
    state.timers.push(id);
    return id;
  }
  function clearAllTimers() {
    state.timers.forEach(clearTimeout);
    state.timers = [];
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
      div.innerHTML =
        '<div class="step-circle">' + (isDone ? checkSvg() : '<span>' + (i + 1) + '</span>') + '</div>' +
        '<div class="step-label">' + step.label + '</div>';
      el.appendChild(div);
      if (i < STEP_META.length - 1) {
        var conn = document.createElement('div');
        conn.className = 'step-connector';
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

  // ---------- playback ----------

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
    addUserMessage(text);
    if (text.indexOf('重新生成') !== -1) {
      var idx = 2;
      if (state.shots[idx]) {
        state.shots[idx].status = 'loading';
        renderFilmstrip();
        setStatus('重新生成第 3 个分镜…', true);
        addTimer(1100, function () {
          state.shots[idx].status = 'ready';
          state.shots[idx].hue = (state.shots[idx].hue + 40) % 360;
          renderFilmstrip();
          addAiText('第 3 个分镜已经重新生成啦，风格调得更活泼了一些～');
          setStatus('创作完成，等待导出', false);
        });
      }
    } else if (text.indexOf('背景音乐') !== -1) {
      var bgmSel = document.getElementById('select-bgm');
      bgmSel.selectedIndex = (bgmSel.selectedIndex + 1) % bgmSel.options.length;
      state.bgm = bgmSel.value;
      addAiText('已经换成「' + state.bgm + '」啦，感觉怎么样？');
    } else if (text.indexOf('语速') !== -1) {
      addAiText('好的，已经把旁白语速调快了一档。');
    }
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

  // ---------- new / reset project ----------

  function startNewProject(mode) {
    clearAllTimers();
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
    empty.textContent = '在下方输入你想拍的视频内容，比如："帮我做一支 30 秒的儿童科普视频，讲海洋生物，风格活泼可爱，配欢快背景音乐"。发送后，AI 会在这里逐步展示脚本、分镜、配音与配乐的生成过程。';
    chatLogEl().appendChild(empty);
    var sug = document.getElementById('suggestions');
    sug.hidden = true; sug.innerHTML = '';
    setStatus('等待你的创意提示词', false);
    updateDurationInfo(0, 0, 0);
    var input = document.getElementById('chat-input');
    input.value = '';
    input.focus();
  }

  // ---------- pipeline simulation ----------

  function runPipeline(promptText) {
    var shotCount = 6;
    var totalDuration = 30;
    state.totalDuration = totalDuration;

    addTimer(600, function () {
      state.doneSteps.add('script');
      state.currentStep = 'storyboard';
      renderStepper();
      addProcessCard('script', '脚本已生成', Math.max(60, promptText.length * 6) + ' 字 · 时长约 ' + totalDuration + ' 秒', { done: true });
      setStatus('分镜拆分中…', true);
    });

    addTimer(1300, function () {
      state.shots = [];
      for (var i = 0; i < shotCount; i++) state.shots.push({ status: 'pending', hue: SHOT_HUES[i % SHOT_HUES.length] });
      renderFilmstrip();
      state.doneSteps.add('storyboard');
      state.currentStep = 'frames';
      renderStepper();
      addProcessCard('storyboard', '已拆分为 ' + shotCount + ' 个分镜', '开场 · 中间场景 · 结尾', { done: true });
      addProcessCard('frames', '分镜画面生成中', '', { progress: 0 });
      setStatus('分镜画面生成中 (0/' + shotCount + ')', true);
      updateDurationInfo(totalDuration, 0, shotCount);
    });

    for (var i = 0; i < shotCount; i++) {
      (function (idx) {
        addTimer(1300 + 500 * (idx + 1), function () {
          state.shots[idx].status = 'ready';
          renderFilmstrip();
          var doneCount = idx + 1;
          updateProcessCardProgress('frames', Math.round(doneCount / shotCount * 100));
          setStatus('分镜画面生成中 (' + doneCount + '/' + shotCount + ')', true);
          updateDurationInfo(totalDuration, doneCount, shotCount);
          if (doneCount === shotCount) {
            state.doneSteps.add('frames');
            state.currentStep = 'voice';
            renderStepper();
            markProcessCardDone('frames', '分镜画面已生成', shotCount + ' 个分镜全部完成');
            setStatus('旁白配音生成中…', true);
          }
        });
      })(i);
    }

    var afterFrames = 1300 + 500 * shotCount;

    addTimer(afterFrames + 700, function () {
      state.doneSteps.add('voice');
      state.currentStep = 'music';
      renderStepper();
      addProcessCard('voice', '旁白配音已生成', '语音：' + state.voice, { done: true });
      setStatus('挑选背景音乐…', true);
    });

    addTimer(afterFrames + 1300, function () {
      state.doneSteps.add('music');
      state.currentStep = 'preview';
      renderStepper();
      addProcessCard('music', '背景音乐已选定', '曲目：' + state.bgm, { done: true });
      setStatus('准备预览…', true);
    });

    addTimer(afterFrames + 1900, function () {
      state.doneSteps.add('preview');
      state.currentStep = 'export';
      renderStepper();
      selectShot(0);
      addAiText('已经为你生成好全部 ' + shotCount + ' 个分镜的画面、旁白和背景音乐啦，可以点击中间播放预览；如果哪个分镜不满意，直接告诉我要怎么改～');
      showSuggestions(['重新生成第 3 个分镜', '换一个背景音乐', '语速再快一点']);
      setStatus('创作完成，等待导出', false);
    });
  }

  function deriveTitle(text) {
    return text.length > 16 ? text.slice(0, 16) + '…' : text;
  }

  function handleSend() {
    var input = document.getElementById('chat-input');
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    clearAllTimers();
    state.activeProjectId = null;
    state.doneSteps = new Set();
    state.currentStep = 'script';
    state.shots = [];
    renderStepper();
    renderFilmstrip();
    resetPlayerToEmpty();
    highlightActiveSidebar(null);
    state.projectTitle = deriveTitle(text);
    updateProjectTitleUI();
    var emptyMsg = document.getElementById('chat-empty');
    if (emptyMsg) emptyMsg.remove();
    var sug = document.getElementById('suggestions');
    sug.hidden = true; sug.innerHTML = '';
    addUserMessage(text);
    setStatus('脚本生成中…', true);
    runPipeline(text);
  }

  // ---------- loading history / demo projects ----------

  function loadInProgressDemo(proj) {
    state.doneSteps = new Set(['script', 'storyboard']);
    state.currentStep = 'frames';
    var shotCount = proj.shots;
    state.shots = [];
    for (var i = 0; i < shotCount; i++) {
      state.shots.push({ status: i < 4 ? 'ready' : 'loading', hue: SHOT_HUES[i % SHOT_HUES.length], active: i === 0 });
    }
    renderStepper();
    renderFilmstrip();
    clearChatLogDom();
    addUserMessage(proj.prompt);
    addProcessCard('script', '脚本已生成', '186 字 · 时长约 ' + proj.duration + ' 秒', { done: true });
    addProcessCard('storyboard', '已拆分为 ' + shotCount + ' 个分镜', '开场 · 4 种海洋生物 · 结尾', { done: true });
    addProcessCard('frames', '分镜画面生成中', '', { progress: 66 });
    addAiText('已经为前 4 个分镜生成好画面和旁白啦，还剩 2 个在生成中，大概 20 秒。你可以先预览已完成的部分，如果不满意某个分镜的画风，直接告诉我要怎么改～');
    showSuggestions(['重新生成第 5 个分镜', '换一个背景音乐', '语速再快一点']);
    setStatus('分镜画面生成中 (4/' + shotCount + ')', true);
    updateDurationInfo(proj.duration, 4, shotCount);
    selectShot(0);
  }

  function loadCompletedDemo(proj) {
    state.doneSteps = new Set(['script', 'storyboard', 'frames', 'voice', 'music', 'preview', 'export']);
    state.currentStep = null;
    var shotCount = proj.shots;
    var hueOffset = HISTORY.indexOf(proj);
    state.shots = [];
    for (var i = 0; i < shotCount; i++) {
      state.shots.push({ status: 'ready', hue: SHOT_HUES[(i + hueOffset) % SHOT_HUES.length], active: i === 0 });
    }
    renderStepper();
    renderFilmstrip();
    clearChatLogDom();
    addUserMessage(proj.prompt);
    addProcessCard('script', '脚本已生成', '时长约 ' + proj.duration + ' 秒', { done: true });
    addProcessCard('storyboard', '已拆分为 ' + shotCount + ' 个分镜', '', { done: true });
    addProcessCard('frames', '分镜画面已生成', shotCount + ' 个分镜全部完成', { done: true });
    addProcessCard('voice', '旁白配音已生成', '语音：' + proj.voice, { done: true });
    addProcessCard('music', '背景音乐已选定', '曲目：' + proj.bgm, { done: true });
    addAiText(proj.reply);
    setStatus('创作完成', false);
    updateDurationInfo(proj.duration, shotCount, shotCount);
    state.bgm = proj.bgm;
    state.voice = proj.voice;
    var bgmSel = document.getElementById('select-bgm');
    var voiceSel = document.getElementById('select-voice');
    if (bgmSel) bgmSel.value = proj.bgm;
    if (voiceSel) voiceSel.value = proj.voice;
    selectShot(0);
  }

  function loadProject(id) {
    var proj = HISTORY.filter(function (p) { return p.id === id; })[0];
    if (!proj) return;
    clearAllTimers();
    state.activeProjectId = id;
    state.mode = proj.mode;
    state.projectTitle = proj.title;
    updateModeSwitchUI();
    updateProjectTitleUI();
    highlightActiveSidebar(id);
    var sug = document.getElementById('suggestions');
    sug.hidden = true; sug.innerHTML = '';
    if (id === 'ocean') {
      loadInProgressDemo(proj);
    } else {
      loadCompletedDemo(proj);
    }
  }

  function buildProjectList() {
    var listEl = document.getElementById('project-list');
    listEl.innerHTML = '';
    HISTORY.forEach(function (proj) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'project-item';
      btn.dataset.id = proj.id;
      btn.innerHTML =
        '<div class="project-thumb" style="background:' + proj.thumb + '"></div>' +
        '<div class="project-item-body">' +
          '<span class="project-item-title">' + escapeHtml(proj.title) + '</span>' +
          '<span class="project-item-meta">' + (proj.mode === 'slideshow' ? '图片轮播' : 'HTML 视频') + ' · ' + escapeHtml(proj.meta) + '</span>' +
        '</div>';
      btn.addEventListener('click', function () {
        loadProject(proj.id);
        location.hash = '#/workspace';
      });
      listEl.appendChild(btn);
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
      if (e.target && (e.target.id === 'fullscreen-icon-btn' || e.target.closest && e.target.closest('#fullscreen-icon-btn'))) enterFullscreen();
    });

    document.getElementById('btn-preview').addEventListener('click', enterFullscreen);
    document.getElementById('player-close-btn').addEventListener('click', exitFullscreen);
    document.getElementById('backdrop').addEventListener('click', exitFullscreen);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') exitFullscreen();
    });

    document.getElementById('btn-export').addEventListener('click', function () {
      if (!state.doneSteps.has('preview')) { showToast('先完成分镜生成，再导出视频吧'); return; }
      showToast('🎬 演示模式：这里会触发录屏导出真实视频文件（原型未接入真实渲染）');
    });

    $all('[data-toast]').forEach(function (el) {
      el.addEventListener('click', function () { showToast(el.dataset.toast); });
    });

    document.getElementById('select-bgm').addEventListener('change', function (e) {
      state.bgm = e.target.value;
      showToast('背景音乐已切换为「' + state.bgm + '」');
    });
    document.getElementById('select-voice').addEventListener('change', function (e) {
      state.voice = e.target.value;
      showToast('旁白语音已切换为「' + state.voice + '」');
    });

    document.getElementById('btn-send').addEventListener('click', handleSend);
    document.getElementById('chat-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });

    window.addEventListener('hashchange', render);
  }

  document.addEventListener('DOMContentLoaded', function () {
    buildProjectList();
    attachStaticHandlers();
    renderStepper();
    renderFilmstrip();
    if (location.hash === '#/workspace') {
      loadProject('ocean');
    }
    render();
  });
})();
