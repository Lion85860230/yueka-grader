/* 阅卡 H5 主逻辑：实时扫描 / 拍照批阅 / 答案与名单 / 成绩与错题率 */
/* global TPL, OMR, EXAM */
(function () {
  'use strict';

  var LS = {
    get: function (k, d) {
      try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 满/隐私模式忽略 */ } },
  };
  var K = { answers: 'acg_web_answers_v1', roster: 'acg_web_roster_v1', records: 'acg_web_records_v1', muted: 'acg_web_muted_v1' };

  var LETTERS = EXAM.LETTERS;
  var NUMS = EXAM.choiceNumbers();
  var FULL = 95;

  function optionsOf(no) { return LETTERS.slice(0, EXAM.optionsOf(no)); }
  function currentExam() { return EXAM.createExam({ title: '英语选择题', answers: LS.get(K.answers, {}) }); }
  function $(id) { return document.getElementById(id); }

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

  /* ================= 实时扫描 ================= */
  var scan = {
    stream: null, video: null, octx: null, ovW: 0, ovH: 0,
    work: null, wctx: null, timer: null, busy: false,
    frameN: 0, lastProc: 0, streak: 0, lastSig: '', needLeave: false, locked: false,
    map: null, holdTimer: null,
  };
  var PROCESS_INTERVAL = 300;
  var LIVE_MAX_SIDE = 1000;
  var STREAK_NEED = 2;

  function setStatus(text, level) {
    var el = $('scanStatus');
    el.textContent = text;
    el.className = 'hud-status lv-' + (level || 'idle');
  }
  function setDbg(text) { $('scanDbg').textContent = text; }

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
      setStatus('将答题卡放入画面', 'idle');
      scan.work = document.createElement('canvas');
      scan.wctx = scan.work.getContext('2d', { willReadFrequently: true });
      scan.timer = setInterval(tick, 120);
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
    scan.locked = false; scan.busy = false; scan.streak = 0; scan.lastSig = ''; scan.needLeave = false;
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

  /* 屏幕映射：视频 object-fit:cover，帧坐标 → 屏幕坐标 */
  function updateMap(fw, fh) {
    var sw = window.innerWidth, sh = window.innerHeight;
    var scale = Math.max(sw / fw, sh / fh);
    scan.map = { scale: scale, ox: (fw - sw / scale) / 2, oy: (fh - sh / scale) / 2 };
  }
  function toScreen(p) {
    var m = scan.map;
    return { x: (p.x - m.ox) * m.scale, y: (p.y - m.oy) * m.scale };
  }
  function clearOverlay() {
    if (scan.octx) scan.octx.clearRect(0, 0, scan.ovW, scan.ovH);
  }
  function drawQuadPath(ctx, quad) {
    var pts = [quad.tl, quad.tr, quad.br, quad.bl].map(toScreen);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < 4; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }

  function tick() {
    if (scan.busy || scan.locked) return;
    var now = Date.now();
    if (now - scan.lastProc < PROCESS_INTERVAL) return;
    scan.lastProc = now;
    scan.busy = true;
    var dbg = '';
    try {
      scan.frameN += 1;
      var img = grabFrame();
      if (!img) { setDbg('等待画面'); return; }
      var quad = OMR.detectQuad(img);
      dbg = img.width + 'x' + img.height + (quad && quad.anchors ? ' 锚点✓' : ' 锚点✗');
      if (!quad || !quad.anchors) {
        scan.needLeave = false; scan.streak = 0; scan.lastSig = '';
        setStatus('将答题卡放入画面', 'idle');
        clearOverlay();
        return;
      }
      if (!OMR.orientationOk(img, quad)) {
        scan.needLeave = false; scan.streak = 0; scan.lastSig = '';
        setStatus('答题卡放倒了，请旋转 180°', 'warn');
        clearOverlay();
        return;
      }
      updateMap(img.width, img.height);
      if (scan.needLeave) {
        setStatus('当前卡已记录，请先拿开', 'warn');
        return;
      }
      var read = OMR.readSheet(img, quad, { sensitivity: 'normal' });
      dbg += ' 学号' + (read.studentNoValid ? '✓' : '✗');
      var sig = read.studentNoValid
        ? read.studentNo + '#' + Object.keys(read.choices).sort().map(function (k) { return k + read.choices[k]; }).join('')
        : '';
      scan.streak = (scan.lastSig && sig === scan.lastSig) ? scan.streak + 1 : 1;
      scan.lastSig = sig;

      if (read.studentNoValid && scan.streak >= STREAK_NEED) {
        lockIn(read, quad, img);
      } else if (read.studentNoValid) {
        setStatus('识别中，请持稳…', 'busy');
        drawTrack(quad);
      } else {
        setStatus('未识别到学号，请对准并保持光线均匀', 'warn');
        drawTrack(quad);
      }
    } catch (e) {
      dbg = 'ERR ' + ((e && e.message) || e);
    } finally {
      scan.busy = false;
      setDbg('帧' + scan.frameN + ' · ' + dbg);
    }
  }

  function drawTrack(quad) {
    if (!scan.octx) return;
    var ctx = scan.octx;
    ctx.clearRect(0, 0, scan.ovW, scan.ovH);
    drawQuadPath(ctx, quad);
    ctx.strokeStyle = 'rgba(80, 220, 140, .95)';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  function drawMarks(read, quad, img, result) {
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
      var p = toScreen(OMR.mapPoint(quadR, c[0], c[1]));
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = it.ok === 'right' ? 'rgba(70, 200, 120, .45)' : 'rgba(240, 55, 55, .75)';
      ctx.fill();
      if (it.ok === 'wrong') {
        var first = toScreen(OMR.mapPoint(quadR, q.cells[0][0], q.cells[0][1]));
        ctx.fillStyle = 'rgba(240, 55, 55, .95)';
        ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(String(q.no), first.x - rx - 4, first.y + 4);
      }
    });
    drawQuadPath(ctx, quadR);
    ctx.strokeStyle = 'rgba(30, 30, 30, .9)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  function lockIn(read, quad, img) {
    scan.locked = true;
    scan.streak = 0;
    scan.lastSig = '';
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
    drawMarks(read, quad, img, result);
    vibrate();
    speak(name + '，' + result.total + '分');

    scan.holdTimer = setTimeout(function () {
      scan.locked = false;
      scan.needLeave = true;
      $('resultFloat').hidden = true;
      setStatus('请拿开当前卡，放入下一张', 'idle');
      clearOverlay();
    }, 5000);
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
  var SECTION_META = [
    { label: '一、听力 1-20（A-C）', from: 1, to: 20 },
    { label: '二、阅读 21-35（A-D）', from: 21, to: 35 },
    { label: '七选五 36-40（A-G）', from: 36, to: 40 },
    { label: '三、完形 41-55（A-D）', from: 41, to: 55 },
  ];
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
    html += '</div><div class="stat-card">';
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
  $('btnRoster').onclick = function () { renderRoster(); showView('roster'); };
  $('btnRosterBack').onclick = function () { showView('home'); };
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
  $('btnRecords').onclick = function () { showView('records'); };
  $('btnRecordsBack').onclick = function () { showView('home'); };
  $('btnExportCsv').onclick = exportCsv;
  $('btnClearRecords').onclick = function () {
    if (confirm('确定清空全部成绩记录？此操作不可恢复！')) { LS.set(K.records, []); renderRecords(); }
  };

  renderHome();
})();
