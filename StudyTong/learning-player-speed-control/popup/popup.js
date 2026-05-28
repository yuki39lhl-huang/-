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
var tabId = 0;
var tabUrl = '';
var COMPAT_MAX_SPEED = 1.75;

var dsp = document.getElementById('currentSpeedDisplay');
var sld = document.getElementById('speedSlider');
var enb = document.getElementById('enableBtn');
var std = document.getElementById('statusDot');
var stt = document.getElementById('statusText');
var vst = document.getElementById('videoStatus');
var pbs = document.querySelectorAll('[data-speed]');
var rfb = document.getElementById('refreshBtn');
var cmb = document.getElementById('compatBtn');
var anb = document.getElementById('autoNextBtn');
var pfb = document.getElementById('preventFocusBtn');
var amb = document.getElementById('autoMuteBtn');
var adb = document.getElementById('autoReadDocBtn');
var aqb = document.getElementById('autoQuizBtn');
var idb = document.getElementById('idleModeBtn');
var idt = document.getElementById('idleModeTip');
var idtp = document.getElementById('idleModeTipSpeed');
var isbs = document.querySelectorAll('#idleSpeedRow .preset-btn');
var modeTip = document.getElementById('modeTip');

function effectiveSpeed() {
  if (!ena) return 1;
  if (compat) return Math.min(spd, COMPAT_MAX_SPEED);
  return spd;
}

function displaySpeed() {
  if (!ena) return 1;
  if (idleMode) return idleSpeed;
  return effectiveSpeed();
}

function canInjectUrl(url) {
  if (!url) return false;
  if (/^(chrome|edge|about|devtools|view-source):/i.test(url)) return false;
  return /chaoxing\.com/i.test(url) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url);
}

function inject() {
  if (!tabId || !canInjectUrl(tabUrl)) return;
  chrome.scripting.executeScript({
    target: { tabId: tabId, allFrames: true },
    world: 'MAIN',
    func: function(s, e, c, pf, am, ad, aq, im, is) {
      window.postMessage({
        type: 'STUDY_TONG_SPEED_CONFIG',
        speed: Number(s),
        enabled: !!e,
        compatMode: !!c,
        preventFocusPause: !!pf,
        autoMute: !!am,
        autoReadDoc: !!ad,
        autoQuiz: !!aq,
        idleMode: !!im,
        idleSpeed: Number(is)
      }, '*');
    },
    args: [spd, ena, compat, preventFocusPause, autoMute, autoReadDoc, autoQuiz, idleMode, idleSpeed]
  }).catch(function() {});
}

function saveAndInject() {
  chrome.storage.local.set({
    speed: spd,
    enabled: ena,
    compatMode: compat,
    autoNext: autoNext,
    preventFocusPause: preventFocusPause,
    autoMute: autoMute,
    autoReadDoc: autoReadDoc,
    autoQuiz: autoQuiz,
    idleMode: idleMode,
    idleSpeed: idleSpeed
  }, function() { inject(); });
}

function ui() {
  var eff = effectiveSpeed();
  var shownSpeed = displaySpeed();

  dsp.textContent = shownSpeed.toFixed(shownSpeed % 1 === 0 ? 0 : 2).replace(/0$/, '');
  sld.value = spd;
  sld.disabled = !!idleMode;

  pbs.forEach(function(b) {
    b.classList.toggle('active', !idleMode && parseFloat(b.dataset.speed) === spd);
  });

  if (ena) {
    enb.textContent = '⏸ 暂停';
    enb.className = 'control-btn secondary';
    std.classList.remove('inactive');
  } else {
    enb.textContent = '▶ 启用';
    enb.className = 'control-btn primary';
    std.classList.add('inactive');
  }

  if (cmb) {
    cmb.textContent = compat ? '✅ 计进度模式（开）' : '⚡ 计进度模式（关）';
    cmb.className = compat ? 'control-btn primary' : 'control-btn secondary';
  }

  if (anb) {
    anb.textContent = autoNext ? '🔁 自动下一条（开）' : '⏸ 自动下一条（关）';
    anb.className = autoNext ? 'control-btn primary' : 'control-btn secondary';
  }

  if (pfb) {
    pfb.textContent = preventFocusPause ? '🛡 防失焦暂停（开）' : '🎯 防失焦暂停（关）';
    pfb.className = preventFocusPause ? 'control-btn primary' : 'control-btn secondary';
  }

  if (amb) {
    amb.textContent = autoMute ? '🔇 自动静音（开）' : '🔊 自动静音（关）';
    amb.className = autoMute ? 'control-btn primary' : 'control-btn secondary';
  }

  if (adb) {
    adb.textContent = autoReadDoc ? '📖 自动阅读文档（开）' : '📄 自动阅读文档（关）';
    adb.className = autoReadDoc ? 'control-btn primary' : 'control-btn secondary';
  }

  if (aqb) {
    aqb.textContent = autoQuiz ? '📝 自动答题（开）' : '✏️ 自动答题（关）';
    aqb.className = autoQuiz ? 'control-btn primary' : 'control-btn secondary';
  }

  if (idb) {
    idb.textContent = idleMode ? '⏸ 停止挂机' : '🍅 挂机拿任务点';
    idb.className = idleMode ? 'control-btn secondary' : 'control-btn primary';
  }
  // 高亮当前挂机倍速预设
  isbs.forEach(function(b) {
    b.classList.toggle('active', parseFloat(b.dataset.idleSpeed) === idleSpeed);
  });
  if (idt) {
    idt.style.display = idleMode ? 'block' : 'none';
  }
  if (idtp) {
    idtp.textContent = idleSpeed.toFixed(2);
  }

  if (modeTip) {
    if (idleMode) {
      modeTip.innerHTML = '<b>挂机模式</b>：以 ' + idleSpeed.toFixed(2).replace(/0$/, '') + 'x 真实播放；普通倍速已暂时停用';
    } else if (compat) {
      var capTip = spd > eff ? '（设定 ' + spd.toFixed(1) + 'x，已为稳定记录降至 ' + eff.toFixed(1) + 'x）' : '';
      modeTip.innerHTML = '<b>计进度模式</b>：以 ' + eff.toFixed(1) + 'x 稳定播放并等待平台正常记录任务点 ' + capTip;
    } else {
      modeTip.innerHTML = '<b>极速模式</b>：以 ' + eff.toFixed(1) + 'x 全速播放，不保证任务点计进度 ⚠️';
    }
  }

  if (!canInjectUrl(tabUrl)) {
    stt.textContent = '请先打开学习通课程页';
    vst.textContent = 'chrome:// 等页面无法注入';
    if (std) std.classList.add('inactive');
    return;
  }
  if (std) std.classList.remove('inactive');
  stt.textContent = (idleMode ? '挂机 ' : (compat ? '计进度 ' : '极速 ')) + shownSpeed.toFixed(shownSpeed % 1 === 0 ? 0 : 2).replace(/0$/, '') + 'x | ' + (ena ? '运行中' : '已关闭');
  vst.textContent = idleMode ? '任务点: 挂机中' : (compat ? '任务点: ✅ 可完成' : '任务点: ⚠️ 不保证');
}

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
  ui();
});

chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
  if (!tabs[0]) return;
  tabId = tabs[0].id;
  tabUrl = tabs[0].url || '';
  ui();
  inject();
});

sld.addEventListener('input', function() {
  spd = parseFloat(sld.value);
  ui();
  saveAndInject();
});

pbs.forEach(function(b) {
  b.addEventListener('click', function() {
    spd = parseFloat(b.dataset.speed);
    sld.value = spd;
    ui();
    saveAndInject();
  });
});

enb.addEventListener('click', function() {
  ena = !ena;
  ui();
  saveAndInject();
});

rfb.addEventListener('click', function() {
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
    ui();
    inject();
  });
});

if (cmb) {
  cmb.addEventListener('click', function() {
    compat = !compat;
    ui();
    saveAndInject();
  });
}

if (anb) {
  anb.addEventListener('click', function() {
    autoNext = !autoNext;
    ui();
    saveAndInject();
  });
}

if (pfb) {
  pfb.addEventListener('click', function() {
    preventFocusPause = !preventFocusPause;
    ui();
    saveAndInject();
  });
}

if (amb) {
  amb.addEventListener('click', function() {
    autoMute = !autoMute;
    ui();
    saveAndInject();
  });
}

if (adb) {
  adb.addEventListener('click', function() {
    autoReadDoc = !autoReadDoc;
    ui();
    saveAndInject();
  });
}

if (aqb) {
  aqb.addEventListener('click', function() {
    autoQuiz = !autoQuiz;
    ui();
    saveAndInject();
  });
}

if (idb) {
  idb.addEventListener('click', function() {
    idleMode = !idleMode;
    if (idleMode) {
      compat = true;
      preventFocusPause = true;
      autoMute = true;
      ena = true;
    }
    ui();
    saveAndInject();
  });
}

isbs.forEach(function(b) {
  b.addEventListener('click', function() {
    idleSpeed = parseFloat(b.dataset.idleSpeed);
    ui();
    saveAndInject();
  });
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    spd = Math.min(16, spd + 0.5);
    sld.value = spd;
    ui();
    saveAndInject();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    spd = Math.max(0.5, spd - 0.5);
    sld.value = spd;
    ui();
    saveAndInject();
  } else if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    ena = !ena;
    ui();
    saveAndInject();
  }
});
