/* 阅卡 H5 主逻辑：实时扫描 / 拍照批阅 / 答案与名单 / 成绩与错题率 */
/* global TPL55, TPL35, TPLS, OMR, EXAM */
(function () {
  'use strict';

  var LS = {
    get: function (k, d) {
      try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 满/隐私模式忽略 */ } },
  };
  var K = {
    answers: 'acg_web_answers_v1', roster: 'acg_web_roster_v1', records: 'acg_web_records_v1',
    muted: 'acg_web_muted_v1', cardType: 'acg_web_cardtype_v1'
  };

  var LETTERS = EXAM.LETTERS;
  // 题量模板：55 题 / 35 题，按答题卡版式切换
  var cardType = Number(LS.get(K.cardType, 55)) === 35 ? 35 : 55;
  var TPL = TPLS[cardType];
  var NUMS;
  var FULL;
  var SECTION_META;

  function sectionMetaFor(ct) {
    if (ct === 35) {
      return [
        { label: '一、1-15（A-D）', from: 1, to: 15 },
        { label: '二、七选五 16-21（A-G）', from: 16, to: 21 },
        { label: '三、22-35（A-D）', from: 22, to: 35 },
      ];
    }
    return [
      { label: '一、听力 1-20（A-C）', from: 1, to: 20 },
      { label: '二、阅读 21-35（A-D）', from: 21, to: 35 },
      { label: '七选五 36-40（A-G）', from: 36, to: 40 },
      { label: '三、完形 41-55（A-D）', from: 41, to: 55 },
    ];
  }

  /** 应用题量模板：切换识别模板、题型结构、题号/满分/副标题 */
  function applyCardType(ct) {
    cardType = Number(ct) === 35 ? 35 : 55;
    TPL = TPLS[cardType];
    OMR.setTemplate(TPL);
    EXAM.setCardType(cardType);
    NUMS = EXAM.choiceNumbers();
    FULL = EXAM.fullScore(EXAM.defaultScores());
    SECTION_META = sectionMetaFor(cardType);
    LS.set(K.cardType, cardType);
    var sel = $('tplSelect');
    if (sel) sel.value = String(cardType);
    var sub = $('examSub');
    if (sub) {
      sub.innerHTML = cardType === 35
        ? '35 题答题卡（1-15 A-D · 16-21 七选五 A-G · 22-35 A-D）· 满分 <b>' + FULL + '</b>'
        : '55 题答题卡（听力 20 · 阅读 20 · 七选五 5 · 完形 10）· 满分 <b>' + FULL + '</b>';
    }
  }

  function optionsOf(no) { return LETTERS.slice(0, EXAM.optionsOf(no)); }
  function currentExam() {
    return EXAM.createExam({ title: '选择题批阅', cardType: cardType, answers: LS.get(K.answers, {}) });
  }
  function $(id) { return document.getElementById(id); }
  applyCardType(cardType);

  function showView(name) {
    ['home', 'scan', 'photo', 'answers', 'roster', 'records'].forEach(function (v) {
      $('view-' + v).hidden = v !== name;
    });
    if (name !== 'scan') stopScan();
    if (name === 'home') renderHome();
    if (name === 'answers') renderAnswers();
    if (name === 'records') renderRecords();
  }

  /* ================= 语音与震动 ================= */
  var muted = LS.get(K.muted, false);
  function beep() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var ctx = beep.ctx || (beep.ctx = new AC());
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.value = 0.18;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.18);
    } catch (e) { /* 忽略 */ }
  }
  function speak(text) {
    if (muted) return;
    try {
      if (!window.speechSynthesis) throw new Error('no tts');
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 1;
      u.onerror = beep;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) { beep(); }
  }
  function vibrate() { try { if (navigator.vibrate) navigator.vibrate(120); } catch (e) { /* 忽略 */ } }

  /* ================= 名单 ================= */
  function roster() {
    return LS.get(K.roster, []).map(function (r) {
      return typeof r === 'string' ? { no: r, name: '' } : r;
    });
  }
  function lookupName(no) {
    var hit = roster().find(function (r) { return String(r.no) === String(no); });
    return hit ? hit.name : '';
  }

  /* ================= 成绩存取 ================= */
  function saveRecord(read, result) {
    var rec = {
      no: read.studentNo,
      name: lookupName(read.studentNo),
      choices: read.choices,
      flags: read.flags,
      score: result.total,
      right: result.right,
      wrong: result.items.filter(function (i) { return i.ok === 'wrong'; }).length,
      blank: result.items.filter(function (i) { return i.ok === 'blank' || i.ok === 'skip'; }).length,
      ts: Date.now(),
    };
    var recs = LS.get(K.records, []);
    // 同一学号 30 秒内重复扫 → 覆盖上一条（防抖重）
    var dupIdx = -1;
    recs.forEach(function (r, i) {
      if (String(r.no) === String(rec.no) && rec.ts - r.ts < 30000) dupIdx = i;
    });
    if (dupIdx >= 0) recs[dupIdx] = rec; else recs.push(rec);
    LS.set(K.records, recs);
    return rec;
  }

  /* ================= 首页 ================= */
  function renderHome() {
    var n = Object.keys(LS.get(K.answers, {})).length;
    var miss = NUMS.length - n;
    $('answersWarn').textContent = miss > 0
      ? '⚠️ 标准答案还有 ' + miss + ' 题未录入，请先到「标准答案」补齐'
      : '✓ 标准答案已录入 ' + n + ' 题，可以开始批阅';
  }

  /* ================= 实时扫描 =================
   * 借鉴“答题卡扫描助手”的取景模式：
   *  1) 打开扫描立刻显示固定黑框 + 内部各框（考号 / 每题选项），用户把卡放进框即可；
   *  2) 每个方向都尝试，用「正向地标分」区分 cw/ccw 与 180°，避免横放卡读反；
   *  3) 定位到高质量一帧即锁定，不再要求连续两帧一致，扫描更快；
   *  4) 提供“拍摄识别”按钮手动确认，避免反复调整。
   */
  var ROTS = ['none', 'cw', 'ccw', '180'];
  var scan = {
    stream: null, video: null, octx: null, ovW: 0, ovH: 0,
    work: null, wctx: null, timer: null, busy: false,
    frameN: 0, lastProc: 0, needLeave: false, locked: false,
    map: null, holdTimer: null, rotFilter: null,
    fixedQuad: null, lastBest: null,
  };
  var PROCESS_INTERVAL = 200;
  var LIVE_MAX_SIDE = 1100;
  var UPRIGHT_MIN = 0.045;      // 正向地标分阈值：低于此值视为颠倒/非卡

  function setStatus(text, level) {
    var el = $('scanStatus');
    el.textContent = text;
    el.className = 'hud-status lv-' + (level || 'idle');
  }
  function setDbg(text) { $('scanDbg').textContent = text; }

  /* 固定取景框：按模板宽高比在屏幕中央算出矩形（四角归一化 0..1） */
  function computeFixedFrame() {
    var sw = scan.ovW, sh = scan.ovH;
    var ar = TPL.frame.w / TPL.frame.h; // 横版约 1.6 / 1.34
    var maxW = sw * 0.86;
    var maxH = sh * 0.66;
    var w = maxW; var h = w / ar;
    if (h > maxH) { h = maxH; w = h * ar; }
    var x0 = (sw - w) / 2;
    var y0 = (sh - h) / 2 - sh * 0.02;
    scan.fixedRect = { x0: x0, y0: y0, x1: x0 + w, y1: y0 + h };
    // 固定框在“分析图 none 方向”的等价归一化 quad：由屏幕坐标反推到原始帧
    scan.fixedQuad = null; // 每帧根据 raw 尺寸计算
  }

  function startScan() {
    showView('scan');
    scan.video = $('cam');
    $('btnMute').textContent = muted ? '已静音' : '播报开';
    var ov = $('overlay');
    scan.ovW = window.innerWidth;
    scan.ovH = window.innerHeight;
    ov.width = scan.ovW * Math.min(2, window.devicePixelRatio || 1);
    ov.height = scan.ovH * Math.min(2, window.devicePixelRatio || 1);
    var dpr = ov.width / scan.ovW;
    scan.octx = ov.getContext('2d');
    scan.octx.scale(dpr, dpr);
    computeFixedFrame();
    scan.rotFilter = null;
    scan.lastBest = null;
    // 取景框在进入扫描的第一时间就画出来，不等识别
    drawIdleFrame();
    setStatus('把答题卡放入黑框内，对齐四角', 'idle');
    setDbg('等待相机');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('此浏览器不支持摄像头，请用拍照批阅', 'warn');
      setDbg('getUserMedia 不可用');
      return;
    }
    navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    }).then(function (stream) {
      scan.stream = stream;
      scan.video.srcObject = stream;
      return scan.video.play();
    }).then(function () {
      setStatus('把答题卡放入黑框内，对齐四角', 'idle');
      scan.work = document.createElement('canvas');
      scan.wctx = scan.work.getContext('2d', { willReadFrequently: true });
      scan.timer = setInterval(tick, 100);
    }).catch(function (e) {
      setStatus('相机启动失败：' + (e && e.name || ''), 'warn');
      setDbg((e && e.message) || String(e));
    });
  }

  function stopScan() {
    if (scan.timer) { clearInterval(scan.timer); scan.timer = null; }
    if (scan.holdTimer) { clearTimeout(scan.holdTimer); scan.holdTimer = null; }
    if (scan.stream) {
      scan.stream.getTracks().forEach(function (t) { t.stop(); });
      scan.stream = null;
    }
    if (scan.video) scan.video.srcObject = null;
    if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (e) { /* 忽略 */ } }
    scan.locked = false; scan.busy = false; scan.needLeave = false; scan.lastBest = null;
    $('resultFloat').hidden = true;
  }

  function grabFrame() {
    var v = scan.video;
    var vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return null;
    var scale = Math.min(1, LIVE_MAX_SIDE / Math.max(vw, vh));
    var W = Math.max(1, Math.round(vw * scale));
    var H = Math.max(1, Math.round(vh * scale));
    if (scan.work.width !== W || scan.work.height !== H) { scan.work.width = W; scan.work.height = H; }
    scan.wctx.drawImage(v, 0, 0, W, H);
    var data = scan.wctx.getImageData(0, 0, W, H).data;
    var gray = new Uint8Array(W * H);
    for (var i = 0, p = 0; i < gray.length; i += 1, p += 4) {
      gray[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
    }
    return { gray: gray, width: W, height: H };
  }

  /* 灰度图旋转：'cw' 顺时针 / 'ccw' 逆时针 / '180' 颠倒 */
  function rotateGray(img, dir) {
    if (dir === 'none') return img;
    var w = img.width, h = img.height, nw = h, nh = w;
    if (dir === '180') { nw = w; nh = h; }
    var g = new Uint8Array(nw * nh);
    for (var y = 0; y < nh; y += 1) {
      for (var x = 0; x < nw; x += 1) {
        var sx, sy;
        if (dir === 'cw') { sx = y; sy = h - 1 - x; }
        else if (dir === 'ccw') { sx = w - 1 - y; sy = x; }
        else { sx = w - 1 - x; sy = h - 1 - y; }
        g[y * nw + x] = img.gray[sy * w + sx];
      }
    }
    return { gray: g, width: nw, height: nh };
  }

  /* 视频 object-fit:cover 的帧坐标 → 屏幕坐标 */
  function updateMap(fw, fh) {
    var sw = window.innerWidth, sh = window.innerHeight;
    var scale = Math.max(sw / fw, sh / fh);
    scan.map = {
      scale: scale, ox: (fw - sw / scale) / 2, oy: (fh - sh / scale) / 2,
      rawW: fw, rawH: fh,
    };
  }
  /* 分析图坐标 → 屏幕坐标（分析图可能旋转过，先逆旋转回原始帧） */
  function toScreen(p, dir) {
    var m = scan.map;
    var x = p.x, y = p.y;
    if (dir === 'cw') { var cx = y, cy = m.rawH - 1 - x; x = cx; y = cy; }
    else if (dir === 'ccw') { var dx = m.rawW - 1 - y, dy = x; x = dx; y = dy; }
    else if (dir === '180') { x = m.rawW - 1 - x; y = m.rawH - 1 - y; }
    return { x: (x - m.ox) * m.scale, y: (y - m.oy) * m.scale };
  }
  function quadPath(ctx, quad, dir) {
    var pts = [quad.tl, quad.tr, quad.br, quad.bl].map(function (p) { return toScreen(p, dir); });
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < 4; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    return pts;
  }
  function drawCorners(ctx, pts) {
    var arm = Math.max(14, Math.min(pts[1].x - pts[0].x, pts[3].y - pts[0].y) * 0.07);
    ctx.strokeStyle = 'rgba(0, 210, 190, .98)';
    ctx.lineWidth = 4; ctx.lineCap = 'round';
    pts.forEach(function (p, i) {
      var nx = pts[(i + 1) % 4], pv = pts[(i + 3) % 4];
      var dx1 = nx.x - p.x, dy1 = nx.y - p.y, dx2 = pv.x - p.x, dy2 = pv.y - p.y;
      var l1 = Math.hypot(dx1, dy1) || 1, l2 = Math.hypot(dx2, dy2) || 1;
      ctx.beginPath();
      ctx.moveTo(p.x + dx1 / l1 * arm, p.y + dy1 / l1 * arm);
      ctx.lineTo(p.x, p.y);
      ctx.lineTo(p.x + dx2 / l2 * arm, p.y + dy2 / l2 * arm);
      ctx.stroke();
    });
  }
  /* 内部各框：考号每位 + 每题每选项；read 非空时高亮涂卡点 */
  function drawBoxes(ctx, M, read, bw, bh) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0, 200, 185, .55)';
    var box = function (c) {
      var p = M(c[0], c[1]);
      ctx.strokeRect(p.x - bw / 2, p.y - bh / 2, bw, bh);
    };
    TPL.studentNo.forEach(function (row) { row.forEach(box); });
    TPL.questions.forEach(function (q) { q.cells.forEach(box); });
    if (read && read.choices) {
      ctx.fillStyle = 'rgba(0, 230, 200, .9)';
      TPL.questions.forEach(function (q) {
        var mine = read.choices[q.no];
        var idx = mine ? q.options.indexOf(mine) : -1;
        if (idx < 0 || !q.cells[idx]) return;
        var p = M(q.cells[idx][0], q.cells[idx][1]);
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, bw * 0.46, bh * 0.46, 0, 0, Math.PI * 2);
        ctx.fill();
      });
      if (read.studentNoValid && read.studentNo) {
        String(read.studentNo).split('').forEach(function (d, i) {
          if (!TPL.studentNo[i] || !/^\d$/.test(d)) return;
          var c = TPL.studentNo[i][Number(d)];
          var p = M(c[0], c[1]);
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, bw * 0.4, bh * 0.4, 0, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    }
  }

  /* 空闲取景框：还没识别到卡时也显示，给用户明确的放置目标 */
  function drawIdleFrame() {
    if (!scan.octx || !scan.fixedRect) return;
    var ctx = scan.octx;
    ctx.clearRect(0, 0, scan.ovW, scan.ovH);
    var r = scan.fixedRect;
    // 黑底遮罩，框外压暗
    ctx.fillStyle = 'rgba(0, 0, 0, .42)';
    ctx.fillRect(0, 0, scan.ovW, r.y0);
    ctx.fillRect(0, r.y1, scan.ovW, scan.ovH - r.y1);
    ctx.fillRect(0, r.y0, r.x0, r.y1 - r.y0);
    ctx.fillRect(r.x1, r.y0, scan.ovW - r.x1, r.y1 - r.y0);
    var pts = [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < 4; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(20, 24, 30, .92)'; ctx.lineWidth = 4; ctx.stroke();
    drawCorners(ctx, pts);
    // 用固定框的归一化坐标画内部小框
    var M = function (u, v) { return { x: r.x0 + u * (r.x1 - r.x0), y: r.y0 + v * (r.y1 - r.y0) }; };
    var bw = Math.max(6, (r.x1 - r.x0) * TPL.radiusX * 2.5);
    var bh = Math.max(4, (r.y1 - r.y0) * TPL.radiusY * 2.5);
    drawBoxes(ctx, M, null, bw, bh);
  }

  /* 已定位：贴着检测到（并精修）的四边形画黑框 + 内部框 */
  function drawGuide(quad, img, read, dir) {
    if (!scan.octx || !scan.map) return;
    var ctx = scan.octx;
    ctx.clearRect(0, 0, scan.ovW, scan.ovH);
    var quadR = (img && read) ? OMR.refineQuad(img, quad, read.quality.white) : quad;
    var pts = quadPath(ctx, quadR, dir);
    ctx.strokeStyle = 'rgba(20, 24, 30, .92)'; ctx.lineWidth = 4; ctx.stroke();
    drawCorners(ctx, pts);
    var qw = OMR.quadWidth(quadR);
    var qh = (quadR.bl.y - quadR.tl.y + quadR.br.y - quadR.tr.y) / 2;
    var s = scan.map.scale;
    var bw = Math.max(7, TPL.radiusX * qw * s * 2.5);
    var bh = Math.max(5, TPL.radiusY * qh * s * 2.5);
    var M = function (u, v) { return toScreen(OMR.mapPoint(quadR, u, v), dir); };
    drawBoxes(ctx, M, read, bw, bh);
  }

  function drawMarks(read, quad, img, result, dir) {
    if (!scan.octx) return;
    var ctx = scan.octx;
    ctx.clearRect(0, 0, scan.ovW, scan.ovH);
    var quadR = OMR.refineQuad(img, quad, read.quality.white);
    var qw = OMR.quadWidth(quadR);
    var qh = (quadR.bl.y - quadR.tl.y + quadR.br.y - quadR.tr.y) / 2;
    var rx = Math.max(6, TPL.radiusX * qw * scan.map.scale);
    var ry = Math.max(3, TPL.radiusY * qh * scan.map.scale);
    var byNo = {};
    result.items.forEach(function (it) { byNo[it.no] = it; });
    TPL.questions.forEach(function (q) {
      var it = byNo[q.no];
      if (!it || (it.ok !== 'right' && it.ok !== 'wrong')) return;
      var idx = it.mine ? q.options.indexOf(it.mine) : -1;
      if (idx < 0) return;
      var c = q.cells[idx];
      var p = toScreen(OMR.mapPoint(quadR, c[0], c[1]), dir);
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = it.ok === 'right' ? 'rgba(70, 200, 120, .45)' : 'rgba(240, 55, 55, .75)';
      ctx.fill();
      if (it.ok === 'wrong') {
        var first = toScreen(OMR.mapPoint(quadR, q.cells[0][0], q.cells[0][1]), dir);
        ctx.fillStyle = 'rgba(240, 55, 55, .95)';
        ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(String(q.no), first.x - rx - 4, first.y + 4);
      }
    });
    quadPath(ctx, quadR, dir);
    ctx.strokeStyle = 'rgba(30, 30, 30, .9)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  /* 选方向：四方向都跑一遍，用正向地标分 + 答案数 + 学号有效性综合打分 */
  function analyzeFrame(raw) {
    var best = null;
    var dbgParts = [];
    for (var ri = 0; ri < ROTS.length; ri += 1) {
      var dir = ROTS[ri];
      if (scan.rotFilter && dir !== scan.rotFilter) continue;
      var im = rotateGray(raw, dir);
      var q = OMR.detectQuad(im);
      if (!q || !q.anchors) { dbgParts.push(dir + ':✗'); continue; }
      var up = OMR.uprightScore(im, q);
      var rd = OMR.readSheet(im, q, { sensitivity: 'normal' });
      var nAns = Object.keys(rd.choices).length;
      var score = nAns + (rd.studentNoValid ? 40 : 0) + up * 60 - (rd.quality.lowContrast || 0) * 2;
      dbgParts.push(dir + ':' + nAns + '/' + up.toFixed(2));
      // 正向地标分过低的直接淘汰（逆/倒的版面）
      if (up < UPRIGHT_MIN) continue;
      if (!best || score > best.score) {
        best = { dir: dir, img: im, quad: q, read: rd, score: score, up: up, nAns: nAns };
      }
    }
    return { best: best, dbg: dbgParts.join(' ') };
  }

  function tick() {
    if (scan.busy || scan.locked) return;
    var now = Date.now();
    if (now - scan.lastProc < PROCESS_INTERVAL) return;
    scan.lastProc = now;
    scan.busy = true;
    try {
      scan.frameN += 1;
      var raw = grabFrame();
      if (!raw) { setDbg('等待画面'); return; }
      updateMap(raw.width, raw.height);
      var res = analyzeFrame(raw);
      if (!res.best) {
        drawIdleFrame();
        setStatus(scan.frameN > 8 ? '把卡放进黑框，尽量填满并放平' : '把答题卡放入黑框内，对齐四角', 'idle');
        scan.lastBest = null;
        setDbg('帧' + scan.frameN + ' · ' + res.dbg);
        return;
      }
      var b = res.best;
      scan.lastBest = b;
      drawGuide(b.quad, b.img, b.read, b.dir);
      var sn = b.read.studentNoValid;
      // 高质量一帧即锁定：不再要求连续两帧一致（速度提升，且用户不必长时间持稳）
      var enough = b.nAns >= (TPL.questions.length * 0.55);
      if (sn && enough && b.up > UPRIGHT_MIN) {
        lockIn(b.read, b.quad, b.img, b.dir);
      } else if (sn) {
        setStatus('识别中：轻按「拍摄识别」可立即确认', 'busy');
      } else {
        setStatus('已定位，但学号未读全：点「拍摄识别」重试', 'warn');
      }
      setDbg('帧' + scan.frameN + ' · ' + res.dbg + ' →' + b.dir);
    } catch (e) {
      setDbg('ERR ' + ((e && e.message) || e));
    } finally {
      scan.busy = false;
    }
  }

  /* 手动拍摄：用当前最优结果立即确认；若无则用当前帧强制分析一次 */
  function captureNow() {
    if (scan.locked) return;
    var b = scan.lastBest;
    if (!b) {
      var raw = grabFrame();
      if (!raw) { setStatus('相机还没准备好', 'warn'); return; }
      updateMap(raw.width, raw.height);
      b = analyzeFrame(raw).best;
    }
    if (!b) { setStatus('没找到答题卡：请把卡放进黑框', 'warn'); return; }
    // 正向地标分低说明方向不对，提示旋转卡片
    if (b.up < UPRIGHT_MIN) { setStatus('卡片方向颠倒：请旋转卡片后重拍', 'warn'); return; }
    scan.lastBest = b;
    drawGuide(b.quad, b.img, b.read, b.dir);
    lockIn(b.read, b.quad, b.img, b.dir);
  }

  function lockIn(read, quad, img, dir) {
    scan.locked = true;
    var result = EXAM.grade(currentExam(), { choices: read.choices, flags: read.flags });
    var saved = saveRecord(read, result);
    var wrong = result.items.filter(function (i) { return i.ok === 'wrong'; }).length;
    var blank = result.items.filter(function (i) { return i.ok === 'blank' || i.ok === 'skip'; }).length;
    var name = saved.name || ('学号 ' + read.studentNo);

    $('rfScore').innerHTML = result.total + '<span class="rf-full">/' + FULL + '</span>';
    $('rfName').textContent = name;
    $('rfMeta').textContent = '对 ' + result.right + ' · 错 ' + wrong + ' · 空 ' + blank;
    $('rfTag').textContent = '✓ 成绩已记录';
    $('resultFloat').hidden = false;
    setStatus('已记录 ' + result.total + ' 分', 'ok');
    drawMarks(read, quad, img, result, dir || 'none');
    vibrate();
    speak(name + '，' + result.total + '分');

    scan.holdTimer = setTimeout(function () {
      scan.locked = false;
      scan.needLeave = true;
      scan.lastBest = null;
      $('resultFloat').hidden = true;
      setStatus('请拿开当前卡，放入下一张', 'idle');
      drawIdleFrame();
    }, 4000);
  }

  /* ================= 拍照批阅 ================= */
  function analyzePhoto(file) {
    var body = $('photoResult');
    body.hidden = false;
    body.innerHTML = '<div class="photo-result"><div style="padding:20px;color:#8a93a5">正在识别…</div></div>';
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function () {
      try {
        var scale = Math.min(1, 1500 / Math.max(img.width, img.height));
        var W = Math.round(img.width * scale), H = Math.round(img.height * scale);
        var c = document.createElement('canvas');
        c.width = W; c.height = H;
        var ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, W, H);
        var data = ctx.getImageData(0, 0, W, H).data;
        var gray = new Uint8Array(W * H);
        for (var i = 0, p = 0; i < gray.length; i += 1, p += 4) {
          gray[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
        }
        var oImg = { gray: gray, width: W, height: H };
        var quad = OMR.detectQuad(oImg);
        if (!quad) {
          body.innerHTML = '<div class="photo-result"><div class="pr-name">未定位到答题卡</div>' +
            '<div class="pr-meta">请拍完整版面、光线均匀后重试</div></div>';
          URL.revokeObjectURL(url);
          return;
        }
        var read = OMR.readSheet(oImg, quad, { sensitivity: 'normal' });
        if (!read.studentNoValid) {
          body.innerHTML = '<div class="photo-result"><div class="pr-name">学号未识别</div>' +
            '<div class="pr-meta">请检查学号区是否清晰、无遮挡，重拍试试</div></div>';
          URL.revokeObjectURL(url);
          return;
        }
        var result = EXAM.grade(currentExam(), { choices: read.choices, flags: read.flags });
        var wrong = result.items.filter(function (i) { return i.ok === 'wrong'; }).length;
        var blank = result.items.filter(function (i) { return i.ok === 'blank' || i.ok === 'skip'; }).length;
        var saved = saveRecord(read, result);
        var name = saved.name || ('学号 ' + read.studentNo);
        body.innerHTML = '<div class="photo-result">' +
          '<div class="pr-score' + (result.total < FULL * 0.6 ? ' bad' : '') + '">' + result.total + '<span style="font-size:18px">/' + FULL + '</span></div>' +
          '<div class="pr-name">' + name + '</div>' +
          '<div class="pr-meta">对 ' + result.right + ' · 错 ' + wrong + ' · 空 ' + blank + ' · 已保存</div>' +
          '<div class="pr-actions">' +
          '<button class="btn btn-ghost grow" id="prAgain">再拍一张</button>' +
          '<button class="btn btn-primary grow" id="prDone">完成</button></div></div>';
        $('prAgain').onclick = function () { $('fileInput').click(); };
        $('prDone').onclick = function () { showView('home'); };
        vibrate();
        speak(name + '，' + result.total + '分');
      } catch (e) {
        body.innerHTML = '<div class="photo-result"><div class="pr-name">识别出错</div><div class="pr-meta">' + ((e && e.message) || e) + '</div></div>';
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = function () {
      body.innerHTML = '<div class="photo-result"><div class="pr-name">照片读取失败</div></div>';
    };
    img.src = url;
  }

  /* ================= 标准答案编辑 ================= */
  function renderAnswers() {
    var answers = LS.get(K.answers, {});
    var box = $('answerChips');
    box.innerHTML = '';
    SECTION_META.forEach(function (sec) {
      var lab = document.createElement('div');
      lab.className = 'sec-label';
      lab.textContent = sec.label;
      box.appendChild(lab);
      for (var no = sec.from; no <= sec.to; no += 1) {
        (function (no) {
          var opts = optionsOf(no);
          var chip = document.createElement('button');
          chip.className = 'chip';
          function paint() {
            var a = answers[no] || '';
            chip.innerHTML = '<span class="no">' + no + '</span><span class="ans' + (a ? '' : ' empty') + '">' + (a || '—') + '</span>';
          }
          chip.onclick = function () {
            var seq = opts.concat(['']);
            var cur = answers[no] || '';
            var idx = seq.indexOf(cur);
            var next = seq[(idx + 1) % seq.length];
            if (next) answers[no] = next; else delete answers[no];
            LS.set(K.answers, answers);
            paint();
            $('answersCount').textContent = Object.keys(answers).length + '/' + NUMS.length;
          };
          paint();
          box.appendChild(chip);
        })(no);
      }
    });
    $('answersCount').textContent = Object.keys(answers).length + '/' + NUMS.length;
  }

  /* ================= 名单 ================= */
  function renderRoster() {
    $('rosterText').value = roster().map(function (r) {
      return r.className ? r.no + ',' + r.name + ',' + r.className : r.no + ',' + r.name;
    }).join('\n');
  }
  function importTip(msg, warn) {
    var el = $('importTip');
    el.textContent = msg;
    el.className = 'import-tip' + (warn ? ' warn' : '');
  }
  function normRow(cells, iNo, iName, iCls) {
    function g(i) { var v = cells[i]; return v == null ? '' : String(v).trim(); }
    var no = g(iNo);
    if (!no) return null;
    return { no: no, name: g(iName), className: g(iCls) };
  }
  /* 表格数组（Excel 首个工作表）→ 名单行 */
  function rowsFromTable(arr) {
    var iNo = 0, iName = 1, iCls = 2, start = 0;
    for (var r = 0; r < Math.min(arr.length, 10); r += 1) {
      var row = (arr[r] || []).map(function (c) { return c == null ? '' : String(c).trim(); });
      var a = -1, b = -1, c2 = -1;
      row.forEach(function (cell, i) {
        if (/学号|考号|考生|编号|id/i.test(cell) && a < 0) a = i;
        else if (/姓名|名字|学生/.test(cell) && b < 0) b = i;
        else if (/班级|class/i.test(cell) && c2 < 0) c2 = i;
      });
      if (a >= 0 || b >= 0) {
        if (a < 0) a = b === 0 ? 1 : 0;
        if (b < 0) b = a === 0 ? 1 : 0;
        iNo = a; iName = b; iCls = c2; start = r + 1;
        break;
      }
    }
    var out = [];
    for (var i = start; i < arr.length; i += 1) {
      var n = normRow(arr[i] || [], iNo, iName >= 0 ? iName : 1, iCls >= 0 ? iCls : 2);
      if (n) out.push(n);
    }
    return out;
  }
  /* 文本行 → 名单行（逗号/制表符/空格分隔） */
  function rowsFromText(text) {
    var lines = text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    var out = [];
    lines.forEach(function (line) {
      var cells = line.split(/[,，\t]+|\s{1,}/).map(function (c) { return c.trim(); }).filter(Boolean);
      if (!cells.length) return;
      if (cells[0].indexOf('学号') >= 0 || cells.some(function (c) { return c === '姓名'; })) return; // 表头
      out.push({ no: cells[0] || '', name: cells[1] || '', className: cells[2] || '' });
    });
    return out.filter(function (r) { return r.no; });
  }
  function mergeRoster(rows) {
    rows = rows.filter(function (r) { return r.no; });
    if (!rows.length) { importTip('没有解析到有效数据（需要「学号」列或第一列为学号）', true); return; }
    var map = {};
    var order = [];
    roster().forEach(function (r) {
      if (!(r.no in map)) { map[r.no] = r; order.push(r.no); }
    });
    var added = 0, updated = 0;
    rows.forEach(function (r) {
      r.no = String(r.no).trim();
      r.name = (r.name || '').trim();
      r.className = (r.className || '').trim();
      if (r.no in map) updated += 1; else added += 1;
      map[r.no] = r;
      if (order.indexOf(r.no) < 0) order.push(r.no);
    });
    var list = order.map(function (no) { return map[no]; });
    LS.set(K.roster, list);
    renderRoster();
    importTip('✓ 导入完成：新增 ' + added + ' 人，更新 ' + updated + ' 人，当前共 ' + list.length + ' 人');
  }
  function importRosterFile(file) {
    importTip('正在读取 ' + file.name + ' …');
    var ext = file.name.toLowerCase().split('.').pop();
    var reader = new FileReader();
    reader.onload = function (ev) {
      try {
        var buf = new Uint8Array(ev.target.result);
        if (ext === 'xlsx' || ext === 'xls') {
          if (!window.XLSX) { importTip('Excel 解析组件未加载，请刷新页面重试', true); return; }
          var wb = window.XLSX.read(buf, { type: 'array' });
          var ws = wb.Sheets[wb.SheetNames[0]];
          var arr = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
          mergeRoster(rowsFromTable(arr));
        } else {
          var utf8 = new TextDecoder('utf-8').decode(buf);
          var text = utf8.indexOf('\uFFFD') === -1 ? utf8 : (function () {
            try { return new TextDecoder('gbk').decode(buf); } catch (e2) { return utf8; }
          })();
          mergeRoster(rowsFromText(text));
        }
      } catch (err) {
        importTip('解析失败：' + ((err && err.message) || err), true);
      }
    };
    reader.onerror = function () { importTip('文件读取失败', true); };
    reader.readAsArrayBuffer(file);
  }

  /* ================= 成绩与错题率 ================= */
  function renderRecords() {
    var recs = LS.get(K.records, []);
    var body = $('recordsBody');
    if (!recs.length) {
      body.innerHTML = '<div class="empty-tip">还没有成绩记录，去扫描一张答题卡吧</div>';
      return;
    }
    var exam = currentExam();
    var sorted = recs.slice().sort(function (a, b) { return b.ts - a.ts; });
    var avg = recs.reduce(function (s, r) { return s + r.score; }, 0) / recs.length;
    var max = recs.reduce(function (m, r) { return Math.max(m, r.score); }, 0);
    var min = recs.reduce(function (m, r) { return Math.min(m, r.score); }, FULL);
    var wrongCnt = {}, answeredCnt = {};
    NUMS.forEach(function (no) { wrongCnt[no] = 0; answeredCnt[no] = 0; });
    recs.forEach(function (r) {
      NUMS.forEach(function (no) {
        var mine = r.choices && r.choices[no];
        var ans = exam.answers[no];
        if (!ans) return;
        if (mine) answeredCnt[no] += 1;
        if (mine && mine !== ans) wrongCnt[no] += 1;
      });
    });
    var rates = NUMS.filter(function (no) { return exam.answers[no]; })
      .map(function (no) {
        var pct = recs.length ? Math.round(wrongCnt[no] * 100 / recs.length) : 0;
        return { no: no, pct: pct };
      })
      .sort(function (a, b) { return b.pct - a.pct; })
      .slice(0, 12);

    /* 逐题作答分布：每题正确答案 + 各选项选择占比 */
    var distHtml = '';
    NUMS.forEach(function (no) {
      var ans = exam.answers[no];
      if (!ans) return;
      var opts = LETTERS.slice(0, EXAM.optionsOf(no));
      var dist = {};
      opts.forEach(function (L) { dist[L] = 0; });
      var blankCnt = 0;
      recs.forEach(function (r) {
        var mine = r.choices && r.choices[no];
        if (mine && mine in dist) dist[mine] += 1;
        else blankCnt += 1;
      });
      var wrongN = 0;
      opts.forEach(function (L) { if (L !== ans) wrongN += dist[L]; });
      var wrongPct = recs.length ? Math.round(wrongN * 100 / recs.length) : 0;
      distHtml += '<div class="qdist">' +
        '<div class="qdist-head"><span class="qdist-no">第' + no + '题</span>' +
        '<span class="qdist-ans">正确答案 ' + ans + '</span>' +
        '<span class="qdist-wrong">错误率 ' + wrongPct + '%</span></div>';
      opts.forEach(function (L) {
        var cnt = dist[L];
        var pct = recs.length ? Math.round(cnt * 100 / recs.length) : 0;
        var cls = L === ans ? 'ok' : (cnt ? 'bad' : 'zero');
        distHtml += '<div class="qdist-row ' + cls + '"><span class="qdist-L">' + L + (L === ans ? ' ✓' : '') + '</span>' +
          '<div class="qrate-bar"><div class="qrate-fill' + (L === ans ? ' fill-ok' : '') + '" style="width:' + pct + '%"></div></div>' +
          '<span class="qdist-pct">' + pct + '% · ' + cnt + '人</span></div>';
      });
      if (blankCnt) {
        var bp = recs.length ? Math.round(blankCnt * 100 / recs.length) : 0;
        distHtml += '<div class="qdist-row zero"><span class="qdist-L">空</span>' +
          '<div class="qrate-bar"><div class="qrate-fill" style="width:' + bp + '%"></div></div>' +
          '<span class="qdist-pct">' + bp + '% · ' + blankCnt + '人</span></div>';
      }
      distHtml += '</div>';
    });

    var html = '<div class="stat-card">' +
      '<div class="stat-line"><span>已批人数</span><b>' + recs.length + '</b></div>' +
      '<div class="stat-line"><span>平均分</span><b>' + avg.toFixed(1) + '</b></div>' +
      '<div class="stat-line"><span>最高 / 最低</span><b>' + max + ' / ' + min + '</b></div>' +
      '</div>';
    html += '<div class="stat-card"><div style="font-weight:700;margin-bottom:6px">错题率 TOP12</div>';
    html += rates.map(function (r) {
      return '<div class="qrate-row"><span class="qrate-no">第' + r.no + '题</span>' +
        '<div class="qrate-bar"><div class="qrate-fill" style="width:' + r.pct + '%"></div></div>' +
        '<span class="qrate-pct">' + r.pct + '%</span></div>';
    }).join('');
    html += '</div><div class="stat-card"><div style="font-weight:700;margin-bottom:6px">逐题作答分布</div>' + distHtml + '</div><div class="stat-card">';
    html += sorted.map(function (r) {
      var d = new Date(r.ts);
      var t = ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) + ' ' +
        ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      return '<div class="rec-row"><div><div class="rec-name">' + (r.name || '学号 ' + r.no) + '</div>' +
        '<div class="rec-sub">学号 ' + r.no + ' · ' + t + ' · 对' + r.right + ' 错' + r.wrong + ' 空' + r.blank + '</div></div>' +
        '<div class="rec-score' + (r.score < FULL * 0.6 ? ' bad' : '') + '">' + r.score + '</div></div>';
    }).join('');
    html += '</div>';
    body.innerHTML = html;
  }

  function exportCsv() {
    var recs = LS.get(K.records, []);
    if (!recs.length) { alert('还没有成绩记录'); return; }
    var exam = currentExam();
    var lines = ['学号,姓名,总分,对,错,空,时间,' + NUMS.map(function (n) { return 'Q' + n; }).join(',')];
    recs.forEach(function (r) {
      var d = new Date(r.ts);
      var t = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) +
        ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      var row = [r.no, r.name || '', r.score, r.right, r.wrong, r.blank, t];
      NUMS.forEach(function (no) {
        var mine = r.choices && r.choices[no];
        var ans = exam.answers[no];
        var mark = !mine ? '空' : (mine === ans ? '对' : '错(' + ans + ')');
        row.push(mine ? mine + mark : mark);
      });
      lines.push(row.join(','));
    });
    var blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '阅卡成绩_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
  }

  /* ================= 事件绑定 ================= */
  $('btnScan').onclick = function () {
    if (Object.keys(LS.get(K.answers, {})).length < NUMS.length &&
        !confirm('标准答案还没录完，未录的题会按"空"计。继续扫描？')) return;
    startScan();
  };
  $('btnPhoto').onclick = function () { showView('photo'); };
  $('btnPhotoBack').onclick = function () { showView('home'); };
  $('btnScanClose').onclick = function () { showView('home'); };
  $('btnStopScan').onclick = function () { showView('home'); };
  $('btnMute').onclick = function () {
    muted = !muted;
    LS.set(K.muted, muted);
    $('btnMute').textContent = muted ? '已静音' : '播报开';
    if (muted && window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (e) { /* 忽略 */ } }
  };
  $('btnCapture').onclick = function () { captureNow(); };
  $('btnAlbum').onclick = function () { $('fileInput').click(); };
  $('fileInput').onchange = function (e) {
    var f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if ($('view-scan').hidden) showView('photo');
    analyzePhoto(f);
  };
  $('btnAnswers').onclick = function () { showView('answers'); };
  $('btnAnswersBack').onclick = function () { showView('home'); };
  $('btnClearAnswers').onclick = function () {
    if (confirm('确定清空全部标准答案？')) { LS.set(K.answers, {}); renderAnswers(); }
  };
  $('btnRoster').onclick = function () { renderRoster(); importTip(''); showView('roster'); };
  $('btnRosterBack').onclick = function () { showView('home'); };
  $('rosterFile').onchange = function (e) {
    var f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) importRosterFile(f);
  };
  $('btnClearRoster').onclick = function () {
    if (confirm('确定清空全部学生名单？')) { LS.set(K.roster, []); renderRoster(); importTip('已清空'); }
  };
  $('btnSaveRoster').onclick = function () {
    var lines = $('rosterText').value.split(/\n+/).map(function (l) { return l.trim(); }).filter(Boolean);
    var list = lines.map(function (l) {
      var parts = l.split(/[,，\s]+/);
      return { no: parts[0] || '', name: parts[1] || '', className: parts[2] || '' };
    }).filter(function (r) { return r.no; });
    LS.set(K.roster, list);
    alert('已保存 ' + list.length + ' 名学生');
    showView('home');
  };
  $('tplSelect').onchange = function (e) {
    var ct = Number(e.target.value);
    if (ct === cardType) return;
    if (!confirm('切换答题卡模板会清空当前标准答案（题号范围不同），确定继续？')) {
      e.target.value = String(cardType);
      return;
    }
    LS.set(K.answers, {});
    applyCardType(ct);
    renderHome();
    alert('已切换为 ' + (ct === 35 ? '35 题' : '55 题') + ' 模板，请重新设置标准答案');
  };
  $('btnRecords').onclick = function () { showView('records'); };
  $('btnRecordsBack').onclick = function () { showView('home'); };
  $('btnExportCsv').onclick = exportCsv;
  $('btnClearRecords').onclick = function () {
    if (confirm('确定清空全部成绩记录？此操作不可恢复！')) { LS.set(K.records, []); renderRecords(); }
  };

  renderHome();
})();
