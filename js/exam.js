/* 由 tools/build-web.js 自动生成，勿手改；源文件: utils/exam.js */
/**
 * 试卷结构、答案与评分
 * 依据上传答题卡版面（语法填空 56-65 已移除，不再批阅）：
 *   一、听力 1-20   A-C  每题 1.5  共 30
 *   二、阅读理解 21-40（21-35 A-D / 36-40 七选五 A-G）每题 2.5 共 50
 *   三、完形填空 41-55  A-D 每题 1（PDF 标注 37.5 有误，按 15 分计）
 *   合计 55 题 / 满分 95
 */
const config = { defaultScores: { listening: 1.5, reading: 2.5, cloze: 1, part1: 2, part2: 2.5, part3: 2 } };

// 55 题版：听力 1-20(A-C) / 阅读 21-35(A-D) / 七选五 36-40(A-G) / 完形 41-55(A-D)
const SECTIONS_55 = [
  {
    key: 'listening', name: '听力', short: '听力', kind: 'choice',
    ranges: [{ from: 1, to: 20, options: 3 }],
    per: config.defaultScores.listening, full: 30,
  },
  {
    key: 'reading', name: '阅读理解', short: '阅读', kind: 'choice',
    ranges: [{ from: 21, to: 35, options: 4 }, { from: 36, to: 40, options: 7 }],
    per: config.defaultScores.reading, full: 50,
  },
  {
    key: 'cloze', name: '完形填空', short: '完形', kind: 'choice',
    ranges: [{ from: 41, to: 55, options: 4 }],
    per: config.defaultScores.cloze, full: 15,
  },
];

// 35 题版：1-15 四选项 / 16-21 七选五(A-G) / 22-35 四选项
// 按通用答题卡模板（1-15、22-35 为 A-D，16-21 为 A-G）标定。
const SECTIONS_35 = [
  {
    key: 'part1', name: '第一部分', short: '1-15', kind: 'choice',
    ranges: [{ from: 1, to: 15, options: 4 }],
    per: config.defaultScores.part1 !== undefined ? config.defaultScores.part1 : 2, full: 30,
  },
  {
    key: 'part2', name: '七选五', short: '16-21', kind: 'choice',
    ranges: [{ from: 16, to: 21, options: 7 }],
    per: config.defaultScores.part2 !== undefined ? config.defaultScores.part2 : 2.5, full: 15,
  },
  {
    key: 'part3', name: '第二部分', short: '22-35', kind: 'choice',
    ranges: [{ from: 22, to: 35, options: 4 }],
    per: config.defaultScores.part3 !== undefined ? config.defaultScores.part3 : 2, full: 28,
  },
];

// 当前题型结构（按 cardType 切换，兼容旧数据默认 55）
let SECTIONS = SECTIONS_55;

/** 按试卷题量切换题型结构；返回当前 SECTIONS */
function setCardType(cardType) {
  SECTIONS = Number(cardType) === 35 ? SECTIONS_35 : SECTIONS_55;
  return SECTIONS;
}

function getCardType() {
  return SECTIONS === SECTIONS_35 ? 35 : 55;
}

/** 依据题量取对应结构（不改动全局状态，供只读场景使用） */
function sectionsFor(cardType) {
  return Number(cardType) === 35 ? SECTIONS_35 : SECTIONS_55;
}

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

function sectionOf(no) {
  return SECTIONS.find((s) => s.ranges.some((r) => no >= r.from && no <= r.to)) || null;
}

function optionsOf(no) {
  for (const s of SECTIONS) {
    for (const r of s.ranges) {
      if (no >= r.from && no <= r.to) return r.options;
    }
  }
  return 4;
}

function choiceNumbers() {
  const out = [];
  SECTIONS.filter((s) => s.kind === 'choice').forEach((s) => {
    s.ranges.forEach((r) => {
      for (let i = r.from; i <= r.to; i += 1) out.push(i);
    });
  });
  return out;
}

/** 语法填空已移除，恒返回空数组（保留接口避免旧调用点报错） */
function grammarNumbers() {
  return [];
}

function defaultScores() {
  const o = {};
  SECTIONS.forEach((s) => { o[s.key] = s.per; });
  return o;
}

function fullScore(scores, secs) {
  let total = 0;
  const list = secs || SECTIONS;
  list.forEach((s) => {
    const n = s.ranges.reduce((a, r) => a + (r.to - r.from + 1), 0);
    total += n * Number(scores[s.key] || 0);
  });
  return Math.round(total * 100) / 100;
}

function scoreOf(scores, no) {
  const s = sectionOf(no);
  return s ? Number(scores[s.key] || 0) : 0;
}

function createExam(partial) {
  const p = partial || {};
  const cardType = p.cardType ? Number(p.cardType) : 55;
  const secs = sectionsFor(cardType);
  const def = {};
  secs.forEach((s) => { def[s.key] = s.per; });
  return Object.assign(
    {
      title: '',
      subject: '英语',
      date: todayStr(),
      cardType,
      scores: def,
      answers: {},
      fullScore: fullScore(def, secs),
    },
    p
  );
}

function todayStr() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* ------------------------- 评分 ------------------------- */

/**
 * @param exam  { scores, answers }
 * @param read  { choices:{1:'A'}, studentNo, flags:{1:'multi'} }
 */
function grade(exam, read) {
  // 按试卷题量切换题型结构（兼容旧数据：无 cardType 视为 55）
  const cardType = exam && exam.cardType ? exam.cardType : 55;
  setCardType(cardType);
  const scores = exam.scores || defaultScores();
  const answers = exam.answers || {};
  const items = [];
  const secMap = {};
  SECTIONS.forEach((s) => {
    secMap[s.key] = { key: s.key, name: s.name, full: 0, score: 0, right: 0, wrong: 0, blank: 0, total: 0 };
  });

  let total = 0;
  let full = 0;

  choiceNumbers().forEach((no) => {
    const sec = sectionOf(no);
    const per = scoreOf(scores, no);
    const key = answers[no] || '';
    const mine = (read.choices && read.choices[no]) || '';
    const flag = (read.flags && read.flags[no]) || '';
    const answered = !!mine;
    let ok = 'blank';
    if (flag === 'multi') ok = 'multi';
    else if (!answered) ok = key ? 'blank' : 'skip';
    else ok = mine === key ? 'right' : 'wrong';

    const got = ok === 'right' ? per : 0;
    total += got;
    if (key) full += per;

    const st = secMap[sec.key];
    st.full += key ? per : 0;
    st.score += got;
    st.total += 1;
    if (ok === 'right') st.right += 1;
    else if (ok === 'blank' || ok === 'skip') st.blank += 1;
    else st.wrong += 1;

    items.push({ no, sec: sec.key, mine, answer: key, ok, score: got, full: key ? per : 0, flag });
  });

  items.sort((a, b) => a.no - b.no);
  const sections = SECTIONS.map((s) => secMap[s.key]);
  const answered = items.filter((i) => i.ok !== 'blank' && i.ok !== 'skip').length;
  const right = items.filter((i) => i.ok === 'right').length;

  return {
    total: round(total),
    full: round(full),
    sections,
    items,
    right,
    answered,
    questionCount: items.length,
    correctRate: answered ? round((right / answered) * 100, 1) : 0,
    accuracy: items.length ? round((right / items.length) * 100, 1) : 0,
  };
}

function round(v, d) {
  const p = Math.pow(10, d === undefined ? 2 : d);
  return Math.round(v * p) / p;
}

/** 全班题目分析：正答率 / 错误率 / 空白率 / 选项分布 */
function analyse(records, exam) {
  if (exam && exam.cardType) setCardType(exam.cardType);
  const rows = {};
  choiceNumbers().forEach((no) => {
    rows[no] = { no, sec: sectionOf(no).key, total: 0, right: 0, wrong: 0, blank: 0, dist: {} };
  });
  records.forEach((rec) => {
    (rec.detail ? rec.detail.items : []).forEach((it) => {
      const r = rows[it.no];
      if (!r || !it.answer) return;
      r.total += 1;
      if (it.ok === 'right') r.right += 1;
      else if (it.ok === 'blank' || it.ok === 'skip') r.blank += 1;
      else r.wrong += 1;
      if (it.mine) r.dist[it.mine] = (r.dist[it.mine] || 0) + 1;
    });
  });

  const list = Object.keys(rows).map((k) => rows[k]).filter((r) => r.total > 0);
  list.forEach((r) => {
    r.rate = round((r.right / r.total) * 100, 1);
    r.errRate = round((r.wrong / r.total) * 100, 1);
    r.blankRate = round((r.blank / r.total) * 100, 1);
  });

  const sumRight = list.reduce((a, r) => a + r.right, 0);
  const sumTotal = list.reduce((a, r) => a + r.total, 0);

  const secStats = SECTIONS.map((s) => {
    const ss = list.filter((r) => r.sec === s.key);
    const t = ss.reduce((a, r) => a + r.total, 0);
    const rg = ss.reduce((a, r) => a + r.right, 0);
    return {
      key: s.key,
      name: s.name,
      rate: t ? round((rg / t) * 100, 1) : 0,
      total: t,
      right: rg,
    };
  });

  const scores = records.map((r) => Number(r.score) || 0);
  const avg = scores.length ? round(scores.reduce((a, b) => a + b, 0) / scores.length, 1) : 0;
  const sorted = scores.slice().sort((a, b) => a - b);
  const mid = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const max = sorted.length ? sorted[sorted.length - 1] : 0;
  const min = sorted.length ? sorted[0] : 0;

  return {
    rows: list.sort((a, b) => a.no - b.no),
    secStats,
    correctRate: sumTotal ? round((sumRight / sumTotal) * 100, 1) : 0,
    errorRate: sumTotal ? round(((sumTotal - sumRight) / sumTotal) * 100, 1) : 0,
    count: records.length,
    avg,
    mid,
    max,
    min,
    fullScore: exam ? exam.fullScore : 0,
  };
}

window.EXAM = {
  get SECTIONS() { return SECTIONS; },
  SECTIONS_55,
  SECTIONS_35,
  setCardType,
  getCardType,
  sectionsFor,
  LETTERS,
  sectionOf,
  optionsOf,
  choiceNumbers,
  grammarNumbers,
  defaultScores,
  fullScore,
  scoreOf,
  createExam,
  todayStr,
  grade,
  analyse,
  round,
};
