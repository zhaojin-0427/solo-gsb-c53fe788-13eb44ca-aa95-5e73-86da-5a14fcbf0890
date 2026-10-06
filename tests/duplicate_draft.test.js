/* 重复候选频点草稿的前端逻辑测试（Node 运行，迷你 DOM 支持事件触发）。
 *
 * 运行：node tests/duplicate_draft.test.js
 *
 * 修复前：已有协调结果或在途求解时，在合法候选“520, 540”后再次键入 520
 * 且未失焦，parseCandidates 静默去重后写入相同候选集与空 candInvalid，
 * planFingerprint 不变——旧表格与频谱不撤下、在途响应可回填，求解/保存
 * 沿用去重列表，失焦重绘还会抹去重复原文。
 *
 * 修复后应满足：
 *   1. 数值识别：按频点数值识别重复（与无法识别词区分），合法值去重后
 *      仍立即写入 candidates，不误改合法候选；
 *   2. 重复暂存：candDupes 记录重复值、candText 保留文本框原文；
 *   3. 键入即撤下：重复频点键入即改变指纹，旧结果立即撤下、在途求解作废；
 *   4. 即时反馈：文本框标红并按数值提示重复频点（不误报“无法识别”）；
 *   5. 失焦不抹去：change 重绘后重复原文与提示仍在；
 *   6. 改正前拦截：求解与保存均不发请求并提示重复错误；
 *   7. 不误伤：重复值仍在去重候选中时现用频点不被清理；现用频点失配
 *      校验与无法识别词反馈仍然有效；
 *   8. 改正即恢复：合法列表未失焦即可提交，求解/保存提交改正后的新列表。
 */
"use strict";

const fs = require("fs");
const path = require("path");

// --------------------------- 迷你 DOM（支持事件） ---------------------------

function makeCtx() {
  return new Proxy(
    {},
    {
      get: (target, prop) => {
        if (!(prop in target)) target[prop] = () => {};
        return target[prop];
      },
      set: (target, prop, v) => {
        target[prop] = v;
        return true;
      },
    }
  );
}

class El {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this._bySel = {};
    this._innerHTML = "";
    this.value = "";
    this.textContent = "";
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.style = {};
    this.clientWidth = 1100;
    this.width = 1100;
    this.height = 320;
  }

  set innerHTML(v) {
    this._innerHTML = v;
    if (v === "") this.children = []; // 模拟重建：清空子节点
  }
  get innerHTML() {
    return this._innerHTML;
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  dispatch(type, extra = {}) {
    const ev = { target: this, stopPropagation() {}, ...extra };
    (this.listeners[type] || []).forEach((f) => f(ev));
  }

  // 同一元素的同一选择器返回同一替身，模拟浏览器中稳定的子节点引用
  querySelector(sel) {
    if (!this._bySel[sel]) this._bySel[sel] = new El(sel);
    return this._bySel[sel];
  }

  querySelectorAll(sel) {
    if (!this._bySel["all:" + sel]) {
      this._bySel["all:" + sel] = [new El(sel + "#0"), new El(sel + "#1")];
    }
    return this._bySel["all:" + sel];
  }

  appendChild(c) {
    this.children.push(c);
  }

  scrollIntoView() {}

  getContext() {
    return makeCtx();
  }
}

const byId = {};
global.document = {
  querySelector(sel) {
    if (!byId[sel]) byId[sel] = new El(sel);
    return byId[sel];
  },
  createElement: (tag) => new El(tag),
  addEventListener() {},
  body: new El("body"),
};
global.window = {
  devicePixelRatio: 1,
  addEventListener() {},
};
global.confirm = () => true;

globalThis.__fetchImpl = () => Promise.reject(new Error("fetch 未 mock"));
global.fetch = (...args) => globalThis.__fetchImpl(...args);

globalThis.__deferred = () => {
  let resolve, reject;
  const p = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { p, resolve, reject };
};

// --------------------------- 加载被测代码并驱动 ---------------------------

const src = fs.readFileSync(
  path.join(__dirname, "..", "app", "static", "app.js"),
  "utf8"
);

const driver = `
;(async function __drive__() {
  const results = [];
  const t = (name, cond) => {
    results.push([name, !!cond]);
    console.log((cond ? "PASS" : "FAIL") + "  " + name);
  };
  const $el = (sel) => document.querySelector(sel);
  const okJson = (data) => Promise.resolve({ ok: true, json: async () => data });
  const SOLVE_OK = {
    status: "optimal", optimal: true, assignedCount: 2, changeCount: 0,
    solveTimeMs: 5, timeLimitSec: 10, phases: [],
    assignment: [
      { id: "A", locked: false, current: null, assigned: true, frequency: 530, changed: false },
      { id: "B", locked: false, current: null, assigned: true, frequency: 545, changed: false },
    ],
    conflicts: [],
  };

  // 0. 解析层：按频点数值识别重复，与无法识别词区分
  let p = parseCandidates("520, 540, 520");
  t("parseCandidates：重复值进入 dupes，合法值去重保留",
    JSON.stringify(p.values) === "[520,540]" &&
    JSON.stringify(p.dupes) === "[520]" &&
    JSON.stringify(p.invalid) === "[]");
  p = parseCandidates("520 520 540 540");
  t("parseCandidates：多个重复值升序列出",
    JSON.stringify(p.dupes) === "[520,540]");
  p = parseCandidates("520 0520");
  t("parseCandidates：按数值识别（520 与 0520 同值即重复）",
    JSON.stringify(p.values) === "[520]" && JSON.stringify(p.dupes) === "[520]");
  p = parseCandidates("520 x 3.5 520");
  t("parseCandidates：无法识别词与重复值同时存在时分别记录",
    JSON.stringify(p.values) === "[520]" &&
    JSON.stringify(p.invalid) === '["x","3.5"]' &&
    JSON.stringify(p.dupes) === "[520]");
  p = parseCandidates("540, 520");
  t("parseCandidates：互异合法列表无重复且保持录入顺序",
    JSON.stringify(p.values) === "[540,520]" && p.dupes.length === 0);

  // 通过界面控件录入合法方案（模拟用户键入，只触发 input，不触发 change）
  $el("#planName").value = "重复草稿测试";
  $el("#minGap").value = "5";
  $el("#imTolerance").value = "0";
  $el("#timeLimit").value = "10";
  const cardOf = () => $el("#mics").children[0];
  const candOf = () => cardOf().querySelector('[data-k="candidates"]');
  const candB = $el("#mics").children[1].querySelector('[data-k="candidates"]');
  candOf().value = "520, 540";
  candOf().dispatch("input");
  candB.value = "525 545";
  candB.dispatch("input");

  // 求解上屏，制造“已有有效结果”的状态
  globalThis.__fetchImpl = () => okJson(SOLVE_OK);
  await solvePlan();
  t("前置：求解成功，结果上屏",
    state.result !== null && $el("#resultPanel").hidden === false);

  // 1. 合法列表后再次键入 520（未失焦）-> 立即撤下旧解，重复进入草稿状态
  const candA = candOf();
  const fpBefore = planFingerprint();
  candA.value = "520, 540, 520";
  candA.dispatch("input"); // 只触发 input，未触发 change（未失焦）
  t("重复键入未失焦：旧结果立即撤下",
    state.result === null && $el("#resultPanel").hidden === true);
  t("重复键入未失焦：指纹随重复草稿变化",
    planFingerprint() !== fpBefore);
  t("重复值暂存：candDupes 按数值记录 520",
    JSON.stringify(plan.mics[0].candDupes) === "[520]");
  t("重复值不是无法识别词：candInvalid 为空",
    plan.mics[0].candInvalid.length === 0);
  t("重复原文：candText 保留文本框原文",
    plan.mics[0].candText === "520, 540, 520");
  t("合法候选不误改：去重后 [520,540] 仍在，其他话筒不动",
    JSON.stringify(plan.mics[0].candidates) === "[520,540]" &&
    JSON.stringify(plan.mics[1].candidates) === "[525,545]");
  t("重复键入未失焦：文本框标红且提示重复值、不误报无法识别",
    candA.className.includes("invalid") &&
    cardOf().querySelector(".cand-err").textContent.includes("候选频点重复") &&
    cardOf().querySelector(".cand-err").textContent.includes("520 kHz") &&
    !cardOf().querySelector(".cand-err").textContent.includes("无法识别"));

  // 2. 在途求解时键入重复值 -> 求解立即作废，迟到响应不上屏
  candA.value = "520, 540";
  candA.dispatch("input");
  const d1 = __deferred();
  globalThis.__fetchImpl = () => d1.p;
  const p1 = solvePlan();
  candA.value = "520, 540, 520";
  candA.dispatch("input");
  t("在途求解时键入重复值：求解按钮立即复位",
    $el("#btnSolve").disabled === false);
  d1.resolve({ ok: true, json: async () => SOLVE_OK });
  await p1;
  t("在途求解时键入重复值：迟到成功响应不上屏",
    state.result === null && $el("#resultPanel").hidden === true);

  // 3. 重复未改正 -> 求解与保存均被拦截（不发请求，提示重复错误）
  const calls = [];
  globalThis.__fetchImpl = (url) => { calls.push(url); return okJson({}); };
  await solvePlan();
  t("重复未改正：求解被拦截（未发请求）", calls.length === 0);
  t("重复未改正：求解提示重复频点错误",
    $el("#toast").textContent.includes("候选频点重复"));
  await savePlan();
  t("重复未改正：保存被拦截（未发请求）", calls.length === 0);
  t("重复未改正：保存提示重复频点错误",
    $el("#toast").textContent.includes("候选频点重复"));

  // 3b. 无法识别词与重复值同时出现 -> 两类反馈并存，同样拦截
  candA.value = "520, x, 520";
  candA.dispatch("input");
  t("混合草稿：无法识别词与重复值分别暂存",
    JSON.stringify(plan.mics[0].candInvalid) === '["x"]' &&
    JSON.stringify(plan.mics[0].candDupes) === "[520]");
  t("混合草稿：提示同时包含无法识别与重复",
    cardOf().querySelector(".cand-err").textContent.includes("无法识别") &&
    cardOf().querySelector(".cand-err").textContent.includes("候选频点重复"));
  calls.length = 0;
  await solvePlan();
  t("混合草稿：求解仍被拦截", calls.length === 0);

  // 4. 失焦重绘 -> 重复原文与提示保留；现用频点仍在去重候选中时不被清理
  candA.value = "520, 540, 520";
  candA.dispatch("input");
  plan.mics[0].current = 520;
  candA.dispatch("change");
  t("失焦重绘：重复原文与 dupes 保留在 plan",
    plan.mics[0].candText === "520, 540, 520" &&
    JSON.stringify(plan.mics[0].candDupes) === "[520]");
  const cardHtml = cardOf().innerHTML;
  t("失焦重绘：文本框回显重复原文且提示仍在",
    cardHtml.includes("520, 540, 520") && cardHtml.includes("候选频点重复"));
  t("现用频点不误伤：520 仍在去重候选中，失焦不清理",
    plan.mics[0].current === 520);
  collectPlan();
  let errs = validatePlan(plan);
  t("失焦后：报重复错误但不报现用频点失配",
    errs.some((e) => e.includes("候选频点重复")) &&
    !errs.some((e) => e.includes("不在候选频点中")));

  // 5. 改正为合法列表（未失焦）-> 立即恢复；现用频点失配校验仍有效
  const candA2 = candOf(); // 重绘后的新文本框
  candA2.value = "530, 550";
  candA2.dispatch("input"); // 始终未触发 change
  t("改正重复未失焦：合法列表立即提交、重复状态清空",
    JSON.stringify(plan.mics[0].candidates) === "[530,550]" &&
    plan.mics[0].candDupes.length === 0 &&
    plan.mics[0].candInvalid.length === 0 &&
    plan.mics[0].candText === null &&
    !candA2.className.includes("invalid"));
  collectPlan();
  errs = validatePlan(plan); // current 仍为 520，已不在新候选中
  t("现用频点失配校验保持有效，且不再报重复",
    errs.some((e) => e.includes("现用频点 520 kHz 不在候选频点中")) &&
    !errs.some((e) => e.includes("候选频点重复")) &&
    !errs.some((e) => e.includes("无法识别")));
  plan.mics[0].current = null;

  // 6. 改正后未失焦直接求解/保存 -> 提交改正后的新列表
  let solveBody = null;
  globalThis.__fetchImpl = (url, opts) => {
    solveBody = opts.body;
    return okJson(SOLVE_OK);
  };
  await solvePlan();
  t("改正后求解：提交改正后的新列表（去重列表不沿用）",
    solveBody.includes("530") && solveBody.includes("550") &&
    !solveBody.includes("520"));
  t("改正后求解：结果重新上屏",
    state.result !== null && $el("#resultPanel").hidden === false);
  let savedBody = null;
  globalThis.__fetchImpl = (url, opts) => {
    savedBody = opts.body;
    return okJson({ id: 8, name: "重复草稿测试" });
  };
  await savePlan();
  t("改正后保存：提交改正后的新列表",
    savedBody.includes("530") && savedBody.includes("550") &&
    !savedBody.includes("520"));

  const failed = results.filter(([, ok]) => !ok).length;
  console.log("\\n" + (results.length - failed) + "/" + results.length + " 通过");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("驱动异常：", e);
  process.exit(1);
});
`;

try {
  // eslint-disable-next-line no-eval
  eval(src + "\n" + driver);
} catch (e) {
  console.error("加载被测代码失败：", e);
  process.exit(1);
}
