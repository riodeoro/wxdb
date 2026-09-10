import {
  ALL_SENSOR_COLS,
  COL_FALLBACK,
  loadStationConfig,
  fireCentres,
  enabledStations,
  fcUrlsFor,
  stationUrlsFor,
  xLabel,
} from "./data.js";
import { YEAR_MIN } from "./config.js";
import { qTable, pack, num, str, lit, ident } from "./duck.js";

const LIMIT = 1000;
const EPS = 0.0005;
const SHOW_COLS = ["Temp", "Rh", "Wspd", "Dir", "Mx_Spd", "Rn_1"];
const OPS = [
  ["=", "="],
  ["!=", "\u2260"],
  [">", ">"],
  [">=", "\u2265"],
  ["<", "<"],
  ["<=", "\u2264"],
];

const el = (id) => document.getElementById(id);

let config = [];
let running = false;

function option(value, label) {
  const o = document.createElement("option");
  o.value = String(value);
  o.textContent = label;
  return o;
}

function fmtTs(ms) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const p = (v) => String(v).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  );
}

function fmtNum(v) {
  return Number.isFinite(v) ? String(Number(v.toFixed(2))) : "";
}

function setStatus(text) {
  el("tr-s-status").textContent = text || "";
}

function syncRemove() {
  const rows = el("tr-s-conds").children;
  for (const r of rows) r.querySelector("button").disabled = rows.length < 2;
}

function addCond(col) {
  const row = document.createElement("div");
  row.className = "tr-s-cond";
  const attr = document.createElement("select");
  attr.setAttribute("aria-label", "Attribute");
  for (const c of ALL_SENSOR_COLS) attr.appendChild(option(c, xLabel(c)));
  attr.value = col;
  const op = document.createElement("select");
  op.setAttribute("aria-label", "Comparison");
  for (const [v, l] of OPS) op.appendChild(option(v, l));
  const val = document.createElement("input");
  val.type = "text";
  val.placeholder = "Value";
  val.autocomplete = "off";
  val.spellcheck = false;
  val.setAttribute("aria-label", "Value");
  val.addEventListener("input", () => val.classList.remove("bad"));
  val.addEventListener("keydown", (e) => {
    if (e.key === "Enter") run();
  });
  const rm = document.createElement("button");
  rm.type = "button";
  rm.textContent = "\u00d7";
  rm.setAttribute("aria-label", "Remove condition");
  rm.addEventListener("click", () => {
    row.remove();
    syncRemove();
  });
  row.append(attr, op, val, rm);
  el("tr-s-conds").appendChild(row);
  syncRemove();
  return val;
}

function readConds() {
  const out = [];
  let ok = true;
  for (const row of el("tr-s-conds").children) {
    const [attr, op, val] = row.querySelectorAll("select, input");
    const s = val.value.trim();
    if (!s) continue;
    const v = Number(s);
    if (!Number.isFinite(v)) {
      val.classList.add("bad");
      ok = false;
      continue;
    }
    out.push({ col: attr.value, op: op.value, value: v });
  }
  if (!ok) {
    setStatus("Values must be numbers.");
    return null;
  }
  if (!out.length) {
    setStatus("Enter a value for at least one condition.");
    return null;
  }
  return out;
}

function colExpr(cols, col) {
  const names = [col]
    .concat(COL_FALLBACK[col] || [])
    .filter((n) => cols.has(n))
    .map(ident);
  if (!names.length) return null;
  return names.length === 1 ? names[0] : `COALESCE(${names.join(", ")})`;
}

function condSql(e, op, v) {
  if (op === "=") return `(${e} BETWEEN ${v - EPS} AND ${v + EPS})`;
  if (op === "!=") return `(${e} NOT BETWEEN ${v - EPS} AND ${v + EPS})`;
  if (op === ">") return `(${e} > ${v + EPS})`;
  if (op === ">=") return `(${e} >= ${v - EPS})`;
  if (op === "<") return `(${e} < ${v - EPS})`;
  return `(${e} <= ${v + EPS})`;
}

async function searchFc(fc, years, conds, want, limit) {
  const stations = enabledStations(config, fc);
  let urls = await fcUrlsFor(fc, years);
  if (!urls.length && stations.length)
    urls = await stationUrlsFor(stations, years);
  if (!urls.length) return null;
  const src = `read_parquet([${urls.map(lit).join(", ")}], union_by_name = true)`;
  const desc = pack(await qTable(`DESCRIBE SELECT * FROM ${src}`));
  const cols = new Set(str(desc, "column_name"));
  if (!cols.has("STATION_NAME") || !cols.has("DATE_TIME_PARSED")) return null;
  const where = [];
  if (stations.length)
    where.push(`"STATION_NAME" IN (${stations.map(lit).join(", ")})`);
  for (const c of conds) {
    const e = colExpr(cols, c.col);
    if (!e) return { rows: [], total: 0 };
    where.push(condSql(e, c.op, c.value));
  }
  const shown = want.filter((c) => colExpr(cols, c));
  const sel = [
    'CAST("STATION_NAME" AS VARCHAR) AS station',
    'CAST(epoch_ms(CAST("DATE_TIME_PARSED" AS TIMESTAMP)) AS DOUBLE) AS t_ms',
  ]
    .concat(shown.map((c) => `CAST(${colExpr(cols, c)} AS DOUBLE) AS ${ident(c)}`))
    .concat(["count(*) OVER () AS _total"]);
  const sql =
    `SELECT ${sel.join(", ")} FROM ${src} WHERE ${where.join(" AND ")} ` +
    `ORDER BY t_ms LIMIT ${Math.max(1, Math.floor(limit))}`;
  const res = pack(await qTable(sql));
  const names = str(res, "station");
  const t = num(res, "t_ms");
  const vals = {};
  for (const c of shown) vals[c] = num(res, c);
  const rows = [];
  for (let i = 0; i < res.n; i++) {
    const r = { fc, station: names[i], t: t[i] };
    for (const c of shown) r[c] = vals[c][i];
    rows.push(r);
  }
  const total = res.n ? Number(res.cols._total[0]) : 0;
  return { rows, total };
}

function render(rows, want) {
  const table = el("tr-s-table");
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");
  thead.innerHTML = "";
  tbody.innerHTML = "";
  if (!rows.length) return;
  const cols = want.filter((c) => rows.some((r) => Number.isFinite(r[c])));
  const head = document.createElement("tr");
  const heads = [
    ["Fire centre", true],
    ["Station", true],
    ["Time", true],
  ].concat(cols.map((c) => [xLabel(c), false]));
  for (const [name, left] of heads) {
    const th = document.createElement("th");
    if (left) th.className = "tleft";
    th.textContent = name;
    head.appendChild(th);
  }
  thead.appendChild(head);
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const tr = document.createElement("tr");
    const cells = [
      [r.fc, true],
      [r.station, true],
      [fmtTs(r.t), true],
    ].concat(cols.map((c) => [fmtNum(r[c]), false]));
    for (const [text, left] of cells) {
      const td = document.createElement("td");
      if (left) td.className = "tleft";
      td.textContent = text;
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

async function run() {
  if (running || !config.length) return;
  const conds = readConds();
  if (!conds) return;
  const a = Number(el("tr-s-from").value);
  const b = Number(el("tr-s-to").value);
  const years = [];
  for (let y = Math.min(a, b); y <= Math.max(a, b); y++) years.push(y);
  const picked = el("tr-s-fc").value;
  const fcs = picked ? [picked] : fireCentres(config);
  const want = conds.map((c) => c.col);
  for (const c of SHOW_COLS) if (!want.includes(c)) want.push(c);

  running = true;
  el("tr-s-run").disabled = true;
  el("tr-spin-search").classList.add("on");
  const rows = [];
  const failed = [];
  let total = 0;
  render(rows, want);
  try {
    for (let i = 0; i < fcs.length; i++) {
      setStatus(`Searching ${fcs[i]} (${i + 1} of ${fcs.length})\u2026`);
      try {
        const res = await searchFc(fcs[i], years, conds, want, LIMIT - rows.length);
        if (!res) continue;
        total += res.total;
        for (const r of res.rows) if (rows.length < LIMIT) rows.push(r);
        render(rows, want);
      } catch (e) {
        failed.push(fcs[i]);
      }
    }
  } finally {
    running = false;
    el("tr-s-run").disabled = false;
    el("tr-spin-search").classList.remove("on");
  }

  let msg = total
    ? `${total.toLocaleString("en-US")} matching hour${total === 1 ? "" : "s"}`
    : "No matching hours";
  if (total > rows.length)
    msg += `, showing the first ${rows.length.toLocaleString("en-US")}`;
  msg += failed.length ? `. Could not search ${failed.join(", ")}.` : ".";
  setStatus(msg);
}

async function init() {
  const now = new Date().getUTCFullYear();
  for (const id of ["tr-s-from", "tr-s-to"]) {
    const s = el(id);
    for (let y = now; y >= YEAR_MIN; y--) s.appendChild(option(y, String(y)));
    s.value = String(now);
  }
  addCond("Temp");
  el("tr-s-add").addEventListener("click", () => {
    const used = Array.from(el("tr-s-conds").children, (r) => r.firstChild.value);
    const next = SHOW_COLS.find((c) => !used.includes(c)) || "Temp";
    addCond(next).focus();
  });
  el("tr-s-run").addEventListener("click", run);
  try {
    config = await loadStationConfig();
    for (const f of fireCentres(config)) el("tr-s-fc").appendChild(option(f, f));
    el("tr-s-run").disabled = false;
  } catch (e) {
    setStatus("Could not load the station configuration.");
  }
}

init();
