/* 由 tools/build-web.js 自动生成，勿手改；源文件: utils/omr.js */
/**
 * OMR —— 2B 铅笔涂卡识别
 * ------------------------------------------------------------------
 * 思路：
 *  1. 用离屏 canvas 把照片解码成像素（缩放到长边 ≤ maxSide）
 *  2. 用行/列黑点投影找出答题卡的版面外框（可再手动微调四角）
 *  3. 按模板里每个选项气泡的归一化坐标，在照片上采样椭圆区域（与气泡圆角矩形内切）
 *  4. 同一题内做相对比较：明显比其它选项深 → 判为涂黑；两个都很深 → 判为多涂
 *     这样即使气泡里印着字母，也不会被误判为“已涂”
 * ------------------------------------------------------------------
 */
const template = window.TPL;

const SENSITIVITY = {
  loose: { ratio: 1.5, abs: 0.28 },
  normal: { ratio: 1.8, abs: 0.32 },
  strict: { ratio: 2.1, abs: 0.36 },
  // 学号格专用：印刷数字（尤其 8/0）墨迹可达 0.3+，涂黑应 0.6+，
  // 阈值必须与印刷墨迹拉开距离，否则空白卡会误识出学号
  sn: { ratio: 2.2, abs: 0.42 },
};

/** 把图片文件解码为像素数据 */
function loadImage(src, maxSide) {
  const limit = maxSide || 1500;
  return new Promise((resolve, reject) => {
    let canvas;
    try {
      canvas = wx.createOffscreenCanvas({ type: '2d', width: 32, height: 32 });
    } catch (e) {
      reject(new Error('当前基础库不支持离屏画布，请升级微信版本'));
      return;
    }
    const img = canvas.createImage();
    img.onload = () => {
      const scale = Math.min(1, limit / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      try {
        const data = ctx.getImageData(0, 0, w, h).data;
        const gray = new Uint8Array(w * h);
        for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
          gray[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
        }
        resolve({ gray, width: w, height: h });
      } catch (err) {
        reject(new Error('读取图片像素失败，请重新拍照'));
      }
    };
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

/** 版面定位块中心在设计画布坐标系中的位置（由 PDF 矢量数据精确提取，单位=设计点） */
const FRAME_W = 858.0;
const FRAME_H = 1207.5;
const ANCHORS = {
  tl: { x: 0.02622 * FRAME_W, y: -0.00952 * FRAME_H },
  tr: { x: 0.97436 * FRAME_W, y: -0.00952 * FRAME_H },
  bl: { x: 0.02622 * FRAME_W, y: 1.01739 * FRAME_H },
  br: { x: 0.97436 * FRAME_W, y: 1.01739 * FRAME_H },
};

/**
 * 方案一：连通域找 4 个实心黑色定位块，再做相似变换（平移+缩放+旋转）。
 * 定位块是整张卡上最黑、最实的图形，远比细边框线可靠。
 */
function detectByAnchors(img, thr) {
  const { gray, width: W, height: H } = img;
  const visited = new Uint8Array(W * H);
  const comps = [];
  const queue = new Int32Array(W * H + 1);
  for (let start = 0; start < W * H; start += 1) {
    if (visited[start] || gray[start] >= thr) continue;
    // BFS 收集连通域
    let head = 0;
    let tail = 0;
    queue[tail += 1] = start;
    visited[start] = 1;
    let minX = W;
    let maxX = -1;
    let minY = H;
    let maxY = -1;
    let area = 0;
    while (head < tail) {
      const p = queue[head += 1];
      const y = (p / W) | 0;
      const x = p - y * W;
      area += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      // 4 邻域
      if (x > 0 && !visited[p - 1] && gray[p - 1] < thr) { visited[p - 1] = 1; queue[tail += 1] = p - 1; }
      if (x < W - 1 && !visited[p + 1] && gray[p + 1] < thr) { visited[p + 1] = 1; queue[tail += 1] = p + 1; }
      if (y > 0 && !visited[p - W] && gray[p - W] < thr) { visited[p - W] = 1; queue[tail += 1] = p - W; }
      if (y < H - 1 && !visited[p + W] && gray[p + W] < thr) { visited[p + W] = 1; queue[tail += 1] = p + W; }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    // 定位块：长宽比 2~4（45x16）或近方形（18x16），实心度高。
    // 尺寸阈值按图像长边自适应：手机实时流常被压到 1000~1300 长边，
    // 此时锚点只有 20x7 左右，固定的 18/8 下限会把它整个滤掉。
    const s = Math.max(W, H) / 1500;
    const minBw = Math.max(9, Math.round(18 * s));
    const minBh = Math.max(5, Math.round(8 * s));
    const fill = area / (bw * bh);
    const aspect = bw / bh;
    // 小块（运动模糊/低分辨率下墨色变淡）放宽实心度要求
    const minFill = bh <= Math.max(8, Math.round(9 * s)) ? 0.55 : 0.62;
    if (bw < minBw || bw > 110 || bh < minBh || bh > 45) continue;
    if (fill < minFill) continue;
    if (aspect < 0.85 || aspect > 4.2) continue;
    comps.push({ cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: bw, h: bh, fill });
  }
  if (comps.length < 4) return null;

  // 按行聚类：y 相近的分一组
  comps.sort((a, b) => a.cy - b.cy);
  const rows = [];
  comps.forEach((c) => {
    const row = rows.find((r) => Math.abs(r[0].cy - c.cy) < H * 0.04);
    if (row) row.push(c);
    else rows.push([c]);
  });
  if (typeof process !== 'undefined' && process.env && process.env.OMR_DEBUG) {
    console.log('[anchors] thr=%d comps=%d rows=%s', thr, comps.length,
      rows.map((r) => '{y=' + r[0].cy.toFixed(0) + ' n=' + r.length + '}').join(','));
  }

  // 枚举所有"上行×下行 × 行内左右组合"，逐一做几何校验 + 仿射拟合，
  // 取残差最小（同残差取面积最大）的一组。
  // 之前只取 rows[0]/rows[rows.length-1] 贪心配对，一旦手机状态栏 /
  // 浏览器地址栏混进假候选行，真正的锚点行就被跳过导致整帧失败。
  const cands = rows
    .filter((r) => r.length >= 2)
    .map((r) => {
      // 每行最多取 6 个候选（按面积保大块，锚点通常比噪点实）
      const kept = r.slice().sort((p, q) => q.w * q.h - p.w * p.h).slice(0, 6);
      kept.sort((p, q) => p.cx - q.cx);
      const pairs = [];
      for (let i = 0; i < kept.length; i += 1) {
        for (let j = kept.length - 1; j > i; j -= 1) {
          pairs.push([kept[i], kept[j]]);
        }
      }
      return pairs;
    });
  if (cands.length < 2) return null;

  const src4 = [ANCHORS.tl, ANCHORS.tr, ANCHORS.bl, ANCHORS.br];
  let best = null;
  for (let i = 0; i < cands.length - 1; i += 1) {
    for (let j = i + 1; j < cands.length; j += 1) {
      for (const [tl, tr] of cands[i]) {
        for (const [bl, br] of cands[j]) {
          const a = { tl, tr, bl, br };
          const r = fitAffine(img, src4, a);
          if (r && (!best || r.err < best.err - 0.01
            || (Math.abs(r.err - best.err) <= 0.01 && r.area > best.area))) {
            best = { err: r.err, area: r.area, quad: r.quad };
          }
        }
      }
    }
  }
  return best ? best.quad : null;
}

/** 由 4 个锚点做几何校验 + 6 自由度仿射最小二乘，返回 {err, area, quad} 或 null */
function fitAffine(img, src4, a) {
  const { gray, width: W, height: H } = img;
  // 几何校验。
  // 高度阈值用"高/宽设计比"而非画面高度的固定百分比：设计比例 1207.5/858≈1.41，
  // 允许透视压缩到 0.85 倍。之前用 dyL ≥ H*0.6（卡片须占画面 60% 高），
  // 用户手机拿稍远（卡片只占 55% 高）时差 1 个像素也会被拒，导致反复识别失败。
  const dxT = a.tr.cx - a.tl.cx;
  const dxB = a.br.cx - a.bl.cx;
  const dyL = a.bl.cy - a.tl.cy;
  const dyR = a.br.cy - a.tr.cy;
  if (dxT < W * 0.5 || dxB < W * 0.5) return null;
  if (dyL < dxT * 0.85 || dyR < dxT * 0.85) return null;
  if (dyL > dxT * 2.2 || dyR > dxT * 2.2) return null;
  if (Math.abs(a.tl.cy - a.tr.cy) > H * 0.05) return null;
  if (Math.abs(a.bl.cy - a.br.cy) > H * 0.05) return null;

  const src = src4;
  const dst = [a.tl, a.tr, a.bl, a.br].map((p) => ({ x: p.cx, y: p.cy }));
  const n = src.length;
  const msx = src.reduce((s, p) => s + p.x, 0) / n;
  const msy = src.reduce((s, p) => s + p.y, 0) / n;
  const mdx = dst.reduce((s, p) => s + p.x, 0) / n;
  const mdy = dst.reduce((s, p) => s + p.y, 0) / n;
  // 中心化后正规方程 [Sxx Sxy; Sxy Syy] [a1;a2] = [Sxu; Syu]（对 x' 和 y' 各解一次）
  let Sxx = 0; let Sxy = 0; let Syy = 0;
  let Sxd = 0; let Syd = 0;
  let Sxe = 0; let Sye = 0;
  for (let i = 0; i < n; i += 1) {
    const ux = src[i].x - msx;
    const uy = src[i].y - msy;
    const vx = dst[i].x - mdx;
    const vy = dst[i].y - mdy;
    Sxx += ux * ux; Sxy += ux * uy; Syy += uy * uy;
    Sxd += ux * vx; Syd += uy * vx;
    Sxe += ux * vy; Sye += uy * vy;
  }
  const det = Sxx * Syy - Sxy * Sxy;
  if (Math.abs(det) < 1e-6) return null;
  const ax = (Syy * Sxd - Sxy * Syd) / det;
  const bx = (Sxx * Syd - Sxy * Sxd) / det;
  const ay = (Syy * Sxe - Sxy * Sye) / det;
  const by = (Sxx * Sye - Sxy * Sxe) / det;
  const tx = mdx - ax * msx - bx * msy;
  const ty = mdy - ay * msx - by * msy;
  const tf = (u, v) => ({
    x: ax * u + bx * v + tx,
    y: ay * u + by * v + ty,
  });
  // 残差校验（照片像素）。锚点越小像素误差越敏感，按锚点平均宽度自适应放宽
  let err = 0;
  for (let i = 0; i < n; i += 1) {
    const p = tf(src[i].x, src[i].y);
    err += Math.hypot(p.x - dst[i].x, p.y - dst[i].y);
  }
  err /= n;
  const avgW = (a.tl.w + a.tr.w + a.bl.w + a.br.w) / 4;
  const errMax = Math.max(6, avgW * 0.3);
  if (typeof process !== 'undefined' && process.env && process.env.OMR_DEBUG) {
    console.log('[anchors] ax=%s by=%s err=%s/%s', ax.toFixed(4), by.toFixed(4), err.toFixed(3), errMax.toFixed(1));
  }
  if (err > errMax) return null;

  const tl = tf(0, 0);
  const tr = tf(FRAME_W, 0);
  const br = tf(FRAME_W, FRAME_H);
  const bl = tf(0, FRAME_H);
  const ratio = Math.hypot(tr.x - tl.x, tr.y - tl.y) / Math.hypot(bl.x - tl.x, bl.y - tl.y);
  return {
    err,
    area: dxT * dyL,
    quad: {
      tl: { x: tl.x, y: tl.y },
      tr: { x: tr.x, y: tr.y },
      br: { x: br.x, y: br.y },
      bl: { x: bl.x, y: bl.y },
      ok: true,
      ratio,
      anchors: true,
    },
  };
}

/** 方案二（回退）：行/列投影取首末有效行列 */
function detectByProjection(img) {
  const { gray, width: W, height: H } = img;
  const step = Math.max(1, Math.round(Math.max(W, H) / 480));
  const rowCount = new Float32Array(H);
  const colCount = new Float32Array(W);

  // 自适应阈值：用整图亮度分布估计纸面白度
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 3) hist[gray[i]] += 1;
  let acc = 0;
  let total = 0;
  for (let i = 0; i < 256; i += 1) total += hist[i];
  let median = 128;
  for (let i = 0; i < 256; i += 1) {
    acc += hist[i];
    if (acc >= total * 0.7) { median = i; break; }
  }
  const thr = Math.max(70, Math.min(200, median * 0.62));

  // 行投影：每一行都统计，避免细线被采样跳过
  for (let y = 0; y < H; y += 1) {
    const base = y * W;
    for (let x = 0; x < W; x += step) {
      if (gray[base + x] < thr) rowCount[y] += 1;
    }
  }

  const samplesX = Math.ceil(W / step);
  const rowThr = Math.max(3, samplesX * 0.015);
  let y0 = -1;
  let y1 = -1;
  for (let y = 0; y < H; y += 1) {
    if (rowCount[y] >= rowThr) { y0 = y; break; }
  }
  for (let y = H - 1; y >= 0; y -= 1) {
    if (rowCount[y] >= rowThr) { y1 = y; break; }
  }
  if (y0 < 0 || y1 <= y0) return null;

  // 列投影：只在已确定的行区间内统计，降低背景干扰
  for (let x = 0; x < W; x += 1) {
    let c = 0;
    for (let y = y0; y <= y1; y += step) {
      if (gray[y * W + x] < thr) c += 1;
    }
    colCount[x] = c;
  }

  const samplesY = Math.ceil((y1 - y0) / step);
  const colThr = Math.max(2, samplesY * 0.02);
  let x0 = -1;
  let x1 = -1;
  for (let x = 0; x < W; x += 1) {
    if (colCount[x] >= colThr) { x0 = x; break; }
  }
  for (let x = W - 1; x >= 0; x -= 1) {
    if (colCount[x] >= colThr) { x1 = x; break; }
  }
  if (x0 < 0 || x1 <= x0) return null;

  const padX = (x1 - x0) * 0.008;
  const padY = (y1 - y0) * 0.008;
  x0 = Math.max(0, x0 - padX);
  x1 = Math.min(W - 1, x1 + padX);
  y0 = Math.max(0, y0 - padY);
  y1 = Math.min(H - 1, y1 + padY);

  const w = x1 - x0;
  const h = y1 - y0;
  const ratio = w / h;
  const expect = template.frame.w / template.frame.h;
  const ok = Math.abs(ratio - expect) / expect < 0.16;

  return {
    tl: { x: x0, y: y0 },
    tr: { x: x1, y: y0 },
    br: { x: x1, y: y1 },
    bl: { x: x0, y: y1 },
    ok,
    ratio,
  };
}

/**
 * 版面外框检测总入口：
 *  1. 优先用四角实心定位块 + 相似变换（精准、抗光照、可纠轻微旋转）
 *  2. 失败时回退到行/列投影法（兼容打印偏移的卡样）
 */
function detectQuad(img) {
  const { gray, width: W, height: H } = img;
  // 估计纸面白度（70 分位），定位块阈值取其一半，保证只抓纯黑实心块
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 3) hist[gray[i]] += 1;
  let acc = 0;
  let total = 0;
  for (let i = 0; i < 256; i += 1) total += hist[i];
  let median = 128;
  for (let i = 0; i < 256; i += 1) {
    acc += hist[i];
    if (acc >= total * 0.7) { median = i; break; }
  }
  const darkThr = Math.max(60, Math.min(130, Math.round(median * 0.55)));
  // 手持拍摄时运动模糊会让锚点墨色变浅、部分锚点低于阈值而漏检。
  // 用多档阈值重试：标准档失败后，放宽（抓回变浅的锚点）再收紧（排除噪点干扰）。
  const tries = [darkThr, Math.round(darkThr * 0.85), Math.round(darkThr * 1.15)];
  const seen = {};
  for (let i = 0; i < tries.length; i += 1) {
    const t = tries[i];
    if (seen[t]) continue;
    seen[t] = 1;
    const byAnchor = detectByAnchors(img, t);
    if (byAnchor) return byAnchor;
  }
  const byProj = detectByProjection(img);
  if (byProj) return byProj;
  return null;
}

function quadWidth(q) {
  return (Math.hypot(q.tr.x - q.tl.x, q.tr.y - q.tl.y) + Math.hypot(q.br.x - q.bl.x, q.br.y - q.bl.y)) / 2;
}

function quadHeight(q) {
  return (Math.hypot(q.bl.x - q.tl.x, q.bl.y - q.tl.y) + Math.hypot(q.br.x - q.tr.x, q.br.y - q.tr.y)) / 2;
}

/** 归一化坐标 → 像素坐标（双线性，兼容轻微透视） */
function mapPoint(q, u, v) {
  const top = { x: q.tl.x + (q.tr.x - q.tl.x) * u, y: q.tl.y + (q.tr.y - q.tl.y) * u };
  const bot = { x: q.bl.x + (q.br.x - q.bl.x) * u, y: q.bl.y + (q.br.y - q.bl.y) * u };
  return { x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v };
}

/** 采样一个椭圆区域的平均暗度（0 白 ~ 1 黑），椭圆与气泡圆角矩形内切 */
function sampleDisc(img, cx, cy, rx, ry, whiteRef) {
  const { gray, width: W, height: H } = img;
  const r = ry > 0 ? ry : 1;
  const k = (rx > 0 ? rx : 1) / r;
  let sum = 0;
  let n = 0;
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(H - 1, Math.ceil(cy + r));
  const x0 = Math.max(0, Math.floor(cx - k * r));
  const x1 = Math.min(W - 1, Math.ceil(cx + k * r));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = (x - cx) / k;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) {
        sum += gray[y * W + x];
        n += 1;
      }
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return Math.max(0, Math.min(1, (whiteRef - mean) / Math.max(60, whiteRef)));
}

/** 窗口内印刷内容的暗质心（用于二阶段自校准） */
function localCentroid(img, cx, cy, r, white) {
  const { gray, width: W, height: H } = img;
  const cut = white * 0.72;
  let sw = 0;
  let sx = 0;
  let sy = 0;
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(H - 1, Math.ceil(cy + r));
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(W - 1, Math.ceil(cx + r));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const g = gray[y * W + x];
      const w = g < cut ? cut - g : 0;
      if (w > 0) { sw += w; sx += w * x; sy += w * y; }
    }
  }
  if (sw < 20) return null;
  return { x: sx / sw, y: sy / sw };
}

/**
 * 二阶段自校准：定位块只提供 4 个锚点，纸张卷曲/透视带来的局部形变
 * （实测可达 2~5px）需要用卡上印刷的气泡网格再修正一次。
 * 做法：在预测位置附近找印刷内容质心，全体格子拟合一个仿射修正，
 * 再把修正折入四角。真卡涂黑后质心仍在气泡中心，不影响校准。
 */
/** 收集模板预测位置附近的印刷质心（自校准/方向校验共用） */
function collectCentroids(img, quad, white, r, cap) {
  const pts = [];
  const collect = (cells) => {
    cells.forEach((c) => {
      const p = mapPoint(quad, c[0], c[1]);
      const ct = localCentroid(img, p.x, p.y, r, white);
      if (!ct) return;
      const dx = ct.x - p.x;
      const dy = ct.y - p.y;
      if (Math.abs(dx) > cap || Math.abs(dy) > cap) return; // 涂改/噪声离群
      pts.push({ u: c[0], v: c[1], dx, dy });
    });
  };
  template.questions.forEach((q) => collect(q.cells));
  template.studentNo.forEach((row) => collect(row));
  return pts;
}

/**
 * 方向校验：锚点定位按"上排/下排"位置标注四角，若卡面上下颠倒 180°，
 * 锚点仍会"成功"拟合，但 u/v 映射完全颠倒（实测定向 265 点 vs 颠倒 90 点）。
 * 用自校准质心数判断当前映射方向是否与卡面印刷内容对齐。
 */
function orientationOk(img, quad) {
  if (!quad || !quad.anchors) return true;
  const white = whiteLevel(img, quad);
  const qw = quadWidth(quad);
  const r = Math.max(5, Math.min(10, qw * 0.0095));
  const cap = Math.max(8, qw * 0.0095);
  return collectCentroids(img, quad, white, r, cap).length >= 150;
}

function refineQuad(img, quad, white) {
  const qw = quadWidth(quad);
  const r = Math.max(5, Math.min(10, qw * 0.0095));
  const cap = Math.max(8, qw * 0.0095);
  const pts = collectCentroids(img, quad, white, r, cap);
  if (pts.length < 40) return quad;

  const n = pts.length;
  const mu = pts.reduce((s, p) => s + p.u, 0) / n;
  const mv = pts.reduce((s, p) => s + p.v, 0) / n;
  let Suu = 0; let Suv = 0; let Svv = 0;
  let Sux = 0; let Svx = 0; let Suy = 0; let Svy = 0;
  for (let i = 0; i < n; i += 1) {
    const pu = pts[i].u - mu;
    const pv = pts[i].v - mv;
    Suu += pu * pu; Suv += pu * pv; Svv += pv * pv;
    Sux += pu * pts[i].dx; Svx += pv * pts[i].dx;
    Suy += pu * pts[i].dy; Svy += pv * pts[i].dy;
  }
  const det = Suu * Svv - Suv * Suv;
  if (Math.abs(det) < 1e-9) return quad;
  const a1 = (Svv * Sux - Suv * Svx) / det;
  const a2 = (Suu * Svx - Suv * Sux) / det;
  const b1 = (Svv * Suy - Suv * Svy) / det;
  const b2 = (Suu * Svy - Suv * Suy) / det;
  const tx = pts.reduce((s, p) => s + p.dx, 0) / n - a1 * mu - a2 * mv;
  const ty = pts.reduce((s, p) => s + p.dy, 0) / n - b1 * mu - b2 * mv;
  const corr = (u, v) => ({ x: a1 * u + a2 * v + tx, y: b1 * u + b2 * v + ty });
  if (typeof process !== 'undefined' && process.env && process.env.OMR_DEBUG) {
    console.log('[refine] n=%d tx=%s ty=%s a1=%s a2=%s b1=%s b2=%s',
      n, tx.toFixed(2), ty.toFixed(2), a1.toFixed(4), a2.toFixed(4), b1.toFixed(4), b2.toFixed(4));
  }
  return {
    tl: { x: quad.tl.x + corr(0, 0).x, y: quad.tl.y + corr(0, 0).y },
    tr: { x: quad.tr.x + corr(1, 0).x, y: quad.tr.y + corr(1, 0).y },
    br: { x: quad.br.x + corr(1, 1).x, y: quad.br.y + corr(1, 1).y },
    bl: { x: quad.bl.x + corr(0, 1).x, y: quad.bl.y + corr(0, 1).y },
    ok: quad.ok,
    ratio: quad.ratio,
    anchors: quad.anchors,
    refined: true,
  };
}

/** 估计纸面白度（版面区域内 85 分位亮度） */
function whiteLevel(img, q) {  const { gray, width: W, height: H } = img;
  const x0 = Math.max(0, Math.round(Math.min(q.tl.x, q.bl.x)));
  const x1 = Math.min(W - 1, Math.round(Math.max(q.tr.x, q.br.x)));
  const y0 = Math.max(0, Math.round(Math.min(q.tl.y, q.tr.y)));
  const y1 = Math.min(H - 1, Math.round(Math.max(q.bl.y, q.br.y)));
  const hist = new Uint32Array(256);
  let n = 0;
  const step = Math.max(1, Math.round((x1 - x0) / 120));
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      hist[gray[y * W + x]] += 1;
      n += 1;
    }
  }
  let acc = 0;
  let white = 235;
  for (let i = 255; i >= 0; i -= 1) {
    acc += hist[i];
    if (acc >= n * 0.15) { white = i; break; }
  }
  return Math.max(120, white);
}

function decide(darks, sens) {
  const { ratio: ratioThr, abs: absThr } = SENSITIVITY[sens] || SENSITIVITY.normal;
  let maxI = 0;
  for (let i = 1; i < darks.length; i += 1) if (darks[i] > darks[maxI]) maxI = i;
  const max = darks[maxI];
  const sorted = darks.slice().sort((a, b) => a - b);
  const base = sorted.length > 1 ? sorted[0] : 0;
  if (max < absThr) return { index: -1, multi: false, max, base };
  if (max < base * ratioThr) return { index: -1, multi: false, max, base };
  let second = 0;
  for (let i = 0; i < darks.length; i += 1) if (i !== maxI && darks[i] > second) second = darks[i];
  const multi = second >= absThr && second >= max * 0.72;
  return { index: maxI, multi, max, base };
}

/**
 * 识别整张答题卡
 * @returns { studentNo, choices, flags, darks, quality }
 */
function readSheet(img, quad, opts) {
  const options = opts || {};
  const sens = options.sensitivity || 'normal';
  const white = whiteLevel(img, quad);
  // 二阶段自校准：用印刷气泡网格补偿纸张弯曲，之后再采样
  const q2 = refineQuad(img, quad, white);
  const quadR = q2;
  const qw = quadWidth(quadR);
  const qh = quadHeight(quadR);
  const rxBase = Math.max(2, template.radiusX * qw);
  const ryBase = Math.max(1.5, template.radiusY * qh);

  const choices = {};
  const flags = {};
  const darks = {};
  let lowContrast = 0;
  let ambiguous = 0;

  template.questions.forEach((q) => {
    const arr = q.cells.map((c) => {
      const p = mapPoint(quadR, c[0], c[1]);
      return sampleDisc(img, p.x, p.y, rxBase, ryBase, white);
    });
    const d = decide(arr, sens);
    darks[q.no] = arr.map((v) => Math.round(v * 100) / 100);
    if (d.index >= 0) {
      choices[q.no] = q.options[d.index];
      if (d.multi) {
        flags[q.no] = 'multi';
        ambiguous += 1;
      }
    } else {
      flags[q.no] = 'blank';
      if (d.max > 0.16) lowContrast += 1;
    }
  });

  // 学号：每行 10 个数字，取最深的那个
  const sn = [];
  let snUncertain = 0;
  template.studentNo.forEach((row) => {
    const arr = row.map((c) => {
      const p = mapPoint(quadR, c[0], c[1]);
      return sampleDisc(
        img,
        p.x,
        p.y,
        Math.max(2, template.studentNoRadiusX * qw),
        Math.max(1.5, template.studentNoRadiusY * qh),
        white
      );
    });
    const d = decide(arr, 'sn');
    if (d.index >= 0) {
      sn.push(String(d.index));
      if (d.multi) snUncertain += 1;
    } else {
      sn.push('');
      snUncertain += 1;
    }
  });
  const studentNo = sn.every((s) => s !== '') ? sn.join('') : sn.join('').replace(/\s/g, '');

  const warnings = [];
  if (!quad.ok) warnings.push('答题卡边框未完全对齐，可拖动四角微调');
  if (lowContrast > 3) warnings.push('部分题目识别度较低，可能是光线不足或涂卡太轻');
  if (ambiguous > 2) warnings.push('存在多涂题目，请在结果页确认');

  return {
    studentNo,
    studentNoValid: studentNo.length === 5,
    studentNoUncertain: snUncertain,
    choices,
    flags,
    darks,
    quality: {
      white,
      contrast: Math.round(rxBase * 100) / 100,
      lowContrast,
      ambiguous,
      warnings,
    },
  };
}

/** 生成四角微调界面上要显示的采样点（抽样，避免太密） */
function samplePoints(quad, step) {
  const every = step || 3;
  const pts = [];
  template.questions.forEach((q, idx) => {
    if (idx % every !== 0) return;
    const c = q.cells[0];
    const p = mapPoint(quad, c[0], c[1]);
    pts.push(p);
  });
  return pts;
}

window.OMR = {
  loadImage,
  detectQuad,
  readSheet,
  refineQuad,
  orientationOk,
  mapPoint,
  quadWidth,
  samplePoints,
  SENSITIVITY,
};
