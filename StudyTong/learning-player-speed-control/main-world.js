(function() {
  'use strict';

  if (window.__studyTongSpeedLock) return;

  var PROGRESS = {
    TASK_MIN_RATIO: 0.9,
    FAKE_CAP_RATIO: 0.992,
    REPORT_CAP_RATIO: 0.995,
    BLOCK_SEEK_RATIO: 0.95,
    REDIRECT_SEEK_RATIO: 0.3,
    ENDED_REWIND_RATIO: 0.85,
    MIN_WATCH_SEC: 30,
    END_SEEK_FROM_END_SEC: 0.2,
    // compat 下对平台谎报 1x，进度每秒最多涨这么多秒，避免「时间跳跃」检测（mock: Δt > 1.5×rate+0.3）
    MAX_FAKE_STEP_PER_SEC: 1.75
  };

  var state = {
    speed: 2,
    enabled: true,
    compatMode: true,
    preventFocusPause: true,
    autoMute: true,
    autoReadDoc: false,
    autoQuiz: false,
    idleMode: false,
    idleSpeed: 1.25,
    applying: false,
    timer: 0,
    docTimer: 0,
    quizTimer: 0,
    observer: null,
    visibilityPatched: false,
    getRealPaused: null,
    origMediaCurrentTime: null,
    origEndedGet: null,
    origPlaybackRate: null,
    reportPlayByJob: {},
    wallWatchByJob: {},
    playerMode: '',
    lastProgressStatus: '',
    lastWarning: ''
  };

  window.__studyTongSpeedLock = state;

  function sharedStore() {
    try {
      var top = window.top;
      if (!top.__studyTongShared) {
        top.__studyTongShared = {
          reportPlayByJob: {},
          wallWatchByJob: {},
          encTypeByJob: {},
          playerMode: 'none'
        };
      }
      var s = top.__studyTongShared;
      if (!s.encTypeByJob) s.encTypeByJob = {};
      if (!s.playerMode) s.playerMode = 'none';
      return s;
    } catch (_) {
      return {
        reportPlayByJob: state.reportPlayByJob,
        wallWatchByJob: state.wallWatchByJob,
        encTypeByJob: {},
        playerMode: 'none'
      };
    }
  }

  function publishTopState() {
    try {
      window.top.__studyTongSpeedLock = state;
      window.top.__studyTongNetPatched = !!window.__studyTongNetPatched;
    } catch (_) {}
  }

  function desiredRate() {
    if (!state.enabled) return 1;
    if (state.idleMode) return normalizedIdleSpeed();
    if (state.compatMode) return compatProgressRate();
    return state.speed;
  }

  function isVideo(node) {
    return node && node.nodeName === 'VIDEO';
  }

  function isVideoJsTech(video) {
    if (!video) return false;
    try {
      if (video.classList && video.classList.contains('vjs-tech')) return true;
      if (video.closest && video.closest('.video-js')) return true;
    } catch (_) {}
    return false;
  }

  function usesSoftCompat(el) {
    return !!(el && el.__st && el.__st.softCompat);
  }

  function setNativeTime(video, sec) {
    var orig = state.origMediaCurrentTime;
    if (!orig || !orig.set || !video) return;
    try {
      state.applying = true;
      orig.set.call(video, sec);
    } catch (_) {
    } finally {
      state.applying = false;
    }
  }

  function readRate(video) {
    try {
      if (state.origPlaybackRate && state.origPlaybackRate.get) {
        return state.origPlaybackRate.get.call(video);
      }
      return video.playbackRate;
    } catch (_) {
      return 1;
    }
  }

  function setRate(video, force) {
    if (!video) return;
    var target = desiredRate();
    if (!force && Math.abs(readRate(video) - target) <= 0.01) return;
    try {
      state.applying = true;
      video.playbackRate = target;
      if (video.defaultPlaybackRate !== target) {
        video.defaultPlaybackRate = target;
      }
    } catch (_) {
    } finally {
      state.applying = false;
    }
    applyAutoMute(video);
  }

  function applyAutoMute(video) {
    if (!video || !state.autoMute || !state.enabled) return;
    if (!video.__st) return;
    var eff = effectiveSpeed();
    if (eff > 1) {
      if (!video.__st._origMutedSaved) {
        video.__st._origMuted = !!video.muted;
        video.__st._origMutedSaved = true;
      }
      video.muted = true;
    } else {
      if (video.__st._origMutedSaved) {
        video.muted = video.__st._origMuted;
        video.__st._origMutedSaved = false;
      }
    }
  }

  // ---- 每个 video 的追踪状态 ----
  function initTrack(v) {
    if (v.__st) return;
    v.__st = {
      startWall: 0,
      accumulated: 0,
      fakeTime: 0,
      lastFakeTick: Date.now(),
      allowEnd: false,
      needReal: needRealSeconds(v),
      softCompat: isVideoJsTech(v),
      _origMuted: false,
      _origMutedSaved: false
    };
  }

  function effectiveSpeed() {
    if (state.idleMode) return normalizedIdleSpeed();
    var s = state.speed;
    if (!isFinite(s) || s <= 0) return 1;
    return Math.max(0.1, s);
  }

  function normalizedIdleSpeed() {
    var s = Number(state.idleSpeed) || 1.25;
    return Math.min(1.5, Math.max(1, s));
  }

  function compatProgressRate() {
    return Math.min(effectiveSpeed(), PROGRESS.MAX_FAKE_STEP_PER_SEC);
  }

  function needRealSeconds(v) {
    var d = v.duration;
    if (!d || !isFinite(d) || d <= 0) return 30;
    // 兼容模式下对页面报告 1x，进度推进不能明显快于墙钟，否则容易触发平台快进检测。
    return Math.max(PROGRESS.TASK_MIN_RATIO * d / compatProgressRate(), PROGRESS.MIN_WATCH_SEC);
  }

  function wallMs(t) {
    var total = t.accumulated;
    if (t.startWall > 0) total += Date.now() - t.startWall;
    return total;
  }

  function targetFakeSeconds(v, wallSec) {
    var sp = state.compatMode ? compatProgressRate() : effectiveSpeed();
    var target = wallSec * sp;
    if (v.duration && isFinite(v.duration) && v.duration > 0) {
      target = Math.min(target, v.duration * PROGRESS.FAKE_CAP_RATIO);
    }
    return target;
  }

  function updateFakeTime(v) {
    var t = v.__st;
    if (!t || !state.compatMode || !state.enabled) return;
    var now = Date.now();
    if (!t.lastFakeTick) t.lastFakeTick = now;
    var dt = Math.max(0, Math.min((now - t.lastFakeTick) / 1000, 2));
    t.lastFakeTick = now;

    var wallSec = wallMs(t) / 1000;
    var target = targetFakeSeconds(v, wallSec);
    // 平台读到 playbackRate=1 时，currentTime 增幅须≈墙钟，否则触发快进检测
    var maxStep = dt * PROGRESS.MAX_FAKE_STEP_PER_SEC;
    var next = Math.min(target, t.fakeTime + maxStep);
    t.fakeTime = Math.max(t.fakeTime, next);

    var d = v.duration;
    if (!t.allowEnd && d && isFinite(d) && d > 0 && t.fakeTime >= d * PROGRESS.TASK_MIN_RATIO) {
      t.allowEnd = true;
      scheduleEndedReconcile(v);
    }
  }

  // 达标后补发 ended，并尽量把解码位置推到片尾，避免只轮询 ended 属性不触发回调
  function isReallyNearEnd(video) {
    if (!video) return false;
    var d = video.duration;
    if (!d || !isFinite(d) || d <= 0) return false;
    try {
      if (state.origEndedGet && state.origEndedGet(video)) return true;
    } catch (_) {}
    try {
      if (state.origMediaCurrentTime) {
        var real = state.origMediaCurrentTime.get.call(video);
        if (real >= d * 0.88) return true;
      }
    } catch (_) {}
    return false;
  }

  function tryNearEndComplete(video) {
    if (!state.compatMode || !state.enabled || !video || !video.__st) return false;
    var t = video.__st;
    var d = video.duration;
    if (!d || !isFinite(d) || d <= 0) return false;
    if (!isReallyNearEnd(video)) return false;

    var wallSec = wallMs(t) / 1000;
    if (wallSec < t.needReal * 0.92) return false;

    state.applying = true;
    t.fakeTime = Math.max(t.fakeTime, d * PROGRESS.TASK_MIN_RATIO + 0.5);
    state.applying = false;

    if (!t.allowEnd) {
      t.allowEnd = true;
      scheduleEndedReconcile(video);
    }
    return true;
  }

  function scheduleEndedReconcile(video) {
    var t = video && video.__st;
    if (!t || t._endedReconciled) return;
    t._endedReconciled = true;
    setTimeout(function() {
      reconcileTaskEnded(video);
    }, 0);
  }

  function reconcileTaskEnded(video) {
    if (!video || !video.__st || !video.__st.allowEnd) return;
    var d = video.duration;
    var soft = video.__st.softCompat;

    if (d && isFinite(d) && d > 0) {
      state.applying = true;
      video.__st.fakeTime = Math.max(video.__st.fakeTime, d * PROGRESS.TASK_MIN_RATIO + 0.3);
      state.applying = false;
      setNativeTime(video, Math.max(0, d - (soft ? 0.35 : PROGRESS.END_SEEK_FROM_END_SEC)));
    }

    try {
      var pr = video.play();
      if (pr && typeof pr.then === 'function') pr.catch(function() {});
    } catch (_) {}

    if (soft) {
      try {
        video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
      } catch (_) {}
      try {
        window.postMessage({ type: 'STUDY_TONG_VIDEO_ENDED' }, '*');
      } catch (_) {}
      return;
    }

    setTimeout(function() {
      try {
        video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
      } catch (_) {}
      setTimeout(function() {
        try {
          video.dispatchEvent(new Event('ended', { bubbles: true }));
        } catch (_) {}
        try {
          window.postMessage({ type: 'STUDY_TONG_VIDEO_ENDED' }, '*');
        } catch (_) {}
      }, 50);
    }, 80);
  }

  // ---- 原型覆盖 ----
  function patchPrototype() {
    var proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
    if (!proto || proto.__studyTongSpeedPatched) return;

    var origCurrentTime = Object.getOwnPropertyDescriptor(proto, 'currentTime');
    var origPaused = Object.getOwnPropertyDescriptor(proto, 'paused');
    var origEnded = Object.getOwnPropertyDescriptor(proto, 'ended');
    var origPlaybackRate = Object.getOwnPropertyDescriptor(proto, 'playbackRate');
    var origPlay = proto.play;
    var origPause = proto.pause;
    if (origPaused && typeof origPaused.get === 'function') {
      state.getRealPaused = function(video) {
        try { return !!origPaused.get.call(video); } catch (_) { return false; }
      };
    }
    if (origEnded && typeof origEnded.get === 'function') {
      state.origEndedGet = function(video) {
        try { return !!origEnded.get.call(video); } catch (_) { return false; }
      };
    }

    if (!origCurrentTime || !origCurrentTime.configurable) return;

    state.origMediaCurrentTime = origCurrentTime;
    state.origPlaybackRate = origPlaybackRate;

    // --- currentTime getter: 返回基于墙钟的假时间 ---
    Object.defineProperty(proto, 'currentTime', {
      configurable: true,
      enumerable: origCurrentTime.enumerable,
      get: function() {
        var real = origCurrentTime.get.call(this);
        if (!state.compatMode || !state.enabled || !this.__st || state.idleMode) return real;
        updateFakeTime(this);
        var t = this.__st;
        if (t.allowEnd) {
          var dur = this.duration;
          if (dur && isFinite(dur) && dur > 0) {
            var finish = Math.min(dur - 0.05, Math.max(real, dur * PROGRESS.TASK_MIN_RATIO, t.fakeTime));
            return finish;
          }
          return real;
        }
        var d = this.duration;
        // 未满时长前不把真实解码进度暴露给页面：高倍速下 real 会秒到结尾，
        // 与平台上报用的墙钟/倍速逻辑不一致，容易导致任务点校验失败。
        if (!d || !isFinite(d) || d <= 0) {
          return Math.max(0, t.fakeTime);
        }
        return Math.min(Math.max(0, t.fakeTime), d * PROGRESS.REPORT_CAP_RATIO);
      },
      set: function(v) {
        if (state.applying || state.idleMode) {
          return origCurrentTime.set.call(this, v);
        }
        if (state.compatMode && state.enabled && this.__st && this.duration && isFinite(this.duration)) {
          var t = this.__st;
          // 未满观看时长前拦截「一键拖到最后」；已满足时长后允许平台正常 seek 到片尾完成任务点
          if (!t.allowEnd && v >= this.duration * PROGRESS.BLOCK_SEEK_RATIO) {
            v = this.duration * PROGRESS.REDIRECT_SEEK_RATIO;
          }
          // 与 updateFakeTime 一致：片长秒 v 对应墙钟 v/sp 秒，故 accumulated 用 v*1000/sp
          var sp = state.compatMode ? compatProgressRate() : effectiveSpeed();
          t.fakeTime = v;
          t.accumulated = (v * 1000) / sp;
          t.startWall = Date.now();
        }
        return origCurrentTime.set.call(this, v);
      }
    });

    // --- paused getter: 始终返回 false ---
    if (origPaused && origPaused.configurable) {
      Object.defineProperty(proto, 'paused', {
        configurable: true,
        enumerable: origPaused.enumerable,
        get: function() {
          if (!state.compatMode || !state.enabled || !this.__st || state.idleMode) return origPaused.get.call(this);
          if (usesSoftCompat(this)) return origPaused.get.call(this);
          return false;
        }
      });
    }

    // --- ended getter: 返回 false 直到 allowEnd ---
    if (origEnded && origEnded.configurable) {
      Object.defineProperty(proto, 'ended', {
        configurable: true,
        enumerable: origEnded.enumerable,
        get: function() {
          var real = origEnded.get.call(this);
          if (!state.compatMode || !state.enabled || !this.__st || state.idleMode) return real;
          if (usesSoftCompat(this)) return real;
          if (this.__st.allowEnd) return real;
          return false;
        }
      });
    }

    // --- pause(): 阻止暂停 ---
    proto.pause = function() {
      if ((state.compatMode || state.idleMode) && state.enabled && this.__st && !usesSoftCompat(this) && !state.applying) {
        // 记录累计时间但不实际暂停
        var t = this.__st;
        if (t.startWall > 0) {
          t.accumulated += Date.now() - t.startWall;
          t.startWall = 0;
        }
        return;
      }
      return origPause.call(this);
    };

    // --- play(): 记录播放开始时间 ---
    proto.play = function() {
      if (state.compatMode && state.enabled) {
        // 懒初始化：平台可能在 hookVideo 之前调用 play()
        if (!this.__st) {
          initTrack(this);
          this.__studyTongSpeedHooked = true;
        }
        var t = this.__st;
        if (t.startWall === 0) {
          t.startWall = Date.now();
          t.needReal = needRealSeconds(this);
        }
      }
      return origPlay.call(this);
    };

    // --- playbackRate setter: 拦截平台修改 ---
    if (origPlaybackRate && origPlaybackRate.configurable) {
      Object.defineProperty(proto, 'playbackRate', {
        configurable: true,
        enumerable: origPlaybackRate.enumerable,
        get: function() {
          var real = origPlaybackRate.get.call(this);
          if (!state.applying && isVideo(this) && state.enabled && (state.compatMode || state.idleMode)) {
            return 1;
          }
          return real;
        },
        set: function(value) {
          var next = value;
          if (!state.applying && isVideo(this) && state.enabled) {
            next = state.idleMode ? (Number(state.idleSpeed) || 1.25) : desiredRate();
          }
          return origPlaybackRate.set.call(this, next);
        }
      });
    }

    Object.defineProperty(proto, '__studyTongSpeedPatched', {
      value: true,
      configurable: true
    });
  }

  // ---- 收集页面所有 video ----
  function collectVideos(root, out) {
    if (!root) return out;
    if (isVideo(root)) {
      out.push(root);
      return out;
    }
    if (root.querySelectorAll) {
      var videos = root.querySelectorAll('video');
      for (var i = 0; i < videos.length; i++) out.push(videos[i]);
      var nodes = root.querySelectorAll('*');
      for (var j = 0; j < nodes.length; j++) {
        if (nodes[j].shadowRoot) collectVideos(nodes[j].shadowRoot, out);
      }
    }
    return out;
  }

  // ---- 对单个 video 应用 hook ----
  function hookVideo(video) {
    if (!video || video.__studyTongSpeedHooked) return;

    try {
      Object.defineProperty(video, '__studyTongSpeedHooked', {
        value: true,
        configurable: true
      });
    } catch (_) {
      video.__studyTongSpeedHooked = true;
    }

    initTrack(video);
    applyAutoMute(video);

    video.addEventListener('ended', function(e) {
      if (!state.compatMode || !state.enabled) return;
      var t = video.__st;
      if (!t) return;
      var d = video.duration;
      updateFakeTime(video);
      if (t.allowEnd) return;

      if (tryNearEndComplete(video)) {
        if (d && isFinite(d)) {
          setNativeTime(video, Math.max(0, d - 0.4));
          try { video.play(); } catch (_) {}
        }
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
      }

      if (d && isFinite(d) && t.fakeTime < d * PROGRESS.TASK_MIN_RATIO) {
        e.stopImmediatePropagation();
        e.preventDefault();
        setNativeTime(video, d * PROGRESS.ENDED_REWIND_RATIO);
        try { video.play(); } catch (_) {}
      }
    }, true);

    // 倍速维护事件
    var fix = function() { setRate(video, false); };
    video.addEventListener('ratechange', fix, true);
    video.addEventListener('play', fix, true);
    video.addEventListener('playing', fix, true);
    video.addEventListener('timeupdate', function() {
      if (state.compatMode && state.enabled) tryNearEndComplete(video);
    }, true);
    video.addEventListener('loadedmetadata', function() {
      if (video.__st) {
        video.__st.allowEnd = false;
        video.__st._endedReconciled = false;
        video.__st.fakeTime = 0;
        video.__st.accumulated = 0;
        video.__st.startWall = 0;
        video.__st.lastFakeTick = Date.now();
        video.__st.needReal = needRealSeconds(video);
      } else {
        initTrack(video);
      }
      setRate(video, true);
    }, true);

    setRate(video, true);
  }

  function applyAll(force) {
    var videos = collectVideos(document, []);
    for (var i = 0; i < videos.length; i++) {
      hookVideo(videos[i]);
      setRate(videos[i], force);
    }
  }

  // ---- MutationObserver：监听新增的 video ----
  function observeVideos() {
    if (state.observer || !document.documentElement) return;
    state.observer = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var nodes = mutations[i].addedNodes;
        for (var j = 0; j < nodes.length; j++) {
          var node = nodes[j];
          if (isVideo(node)) {
            hookVideo(node);
          } else if (node && node.querySelectorAll) {
            var videos = collectVideos(node, []);
            for (var k = 0; k < videos.length; k++) hookVideo(videos[k]);
          }
        }
      }
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  // ---- 心跳：更新 fakeTime 并检查 allowEnd ----
  function startHeartbeat() {
    if (state.timer) return;
    state.timer = window.setInterval(function() {
      if (!state.enabled || !state.compatMode) return;
      var videos = collectVideos(document, []);
      for (var i = 0; i < videos.length; i++) {
        var v = videos[i];
        if (v.__st) {
          // 兜底：某些页面在注入前已开始播放，play() hook 不会触发，导致 startWall 一直为 0。
          // 这里用真实 paused 状态补齐开始/暂停计时，避免 allowEnd 永远不满足。
          if (state.getRealPaused) {
            var realPaused = state.getRealPaused(v);
            if (!realPaused && v.__st.startWall === 0) {
              v.__st.startWall = Date.now();
              v.__st.needReal = needRealSeconds(v);
            } else if (realPaused && v.__st.startWall > 0) {
              v.__st.accumulated += Date.now() - v.__st.startWall;
              v.__st.startWall = 0;
            }
          }
          updateFakeTime(v);
          tryNearEndComplete(v);
        }
      }
    }, 500);
  }

  // ---- 接收配置更新 ----
  function update(config) {
    if (!config) return;
    var speedChanged = false;
    var autoMuteChanged = false;
    if (typeof config.speed === 'number' && isFinite(config.speed)) {
      state.speed = Math.max(0.1, config.speed);
      speedChanged = true;
    }
    if (typeof config.enabled === 'boolean') {
      state.enabled = config.enabled;
    }
    if (typeof config.compatMode === 'boolean') {
      state.compatMode = config.compatMode;
    }
    if (typeof config.preventFocusPause === 'boolean') {
      state.preventFocusPause = config.preventFocusPause;
    }
    if (typeof config.autoMute === 'boolean') {
      state.autoMute = config.autoMute;
      autoMuteChanged = true;
    }
    if (typeof config.autoReadDoc === 'boolean') {
      state.autoReadDoc = config.autoReadDoc;
      if (state.autoReadDoc && !state.docTimer) startDocReader();
      if (!state.autoReadDoc && state.docTimer) {
        clearInterval(state.docTimer);
        state.docTimer = 0;
      }
    }
    if (typeof config.autoQuiz === 'boolean') {
      state.autoQuiz = config.autoQuiz;
      if (state.autoQuiz && !state.quizTimer) startQuizSolver();
      if (!state.autoQuiz && state.quizTimer) {
        clearInterval(state.quizTimer);
        state.quizTimer = 0;
      }
    }
    if (typeof config.idleMode === 'boolean') {
      if (config.idleMode && !state.idleMode) enterIdleMode();
      if (!config.idleMode && state.idleMode) exitIdleMode();
    }
    if (typeof config.idleSpeed === 'number' && isFinite(config.idleSpeed)) {
      state.idleSpeed = Math.min(1.5, Math.max(1, config.idleSpeed));
      if (state.idleMode) {
        // 挂机中改速度立即生效
        var is = state.idleSpeed;
        var videos = collectVideos(document, []);
        for (var i = 0; i < videos.length; i++) {
          try { state.applying = true; videos[i].playbackRate = is; state.applying = false; } catch (_) { state.applying = false; }
        }
      }
    }
    applyAll(true);
    // speed/autoMute 改变后更新所有已 hook video
    if (speedChanged || autoMuteChanged) {
      var videos = collectVideos(document, []);
      for (var i = 0; i < videos.length; i++) {
        var v = videos[i];
        if (v.__st) {
          v.__st.needReal = needRealSeconds(v);
        }
        applyAutoMute(v);
      }
    }
  }

  function safeActivateElement(el) {
    if (!el) return;
    try {
      if (typeof el.onclick === 'function') {
        el.onclick.call(el, { preventDefault: function() {}, stopPropagation: function() {} });
        return;
      }
    } catch (_) {}
    try {
      var evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
      el.dispatchEvent(evt);
    } catch (_) {}
  }

  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    var data = event.data || {};
    if (data.type === 'STUDY_TONG_SAFE_ACTIVATE') {
      var el = document.querySelector('[data-st-tong-act]');
      if (el) {
        el.removeAttribute('data-st-tong-act');
        safeActivateElement(el);
      }
      return;
    }
    if (data.type !== 'STUDY_TONG_SPEED_CONFIG') return;
    update(data);
  });

  // ---- 学习通进度上报：playingTime + enc（与 video.currentTime 可能无关）----
  function md5hex(str) {
    function cmn(q, a, b, x, s, t) {
      a = (a + q + x + t) | 0;
      return (((a << s) | (a >>> (32 - s))) + b) | 0;
    }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
    function md5blk(s) {
      var md5blks = [];
      for (var i = 0; i < 64; i += 4) {
        md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) +
          (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
      }
      return md5blks;
    }
    function md51(s) {
      var n = s.length;
      var state = [1732584193, -271733879, -1732584194, 271733878];
      var i;
      for (i = 64; i <= n; i += 64) {
        md5cycle(state, md5blk(s.substring(i - 64, i)));
      }
      s = s.substring(i - 64);
      var tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (i = 0; i < s.length; i++) tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
      tail[i >> 2] |= 0x80 << ((i % 4) << 3);
      if (i > 55) { md5cycle(state, tail); tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; }
      tail[14] = n * 8;
      md5cycle(state, tail);
      return state;
    }
    function md5cycle(x, k) {
      var a = x[0]; var b = x[1]; var c = x[2]; var d = x[3];
      a = ff(a, b, c, d, k[0], 7, -680876936); d = ff(d, a, b, c, k[1], 12, -389564586);
      c = ff(c, d, a, b, k[2], 17, 606105819); b = ff(b, c, d, a, k[3], 22, -1044525330);
      a = ff(a, b, c, d, k[4], 7, -176418897); d = ff(d, a, b, c, k[5], 12, 1200080426);
      c = ff(c, d, a, b, k[6], 17, -1473231341); b = ff(b, c, d, a, k[7], 22, -45705983);
      a = ff(a, b, c, d, k[8], 7, 1770035416); d = ff(d, a, b, c, k[9], 12, -1958414417);
      c = ff(c, d, a, b, k[10], 17, -42063); b = ff(b, c, d, a, k[11], 22, -1990404162);
      a = ff(a, b, c, d, k[12], 7, 1804603682); d = ff(d, a, b, c, k[13], 12, -40341101);
      c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);
      a = gg(a, b, c, d, k[1], 5, -165796510); d = gg(d, a, b, c, k[6], 9, -1069501632);
      c = gg(c, d, a, b, k[11], 14, 643717713); b = gg(b, c, d, a, k[0], 20, -373897302);
      a = gg(a, b, c, d, k[5], 5, -701558691); d = gg(d, a, b, c, k[10], 9, 38016083);
      c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848);
      a = gg(a, b, c, d, k[9], 5, 568446438); d = gg(d, a, b, c, k[14], 9, -1019803690);
      c = gg(c, d, a, b, k[3], 14, -187363961); b = gg(b, c, d, a, k[8], 20, 1163531501);
      a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784);
      c = gg(c, d, a, b, k[7], 14, 1735328473); b = gg(b, c, d, a, k[12], 20, -1926607734);
      a = hh(a, b, c, d, k[5], 4, -378558); d = hh(d, a, b, c, k[8], 11, -2022574463);
      c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556);
      a = hh(a, b, c, d, k[1], 4, -1530992060); d = hh(d, a, b, c, k[4], 11, 1272893353);
      c = hh(c, d, a, b, k[7], 16, -155497632); b = hh(b, c, d, a, k[10], 23, -1094730640);
      a = hh(a, b, c, d, k[13], 4, 681279174); d = hh(d, a, b, c, k[0], 11, -358537222);
      c = hh(c, d, a, b, k[3], 16, -722521979); b = hh(b, c, d, a, k[6], 23, 76029189);
      a = hh(a, b, c, d, k[9], 4, -640364487); d = hh(d, a, b, c, k[12], 11, -421815835);
      c = hh(c, d, a, b, k[15], 16, 530742520); b = hh(b, c, d, a, k[2], 23, -995338651);
      a = ii(a, b, c, d, k[0], 6, -198630844); d = ii(d, a, b, c, k[7], 10, 1126891415);
      c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
      a = ii(a, b, c, d, k[12], 6, 1700485571); d = ii(d, a, b, c, k[3], 10, -1894986606);
      c = ii(c, d, a, b, k[10], 15, -1051523); b = ii(b, c, d, a, k[1], 21, -2054922799);
      a = ii(a, b, c, d, k[8], 6, 1873313359); d = ii(d, a, b, c, k[15], 10, -30611744);
      c = ii(c, d, a, b, k[6], 15, -1560198380); b = ii(b, c, d, a, k[13], 21, 1309151649);
      a = ii(a, b, c, d, k[4], 6, -145523070); d = ii(d, a, b, c, k[11], 10, -1120210379);
      c = ii(c, d, a, b, k[2], 15, 718787259); b = ii(b, c, d, a, k[9], 21, -343485551);
      x[0] = (a + x[0]) | 0; x[1] = (b + x[1]) | 0; x[2] = (c + x[2]) | 0; x[3] = (d + x[3]) | 0;
    }
    function rhex(n) {
      var s = '';
      for (var j = 0; j < 4; j++) {
        s += ('0' + ((n >> (j * 8 + 4)) & 0x0f).toString(16) + ((n >> (j * 8)) & 0x0f).toString(16)).slice(-2);
      }
      return s;
    }
    return md51(str).map(rhex).join('');
  }

  function parseQuery(qs) {
    var o = {};
    if (!qs) return o;
    qs.split('&').forEach(function(pair) {
      if (!pair) return;
      var i = pair.indexOf('=');
      if (i < 0) { o[decodeURIComponent(pair)] = ''; return; }
      o[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
    });
    return o;
  }

  function stringifyQuery(o) {
    var parts = [];
    for (var k in o) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(o[k]));
    }
    return parts.join('&');
  }

  function shouldPatchProgressUrl(url) {
    if (!url || !state.compatMode || !state.enabled || state.idleMode) return false;
    if (!/playingTime/i.test(url) || !/duration/i.test(url)) return false;
    return /chaoxing\.com/i.test(url) &&
      (/enc=/i.test(url) || /mooc-ans|multimedia|heartbeat|HeartBeat|doubleData|insertStudyLog|videoPlay|\/log\//i.test(url));
  }

  function pickParam(params, keys) {
    for (var i = 0; i < keys.length; i++) {
      if (params[keys[i]] != null && params[keys[i]] !== '') {
        return String(params[keys[i]]);
      }
    }
    return '';
  }

  function encPwd(type, params, playSec, durSec) {
    var clazzId = pickParam(params, ['clazzId', 'clazzid']);
    var userid = pickParam(params, ['userid', 'userId', 'uid', 'cpi']);
    var jobid = pickParam(params, ['jobid', 'jobId']);
    var objectId = pickParam(params, ['objectId', 'objectid', 'mid']);
    var clipTime = pickParam(params, ['clipTime', 'clip_time']) || '0_0';
    var salt = 'd_yHJ!$pdA~5';
    if (!isFinite(durSec) || durSec <= 0) return '';
    if (!isFinite(playSec)) playSec = 0;
    var playMs = Math.floor(playSec * 1000);
    var durMs = Math.floor(durSec * 1000);
    if (type === 2) {
      return '[' + clazzId + '][' + userid + '][' + jobid + '][' + objectId + '][' +
        Math.floor(playSec) + '][' + salt + '][' + Math.floor(durSec) + '][' + clipTime + ']';
    }
    if (type === 1 || playSec >= durSec * PROGRESS.TASK_MIN_RATIO - 0.5) {
      return '[' + clazzId + '][' + userid + '][' + jobid + '][' + objectId + '][' +
        durMs + '][' + salt + '][' + durMs + '][' + clipTime + ']';
    }
    return '[' + clazzId + '][' + userid + '][' + jobid + '][' + objectId + '][' +
      playMs + '][' + salt + '][' + durMs + '][' + clipTime + ']';
  }

  function resolveEncType(jobKey, params, origPlay, origEnc, durSec) {
    var store = sharedStore();
    if (store.encTypeByJob[jobKey] != null) return store.encTypeByJob[jobKey];
    if (!origEnc) return 0;
    if (!isFinite(origPlay)) origPlay = 0;
    var t;
    for (t = 0; t < 3; t++) {
      if (md5hex(encPwd(t, params, origPlay, durSec)) === origEnc) {
        store.encTypeByJob[jobKey] = t;
        return t;
      }
    }
    store.encTypeByJob[jobKey] = 0;
    return 0;
  }

  function computeEnc(params, playSec, durSec, jobKey, origPlay, origEnc) {
    var names = ['getEnc', 'getReportEnc', 'genEnc', 'createEnc'];
    for (var i = 0; i < names.length; i++) {
      try {
        if (typeof window[names[i]] === 'function') {
          var r = window[names[i]](playSec, durSec, params);
          if (r) return String(r);
        }
      } catch (_) {}
    }
    var encType = resolveEncType(jobKey, params, origPlay, origEnc, durSec);
    return md5hex(encPwd(encType, params, playSec, durSec));
  }

  function getPrimaryVideo() {
    var videos = collectVideos(document, []);
    return videos.length ? videos[0] : null;
  }

  function detectPlayerMode() {
    if (getPrimaryVideo()) return 'html5';
    try {
      if (document.querySelector('object, embed, iframe[src*="flash"]')) return 'flash';
      if (document.querySelector('.ans-insertvideo-online, #flashbox, .flashPlayer')) return 'flash';
    } catch (_) {}
    return 'none';
  }

  function syncWallWatch(jobKey, dur) {
    var store = sharedStore();
    var w = store.wallWatchByJob[jobKey];
    var now = Date.now();
    if (!w || w.duration !== dur) {
      store.wallWatchByJob[jobKey] = {
        duration: dur,
        accumulatedMs: 0,
        startMs: document.hidden ? 0 : now,
        running: !document.hidden
      };
      return;
    }
    if (w.running && w.startMs) {
      w.accumulatedMs += now - w.startMs;
    }
    w.startMs = document.hidden ? 0 : now;
    w.running = !document.hidden;
  }

  function getWallWatchSeconds(jobKey) {
    var w = sharedStore().wallWatchByJob[jobKey];
    if (!w) return 0;
    var ms = w.accumulatedMs;
    if (w.running && w.startMs) ms += Date.now() - w.startMs;
    return (ms / 1000) * compatProgressRate();
  }

  function getReportTargetSeconds(dur, jobKey) {
    var target = 0;
    var v = getPrimaryVideo();
    if (v && v.__st) {
      updateFakeTime(v);
      target = Math.max(target, v.__st.fakeTime);
    }
    syncWallWatch(jobKey, dur);
    target = Math.max(target, getWallWatchSeconds(jobKey));
    return Math.min(dur * PROGRESS.FAKE_CAP_RATIO, target);
  }

  function reportJobKey(params) {
    return String(params.jobid || params.objectId || 'default');
  }

  function fixProgressParams(params) {
    if (!params.duration || params.playingTime == null || !params.enc) return params;
    var dur = parseFloat(params.duration);
    var play = parseFloat(params.playingTime);
    if (!isFinite(dur) || dur <= 0 || !isFinite(play)) return params;

    var mode = detectPlayerMode();
    if (mode !== 'none') {
      sharedStore().playerMode = mode;
      state.playerMode = mode;
    } else {
      state.playerMode = sharedStore().playerMode || 'none';
    }
    var jobKey = reportJobKey(params);
    var target = getReportTargetSeconds(dur, jobKey);
    var last = sharedStore().reportPlayByJob[jobKey] || 0;

    var next = Math.min(dur * PROGRESS.FAKE_CAP_RATIO, target);
    next = Math.max(play, next, last);

    if (next >= dur * PROGRESS.TASK_MIN_RATIO) {
      next = Math.min(dur, Math.max(next, dur * 0.96));
    }

    if (Math.abs(next - play) < 0.05) return params;

    sharedStore().reportPlayByJob[jobKey] = next;
    var origEnc = params.enc;
    params.playingTime = String(Math.floor(next * 1000) / 1000);
    params.enc = computeEnc(params, next, dur, jobKey, play, origEnc);
    return params;
  }

  function startWallWatchListeners() {
    if (state.wallWatchListeners) return;
    state.wallWatchListeners = true;
    document.addEventListener('visibilitychange', function() {
      if (!state.compatMode || !state.enabled) return;
      var keys = Object.keys(sharedStore().wallWatchByJob);
      for (var i = 0; i < keys.length; i++) {
        var w = sharedStore().wallWatchByJob[keys[i]];
        if (w) syncWallWatch(keys[i], w.duration);
      }
    });
  }

  function fixProgressUrl(url) {
    if (!shouldPatchProgressUrl(url)) return url;
    var q = url.indexOf('?');
    if (q < 0) return url;
    var params = fixProgressParams(parseQuery(url.slice(q + 1)));
    return url.slice(0, q + 1) + stringifyQuery(params);
  }

  function fixProgressBody(body) {
    if (!body || typeof body !== 'string') return body;
    if (body.indexOf('playingTime') === -1) return body;
    try {
      if (body.charAt(0) === '{') {
        var json = JSON.parse(body);
        fixProgressParams(json);
        return JSON.stringify(json);
      }
    } catch (_) {}
    var params = fixProgressParams(parseQuery(body));
    return stringifyQuery(params);
  }

  function patchNetwork() {
    if (window.__studyTongNetPatched) return;
    window.__studyTongNetPatched = true;

    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      try {
        var u = String(url || '');
        if (shouldPatchProgressUrl(u)) url = fixProgressUrl(u);
      } catch (_) {}
      this.__stPatchBody = shouldPatchProgressUrl(String(url || ''));
      return origOpen.call(this, method, url);
    };
    XMLHttpRequest.prototype.send = function(body) {
      var self = this;
      try {
        if (this.__stPatchBody) {
          body = fixProgressBody(body);
          this.addEventListener('load', function() {
            try {
              if (!self.__stPatchBody || !self.responseText) return;
              if (/isPassed"\s*:\s*false/i.test(self.responseText)) {
                state.lastProgressStatus = 'isPassed:false';
              }
            } catch (_) {}
          });
        }
      } catch (_) {}
      return origSend.call(this, body);
    };

    if (window.fetch) {
      var origFetch = window.fetch;
      window.fetch = function(input, init) {
        try {
          if (typeof input === 'string' && shouldPatchProgressUrl(input)) {
            input = fixProgressUrl(input);
          } else if (input && input.url && shouldPatchProgressUrl(input.url)) {
            input = new Request(fixProgressUrl(input.url), input);
          }
          if (init && init.body) {
            init = Object.assign({}, init, { body: fixProgressBody(init.body) });
          }
        } catch (_) {}
        return origFetch.call(this, input, init);
      };
    }
  }

  // ---- 防失焦暂停 ----
  function patchVisibility() {
    if (state.visibilityPatched) return;
    state.visibilityPatched = true;

    // 1) 拦截 visibilitychange 事件
    document.addEventListener('visibilitychange', function(e) {
      if (state.preventFocusPause && state.enabled) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }, true);

    // 2) 覆盖 document.hidden
    var origHiddenDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
    if (origHiddenDesc && origHiddenDesc.configurable) {
      Object.defineProperty(Document.prototype, 'hidden', {
        configurable: true,
        enumerable: origHiddenDesc.enumerable,
        get: function() {
          if (state.preventFocusPause && state.enabled) return false;
          return origHiddenDesc.get.call(this);
        }
      });
    }

    // 3) 覆盖 document.visibilityState
    var origVisDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    if (origVisDesc && origVisDesc.configurable) {
      Object.defineProperty(Document.prototype, 'visibilityState', {
        configurable: true,
        enumerable: origVisDesc.enumerable,
        get: function() {
          if (state.preventFocusPause && state.enabled) return 'visible';
          return origVisDesc.get.call(this);
        }
      });
    }

    // 4) 覆盖 document.hasFocus()
    var origHasFocus = Document.prototype.hasFocus;
    Document.prototype.hasFocus = function() {
      if (state.preventFocusPause && state.enabled) return true;
      return origHasFocus.call(this);
    };

    // 5) 拦截 window blur 事件
    window.addEventListener('blur', function(e) {
      if (state.preventFocusPause && state.enabled) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }, true);

    // 覆盖 window.onblur setter
    var blurDesc = Object.getOwnPropertyDescriptor(Window.prototype, 'onblur');
    if (!blurDesc) blurDesc = Object.getOwnPropertyDescriptor(window, 'onblur');
    if (blurDesc && blurDesc.configurable) {
      var origBlurGetter = blurDesc.get;
      var origBlurSetter = blurDesc.set;
      var _rawBlurHandler = null;
      Object.defineProperty(window, 'onblur', {
        configurable: true,
        enumerable: blurDesc.enumerable,
        get: function() { return _rawBlurHandler; },
        set: function(fn) {
          _rawBlurHandler = fn;
          if (typeof fn === 'function') {
            origBlurSetter.call(this, function(e) {
              if (state.preventFocusPause && state.enabled) return;
              fn.call(this, e);
            });
          } else {
            origBlurSetter.call(this, fn);
          }
        }
      });
    }

    // 6) 拦截鼠标移出事件（平台常用来检测用户是否在看视频）
    var mouseLeaveEvents = ['mouseleave', 'mouseout', 'pointerleave', 'pointerout'];
    for (var m = 0; m < mouseLeaveEvents.length; m++) {
      document.addEventListener(mouseLeaveEvents[m], function(e) {
        if (state.preventFocusPause && state.enabled) {
          e.stopImmediatePropagation();
          e.preventDefault();
        }
      }, true);
    }
  }

  // ---- 自动阅读文档 ----
  function startDocReader() {
    if (state.docTimer) return;
    state.docTimer = window.setInterval(function() {
      if (!state.autoReadDoc || !state.enabled) return;

      // 检测文档页面的可滚动容器
      var docSelectors = [
        '.ans-read-general', '.ans-read-container', '.read-main',
        '#readFrame', '.readArea', '.docContent', '.pdf-container',
        'iframe[src*="read"]', 'iframe[src*="doc"]', 'iframe[src*="pdf"]'
      ];

      var container = null;
      for (var s = 0; s < docSelectors.length; s++) {
        var el = document.querySelector(docSelectors[s]);
        if (el && (el.scrollHeight > el.clientHeight + 5 || el.tagName === 'IFRAME')) {
          container = el;
          break;
        }
      }

      // 模拟滚动
      if (container) {
        if (container.tagName === 'IFRAME') {
          try { container.contentWindow.scrollBy({ top: 300, behavior: 'smooth' }); } catch (_) {}
        } else {
          container.scrollBy({ top: 300, behavior: 'smooth' });
        }
      } else {
        window.scrollBy({ top: 300, behavior: 'smooth' });
      }

      // 模拟鼠标活动（派发 mousemove 事件保持活跃状态）
      try {
        var evt = new MouseEvent('mousemove', {
          bubbles: true, cancelable: true,
          clientX: Math.floor(Math.random() * 500 + 100),
          clientY: Math.floor(Math.random() * 300 + 100)
        });
        document.dispatchEvent(evt);
      } catch (_) {}

      // 自动点击"下一节"/"继续"/"完成"按钮
      var NEXT_DOC_LABELS = ['下一', '继续', '下一页', '完成', '确定', '提交', '下一章', '下一节'];
      var nodes = document.querySelectorAll('a, button, [role="button"], input[type="button"], .next, .next_btn, .continue');
      for (var n = 0; n < nodes.length; n++) {
        var btn = nodes[n];
        if (!btn || btn.disabled) continue;
        var txt = (btn.innerText || btn.textContent || btn.value || '').replace(/\s+/g, '');
        var isVisible = btn.offsetParent !== null || btn.getClientRects().length > 0;
        if (!isVisible) continue;
        for (var l = 0; l < NEXT_DOC_LABELS.length; l++) {
          if (txt.indexOf(NEXT_DOC_LABELS[l]) !== -1) {
            try {
              if (typeof btn.onclick === 'function') {
                btn.onclick.call(btn, { preventDefault: function(){}, stopPropagation: function(){} });
              }
              btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            } catch (_) {}
            return;
          }
        }
      }
    }, 3000);
  }

  // ---- 自动答题 ----
  function startQuizSolver() {
    if (state.quizTimer) return;
    state.quizTimer = window.setInterval(function() {
      if (!state.autoQuiz || !state.enabled) return;

      // 检测题目容器
      var qSelectors = [
        '.TiMu', '.question', '.testQuestion', '.singleQues', '.multipleQues',
        '.exam-item', '.quiz-item', '.answer-area', '.topic-item',
        '.cy_ul li', '.mark_item'
      ];
      var questions = [];
      for (var q = 0; q < qSelectors.length; q++) {
        var nodes = document.querySelectorAll(qSelectors[q]);
        for (var i = 0; i < nodes.length; i++) {
          if (questions.indexOf(nodes[i]) < 0) questions.push(nodes[i]);
        }
      }

      var answeredCount = 0;
      for (var qi = 0; qi < questions.length; qi++) {
        var qEl = questions[qi];
        if (qEl.__stQuizAnswered) { answeredCount++; continue; }
        if (tryAnswerQuestion(qEl)) {
          qEl.__stQuizAnswered = true;
          answeredCount++;
        }
      }

      // 全部答完后尝试提交
      if (answeredCount > 0 && answeredCount >= questions.length && questions.length > 0) {
        var submitSelectors = [
          '.subBtn', '.submitBtn', '#submitBtn', '.submit-test',
          'input[value*="提交"]', 'button[value*="提交"]',
          '.btnSubmit', '#btnSubmit', '.ans-submit-btn'
        ];
        for (var ss = 0; ss < submitSelectors.length; ss++) {
          var sub = document.querySelector(submitSelectors[ss]);
          if (sub && !sub.disabled) {
            try {
              sub.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              if (typeof sub.onclick === 'function') sub.onclick();
            } catch (_) {}
            break;
          }
        }
      }
    }, 5000);
  }

  function tryAnswerQuestion(qEl) {
    // 策略 1: 从题目元素的 data 属性直接提取答案
    var answerKeys = ['answer', 'key', 'right', 'correct', 'data-answer', 'data-key', 'data-right', 'data-correct', 'ans', 'data-ans'];
    var answer = '';
    for (var a = 0; a < answerKeys.length; a++) {
      var val = qEl.getAttribute(answerKeys[a]) || qEl.dataset && qEl.dataset[answerKeys[a].replace('data-', '')];
      if (val) { answer = String(val).trim().toUpperCase(); break; }
    }

    // 策略 2: 查找隐藏元素中的正确答案
    if (!answer) {
      var hiddenSelectors = ['.correctAnswer', '.answer', '.rightAnswer', '.key', '.trueAnswer',
        'input[type="hidden"][name*="answer"]', '.ansRight', '.right_key'];
      for (var h = 0; h < hiddenSelectors.length; h++) {
        var hidden = qEl.querySelector(hiddenSelectors[h]);
        if (hidden) {
          answer = String(hidden.value || hidden.textContent || hidden.innerText || '').trim().toUpperCase();
          if (answer) break;
        }
      }
    }

    // 策略 3: 遍历选项找 data 属性标记
    if (!answer) {
      var options = qEl.querySelectorAll('input[type="radio"], input[type="checkbox"], label, li, .option, .ans-item');
      for (var o = 0; o < options.length; o++) {
        var opt = options[o];
        for (var ak = 0; ak < answerKeys.length; ak++) {
          var ov = opt.getAttribute(answerKeys[ak]) || (opt.dataset && opt.dataset[answerKeys[ak].replace('data-', '')]);
          if (ov && /^(true|1|right|correct|yes)$/i.test(String(ov))) {
            answer = String(opt.getAttribute('data-value') || opt.getAttribute('value') || opt.textContent || '').trim().toUpperCase();
            break;
          }
        }
        if (answer) break;
      }
    }

    // 策略 4: 解析 script 标签中的答案
    if (!answer) {
      var scripts = qEl.querySelectorAll('script');
      for (var sc = 0; sc < scripts.length; sc++) {
        var text = scripts[sc].textContent || scripts[sc].innerText || '';
        var m = text.match(/(?:answer|key|correct|right)\s*[:=]\s*['"]?([A-D0-9]+)['"]?/i);
        if (m) { answer = m[1].toUpperCase(); break; }
      }
    }

    if (!answer) return false;

    // 根据答案选中选项
    var allOptions = qEl.querySelectorAll('input[type="radio"], input[type="checkbox"], label, li, .option, .ans-item');
    var clicked = false;
    for (var oi = 0; oi < allOptions.length; oi++) {
      var optEl = allOptions[oi];
      var optVal = String(optEl.getAttribute('data-value') || optEl.getAttribute('value') || '').trim().toUpperCase();
      var optText = String(optEl.textContent || optEl.innerText || '').trim().toUpperCase();

      var isMatch = false;
      // 单选/多选答案可能是 "A" 或 "A,B,C"
      if (answer.indexOf(',') >= 0) {
        var parts = answer.split(',');
        for (var p = 0; p < parts.length; p++) {
          if (optVal === parts[p].trim() || optText.indexOf(parts[p].trim()) === 0) { isMatch = true; break; }
        }
      } else {
        // 尝试用索引匹配：字母 A=0, B=1, C=2, D=3
        var answerIdx = answer.charCodeAt(0) - 65;
        if (answerIdx >= 0 && answerIdx < 26 && oi === answerIdx) isMatch = true;
        if (optVal === answer || optText.indexOf(answer) === 0) isMatch = true;
        // 选项文字包含正确答案的文本
        if (answer.length > 1 && (optVal.indexOf(answer) >= 0 || optText.indexOf(answer) >= 0)) isMatch = true;
      }

      if (isMatch) {
        if (optEl.tagName === 'INPUT') {
          optEl.checked = true;
          optEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        optEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        if (typeof optEl.onclick === 'function') {
          try { optEl.onclick.call(optEl, { preventDefault: function(){}, stopPropagation: function(){} }); } catch (_) {}
        }
        clicked = true;
      }
    }

    return clicked;
  }

  // ---- 挂机模式：切到真实 1x 播放让平台自然记录任务点 ----
  function enterIdleMode() {
    if (state.idleMode) return;
    state.idleMode = true;
    state.compatMode = true;
    state.autoMute = true;
    state.preventFocusPause = true;
    var is = normalizedIdleSpeed();
    var videos = collectVideos(document, []);
    for (var i = 0; i < videos.length; i++) {
      var v = videos[i];
      v.muted = true;
      try { state.applying = true; v.playbackRate = is; state.applying = false; } catch (_) { state.applying = false; }
      try { if (v.paused) v.play(); } catch (_) {}
    }
  }

  function exitIdleMode() {
    if (!state.idleMode) return;
    state.idleMode = false;
    var videos = collectVideos(document, []);
    for (var i = 0; i < videos.length; i++) {
      applyAutoMute(videos[i]);
      setRate(videos[i], true);
    }
  }

  // ---- 启动 ----
  patchPrototype();
  patchNetwork();
  patchVisibility();
  publishTopState();
  startWallWatchListeners();
  var initMode = detectPlayerMode();
  if (initMode !== 'none') {
    sharedStore().playerMode = initMode;
    state.playerMode = initMode;
  } else {
    state.playerMode = sharedStore().playerMode || 'none';
  }
  publishTopState();
  if (state.playerMode === 'flash') {
    try {
      state.lastWarning = '检测到 Flash 播放器，请切换为 HTML5 播放。';
    } catch (_) {}
  }

  if (document.documentElement) {
    observeVideos();
    applyAll(true);
  } else {
    document.addEventListener('DOMContentLoaded', function() {
      observeVideos();
      applyAll(true);
    }, { once: true });
  }

  startHeartbeat();
  startDocReader();
  startQuizSolver();
})();
