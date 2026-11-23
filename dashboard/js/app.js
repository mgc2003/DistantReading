// DistantReading dashboard: HN generative-AI imagery debate.
// Reads the JSON produced by analyze.py from ./data/ and renders every view with D3 v7.

const d3 = window.d3;

const DATA = {};
const state = { from: null, to: null, tier: "all", topic: "all", thread: 0 };
const tableMode = {};
let C = {}; // resolved colors for the current theme
let MONTHS = []; // continuous month list
const fmtInt = d3.format(",");
const fmtPct = d3.format(".0%");
const fmtSent = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(3);
const TIER_NAME = { A: "AI imagery in games", B: "Gen-AI debate" };

// ------------------------------------------------------------------ utilities

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function readColors() {
  C = {
    text: css("--text"), text2: css("--text-2"), muted: css("--muted"), grid: css("--grid"),
    axis: css("--axis"), surface: css("--surface"), tierA: css("--tier-a"), tierB: css("--tier-b"),
    accent: css("--accent"), neg: css("--neg"), neu: css("--neu"), pos: css("--pos"), mid: css("--mid"),
    wash: css("--wash"),
  };
}
const tierColor = (t) => (t === "A" ? C.tierA : C.tierB);
function sentScale(extent) {
  return d3.scaleLinear().domain([-extent, 0, extent]).range([C.neg, C.mid, C.pos])
    .interpolate(d3.interpolateLab).clamp(true);
}
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function monthLabel(m) {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString("en", { month: "short", year: "numeric", timeZone: "UTC" });
}
function monthRange(a, b) {
  const out = [];
  let [y, m] = a.split("-").map(Number);
  const [y2, m2] = b.split("-").map(Number);
  while (y < y2 || (y === y2 && m <= m2)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}
function monthTicks(months, width) {
  const per = Math.max(1, Math.ceil(months.length / Math.max(2, Math.floor(width / 70))));
  const step = per <= 1 ? 1 : per <= 3 ? 3 : per <= 6 ? 6 : 12;
  return months.filter((m) => (Number(m.slice(5)) - 1) % step === 0);
}
function tickFormat(m, months) {
  return months.length > 24 && m.endsWith("-01") ? m.slice(0, 4) : monthLabel(m);
}
function roundedTop(x, y, w, hgt, r) {
  if (hgt <= 0 || w <= 0) return "";
  r = Math.min(r, w / 2, hgt);
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}
function roundedRight(x, y, w, hgt, r) {
  if (hgt <= 0 || w <= 0) return "";
  r = Math.min(r, hgt / 2, w);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt - r}Q${x + w},${y + hgt} ${x + w - r},${y + hgt}H${x}Z`;
}
function topicLabel(k) {
  if (k === -1) return "Unassigned (short posts)";
  return DATA.topics[k] ? DATA.topics[k].label : `Topic ${k}`;
}

// --------------------------------------------------------------- tooltip

const tip = document.getElementById("tooltip");
function showTip(event, build) {
  tip.replaceChildren();
  build(tip);
  tip.hidden = false;
  const pad = 14;
  const { innerWidth: W, innerHeight: H } = window;
  const r = tip.getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + r.width > W - 8) x = event.clientX - r.width - pad;
  if (y + r.height > H - 8) y = event.clientY - r.height - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
function focusTip(el, build) {
  const r = el.getBoundingClientRect();
  showTip({ clientX: r.right, clientY: r.top }, build);
}
function hideTip() { tip.hidden = true; }
function tipTitle(t) { return h("div", "tt-title", t); }
function tipRow(value, label, color) {
  const row = h("div", "tt-row");
  if (color) { const ln = h("span", "ln"); ln.style.background = color; row.append(ln); }
  row.append(h("strong", null, value), h("span", "tt-muted", label));
  return row;
}

// ------------------------------------------------------------ filtering

const inRange = (m) => m >= state.from && m <= state.to;
const tierOk = (t) => state.tier === "all" || t === state.tier;
const topicOk = (k) => state.topic === "all" || k === Number(state.topic);
function rows({ date = true, tier = true, topic = true } = {}) {
  return DATA.timeline.filter((r) => (!date || inRange(r.m)) && (!tier || tierOk(r.t)) && (!topic || topicOk(r.k)));
}
function activeTiers() { return state.tier === "all" ? ["A", "B"] : [state.tier]; }
function activeMonths() { return MONTHS.filter(inRange); }

// --------------------------------------------------------------- legends

function legend(id, items) {
  const el = document.getElementById(id);
  if (!el) return;
  el.replaceChildren(...items.map((it) => {
    const k = h("span", "key");
    if (it.ramp) {
      k.append(h("span", "tt-muted", it.left));
      const r = h("span", "ramp");
      r.style.background = `linear-gradient(90deg, ${C.neg}, ${C.mid}, ${C.pos})`;
      r.style.outline = `1px solid ${C.axis}`;
      k.append(r, h("span", "tt-muted", it.right));
    } else {
      const sw = h("span", it.line ? "ln" : "sw");
      sw.style.background = it.color;
      if (it.ring) sw.style.outline = `1px solid ${C.axis}`;
      k.append(sw, document.createTextNode(it.label));
    }
    return k;
  }));
}
const sentimentLegend = (id) => legend(id, [{ ramp: true, left: "Negative", right: "Positive" }]);

// ------------------------------------------------------------------ cards

const RENDERERS = {};
function renderCard(name) {
  const card = document.querySelector(`[data-chart="${name}"]`);
  const el = card.querySelector(".chart");
  const width = Math.max(260, el.clientWidth || card.clientWidth - 32);
  if (tableMode[name]) {
    const spec = RENDERERS[name](document.createElement("div"), width);
    el.replaceChildren(renderTable(spec));
  } else {
    el.replaceChildren();
    RENDERERS[name](el, width);
  }
}
function renderTable(spec) {
  const wrap = h("div", "table-wrap");
  if (!spec || !spec.rows.length) { wrap.append(h("div", "empty", "No data in this selection.")); return wrap; }
  const t = h("table");
  const thead = h("thead"); const tr = h("tr");
  spec.columns.forEach((c) => tr.append(h("th", null, c)));
  thead.append(tr);
  const tb = h("tbody");
  spec.rows.forEach((r) => {
    const row = h("tr");
    r.forEach((v) => row.append(h("td", typeof v === "number" ? "num" : null, typeof v === "number" ? String(+v.toFixed(3)) : v)));
    tb.append(row);
  });
  t.append(thead, tb);
  wrap.append(t);
  return wrap;
}
function renderAll() {
  renderTiles();
  Object.keys(RENDERERS).forEach(renderCard);
}
function empty(el, msg = "No posts in this selection.") {
  el.replaceChildren(h("div", "empty", msg));
}

// ------------------------------------------------------------------ tiles

function renderTiles() {
  const rs = rows();
  const n = d3.sum(rs, (r) => r.n);
  const s = d3.sum(rs, (r) => r.s);
  const pos = d3.sum(rs, (r) => r.pos);
  const neg = d3.sum(rs, (r) => r.neg);
  const tiles = [
    ["Posts in selection", fmtInt(n), `${fmtInt(DATA.meta.counts.posts)} in whole corpus`],
    ["Mean sentiment", n ? fmtSent(s / n) : "–", "VADER, −1 to +1"],
    ["Negative posts", n ? fmtPct(neg / n) : "–", `score ≤ −${DATA.meta.params.neutral_band}`],
    ["Positive posts", n ? fmtPct(pos / n) : "–", `score ≥ +${DATA.meta.params.neutral_band}`],
    ["Pseudonymized accounts", fmtInt(DATA.meta.counts.accounts), "whole corpus"],
  ];
  document.getElementById("tiles").replaceChildren(...tiles.map(([k, v, sub]) => {
    const t = h("div", "tile");
    t.append(h("div", "k", k), h("div", "v", v), h("div", "s", sub));
    return t;
  }));
}

// ------------------------------------------------------------ 1. volume

RENDERERS.volume = (el, width) => {
  const months = activeMonths();
  const tiers = activeTiers();
  const rs = rows({ tier: true, topic: true });
  const by = d3.rollup(rs, (v) => d3.sum(v, (r) => r.n), (r) => r.m, (r) => r.t);
  const data = months.map((m) => {
    const o = { m };
    tiers.forEach((t) => (o[t] = (by.get(m) && by.get(m).get(t)) || 0));
    o.total = d3.sum(tiers, (t) => o[t]);
    return o;
  });
  const events = (DATA.events || []).filter((e) => inRange(e.date));
  legend("legend-volume", [
    ...tiers.map((t) => ({ label: TIER_NAME[t], color: tierColor(t) })),
    ...events.map((e) => ({ label: `${DATA.events.indexOf(e) + 1}. ${e.label} (${monthLabel(e.date)})`, color: "transparent" })),
  ]);
  const spec = { columns: ["Month", ...tiers.map((t) => TIER_NAME[t]), "Total"], rows: data.map((d) => [d.m, ...tiers.map((t) => d[t]), d.total]) };
  if (!d3.sum(data, (d) => d.total)) { empty(el); return spec; }

  const M = { t: 22, r: 8, b: 26, l: 44 };
  const H = 260;
  const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${width} ${H}`).attr("role", "img")
    .attr("aria-label", "Stacked bar chart of posts per month by tier");
  const x = d3.scaleBand(months, [M.l, width - M.r]).padding(months.length > 40 ? 0.12 : 0.25);
  const y = d3.scaleLinear([0, d3.max(data, (d) => d.total)], [H - M.b, M.t]).nice();
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${M.l},0)`)
    .call(d3.axisLeft(y).ticks(4).tickSize(-(width - M.l - M.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${M.l},0)`)
    .call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(6).tickFormat(d3.format("~s"))).call((g) => g.select(".domain").remove());
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - M.b})`)
    .call(d3.axisBottom(x).tickValues(monthTicks(months, width)).tickFormat((m) => tickFormat(m, months)).tickSizeOuter(0));

  const hover = svg.append("rect").attr("fill", C.wash).attr("y", M.t).attr("height", H - M.b - M.t).attr("width", x.step()).attr("opacity", 0);
  const stack = d3.stack().keys(tiers)(data);
  stack.forEach((layer, li) => {
    svg.append("g").selectAll("path").data(layer).join("path")
      .attr("fill", tierColor(layer.key))
      .attr("d", (d) => {
        const top = li === stack.length - 1 || d.data.total === d[1];
        const y0 = y(d[0]), y1 = y(d[1]);
        const gap = li > 0 && d[0] > 0 ? 2 : 0;
        const hgt = y0 - y1 - gap;
        return top ? roundedTop(x(d.data.m), y1, x.bandwidth(), hgt, 3) : (hgt > 0 ? `M${x(d.data.m)},${y1}h${x.bandwidth()}v${hgt}h${-x.bandwidth()}Z` : "");
      });
  });
  // events
  const ev = svg.append("g");
  events.forEach((e) => {
    const cx = x(e.date) + x.bandwidth() / 2;
    const idx = DATA.events.indexOf(e) + 1;
    ev.append("line").attr("x1", cx).attr("x2", cx).attr("y1", M.t - 6).attr("y2", H - M.b).attr("stroke", C.muted).attr("stroke-width", 1);
    const g = ev.append("g").attr("transform", `translate(${cx},${M.t - 12})`).attr("tabindex", 0).style("cursor", "default")
      .on("pointerenter focus", function (event) {
        const fn = (t) => { t.append(tipTitle(monthLabel(e.date)), h("div", null, e.label)); };
        event.type === "focus" ? focusTip(this, fn) : showTip(event, fn);
      }).on("pointerleave blur", hideTip);
    g.append("circle").attr("r", 12).attr("fill", "transparent");
    g.append("circle").attr("r", 7).attr("fill", C.surface).attr("stroke", C.muted);
    g.append("text").attr("text-anchor", "middle").attr("dy", "0.35em").style("font-size", "10px").style("fill", C.text2).text(idx);
  });
  // crosshair
  svg.append("rect").attr("x", M.l).attr("y", M.t).attr("width", width - M.l - M.r).attr("height", H - M.t - M.b)
    .attr("fill", "transparent").lower()
    .on("pointermove", (event) => {
      const [px] = d3.pointer(event);
      const i = Math.max(0, Math.min(months.length - 1, Math.floor((px - M.l) / x.step())));
      const d = data[i];
      hover.attr("x", x(d.m) - (x.step() - x.bandwidth()) / 2).attr("opacity", 1);
      showTip(event, (t) => {
        t.append(tipTitle(monthLabel(d.m)));
        tiers.slice().reverse().forEach((tr) => t.append(tipRow(fmtInt(d[tr]), TIER_NAME[tr], tierColor(tr))));
        if (tiers.length > 1) t.append(tipRow(fmtInt(d.total), "total"));
      });
    })
    .on("pointerleave", () => { hover.attr("opacity", 0); hideTip(); });
  svg.select("rect[fill='transparent']").raise();
  ev.raise();
  hover.lower();
  return spec;
};

// --------------------------------------------------------- 2. sentiment

RENDERERS.sentiment = (el, width) => {
  const months = activeMonths();
  const tiers = activeTiers();
  const rs = rows({ tier: true, topic: true });
  const by = d3.rollup(rs, (v) => ({ n: d3.sum(v, (r) => r.n), s: d3.sum(v, (r) => r.s) }), (r) => r.t, (r) => r.m);
  const series = tiers.map((t) => ({
    t,
    values: months.map((m) => {
      const a = by.get(t) && by.get(t).get(m);
      return { m, n: a ? a.n : 0, v: a && a.n >= 5 ? a.s / a.n : null };
    }),
  }));
  legend("legend-sentiment", tiers.map((t) => ({ label: TIER_NAME[t], color: tierColor(t), line: true })));
  const spec = {
    columns: ["Month", "Tier", "Posts", "Mean sentiment"],
    rows: series.flatMap((s) => s.values.filter((d) => d.v != null).map((d) => [d.m, TIER_NAME[s.t], d.n, d.v])),
  };
  const all = series.flatMap((s) => s.values.filter((d) => d.v != null).map((d) => d.v));
  if (!all.length) { empty(el); return spec; }

  const M = { t: 12, r: 120, b: 26, l: 44 };
  if (width < 520) M.r = 12;
  const H = 240;
  const ext = Math.max(0.1, d3.max(all, Math.abs) * 1.1);
  const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${width} ${H}`).attr("role", "img")
    .attr("aria-label", "Line chart of mean sentiment per month by tier");
  const x = d3.scalePoint(months, [M.l, width - M.r]).padding(0.5);
  const y = d3.scaleLinear([-ext, ext], [H - M.b, M.t]).nice();
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${M.l},0)`)
    .call(d3.axisLeft(y).ticks(4).tickSize(-(width - M.l - M.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${M.l},0)`)
    .call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(6).tickFormat(d3.format("+.2~f"))).call((g) => g.select(".domain").remove());
  svg.append("line").attr("x1", M.l).attr("x2", width - M.r).attr("y1", y(0)).attr("y2", y(0)).attr("stroke", C.axis);
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - M.b})`)
    .call(d3.axisBottom(x).tickValues(monthTicks(months, width)).tickFormat((m) => tickFormat(m, months)).tickSizeOuter(0))
    .call((g) => g.select(".domain").attr("stroke", C.axis));
  const line = d3.line().defined((d) => d.v != null).x((d) => x(d.m)).y((d) => y(d.v)).curve(d3.curveMonotoneX);
  series.forEach((s) => {
    svg.append("path").attr("fill", "none").attr("stroke", tierColor(s.t)).attr("stroke-width", 2)
      .attr("stroke-linejoin", "round").attr("d", line(s.values));
    const last = s.values.filter((d) => d.v != null).at(-1);
    if (last && width >= 520) {
      svg.append("text").attr("class", "label").attr("x", x(last.m) + 8).attr("y", y(last.v)).attr("dy", "0.35em")
        .text(TIER_NAME[s.t]);
    }
  });
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", M.t).attr("y2", H - M.b).attr("opacity", 0);
  const dots = svg.append("g");
  svg.append("rect").attr("x", M.l).attr("y", M.t).attr("width", width - M.l - M.r).attr("height", H - M.t - M.b)
    .attr("fill", "transparent")
    .on("pointermove", (event) => {
      const [px] = d3.pointer(event);
      const i = Math.max(0, Math.min(months.length - 1, Math.round((px - x(months[0])) / (x.step() || 1))));
      const m = months[i];
      cross.attr("x1", x(m)).attr("x2", x(m)).attr("opacity", 1);
      dots.selectAll("circle").data(series.map((s) => ({ t: s.t, d: s.values[i] })).filter((o) => o.d.v != null))
        .join("circle").attr("r", 4).attr("cx", x(m)).attr("cy", (o) => y(o.d.v))
        .attr("fill", (o) => tierColor(o.t)).attr("stroke", C.surface).attr("stroke-width", 2);
      showTip(event, (t) => {
        t.append(tipTitle(monthLabel(m)));
        series.forEach((s) => {
          const d = s.values[i];
          t.append(tipRow(d.v == null ? "–" : fmtSent(d.v), `${TIER_NAME[s.t]} · ${fmtInt(d.n)} posts`, tierColor(s.t)));
        });
      });
    })
    .on("pointerleave", () => { cross.attr("opacity", 0); dots.selectAll("circle").remove(); hideTip(); });
  return spec;
};

// --------------------------------------------------------- topic aggregates

function topicStats() {
  const rs = rows({ topic: false }).filter((r) => r.k >= 0);
  const by = d3.rollup(rs, (v) => ({
    n: d3.sum(v, (r) => r.n), s: d3.sum(v, (r) => r.s), pos: d3.sum(v, (r) => r.pos), neg: d3.sum(v, (r) => r.neg),
  }), (r) => r.k);
  return DATA.topics.map((t) => {
    const a = by.get(t.id) || { n: 0, s: 0, pos: 0, neg: 0 };
    return { ...t, cn: a.n, mean: a.n ? a.s / a.n : 0, pos: a.pos, neg: a.neg, neu: a.n - a.pos - a.neg };
  });
}
function selectTopic(k) {
  state.topic = state.topic !== "all" && Number(state.topic) === k ? "all" : String(k);
  document.getElementById("f-topic").value = state.topic;
  renderAll();
}

// -------------------------------------------------------------- 3. map

RENDERERS.map = (el, width) => {
  const ts = topicStats();
  sentimentLegend("legend-map");
  const spec = {
    columns: ["Topic", "Posts", "Mean sentiment", "% negative", "% neutral", "% positive"],
    rows: ts.slice().sort((a, b) => b.cn - a.cn).map((t) => [t.label, t.cn, t.mean,
      t.cn ? +(100 * t.neg / t.cn).toFixed(1) : 0, t.cn ? +(100 * t.neu / t.cn).toFixed(1) : 0, t.cn ? +(100 * t.pos / t.cn).toFixed(1) : 0]),
  };
  if (!d3.sum(ts, (t) => t.cn)) { empty(el); return spec; }
  const H = Math.min(420, Math.max(300, width * 0.8));
  const rMax = Math.min(42, width / 10);
  const pad = rMax + 8;
  const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${width} ${H}`).attr("role", "img")
    .attr("aria-label", "Bubble map of topics colored by mean sentiment");
  const x = d3.scaleLinear(d3.extent(ts, (t) => t.x), [pad, width - pad]);
  const y = d3.scaleLinear(d3.extent(ts, (t) => t.y), [H - pad, pad]);
  const r = d3.scaleSqrt([0, d3.max(ts, (t) => t.cn)], [0, rMax]);
  const color = sentScale(0.2);
  const sel = state.topic === "all" ? null : Number(state.topic);
  const nodes = ts.filter((t) => t.cn > 0).map((t) => ({ ...t, px: x(t.x), py: y(t.y), r: Math.max(4, r(t.cn)) }));
  // nudge overlapping bubbles apart
  const sim = d3.forceSimulation(nodes).force("x", d3.forceX((d) => x(d.x)).strength(0.3))
    .force("y", d3.forceY((d) => y(d.y)).strength(0.3)).force("c", d3.forceCollide((d) => d.r + 2)).stop();
  nodes.forEach((n) => { n.x0 = n.x; n.y0 = n.y; n.x = n.px; n.y = n.py; });
  for (let i = 0; i < 120; i++) sim.tick();
  nodes.forEach((n) => {
    n.cx = Math.max(n.r, Math.min(width - n.r, n.x)); n.cy = Math.max(n.r, Math.min(H - n.r, n.y));
  });
  const bigOnes = new Set(nodes.slice().sort((a, b) => b.cn - a.cn).slice(0, width < 500 ? 4 : 7).map((n) => n.id));
  const g = svg.append("g").selectAll("g").data(nodes.sort((a, b) => b.r - a.r)).join("g")
    .attr("transform", (d) => `translate(${d.cx},${d.cy})`).attr("tabindex", 0).style("cursor", "pointer")
    .attr("role", "button").attr("aria-label", (d) => `${d.label}: ${d.cn} posts, mean sentiment ${fmtSent(d.mean)}`)
    .attr("class", (d) => (sel != null && d.id !== sel ? "dim" : null))
    .on("click", (e, d) => selectTopic(d.id))
    .on("keydown", (e, d) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectTopic(d.id); } })
    .on("pointerenter pointermove focus", function (event, d) {
      const fn = (t) => {
        t.append(tipTitle(d.label), tipRow(fmtInt(d.cn), "posts"), tipRow(fmtSent(d.mean), "mean sentiment"),
          tipRow(fmtPct(d.cn ? d.neg / d.cn : 0), "negative", C.neg), tipRow(fmtPct(d.cn ? d.pos / d.cn : 0), "positive", C.pos));
      };
      event.type === "focus" ? focusTip(this, fn) : showTip(event, fn);
    })
    .on("pointerleave blur", hideTip);
  g.append("circle").attr("r", (d) => Math.max(12, d.r)).attr("fill", "transparent");
  g.append("circle").attr("r", (d) => d.r).attr("fill", (d) => color(d.mean))
    .attr("stroke", (d) => (d.id === sel ? C.text : C.axis)).attr("stroke-width", (d) => (d.id === sel ? 2 : 1));
  // Direct labels: selected topic first, then the largest, skipping any that would collide.
  const placed = [];
  const candidates = nodes.filter((d) => bigOnes.has(d.id) || d.id === sel)
    .sort((a, b) => (b.id === sel) - (a.id === sel) || b.cn - a.cn);
  candidates.forEach((d) => {
    const text = truncate(d.label, 26);
    const w = text.length * 6.4;
    let x0 = d.cx - w / 2;
    x0 = Math.max(2, Math.min(width - w - 2, x0));
    const box = { x0, x1: x0 + w, y0: d.cy + d.r + 2, y1: d.cy + d.r + 17 };
    if (box.y1 > H) { box.y0 = d.cy - d.r - 17; box.y1 = d.cy - d.r - 2; }
    if (placed.some((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0)) return;
    placed.push(box);
    svg.append("text").attr("class", "label" + (d.id === sel ? " strong" : "")).attr("x", box.x0).attr("y", box.y1 - 4)
      .attr("paint-order", "stroke").attr("stroke", C.surface).attr("stroke-width", 3).style("pointer-events", "none")
      .classed("dim", sel != null && d.id !== sel).text(text);
  });
  return spec;
};

// -------------------------------------------------- 4. sentiment by topic

RENDERERS.topicSentiment = (el, width) => {
  const ts = topicStats().filter((t) => t.cn > 0).sort((a, b) => (a.pos - a.neg) / a.cn - (b.pos - b.neg) / b.cn);
  legend("legend-ts", [{ label: "Negative", color: C.neg }, { label: "Neutral", color: C.neu }, { label: "Positive", color: C.pos }]);
  const spec = {
    columns: ["Topic", "Posts", "Negative", "Neutral", "Positive"],
    rows: ts.map((t) => [t.label, t.cn, t.neg, t.neu, t.pos]),
  };
  if (!ts.length) { empty(el); return spec; }
  const labelW = Math.min(190, width * 0.42);
  const rowH = 28;
  const M = { t: 4, r: 8, b: 22, l: labelW };
  const H = M.t + ts.length * rowH + M.b;
  const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${width} ${H}`).attr("role", "img")
    .attr("aria-label", "Stacked bars of sentiment share per topic");
  const x = d3.scaleLinear([0, 1], [M.l, width - M.r]);
  const y = d3.scaleBand(ts.map((t) => t.id), [M.t, H - M.b]).padding(0.25);
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - M.b})`)
    .call(d3.axisBottom(x).ticks(4).tickFormat(fmtPct).tickSizeOuter(0)).call((g) => g.select(".domain").remove());
  const sel = state.topic === "all" ? null : Number(state.topic);
  const parts = [["neg", "Negative", C.neg, "#ffffff"], ["neu", "Neutral", C.neu, C.text], ["pos", "Positive", C.pos, "#ffffff"]];
  ts.forEach((t) => {
    const g = svg.append("g").attr("class", sel != null && t.id !== sel ? "dim" : null).style("cursor", "pointer")
      .attr("tabindex", 0).attr("role", "button")
      .attr("aria-label", `${t.label}: ${fmtPct(t.neg / t.cn)} negative, ${fmtPct(t.pos / t.cn)} positive`)
      .on("click", () => selectTopic(t.id))
      .on("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectTopic(t.id); } });
    g.append("text").attr("class", "label" + (t.id === sel ? " strong" : "")).attr("x", M.l - 8).attr("y", y(t.id) + y.bandwidth() / 2)
      .attr("dy", "0.35em").attr("text-anchor", "end").text(truncate(t.label, Math.floor(labelW / 6.6)));
    let acc = 0;
    parts.forEach(([key, name, fill, ink], i) => {
      const share = t[key] / t.cn;
      const x0 = x(acc) + (i > 0 ? 1 : 0);
      const w = Math.max(0, x(acc + share) - x(acc) - (i > 0 ? 1 : 0) - (i < 2 ? 1 : 0));
      acc += share;
      const isLast = i === 2 || parts.slice(i + 1).every(([k]) => t[k] === 0);
      g.append("path").attr("fill", fill)
        .attr("d", isLast ? roundedRight(x0, y(t.id), w, y.bandwidth(), 3) : `M${x0},${y(t.id)}h${w}v${y.bandwidth()}h${-w}Z`)
        .on("pointerenter pointermove", (event) => showTip(event, (tt) => {
          tt.append(tipTitle(t.label), tipRow(fmtPct(share), `${name} · ${fmtInt(t[key])} of ${fmtInt(t.cn)} posts`, fill));
        }))
        .on("pointerleave", hideTip);
      if (key !== "neu" && w >= 36) {
        g.append("text").attr("x", x0 + w / 2).attr("y", y(t.id) + y.bandwidth() / 2).attr("dy", "0.35em")
          .attr("text-anchor", "middle").style("fill", ink).style("font-size", "11px").style("pointer-events", "none")
          .text(fmtPct(share));
      }
    });
  });
  return spec;
};

// --------------------------------------------------- 5. small multiples

RENDERERS.multiples = (el, width) => {
  const months = activeMonths();
  const rs = rows({ topic: false });
  const totals = d3.rollup(rs, (v) => d3.sum(v, (r) => r.n), (r) => r.m);
  const byTopic = d3.rollup(rs.filter((r) => r.k >= 0), (v) => d3.sum(v, (r) => r.n), (r) => r.k, (r) => r.m);
  const panels = DATA.topics.map((t) => ({
    t,
    total: d3.sum(months, (m) => (byTopic.get(t.id) && byTopic.get(t.id).get(m)) || 0),
    values: months.map((m) => {
      const n = (byTopic.get(t.id) && byTopic.get(t.id).get(m)) || 0;
      const tot = totals.get(m) || 0;
      return { m, n, tot, v: tot >= 5 ? n / tot : null };
    }),
  }));
  const spec = {
    columns: ["Topic", "Month", "Posts", "Share of month"],
    rows: panels.flatMap((p) => p.values.filter((d) => d.v != null && d.n > 0).map((d) => [p.t.label, d.m, d.n, d.v])),
  };
  if (!d3.sum(panels, (p) => p.total)) { empty(el); return spec; }
  const cols = width > 960 ? 4 : width > 620 ? 3 : width > 380 ? 2 : 1;
  const gap = 18;
  const pw = (width - gap * (cols - 1)) / cols;
  const ph = 108;
  const M = { t: 30, r: 6, b: 16, l: 34 };
  const rowsN = Math.ceil(panels.length / cols);
  const H = rowsN * (ph + gap);
  const ymax = d3.max(panels, (p) => d3.max(p.values, (d) => d.v || 0)) || 0.1;
  const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${width} ${H}`).attr("role", "img")
    .attr("aria-label", "Small multiples of topic share over time");
  const x = d3.scalePoint(months, [M.l, pw - M.r]);
  const y = d3.scaleLinear([0, ymax], [ph - M.b, M.t]).nice();
  const sel = state.topic === "all" ? null : Number(state.topic);
  const crosses = [];
  panels.forEach((p, i) => {
    const g = svg.append("g").attr("transform", `translate(${(i % cols) * (pw + gap)},${Math.floor(i / cols) * (ph + gap)})`)
      .attr("class", sel != null && p.t.id !== sel ? "dim" : null);
    g.append("text").attr("class", "label" + (p.t.id === sel ? " strong" : "")).attr("x", 0).attr("y", 12)
      .text(truncate(p.t.label, Math.floor(pw / 6.8)));
    g.append("text").attr("x", 0).attr("y", 25).text(`${fmtInt(p.total)} posts`);
    g.append("g").attr("class", "gridline").attr("transform", `translate(${M.l},0)`)
      .call(d3.axisLeft(y).ticks(2).tickSize(-(pw - M.l - M.r)).tickFormat(""));
    g.append("g").attr("class", "axis").attr("transform", `translate(${M.l},0)`)
      .call(d3.axisLeft(y).ticks(2).tickSize(0).tickPadding(4).tickFormat(d3.format(".0%"))).call((a) => a.select(".domain").remove());
    g.append("line").attr("x1", M.l).attr("x2", pw - M.r).attr("y1", y(0)).attr("y2", y(0)).attr("stroke", C.axis);
    const area = d3.area().defined((d) => d.v != null).x((d) => x(d.m)).y0(y(0)).y1((d) => y(d.v)).curve(d3.curveMonotoneX);
    const line = area.lineY1();
    g.append("path").attr("fill", C.accent).attr("fill-opacity", 0.16).attr("d", area(p.values));
    g.append("path").attr("fill", "none").attr("stroke", C.accent).attr("stroke-width", 2).attr("d", line(p.values));
    const first = months[0], last = months.at(-1);
    g.append("text").attr("x", M.l).attr("y", ph - 3).text(tickFormat(first, [])).style("font-size", "10px");
    g.append("text").attr("x", pw - M.r).attr("y", ph - 3).attr("text-anchor", "end").text(tickFormat(last, [])).style("font-size", "10px");
    const cross = g.append("line").attr("class", "crosshair").attr("y1", M.t).attr("y2", ph - M.b).attr("opacity", 0);
    const dot = g.append("circle").attr("r", 4).attr("fill", C.accent).attr("stroke", C.surface).attr("stroke-width", 2).attr("opacity", 0);
    crosses.push({ cross, dot, p });
    g.append("rect").attr("x", M.l).attr("y", 0).attr("width", pw - M.l - M.r).attr("height", ph).attr("fill", "transparent")
      .style("cursor", "pointer")
      .on("click", () => selectTopic(p.t.id))
      .on("pointermove", (event) => {
        const [px] = d3.pointer(event);
        const idx = Math.max(0, Math.min(months.length - 1, Math.round((px - M.l) / (x.step() || 1))));
        const m = months[idx];
        crosses.forEach((c) => {
          const d = c.p.values[idx];
          c.cross.attr("x1", x(m)).attr("x2", x(m)).attr("opacity", 1);
          c.dot.attr("cx", x(m)).attr("cy", d.v == null ? 0 : y(d.v)).attr("opacity", d.v == null ? 0 : 1);
        });
        const d = p.values[idx];
        showTip(event, (t) => {
          t.append(tipTitle(`${p.t.label} · ${monthLabel(m)}`),
            tipRow(d.v == null ? "–" : fmtPct(d.v), "of the month's posts", C.accent),
            tipRow(fmtInt(d.n), `of ${fmtInt(d.tot)} posts`));
        });
      })
      .on("pointerleave", () => { crosses.forEach((c) => { c.cross.attr("opacity", 0); c.dot.attr("opacity", 0); }); hideTip(); });
  });
  return spec;
};

// ------------------------------------------------------- 6. histogram

RENDERERS.histogram = (el, width) => {
  const hs = DATA.histogram.filter((r) => inRange(r.m) && tierOk(r.t) && topicOk(r.k));
  const by = d3.rollup(hs, (v) => d3.sum(v, (r) => r.n), (r) => r.b);
  const bins = d3.range(10).map((b) => ({ b, lo: -1 + b * 0.2, hi: -1 + (b + 1) * 0.2, n: by.get(b) || 0 }));
  const spec = { columns: ["Sentiment from", "to", "Posts"], rows: bins.map((d) => [d.lo, d.hi, d.n]) };
  if (!d3.sum(bins, (d) => d.n)) { empty(el); return spec; }
  const M = { t: 10, r: 8, b: 34, l: 44 };
  const H = 240;
  const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${width} ${H}`).attr("role", "img")
    .attr("aria-label", "Histogram of post sentiment scores");
  const x = d3.scaleLinear([-1, 1], [M.l, width - M.r]);
  const y = d3.scaleLinear([0, d3.max(bins, (d) => d.n)], [H - M.b, M.t]).nice();
  const color = sentScale(0.8);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${M.l},0)`)
    .call(d3.axisLeft(y).ticks(4).tickSize(-(width - M.l - M.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${M.l},0)`)
    .call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(6).tickFormat(d3.format("~s"))).call((g) => g.select(".domain").remove());
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - M.b})`)
    .call(d3.axisBottom(x).tickValues([-1, -0.5, 0, 0.5, 1]).tickFormat(d3.format("+.1~f")).tickSizeOuter(0));
  svg.append("text").attr("x", M.l).attr("y", H - 4).text("← negative");
  svg.append("text").attr("x", width - M.r).attr("y", H - 4).attr("text-anchor", "end").text("positive →");
  svg.append("g").selectAll("g").data(bins).join("g").each(function (d) {
    const g = d3.select(this);
    const x0 = x(d.lo) + 1, w = x(d.hi) - x(d.lo) - 2;
    g.append("path").attr("fill", color((d.lo + d.hi) / 2)).attr("stroke", C.axis).attr("stroke-width", 0.5)
      .attr("d", roundedTop(x0, y(d.n), w, y(0) - y(d.n), 4));
    g.append("rect").attr("x", x0).attr("width", w).attr("y", M.t).attr("height", H - M.b - M.t).attr("fill", "transparent")
      .on("pointerenter pointermove", (event) => showTip(event, (t) => {
        t.append(tipTitle(`Sentiment ${d3.format("+.1f")(d.lo)} to ${d3.format("+.1f")(d.hi)}`), tipRow(fmtInt(d.n), "posts"));
      }))
      .on("pointerleave", hideTip);
  });
  return spec;
};

// ----------------------------------------------------------- 7. detail

RENDERERS.detail = (el, width) => {
  let t;
  let note = "";
  if (state.topic === "all") {
    const ts = topicStats().sort((a, b) => b.cn - a.cn);
    t = ts[0] || DATA.topics[0];
    note = "Largest topic in the current selection. Click a topic to change it. ";
  } else {
    t = DATA.topics[Number(state.topic)];
  }
  document.getElementById("detail-title").textContent = `Topic: ${t.label}`;
  document.getElementById("detail-sub").textContent =
    `${note}Top terms by weight in the topic model, then example excerpts${t.label !== t.auto_label ? ` (terms: ${t.auto_label})` : ""}.`;
  const terms = t.terms.slice(0, 12);
  const spec = { columns: ["Term", "Weight"], rows: terms.map((d) => [d.term, d.weight]) };

  const labelW = Math.min(150, width * 0.38);
  const rowH = 22;
  const M = { t: 4, r: 12, b: 4, l: labelW };
  const H = M.t + terms.length * rowH + M.b;
  const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${width} ${H}`).attr("role", "img")
    .attr("aria-label", `Top terms for topic ${t.label}`);
  const x = d3.scaleLinear([0, d3.max(terms, (d) => d.weight)], [M.l, width - M.r]);
  const y = d3.scaleBand(terms.map((d) => d.term), [M.t, H - M.b]).padding(0.28);
  terms.forEach((d) => {
    svg.append("text").attr("class", "label").attr("x", M.l - 8).attr("y", y(d.term) + y.bandwidth() / 2).attr("dy", "0.35em")
      .attr("text-anchor", "end").text(truncate(d.term, Math.floor(labelW / 6.6)));
    svg.append("path").attr("fill", C.accent).attr("d", roundedRight(M.l, y(d.term), x(d.weight) - M.l, y.bandwidth(), 4));
    svg.append("rect").attr("x", 0).attr("width", width).attr("y", y(d.term) - 2).attr("height", y.bandwidth() + 4).attr("fill", "transparent")
      .on("pointerenter pointermove", (event) => showTip(event, (tt) => { tt.append(tipTitle(d.term), tipRow(d.weight.toFixed(3), "weight", C.accent)); }))
      .on("pointerleave", hideTip);
  });

  // examples
  let ex = t.examples.filter((e) => inRange(e.month) && tierOk(e.tier));
  const ul = document.getElementById("examples");
  const items = [];
  if (!ex.length && t.examples.length) {
    items.push(Object.assign(h("li", null, "No examples in this selection; showing all."), { style: "border:0;color:var(--muted)" }));
    ex = t.examples;
  }
  ex.slice(0, 5).forEach((e) => {
    const li = h("li", e.sent >= DATA.meta.params.neutral_band ? "pos" : e.sent <= -DATA.meta.params.neutral_band ? "neg" : null);
    li.append(document.createTextNode(`“${e.text}”`));
    li.append(h("span", "meta", `${e.author} · ${monthLabel(e.month)} · ${TIER_NAME[e.tier]} · sentiment ${fmtSent(e.sent)}`));
    items.push(li);
  });
  ul.replaceChildren(...items);
  return spec;
};

// ----------------------------------------------------------- 8. thread

RENDERERS.thread = (el, width) => {
  const thread = DATA.threads[state.thread];
  sentimentLegend("legend-thread");
  if (!thread) { empty(el, "No threads exported."); return { columns: [], rows: [] }; }
  const root = d3.hierarchy(thread, (d) => d.c);
  const spec = { columns: ["Depth", "Author", "Month", "Sentiment", "Topic", "Excerpt"], rows: [] };
  root.eachBefore((n) => spec.rows.push([n.depth, n.data.a, n.data.m, n.data.s, n.depth ? topicLabel(n.data.k) : "(story)",
    (n.depth ? "  ".repeat(n.depth - 1) : "") + (n.depth ? n.data.x : thread.title || "")]));

  const H = el.clientHeight || 560;
  const R = Math.min(width, H) / 2 - 24;
  const tree = d3.tree().size([2 * Math.PI, R]).separation((a, b) => (a.parent === b.parent ? 1 : 2) / Math.max(1, a.depth));
  tree(root);
  const color = sentScale(0.5);
  const svg = d3.select(el).append("svg").attr("viewBox", `${-width / 2} ${-H / 2} ${width} ${H}`).attr("role", "img")
    .attr("aria-label", `Reply tree for ${thread.title || "thread"} with ${root.descendants().length - 1} comments`);
  const g = svg.append("g");
  svg.call(d3.zoom().scaleExtent([0.5, 8]).on("zoom", (e) => g.attr("transform", e.transform)));
  g.append("g").attr("fill", "none").attr("stroke", C.axis).attr("stroke-width", 1)
    .selectAll("path").data(root.links()).join("path")
    .attr("d", d3.linkRadial().angle((d) => d.x).radius((d) => d.y));
  g.append("g").selectAll("circle").data(root.descendants()).join("circle")
    .attr("transform", (d) => `rotate(${(d.x * 180) / Math.PI - 90}) translate(${d.y},0)`)
    .attr("r", (d) => (d.depth === 0 ? 8 : 4.5))
    .attr("fill", (d) => (d.depth === 0 ? C.text : color(d.data.s)))
    .attr("stroke", C.surface).attr("stroke-width", 1.5)
    .on("pointerenter pointermove", (event, d) => showTip(event, (t) => {
      if (d.depth === 0) {
        t.append(tipTitle(`Story · ${monthLabel(d.data.m)} · ${TIER_NAME[thread.tier]}`), h("div", null, thread.title || ""),
          tipRow(fmtInt(root.descendants().length - 1), "comments shown"));
        return;
      }
      t.append(tipTitle(`${d.data.a} · ${monthLabel(d.data.m)} · depth ${d.depth}`),
        tipRow(fmtSent(d.data.s), "sentiment", color(d.data.s)),
        tipRow(topicLabel(d.data.k), "topic"));
      if (d.data.x) t.append(h("div", "tt-text", `“${d.data.x}”`));
    }))
    .on("pointerleave", hideTip);
  return spec;
};

// ------------------------------------------------------------- controls

function setupControls() {
  const from = document.getElementById("f-from");
  const to = document.getElementById("f-to");
  [from, to].forEach((sel) => sel.replaceChildren(...MONTHS.map((m) => {
    const o = h("option", null, monthLabel(m)); o.value = m; return o;
  })));
  from.value = state.from; to.value = state.to;
  from.addEventListener("change", () => { state.from = from.value; if (state.from > state.to) { state.to = state.from; to.value = state.to; } renderAll(); });
  to.addEventListener("change", () => { state.to = to.value; if (state.to < state.from) { state.from = state.to; from.value = state.from; } renderAll(); });

  document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
    state.tier = b.dataset.tier;
    document.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    renderAll();
  }));

  const topic = document.getElementById("f-topic");
  const all = h("option", null, "All topics"); all.value = "all";
  topic.replaceChildren(all, ...DATA.topics.map((t) => { const o = h("option", null, t.label); o.value = String(t.id); return o; }));
  topic.addEventListener("change", () => { state.topic = topic.value; renderAll(); });

  document.getElementById("f-reset").addEventListener("click", () => {
    state.from = MONTHS[0]; state.to = MONTHS.at(-1); state.tier = "all"; state.topic = "all";
    from.value = state.from; to.value = state.to; topic.value = "all";
    document.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-checked", String(x.dataset.tier === "all")));
    renderAll();
  });

  const ts = document.getElementById("thread-select");
  ts.replaceChildren(...DATA.threads.map((t, i) => {
    const o = h("option", null, `${t.tier === "A" ? "[Games] " : "[Gen-AI] "}${truncate(t.title || "(untitled)", 80)} · ${t.size - 1} comments`);
    o.value = String(i); return o;
  }));
  ts.addEventListener("change", () => { state.thread = Number(ts.value); renderCard("thread"); });

  document.querySelectorAll(".card").forEach((card) => {
    const name = card.dataset.chart;
    const b = h("button", "btn table-toggle", "Table");
    b.type = "button";
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => {
      tableMode[name] = !tableMode[name];
      b.textContent = tableMode[name] ? "Chart" : "Table";
      b.setAttribute("aria-pressed", String(!!tableMode[name]));
      renderCard(name);
    });
    card.append(b);
  });

  document.getElementById("theme-toggle").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("dr-theme", next); } catch (e) { /* storage unavailable */ }
    readColors(); renderAll();
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { readColors(); renderAll(); });

  let raf = null;
  let lastW = 0;
  new ResizeObserver(() => {
    const w = document.querySelector(".grid").clientWidth;
    if (w === lastW) return;
    lastW = w;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(renderAll);
  }).observe(document.querySelector(".grid"));
}

function fillMethods() {
  const m = DATA.meta;
  const c = m.collection || {};
  if (c.since) {
    document.getElementById("m-data").textContent =
      `Collected ${c.collected_at ? c.collected_at.slice(0, 10) : ""} from the Algolia HN Search API, covering ${c.since} to ${c.until}. ` +
      `${fmtInt(c.threads_expanded || 0)} full comment trees were downloaded; ${fmtInt(m.counts.posts)} of ${fmtInt(c.posts || 0)} posts ` +
      `matched the corpus definition (${fmtInt(m.counts.by_tier.A || 0)} AI imagery in games, ${fmtInt(m.counts.by_tier.B || 0)} gen-AI debate).`;
  }
  document.getElementById("m-models").textContent =
    `${m.params.vectorizer}; ${m.params.topic_model} with k = ${m.params.k} topics on ${fmtInt(m.counts.modeled)} posts of at least ` +
    `${m.params.min_words} words. Sentiment: ${m.params.sentiment}; |score| < ${m.params.neutral_band} counts as neutral. ` +
    `Topic labels are the top three terms unless a researcher has named them. Sentiment is a proxy for tone, not for stance: ` +
    `a post can sound negative while supporting AI art.`;
  document.getElementById("m-foot").textContent = `Analysis generated ${m.generated_at}. Excerpts are capped at ${m.params.excerpt_words} words.`;
}

async function main() {
  const names = ["meta", "topics", "timeline", "histogram", "threads", "events"];
  const loaded = await Promise.all(names.map((n) => fetch(`data/${n}.json`).then((r) => {
    if (!r.ok) throw new Error(`data/${n}.json: ${r.status}`);
    return r.json();
  })));
  names.forEach((n, i) => (DATA[n] = loaded[i]));
  MONTHS = monthRange(DATA.meta.months[0], DATA.meta.months.at(-1));
  state.from = MONTHS[0];
  state.to = MONTHS.at(-1);
  readColors();
  setupControls();
  fillMethods();
  renderAll();
}

main().catch((err) => {
  document.querySelector("main").replaceChildren(h("div", "empty", `Could not load dashboard data: ${err.message}. Run analyze.py first.`));
  console.error(err);
});
