(function() {
  'use strict';

  var spd = 2;
  var ena = true;
  var compat = true;
  var autoNext = true;
  var preventFocusPause = true;
  var autoMute = true;
  var autoReadDoc = false;
  var autoQuiz = false;
  var idleMode = false;
  var idleSpeed = 1.25;
  var autoNextBusy = false;
  var lastWarning = '';

  var NEXT_LABELS = ['下一个', '下一节', '下一个任务', '下一任务'];

  function broadcast() {
    try {
      window.postMessage({
        type: 'STUDY_TONG_SPEED_CONFIG',
        speed: Number(spd),
        enabled: !!ena,
        compatMode: !!compat,
        preventFocusPause: !!preventFocusPause,
        autoMute: !!autoMute,
        autoReadDoc: !!autoReadDoc,
        autoQuiz: !!autoQuiz,
        idleMode: !!idleMode,
        idleSpeed: Number(idleSpeed)
      }, '*');
    } catch (_) {}
  }

  function warnFlashPlayer() {
    if (!isTopFrame()) return;
    var hasVideo = false;
    var hasFlash = false;
    try {
      hasVideo = !!document.querySelector('video');
      hasFlash = !!document.querySelector('object, embed, .ans-insertvideo-online, #flashbox');
    } catch (_) {}
    if (!hasFlash || hasVideo) return;
    try {
      lastWarning = '当前为 Flash 课件，请切换为 HTML5 播放。';
    } catch (_) {}
  }

  function isTopFrame() {
    try {
      return window.top === window;
    } catch (_) {
      return false;
    }
  }

  function hasJavascriptHref(el) {
    try {
      var href = el.getAttribute && el.getAttribute('href');
      return !!(href && /^\s*javascript:/i.test(href));
    } catch (_) {
      return false;
    }
  }

  function isVisible(el) {
    try {
      return el.offsetParent !== null || el.getClientRects().length > 0;
    } catch (_) {
      return true;
    }
  }

  function matchesNextLabel(el) {
    var text = (el.innerText || el.textContent || el.value || '').replace(/\s+/g, '');
    for (var j = 0; j < NEXT_LABELS.length; j++) {
      if (text.indexOf(NEXT_LABELS[j]) !== -1) return true;
    }
    return false;
  }

  function findNextButton(root) {
    root = root || document;
    var nodes = root.querySelectorAll('a, button, [role="button"], input[type="button"], .next, .next_btn');
    var fallback = null;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el || el.disabled || !matchesNextLabel(el) || !isVisible(el)) continue;
      if (el.nodeName === 'BUTTON' || el.getAttribute('role') === 'button') return el;
      if (!hasJavascriptHref(el)) return el;
      if (!fallback) fallback = el;
    }
    return fallback;
  }

  function requestSafeActivate(el) {
    try {
      document.querySelectorAll('[data-st-tong-act]').forEach(function(n) {
        n.removeAttribute('data-st-tong-act');
      });
      el.setAttribute('data-st-tong-act', '1');
      window.postMessage({ type: 'STUDY_TONG_SAFE_ACTIVATE' }, '*');
      return true;
    } catch (_) {
      return false;
    }
  }

  function tryClickNext() {
    if (!autoNext || !isTopFrame() || autoNextBusy) return;
    var btn = findNextButton(document);
    if (!btn) {
      try {
        btn = findNextButton(window.top.document);
      } catch (_) {}
    }
    if (!btn) return;
    autoNextBusy = true;
    requestSafeActivate(btn);
    setTimeout(function() { autoNextBusy = false; }, 3000);
  }

  function signalVideoEnded() {
    if (!autoNext) return;
    chrome.storage.local.set({ videoEndedAt: Date.now() });
  }

  function onVideoEnded(ev) {
    if (!autoNext || !ev || !ev.target || ev.target.nodeName !== 'VIDEO') return;
    signalVideoEnded();
  }

  function bindAutoNext() {
    document.addEventListener('ended', onVideoEnded, true);
    window.addEventListener('message', function(event) {
      if (event.source !== window) return;
      var data = event.data || {};
      if (data.type === 'STUDY_TONG_VIDEO_ENDED') signalVideoEnded();
    });
    if (isTopFrame()) {
      chrome.storage.onChanged.addListener(function(ch) {
        if (!ch.videoEndedAt || ch.videoEndedAt.newValue == null) return;
        setTimeout(tryClickNext, 600);
      });
    }
  }

  function loadConfig(cb) {
    chrome.storage.local.get(['speed','enabled','compatMode','autoNext','preventFocusPause','autoMute','autoReadDoc','autoQuiz','idleMode','idleSpeed'], function(d) {
      if (d.speed != null) spd = d.speed;
      if (d.enabled != null) ena = d.enabled;
      if (d.compatMode != null) compat = d.compatMode;
      if (d.autoNext != null) autoNext = d.autoNext;
      if (d.preventFocusPause != null) preventFocusPause = d.preventFocusPause;
      if (d.autoMute != null) autoMute = d.autoMute;
      if (d.autoReadDoc != null) autoReadDoc = d.autoReadDoc;
      if (d.autoQuiz != null) autoQuiz = d.autoQuiz;
      if (d.idleMode != null) idleMode = d.idleMode;
      if (d.idleSpeed != null) idleSpeed = d.idleSpeed;
      if (cb) cb();
    });
  }

  loadConfig(function() {
    broadcast();
    bindAutoNext();
    warnFlashPlayer();
    setInterval(warnFlashPlayer, 8000);
  });

  chrome.storage.onChanged.addListener(function(ch) {
    var changed = false;
    if (ch.speed && ch.speed.newValue != null) { spd = ch.speed.newValue; changed = true; }
    if (ch.enabled && ch.enabled.newValue != null) { ena = ch.enabled.newValue; changed = true; }
    if (ch.compatMode && ch.compatMode.newValue != null) { compat = ch.compatMode.newValue; changed = true; }
    if (ch.autoNext && ch.autoNext.newValue != null) autoNext = ch.autoNext.newValue;
    if (ch.preventFocusPause && ch.preventFocusPause.newValue != null) { preventFocusPause = ch.preventFocusPause.newValue; changed = true; }
    if (ch.autoMute && ch.autoMute.newValue != null) { autoMute = ch.autoMute.newValue; changed = true; }
    if (ch.autoReadDoc && ch.autoReadDoc.newValue != null) { autoReadDoc = ch.autoReadDoc.newValue; changed = true; }
    if (ch.autoQuiz && ch.autoQuiz.newValue != null) { autoQuiz = ch.autoQuiz.newValue; changed = true; }
    if (ch.idleMode && ch.idleMode.newValue != null) { idleMode = ch.idleMode.newValue; changed = true; }
    if (ch.idleSpeed && ch.idleSpeed.newValue != null) { idleSpeed = ch.idleSpeed.newValue; changed = true; }
    if (changed) broadcast();
  });
})();
