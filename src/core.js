'use strict';

/*
 * Table Studio
 * 像 Notion 一样调整 Obsidian 的 Markdown 表格：
 *  - 拖动列边框调整列宽（双击适应内容），宽度按表格记住
 *  - 标题行 / 标题列高亮、表格样式（极简 / 三线表 / 斑马纹）
 *  - 行距与垂直对齐（只作用于调整过的表格）、冻结标题行 / 首列
 *  - 列 / 行 / 整表的文字对齐、行 / 列背景色、按列换行
 *  - 行列互换（转置）、复制为 CSV / TSV / HTML / LaTeX
 *  - 10 种界面语言
 *
 * 设计要点：
 *  - 列对齐和转置是标准 Markdown，直接改写源码；其余设置存在插件 data.json 里，不写进笔记。
 *  - 每个表格用「文件路径 + 表头内容 + 同表头出现次数」识别；改表头、增删 / 移动列时
 *    会按列名把设置对应过去。
 *  - 不往表格里插入 DOM 节点，只改 class / inline style / data 属性；
 *    按列的样式通过 data 属性里的列号 token 配合 CSS 选择器实现。
 *    指示线、⋯ 按钮、浮动工具条都是挂在 body 上的浮层。
 */

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, MarkdownView, Menu, Notice, TFile, setIcon } = obsidian;

const DEFAULT_SETTINGS = {
  language: 'auto',
  enableReading: true,
  enableLivePreview: true,
  minWidth: 48,
  defaultWidth: 160,
  maxAutoWidth: 480,
  wrap: true,
  headerRow: true,
  headerColDefault: false,
  style: 'default',
  density: 'c',
  valign: 'middle',
};

const DENSITIES = ['d', 'c', 's'];
const ALIGNS = ['left', 'center', 'right'];
const STYLES = ['default', 'minimal', 'three', 'zebra'];
const STYLE_KEYS = { default: 'stDefault', minimal: 'stMinimal', three: 'stThree', zebra: 'stZebra' };
const COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];
const MAX_COLS = 32; // 按列的样式（换行 / 颜色）最多支持的列数

/*__LOCALES__*/

let LANG_SETTING = 'auto';

function mapLang(l) {
  l = (l || '').toLowerCase();
  if (/^zh[-_](tw|hk|mo|hant)/.test(l)) return 'zh-TW';
  if (l.startsWith('zh')) return 'zh';
  if (l.startsWith('pt')) return 'pt-BR';
  const two = l.slice(0, 2);
  return STRINGS[two] ? two : 'en';
}

function uiLang() {
  if (LANG_SETTING && LANG_SETTING !== 'auto' && STRINGS[LANG_SETTING]) return LANG_SETTING;
  let lang = '';
  try {
    lang = (typeof obsidian.getLanguage === 'function' ? obsidian.getLanguage() : '')
      || window.localStorage.getItem('language') || '';
  } catch (e) { lang = ''; }
  return mapLang(lang);
}

function t(key, vars) {
  const table = STRINGS[uiLang()] || STRINGS.en;
  let s = table[key] || STRINGS.en[key] || key;
  if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
  return s;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const colorName = (c) => t('c' + cap(c));

const HIT_ZONE = 5;
const DBL_CLICK_MS = 400;
const SEL_CELL = ':is(td,th):is(.is-selected,.is-highlighted,.selected,[aria-selected="true"]),'
  + ':is(td,th):has(> .table-cell-wrapper:is(.is-selected,.is-highlighted))';

/* ====================================================================== */
/* 纯函数：解析与改写 Markdown 表格                                         */
/* ====================================================================== */

const QUOTE_RE = /^(?:[ \t]*>)+[ \t]?/;
function stripQuote(line) { return line.replace(QUOTE_RE, ''); }

const SEP_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
function isSeparator(s) { return s.indexOf('|') !== -1 && SEP_RE.test(s); }

function splitRow(s) {
  s = s.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function normName(s) { return s.trim().replace(/\s+/g, ' ').toLowerCase(); }
function looseText(s) { return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); }
function rowKey(cells) { return cells.map(normName).join('|'); }

function mdToPlain(s) {
  return s
    .replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/!?\[\[([^\]]*)\]\]/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '');
}

function sepAlign(c) {
  const l = c.startsWith(':');
  const r = c.endsWith(':');
  if (l && r) return 'center';
  if (r) return 'right';
  if (l) return 'left';
  return null;
}

function parseTables(text) {
  const lines = text.split(/\r?\n/);
  const tables = [];
  let i = 0;
  if (lines[0] === '---') {
    for (let j = 1; j < lines.length; j++) {
      if (lines[j] === '---' || lines[j] === '...') { i = j + 1; break; }
    }
  }
  let fence = null;
  for (; i < lines.length; i++) {
    const l = stripQuote(lines[i]);
    if (fence) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(l);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = /^\s*(`{3,}|~{3,})/.exec(l);
    if (open) { fence = open[1]; continue; }
    if (l.indexOf('|') === -1 || i + 1 >= lines.length) continue;
    const sep = stripQuote(lines[i + 1]);
    if (!isSeparator(sep)) continue;
    const header = splitRow(l);
    const sepCells = splitRow(sep);
    if (header.length !== sepCells.length) continue;
    let end = i + 1;
    while (end + 1 < lines.length) {
      const n = stripQuote(lines[end + 1]);
      if (!n.trim() || n.indexOf('|') === -1) break;
      end++;
    }
    const rows = [];
    for (let k = i + 2; k <= end; k++) rows.push(splitRow(stripQuote(lines[k])));
    tables.push({ start: i, end, header, cols: header.length, rows, aligns: sepCells.map(sepAlign) });
    i = end;
  }
  const seen = new Map();
  tables.forEach((tb, ord) => {
    tb.ord = ord;
    tb.names = tb.header.map(normName);
    tb.sig = tb.names.join('|');
    tb.loose = tb.header.map((h) => looseText(mdToPlain(h))).join('|');
    const n = seen.get(tb.sig) || 0;
    tb.occ = n;
    seen.set(tb.sig, n + 1);
  });
  tables.forEach((tb) => { tb.dups = seen.get(tb.sig); });
  return tables;
}

function tableRowKeys(tb) {
  return ['#header'].concat(tb.rows.map(rowKey));
}

function findTableAtLine(tables, line, slack) {
  let tb = tables.find((x) => line >= x.start && line <= x.end);
  if (!tb && slack) tb = tables.find((x) => line >= x.start - slack && line <= x.end + slack);
  return tb || null;
}

function sepCell(a) {
  if (a === 'center') return ':---:';
  if (a === 'right') return '---:';
  if (a === 'left') return ':---';
  return '---';
}
function buildRow(cells) { return '| ' + cells.join(' | ') + ' |'; }
function escCell(s) { return s.replace(/\|/g, '\\|'); }

/** 改写分隔行，设置若干列的对齐方式。body 是去掉引用前缀后的表格行。 */
function alignTransform(cols, a) {
  return (body, tb) => {
    const sep = splitRow(body[1]);
    while (sep.length < tb.cols) sep.push('---');
    for (const c of cols) if (c >= 0 && c < sep.length) sep[c] = sepCell(a);
    const out = body.slice();
    out[1] = buildRow(sep);
    return out;
  };
}

/** 行列互换：第一行 ↔ 第一列。对齐重置为默认。 */
function transposeTransform(body, tb) {
  const n = tb.cols;
  const grid = [splitRow(body[0])].concat(body.slice(2).map(splitRow)).map((r) => {
    const x = r.slice(0, n);
    while (x.length < n) x.push('');
    return x;
  });
  const cols = [];
  for (let j = 0; j < n; j++) cols.push(grid.map((r) => escCell(r[j])));
  const lines = [buildRow(cols[0]), buildRow(cols[0].map(() => '---'))];
  for (let j = 1; j < n; j++) lines.push(buildRow(cols[j]));
  return lines;
}

/** 在整篇文本中找到表格 ref 并用 transform 改写。 */
function applyTableEdit(text, ref, transform) {
  const eol = text.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const tables = parseTables(text);
  const tb = tables.find((x) => x.sig === ref.sig && x.occ === ref.occ && x.start === ref.start)
    || tables.find((x) => x.sig === ref.sig && x.occ === ref.occ)
    || tables.find((x) => x.start === ref.start);
  if (!tb) return null;
  const seg = lines.slice(tb.start, tb.end + 1);
  const m = QUOTE_RE.exec(seg[0]);
  const prefix = m ? m[0] : '';
  const out = transform(seg.map(stripQuote), tb);
  const newSeg = out.map((l) => prefix + l);
  const newText = lines.slice(0, tb.start).concat(newSeg, lines.slice(tb.end + 1)).join(eol);
  return { start: tb.start, end: tb.end, replacement: newSeg.join('\n'), newText, t: tb };
}

/* ---------- 导出为其他格式 ---------- */

function cellPlain(s) {
  return mdToPlain(s.replace(/<br\s*\/?>/gi, '\n')).replace(/\*\*|__|~~|==/g, '').replace(/`/g, '').trim();
}

function tableGrid(tb) {
  const pad = (r) => { const x = r.slice(0, tb.cols); while (x.length < tb.cols) x.push(''); return x; };
  return [pad(tb.header)].concat(tb.rows.map(pad)).map((r) => r.map(cellPlain));
}

function toCSV(grid) {
  return grid.map((r) => r.map((c) => (/[",\n\r]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c)).join(',')).join('\n');
}

function toTSV(grid) {
  return grid.map((r) => r.map((c) => c.replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
}

function escHTML(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toHTML(grid, aligns) {
  const cell = (tag, c, i) => {
    const a = aligns[i] ? ' style="text-align: ' + aligns[i] + '"' : '';
    return '<' + tag + a + '>' + escHTML(c).replace(/\n/g, '<br>') + '</' + tag + '>';
  };
  const head = '<thead><tr>' + grid[0].map((c, i) => cell('th', c, i)).join('') + '</tr></thead>';
  const body = '<tbody>' + grid.slice(1).map((r) => '<tr>' + r.map((c, i) => cell('td', c, i)).join('') + '</tr>').join('') + '</tbody>';
  return '<table>' + head + body + '</table>';
}

const LATEX_ESC = {
  '\\': '\\textbackslash{}', '&': '\\&', '%': '\\%', $: '\\$', '#': '\\#', _: '\\_',
  '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
};

function latexCell(s) {
  // 保留 $…$ / $$…$$ 里的公式原样，其余转义
  return s.split(/(\$\$[^$]+\$\$|\$[^$\n]+\$)/).map((part, i) => (
    i % 2 ? part : part.replace(/[\\&%$#_{}~^]/g, (ch) => LATEX_ESC[ch]).replace(/\n/g, ' ')
  )).join('');
}

function toLaTeX(grid, aligns) {
  const spec = grid[0].map((_, i) => (aligns[i] === 'center' ? 'c' : aligns[i] === 'right' ? 'r' : 'l')).join('');
  const row = (r) => '    ' + r.map(latexCell).join(' & ') + ' \\\\';
  return [
    '% \\usepackage{booktabs}',
    '\\begin{table}[htbp]',
    '  \\centering',
    '  \\begin{tabular}{' + spec + '}',
    '    \\toprule',
    row(grid[0]),
    '    \\midrule',
  ].concat(grid.slice(1).map(row), [
    '    \\bottomrule',
    '  \\end{tabular}',
    '\\end{table}',
  ]).join('\n');
}

/* ---------- 设置记录的辅助函数 ---------- */

/** 按列名把旧宽度映射到新的列顺序上（处理增删列、拖动换列、改表头）。 */
function mapWidths(oldNames, oldWidths, newNames) {
  const used = new Array(oldNames.length).fill(false);
  const out = new Array(newNames.length).fill(null);
  newNames.forEach((n, i) => {
    if (i < oldNames.length && oldNames[i] === n) { out[i] = oldWidths[i]; used[i] = true; }
  });
  newNames.forEach((n, i) => {
    if (out[i] != null) return;
    const j = oldNames.findIndex((m, k) => !used[k] && m === n);
    if (j >= 0) { out[i] = oldWidths[j]; used[j] = true; }
  });
  if (oldNames.length === newNames.length) {
    newNames.forEach((n, i) => {
      if (out[i] == null && !used[i]) { out[i] = oldWidths[i]; used[i] = true; }
    });
  }
  return out;
}

/** 列名改了以后，把以列名为键的设置搬到新列名上。 */
function remapNameKeyed(obj, oldNames, newNames) {
  if (!obj) return obj;
  const idx = mapWidths(oldNames, oldNames.map((_, i) => i), newNames);
  const out = {};
  newNames.forEach((n, i) => {
    const j = idx[i];
    if (j != null && oldNames[j] in obj) out[n] = obj[oldNames[j]];
    else if (n in obj) out[n] = obj[n];
  });
  return Object.keys(out).length ? out : undefined;
}

function nameSimilarity(a, b) {
  const pool = a.slice();
  let hit = 0;
  for (const n of b) {
    const k = pool.indexOf(n);
    if (k >= 0) { hit++; pool.splice(k, 1); }
  }
  return hit / Math.max(a.length, b.length, 1);
}

/** 行级设置（对齐 / 颜色）：按行内容匹配，找不到时按位置匹配失去主人的记录。 */
function rowFieldFor(entry, field, keys, i) {
  const list = entry && entry[field];
  if (!list || !list.length || keys[i] == null) return null;
  const val = (x) => (x.v != null ? x.v : x.a);
  let x = list.find((y) => y.k === keys[i]);
  if (x) return val(x);
  x = list.find((y) => y.i === i && keys.indexOf(y.k) === -1);
  return x ? val(x) : null;
}

function isEmptyEntry(e) {
  return !(e.widths && e.widths.some((w) => w != null))
    && e.headerRow == null && e.headerCol == null && !e.density && !e.style
    && !e.freezeRow && !e.freezeCol
    && !(e.rowAlign && e.rowAlign.length) && !(e.rowColors && e.rowColors.length)
    && !(e.colWrap && Object.keys(e.colWrap).length) && !(e.colColors && Object.keys(e.colColors).length)
    && !e.touched;
}

let lastParsed = { text: null, tables: null };
function getTables(text) {
  if (lastParsed.text !== text) lastParsed = { text, tables: parseTables(text) };
  return lastParsed.tables;
}

/* ====================================================================== */
/* 表格设置存储                                                            */
/* ====================================================================== */

class TableStore {
  constructor(plugin) { this.plugin = plugin; }
  get map() { return this.plugin.data.tables; }

  /** 记录 e 是否就是表格 tb（表头相同；有重名表格时还要求序号一致）。 */
  static exact(e, tb) {
    if (e.sig !== tb.sig || e.occ !== tb.occ) return false;
    const dups = e.dups || 1;
    if (dups === 1 && tb.dups === 1) return true;
    return e.ord === tb.ord;
  }

  find(path, tb, tables) {
    const list = this.map[path];
    if (!list || !list.length) return null;
    const e = list.find((x) => TableStore.exact(x, tb));
    if (e) {
      if (e.ord !== tb.ord) { e.ord = tb.ord; this.plugin.requestSave(); }
      return e;
    }
    // 找一个「失去主人」的记录（文件里已没有表格和它完全对应），且列名一半以上相同：
    // 通常是改了表头、增删或移动了列。
    let best = null;
    let bestScore = 0;
    for (const x of list) {
      if (tables.some((y) => TableStore.exact(x, y))) continue;
      let score = nameSimilarity(x.names || [], tb.names);
      if (score < 0.5) continue;
      if (x.occ === tb.occ) score += 0.02;
      if (x.ord === tb.ord) score += 0.01;
      if (score > bestScore) { best = x; bestScore = score; }
    }
    if (best) {
      const old = best.names || [];
      if (best.widths) best.widths = mapWidths(old, best.widths, tb.names);
      if (best.colWrap) best.colWrap = remapNameKeyed(best.colWrap, old, tb.names);
      if (best.colColors) best.colColors = remapNameKeyed(best.colColors, old, tb.names);
      Object.assign(best, { names: tb.names.slice(), sig: tb.sig, occ: tb.occ, dups: tb.dups, ord: tb.ord });
      this.plugin.requestSave();
    }
    return best;
  }

  widthsFor(entry, tb) {
    if (!entry || !entry.widths || !entry.widths.some((w) => w != null)) return null;
    const names = entry.names || [];
    if (names.join('|') === tb.names.join('|')) return entry.widths.slice();
    return mapWidths(names, entry.widths, tb.names);
  }

  patch(path, tb, tables, fields) {
    const list = this.map[path] || (this.map[path] = []);
    let e = this.find(path, tb, tables);
    if (!e) { e = { widths: null }; list.push(e); }
    Object.assign(e, { sig: tb.sig, occ: tb.occ, dups: tb.dups, ord: tb.ord, names: tb.names.slice() });
    for (const k of Object.keys(fields)) {
      if (fields[k] === undefined) delete e[k]; else e[k] = fields[k];
    }
    if (e.widths) {
      e.widths = e.widths.map((w) => (w == null ? null : Math.round(w)));
      while (e.names.length < e.widths.length) e.names.push('');
    }
    let next = (this.map[path] || []).filter((x) => x === e || !TableStore.exact(x, tb));
    if (isEmptyEntry(e)) next = next.filter((x) => x !== e);
    if (next.length) this.map[path] = next; else delete this.map[path];
    this.plugin.requestSave();
    return e;
  }

  removeEntry(path, e) {
    const list = this.map[path];
    if (!list) return;
    const next = list.filter((x) => x !== e);
    if (next.length) this.map[path] = next; else delete this.map[path];
    this.plugin.requestSave();
  }

  remove(path, tb, tables) {
    const e = this.find(path, tb, tables);
    if (!e) return false;
    this.removeEntry(path, e);
    return true;
  }

  count() {
    return Object.values(this.map).reduce((a, l) => a + l.length, 0);
  }
}

/** 菜单项打勾（兼容没有 setChecked 的旧版本）。 */
function checked(item, on) {
  if (typeof item.setChecked === 'function') return item.setChecked(on);
  return on ? item.setIcon('check') : item;
}

function isForeignTable(table) {
  // Dataview 等代码块渲染出来的表格没有对应的 Markdown 源码，不处理
  return !!table.closest('[class*="block-language-"], .dataview, .table-view-table');
}

function setAttr(el, name, val) {
  if (val) { if (el.getAttribute(name) !== val) el.setAttribute(name, val); } else if (el.hasAttribute(name)) el.removeAttribute(name);
}

/* ====================================================================== */
/* 插件                                                                   */
/* ====================================================================== */

class TableStudioPlugin extends Plugin {
  async onload() {
    await this.loadAll();
    this.store = new TableStore(this);
    this.ppInfo = new WeakMap();
    this.docTables = new WeakMap();
    this.pending = new Set();
    this.rafId = 0;
    this.windows = new Set();
    this.observers = new Map();
    this.ui = new Map();
    this.hover = null;
    this.drag = null;
    this.lastDown = null;
    this.swallowUntil = 0;
    this.saveTimer = 0;
    this.btnTable = null;
    this.btnHideTimer = 0;
    this.selTimer = 0;
    this.currentCell = null;

    this.registerMarkdownPostProcessor((el, ctx) => this.postProcess(el, ctx));
    this.addSettingTab(new TableStudioSettingTab(this.app, this));
    this.addCommands();

    this.app.workspace.onLayoutReady(() => {
      this.attachWindow(window);
      this.registerEvent(this.app.workspace.on('window-open', (_w, win) => this.attachWindow(win)));
      this.registerEvent(this.app.workspace.on('window-close', (_w, win) => this.detachWindow(win)));
      this.registerEvent(this.app.workspace.on('layout-change', () => this.scanAll(false)));
      this.registerEvent(this.app.workspace.on('file-open', () => this.scanAll(false)));
      this.scanAll(true);
    });

    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onRename(file, oldPath)));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (this.data.tables[file.path]) { delete this.data.tables[file.path]; this.requestSave(); }
    }));
  }

  onunload() {
    for (const mo of this.observers.values()) mo.disconnect();
    this.observers.clear();
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveData(this.data); }
    if (this.btnHideTimer) clearTimeout(this.btnHideTimer);
    if (this.selTimer) clearTimeout(this.selTimer);
    for (const win of this.windows) {
      const doc = win.document;
      doc.body.classList.remove('tt-col-hover', 'tt-dragging');
      doc.querySelectorAll('table.tt-managed, table.tt-sized').forEach((tb) => this.clearTable(tb));
    }
    for (const u of this.ui.values()) { u.line.remove(); u.tip.remove(); u.btn.remove(); u.bar.remove(); }
    this.ui.clear();
  }

  /* ---------------- 数据 ---------------- */

  async loadAll() {
    const raw = (await this.loadData()) || {};
    const settings = Object.assign({}, DEFAULT_SETTINGS, raw.settings || {});
    delete settings.notionLook;
    if (STYLES.indexOf(settings.style) === -1) settings.style = 'default';
    this.data = { settings, tables: raw.tables || {} };
    LANG_SETTING = settings.language;
  }

  get settings() { return this.data.settings; }

  setLanguage(v) {
    this.settings.language = v;
    LANG_SETTING = v;
    for (const u of this.ui.values()) u.btn.setAttribute('aria-label', t('tableMenu'));
    this.requestSave();
  }

  requestSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = 0; this.saveData(this.data); }, 400);
  }

  onRename(file, oldPath) {
    const m = this.data.tables;
    let changed = false;
    for (const k of Object.keys(m)) {
      if (k === oldPath || k.startsWith(oldPath + '/')) {
        m[file.path + k.slice(oldPath.length)] = m[k];
        delete m[k];
        changed = true;
      }
    }
    if (changed) this.requestSave();
  }

  /* ---------------- 窗口 / 事件 ---------------- */

  attachWindow(win) {
    if (!win || this.windows.has(win)) return;
    this.windows.add(win);
    const doc = win.document;
    const mo = new MutationObserver((recs) => this.onMutations(recs));
    mo.observe(doc.body, { childList: true, subtree: true });
    this.observers.set(win, mo);
    const cap = { capture: true };
    this.registerDomEvent(win, 'pointermove', (e) => this.onPointerMove(e), { capture: true, passive: true });
    this.registerDomEvent(win, 'pointerdown', (e) => this.onPointerDown(e), cap);
    this.registerDomEvent(win, 'pointerup', (e) => this.onPointerUp(e), cap);
    this.registerDomEvent(win, 'pointercancel', () => this.cancelDrag(), cap);
    this.registerDomEvent(win, 'mousedown', (e) => this.swallow(e), cap);
    this.registerDomEvent(win, 'mouseup', (e) => this.swallow(e), cap);
    this.registerDomEvent(win, 'click', (e) => this.swallow(e), cap);
    this.registerDomEvent(win, 'dblclick', (e) => this.swallow(e), cap);
    this.registerDomEvent(win, 'contextmenu', (e) => this.onContextMenu(e), cap);
    this.registerDomEvent(win, 'keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this.drag) { e.preventDefault(); e.stopPropagation(); this.cancelDrag(); }
      this.hideSelBar();
    }, cap);
    this.registerDomEvent(win, 'keyup', () => this.scheduleSelCheck(), cap);
    this.registerDomEvent(doc, 'scroll', () => {
      if (!this.drag) this.hideHover();
      if (this.btnTable) this.positionBtn();
      this.hideSelBar();
    }, { capture: true, passive: true });
    this.registerDomEvent(win, 'blur', () => this.cancelDrag());
  }

  detachWindow(win) {
    const mo = this.observers.get(win);
    if (mo) mo.disconnect();
    this.observers.delete(win);
    this.windows.delete(win);
    this.ui.delete(win.document);
  }

  getUI(doc) {
    let u = this.ui.get(doc);
    if (u && u.line.isConnected) return u;
    const mk = (cls) => { const el = doc.createElement('div'); el.className = cls; doc.body.appendChild(el); return el; };
    const line = mk('tt-resize-line');
    const tip = mk('tt-width-tip');
    const btn = mk('tt-table-btn');
    btn.setAttribute('aria-label', t('tableMenu'));
    btn.setAttribute('role', 'button');
    if (setIcon) setIcon(btn, 'more-horizontal'); else btn.textContent = '⋯';
    const bar = mk('tt-sel-bar');
    // 按下时不抢走编辑器焦点 / 表格选择
    const keep = (e) => { e.preventDefault(); e.stopPropagation(); };
    btn.addEventListener('pointerdown', keep);
    btn.addEventListener('mousedown', keep);
    bar.addEventListener('pointerdown', keep);
    bar.addEventListener('mousedown', keep);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.btnTable) this.openTableMenu(this.btnTable, btn.getBoundingClientRect());
    });
    btn.addEventListener('pointerenter', () => this.cancelBtnHide());
    u = { line, tip, btn, bar };
    this.ui.set(doc, u);
    return u;
  }

  /* ---------------- 发现表格 & 应用设置 ---------------- */

  postProcess(el, ctx) {
    const tbls = el.querySelectorAll('table');
    if (!tbls.length) return;
    const info = ctx.getSectionInfo(el);
    let inSection = [];
    if (info) {
      inSection = getTables(info.text).filter((x) => x.start >= info.lineStart && x.start <= info.lineEnd);
    }
    tbls.forEach((tb, k) => {
      if (isForeignTable(tb)) return;
      const x = inSection[k];
      this.ppInfo.set(tb, x
        ? { path: ctx.sourcePath, text: info.text, line: x.start }
        : { path: ctx.sourcePath, text: null, line: -1 });
      this.queue(tb);
    });
  }

  onMutations(recs) {
    for (const r of recs) {
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.classList && /\btt-(measure|resize-line|width-tip|table-btn|sel-bar)\b/.test(n.className)) continue;
        if (n.tagName === 'TABLE') { this.queue(n); continue; }
        const up = n.closest && n.closest('table');
        if (up) { this.queue(up); continue; }
        if (n.getElementsByTagName) {
          const ts = n.getElementsByTagName('table');
          for (let i = 0; i < ts.length; i++) this.queue(ts[i]);
        }
      }
    }
  }

  queue(table) {
    this.pending.add(table);
    if (this.rafId) return;
    const win = (table.ownerDocument && table.ownerDocument.defaultView) || window;
    this.rafId = win.requestAnimationFrame(() => {
      this.rafId = 0;
      const list = Array.from(this.pending);
      this.pending.clear();
      for (const tb of list) this.processTable(tb, false);
    });
  }

  scanAll(force) {
    for (const win of this.windows) {
      win.document.querySelectorAll('table').forEach((tb) => {
        if (tb.closest('.markdown-rendered, .markdown-preview-view, .markdown-source-view')) this.processTable(tb, force);
      });
    }
  }

  refreshAll() {
    for (const win of this.windows) {
      win.document.querySelectorAll('table').forEach((tb) => {
        if (tb.closest('.markdown-rendered, .markdown-preview-view, .markdown-source-view')) {
          tb.dataset.ttState = '';
          this.queue(tb);
        }
      });
    }
  }

  contextOf(table) {
    if (isForeignTable(table)) return null;
    if (table.closest('.markdown-source-view')) {
      if (!table.closest('.is-live-preview')) return null;
      return this.settings.enableLivePreview ? 'live' : null;
    }
    if (table.closest('.markdown-rendered, .markdown-preview-view')) {
      return this.settings.enableReading ? 'reading' : null;
    }
    return null;
  }

  stateIntact(table) {
    if (table.classList.contains('tt-sized')) {
      const row = table.rows[0];
      if (row) for (const c of Array.from(row.cells)) if (!c.style.width) return false;
    }
    for (const tr of Array.from(table.rows)) if (!tr.dataset.ttc) return false;
    return true;
  }

  processTable(table, force) {
    if (!table.isConnected) return;
    if (this.drag && this.drag.table === table) return;
    if (!this.contextOf(table)) {
      if (table.classList.contains('tt-managed') || table.classList.contains('tt-sized')) this.clearTable(table);
      return;
    }
    if (!force && table.dataset.ttState === 'ok' && this.stateIntact(table)) return;
    const r = this.resolve(table);
    const entry = r ? this.store.find(r.path, r.t, r.tables) : null;
    this.decorate(table, entry, r);
    if (r) table.dataset.ttState = 'ok';
  }

  effective(entry, key, fallback) {
    return entry && entry[key] != null ? entry[key] : fallback;
  }

  /** 某一列当前是否换行。 */
  colWraps(entry, name, sized) {
    const ex = entry && entry.colWrap && name != null ? entry.colWrap[name] : undefined;
    if (ex != null) return !!ex;
    return this.settings.wrap || !sized;
  }

  /** 根据记录给表格加 class / 属性 / 列宽。 */
  decorate(table, entry, r) {
    const s = this.settings;
    const cl = table.classList;
    cl.add('tt-managed');
    cl.toggle('tt-hrow', !!this.effective(entry, 'headerRow', s.headerRow));
    cl.toggle('tt-hcol', !!this.effective(entry, 'headerCol', s.headerColDefault));
    const style = this.effective(entry, 'style', s.style);
    STYLES.forEach((x) => cl.toggle('tt-st-' + x, x !== 'default' && style === x));
    const adjusted = !!entry;
    cl.toggle('tt-adjusted', adjusted);
    const dens = adjusted ? (entry.density || s.density) : null;
    DENSITIES.forEach((d) => cl.toggle('tt-d-' + d, dens === d));
    cl.toggle('tt-va-middle', adjusted && s.valign === 'middle');
    cl.toggle('tt-va-top', adjusted && s.valign === 'top');
    cl.toggle('tt-frz-row', !!(entry && entry.freezeRow));
    cl.toggle('tt-frz-col', !!(entry && entry.freezeCol));

    const ws = entry && r ? this.store.widthsFor(entry, r.t) : null;
    if (ws) this.applyWidths(table, ws);
    else if (cl.contains('tt-sized')) this.clearWidths(table);
    const sized = cl.contains('tt-sized');

    // 按列：换行 / 背景色 → data 属性里的列号 token
    const names = r ? r.t.names : [];
    const nCols = Math.min(MAX_COLS, table.rows[0] ? table.rows[0].cells.length : 0);
    const nw = [];
    const colTok = {};
    for (let i = 0; i < nCols; i++) {
      const name = names[i];
      if (!this.colWraps(entry, name, sized)) nw.push('c' + (i + 1));
      const c = entry && entry.colColors && name != null ? entry.colColors[name] : null;
      if (c && COLORS.indexOf(c) !== -1) (colTok[c] = colTok[c] || []).push('c' + (i + 1));
    }
    setAttr(table, 'data-tt-nw', nw.join(' '));
    let hasColor = false;
    for (const c of COLORS) {
      const v = (colTok[c] || []).join(' ');
      setAttr(table, 'data-tt-c-' + c, v);
      if (v) hasColor = true;
    }

    // 按行：对齐 / 背景色
    const keys = r ? tableRowKeys(r.t) : [];
    Array.from(table.rows).forEach((tr, i) => {
      const a = entry ? rowFieldFor(entry, 'rowAlign', keys, i) : null;
      const c = entry ? rowFieldFor(entry, 'rowColors', keys, i) : null;
      setAttr(tr, 'data-tt-align', a);
      setAttr(tr, 'data-tt-color', c);
      if (c) hasColor = true;
      tr.dataset.ttc = '1';
    });
    cl.toggle('tt-has-color', hasColor);
  }

  /** 找出 DOM 表格对应的源码表格：{ path, t, tables } */
  resolve(table) {
    const pi = this.ppInfo.get(table);
    if (pi && pi.text != null) {
      const tables = getTables(pi.text);
      const tb = tables.find((x) => x.start === pi.line) || findTableAtLine(tables, pi.line, 1);
      return tb ? { path: pi.path, t: tb, tables } : null;
    }
    const live = this.resolveLive(table);
    if (live) return live;
    if (pi) this.resolveAsync(table, pi);
    return null;
  }

  resolveLive(table) {
    if (!table.closest('.markdown-source-view.is-live-preview')) return null;
    if (table.closest('.markdown-embed, .internal-embed')) return null;
    const view = this.viewFor(table);
    if (!view || !view.file) return null;
    const cm = view.editor && view.editor.cm;
    if (!cm || !cm.contentDOM || !cm.contentDOM.contains(table)) return null;
    let pos;
    try { pos = cm.posAtDOM(table); } catch (e) { return null; }
    const doc = cm.state.doc;
    const line = doc.lineAt(pos).number - 1;
    let tables = this.docTables.get(doc);
    if (!tables) { tables = parseTables(doc.toString()); this.docTables.set(doc, tables); }
    let tb = null;
    const callout = table.closest('.callout');
    if (callout && !table.closest('.cm-table-widget')) {
      const k = Array.from(callout.querySelectorAll('table')).indexOf(table);
      tb = tables.filter((x) => x.start >= line)[k] || null;
    } else {
      tb = findTableAtLine(tables, line, 1);
    }
    return tb ? { path: view.file.path, t: tb, tables } : null;
  }

  resolveAsync(table, pi) {
    if (pi.loading) return;
    pi.loading = true;
    const f = this.app.vault.getAbstractFileByPath(pi.path);
    if (!(f instanceof TFile)) return;
    this.app.vault.cachedRead(f).then((text) => {
      const row = table.rows[0];
      if (!row) return;
      const loose = Array.from(row.cells).map((c) => looseText(c.textContent || '')).join('|');
      const tb = parseTables(text).find((x) => x.loose === loose);
      if (tb) { pi.text = text; pi.line = tb.start; this.processTable(table, true); }
    }).catch(() => {});
  }

  viewFor(el) {
    let found = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const v = leaf.view;
      if (!found && v instanceof MarkdownView && v.containerEl.contains(el)) found = v;
    });
    return found;
  }

  editingViewFor(path) {
    let found = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const v = leaf.view;
      if (!found && v instanceof MarkdownView && v.file && v.file.path === path
        && typeof v.getMode === 'function' && v.getMode() === 'source') found = v;
    });
    return found;
  }

  measure(table) {
    const row = table.rows[0];
    if (!row) return [];
    return Array.from(row.cells).map((c) => Math.round(c.getBoundingClientRect().width));
  }

  applyWidths(table, widths) {
    const row = table.rows[0];
    if (!row) return;
    const cells = row.cells;
    let total = 0;
    for (let i = 0; i < cells.length; i++) {
      const raw = widths[i] == null ? this.settings.defaultWidth : widths[i];
      const w = Math.max(16, Math.round(raw));
      const px = w + 'px';
      const st = cells[i].style;
      if (st.width !== px) { st.width = px; st.minWidth = px; st.maxWidth = px; }
      total += w;
    }
    table.classList.add('tt-sized');
    table.style.width = total + 'px';
    table.style.minWidth = total + 'px';
  }

  clearWidths(table) {
    table.classList.remove('tt-sized');
    ['width', 'min-width'].forEach((p) => table.style.removeProperty(p));
    const row = table.rows[0];
    if (row) {
      for (const c of Array.from(row.cells)) {
        c.style.removeProperty('width');
        c.style.removeProperty('min-width');
        c.style.removeProperty('max-width');
      }
    }
  }

  clearTable(table) {
    this.clearWidths(table);
    table.classList.remove('tt-managed', 'tt-hrow', 'tt-hcol', 'tt-adjusted', 'tt-va-middle', 'tt-va-top',
      'tt-frz-row', 'tt-frz-col', 'tt-has-color',
      ...DENSITIES.map((d) => 'tt-d-' + d), ...STYLES.map((x) => 'tt-st-' + x));
    table.removeAttribute('data-tt-nw');
    for (const c of COLORS) table.removeAttribute('data-tt-c-' + c);
    for (const tr of Array.from(table.rows)) {
      tr.removeAttribute('data-tt-align');
      tr.removeAttribute('data-tt-color');
      delete tr.dataset.ttc;
    }
    table.dataset.ttState = '';
  }

  /** 列内容的自然宽度（不换行时的宽度），用于「适应内容」。 */
  naturalWidth(table, col) {
    const doc = table.ownerDocument;
    const win = doc.defaultView;
    const box = doc.createElement('div');
    box.className = 'tt-measure';
    doc.body.appendChild(box);
    let max = 0;
    for (const row of Array.from(table.rows)) {
      const cell = row.cells[col];
      if (!cell) continue;
      const cs = win.getComputedStyle(cell);
      const wrap = doc.createElement('div');
      wrap.style.font = cs.font;
      wrap.style.letterSpacing = cs.letterSpacing;
      for (const ch of Array.from(cell.childNodes)) wrap.appendChild(ch.cloneNode(true));
      box.appendChild(wrap);
      let extra = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
        + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
      const inner = cell.querySelector(':scope > .table-cell-wrapper');
      if (inner) {
        const ics = win.getComputedStyle(inner);
        extra += (parseFloat(ics.paddingLeft) || 0) + (parseFloat(ics.paddingRight) || 0);
      }
      max = Math.max(max, wrap.getBoundingClientRect().width + extra);
    }
    box.remove();
    const s = this.settings;
    return Math.min(s.maxAutoWidth, Math.max(s.minWidth, Math.ceil(max) + 4));
  }

  /* ---------------- 鼠标：列宽拖动 ---------------- */

  hitTest(e) {
    const tgt = e.target;
    if (!tgt || tgt.nodeType !== 1 || !tgt.closest) return null;
    let table = tgt.closest('table');
    if (!table) {
      const wrap = tgt.closest('.el-table, .cm-table-widget, .table-wrapper');
      table = wrap && wrap.querySelector('table');
    }
    if (!table || !this.contextOf(table)) return null;
    const row = table.rows[0];
    if (!row) return null;
    const tr = table.getBoundingClientRect();
    if (e.clientY < tr.top - 2 || e.clientY > tr.bottom + 2) return null;
    const cells = row.cells;
    for (let i = 0; i < cells.length; i++) {
      const r = cells[i].getBoundingClientRect();
      if (Math.abs(e.clientX - r.right) <= HIT_ZONE) return { table, col: i, x: r.right };
    }
    return null;
  }

  onPointerMove(e) {
    if (this.drag) { this.onDragMove(e); return; }
    if (e.pointerType === 'touch' || e.buttons) { this.hideHover(); return; }
    const hit = this.hitTest(e);
    if (!hit) this.hideHover();
    else {
      this.hover = hit;
      this.showLine(hit.table, hit.x);
      hit.table.ownerDocument.body.classList.add('tt-col-hover');
    }
    this.updateTableBtn(e);
  }

  showLine(table, x) {
    const doc = table.ownerDocument;
    const u = this.getUI(doc);
    const tr = table.getBoundingClientRect();
    const sc = table.closest('.markdown-preview-view, .cm-scroller, .markdown-embed-content');
    const cr = sc ? sc.getBoundingClientRect() : { top: 0, bottom: doc.defaultView.innerHeight };
    const top = Math.max(tr.top, cr.top);
    const bottom = Math.min(tr.bottom, cr.bottom);
    u.line.style.left = Math.round(x) + 'px';
    u.line.style.top = Math.round(top) + 'px';
    u.line.style.height = Math.max(0, Math.round(bottom - top)) + 'px';
    u.line.classList.add('is-visible');
  }

  hideHover() {
    if (!this.hover) return;
    const doc = this.hover.table.ownerDocument;
    this.hover = null;
    doc.body.classList.remove('tt-col-hover');
    const u = this.ui.get(doc);
    if (u) u.line.classList.remove('is-visible');
  }

  showTip(doc, x, y, text) {
    const u = this.getUI(doc);
    u.tip.textContent = text;
    u.tip.style.left = Math.round(x + 14) + 'px';
    u.tip.style.top = Math.round(y - 30) + 'px';
    u.tip.classList.add('is-visible');
  }

  stop(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  swallow(e) {
    if (this.drag || Date.now() < this.swallowUntil) this.stop(e);
  }

  onPointerDown(e) {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    const hit = this.hitTest(e);
    if (!hit) { this.rememberCell(e); return; }
    this.stop(e);
    this.swallowUntil = Date.now() + 600;

    const now = Date.now();
    const ld = this.lastDown;
    if (ld && ld.table === hit.table && ld.col === hit.col && now - ld.t < DBL_CLICK_MS) {
      this.lastDown = null;
      const cols = e.shiftKey ? this.measure(hit.table).map((_, i) => i) : [hit.col];
      this.fitColumns(hit.table, cols);
      return;
    }
    this.lastDown = { table: hit.table, col: hit.col, t: now };

    const r = this.resolve(hit.table);
    if (!r) { new Notice(t('unresolved')); return; }
    const widths = this.measure(hit.table);
    const wasSized = hit.table.classList.contains('tt-sized');
    this.drag = {
      table: hit.table, col: hit.col, r,
      startX: e.clientX, startW: widths[hit.col],
      widths, orig: widths.slice(), wasSized, moved: false,
    };
    this.applyWidths(hit.table, widths);
    hit.table.ownerDocument.body.classList.add('tt-dragging');
    this.showTip(hit.table.ownerDocument, e.clientX, e.clientY, widths[hit.col] + ' px');
  }

  /** 记住最后点击的单元格，作为「本行 / 本列」的对象。 */
  rememberCell(e) {
    const tgt = e.target;
    if (!tgt || tgt.nodeType !== 1 || !tgt.closest) return;
    const cell = tgt.closest('td, th');
    const table = cell && cell.closest('table');
    if (!table || !this.contextOf(table)) return;
    const r = this.resolve(table);
    this.currentCell = {
      table, row: cell.parentElement.rowIndex, col: cell.cellIndex,
      path: r ? r.path : null, start: r ? r.t.start : -1,
    };
  }

  onDragMove(e) {
    const d = this.drag;
    const w = Math.min(4000, Math.max(this.settings.minWidth, Math.round(d.startW + e.clientX - d.startX)));
    if (w !== d.widths[d.col]) {
      d.widths[d.col] = w;
      d.moved = true;
      this.applyWidths(d.table, d.widths);
    }
    const cell = d.table.rows[0] && d.table.rows[0].cells[d.col];
    if (cell) this.showLine(d.table, cell.getBoundingClientRect().right);
    this.showTip(d.table.ownerDocument, e.clientX, e.clientY, w + ' px');
  }

  onPointerUp(e) {
    this.scheduleSelCheck();
    const d = this.drag;
    if (!d) return;
    this.stop(e);
    this.endDrag();
    this.swallowUntil = Date.now() + 400;
    if (!d.moved) {
      if (!d.wasSized) this.clearWidths(d.table);
      return;
    }
    this.store.patch(d.r.path, d.r.t, d.r.tables, { widths: d.widths });
    this.refreshAll();
  }

  cancelDrag() {
    const d = this.drag;
    if (!d) return;
    this.endDrag();
    if (d.wasSized) this.applyWidths(d.table, d.orig);
    else this.clearWidths(d.table);
  }

  endDrag() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const doc = d.table.ownerDocument;
    doc.body.classList.remove('tt-dragging');
    const u = this.ui.get(doc);
    if (u) u.tip.classList.remove('is-visible');
    this.hideHover();
  }

  /** 右键列边框：这一列相关的操作 + 列宽操作。 */
  onContextMenu(e) {
    const hit = this.hitTest(e);
    if (!hit) return;
    this.stop(e);
    const { table, col } = hit;
    const pos = { x: e.clientX, y: e.clientY };
    const r = this.resolve(table);
    const entry = r ? this.store.find(r.path, r.t, r.tables) : null;
    const menu = new Menu();
    menu.addItem((i) => i.setTitle(t('fitCol')).setIcon('arrow-left-right').onClick(() => this.fitColumns(table, [col])));
    if (r) {
      const wraps = this.colWraps(entry, r.t.names[col], table.classList.contains('tt-sized'));
      menu.addItem((i) => checked(i.setTitle(t('wrapThisCol')).setIcon('wrap-text'), wraps)
        .onClick(() => this.setColField(table, 'colWrap', [col], !wraps)));
      menu.addItem((i) => i.setTitle(t('colorThisCol')).setIcon('palette')
        .onClick(() => this.sub(() => this.colorMenu(table, { kind: 'cols', idx: [col] }), pos)));
    }
    menu.addSeparator();
    this.addWidthItems(menu, table);
    menu.showAtMouseEvent(e);
  }

  addWidthItems(menu, table, entry) {
    menu.addItem((i) => i.setTitle(t('fitAll')).setIcon('table')
      .onClick(() => this.fitColumns(table, this.measure(table).map((_, k) => k))));
    menu.addItem((i) => i.setTitle(t('distribute')).setIcon('columns')
      .onClick(() => this.distribute(table)));
    if (entry === undefined || (entry && entry.widths)) {
      menu.addItem((i) => i.setTitle(t('resetWidths')).setIcon('rotate-ccw')
        .onClick(() => this.resetWidths(table)));
    }
  }

  /** 关掉当前菜单后在同一位置打开下一级菜单。build 返回 Menu。 */
  sub(build, pos) {
    setTimeout(() => {
      const m = build();
      if (m) m.showAtPosition(pos);
    }, 0);
  }

  /* ---------------- ⋯ 表格菜单 ---------------- */

  updateTableBtn(e) {
    const tgt = e.target;
    if (!tgt || tgt.nodeType !== 1 || !tgt.closest) return;
    const u = this.ui.get(tgt.ownerDocument);
    if (u && (u.btn.contains(tgt) || u.bar.contains(tgt))) { this.cancelBtnHide(); return; }
    const table = tgt.closest('table');
    if (table && this.contextOf(table)) { this.showBtn(table); return; }
    this.scheduleBtnHide();
  }

  showBtn(table) {
    this.cancelBtnHide();
    this.btnTable = table;
    this.positionBtn();
  }

  positionBtn() {
    const table = this.btnTable;
    if (!table || !table.isConnected) { this.hideBtn(); return; }
    const u = this.getUI(table.ownerDocument);
    const r = table.getBoundingClientRect();
    const sc = table.closest('.markdown-preview-view, .cm-scroller, .markdown-embed-content');
    const cr = sc ? sc.getBoundingClientRect() : { top: 0, left: 0 };
    const left = Math.max(cr.left + 2, r.left - 26);
    const top = r.top - 26;
    if (top < cr.top || r.bottom < cr.top) { u.btn.classList.remove('is-visible'); return; }
    u.btn.style.left = Math.round(left) + 'px';
    u.btn.style.top = Math.round(top) + 'px';
    u.btn.classList.add('is-visible');
  }

  scheduleBtnHide() {
    if (!this.btnTable || this.btnHideTimer) return;
    this.btnHideTimer = setTimeout(() => { this.btnHideTimer = 0; this.hideBtn(); }, 450);
  }

  cancelBtnHide() {
    if (this.btnHideTimer) { clearTimeout(this.btnHideTimer); this.btnHideTimer = 0; }
  }

  hideBtn() {
    const table = this.btnTable;
    this.btnTable = null;
    for (const u of this.ui.values()) u.btn.classList.remove('is-visible');
    return table;
  }

  openTableMenu(table, at) {
    if (!table || !table.isConnected) return;
    const r = this.resolve(table);
    if (!r) { new Notice(t('unresolved')); return; }
    const e = this.store.find(r.path, r.t, r.tables);
    const s = this.settings;
    const hrow = !!this.effective(e, 'headerRow', s.headerRow);
    const hcol = !!this.effective(e, 'headerCol', s.headerColDefault);
    const pos = { x: Math.round(at.left), y: Math.round(at.bottom + 4) };

    const menu = new Menu();
    menu.addItem((i) => checked(i.setTitle(t('headerRow')).setIcon('panel-top'), hrow)
      .onClick(() => this.patchTable(table, { headerRow: !hrow })));
    menu.addItem((i) => checked(i.setTitle(t('headerCol')).setIcon('panel-left'), hcol)
      .onClick(() => this.patchTable(table, { headerCol: !hcol })));
    menu.addItem((i) => i.setTitle(t('styleMenu')).setIcon('paintbrush')
      .onClick(() => this.sub(() => this.styleMenu(table, e), pos)));
    menu.addItem((i) => i.setTitle(t('densitySub')).setIcon('rows')
      .onClick(() => this.sub(() => this.densityMenu(table, e), pos)));
    menu.addSeparator();
    const fr = !!(e && e.freezeRow);
    const fc = !!(e && e.freezeCol);
    menu.addItem((i) => checked(i.setTitle(t('freezeRow')).setIcon('pin'), fr)
      .onClick(() => this.patchTable(table, { freezeRow: fr ? undefined : true, touched: true })));
    menu.addItem((i) => checked(i.setTitle(t('freezeCol')).setIcon('pin'), fc)
      .onClick(() => this.patchTable(table, { freezeCol: fc ? undefined : true, touched: true })));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle(t('alignMenu')).setIcon('align-left')
      .onClick(() => this.sub(() => this.alignMenu(table), pos)));
    menu.addItem((i) => i.setTitle(t('colorMenu')).setIcon('palette')
      .onClick(() => this.sub(() => this.colorTargetMenu(table, pos), pos)));
    menu.addItem((i) => i.setTitle(t('wrapMenu')).setIcon('wrap-text')
      .onClick(() => this.sub(() => this.wrapMenu(table), pos)));
    menu.addItem((i) => i.setTitle(t('transpose')).setIcon('repeat')
      .onClick(() => this.transposeTable(table)));
    menu.addItem((i) => i.setTitle(t('copyMenu')).setIcon('copy')
      .onClick(() => this.sub(() => this.copyMenu(table), pos)));
    menu.addSeparator();
    this.addWidthItems(menu, table, e);
    if (e) {
      menu.addItem((i) => i.setTitle(t('clearTable')).setIcon('eraser')
        .onClick(() => this.clearAdjustments(table)));
    }
    menu.showAtPosition(pos);
  }

  styleMenu(table, e) {
    const menu = new Menu();
    const own = e && e.style;
    menu.addItem((i) => checked(i.setTitle(t('stFollow', { v: t(STYLE_KEYS[this.settings.style]) })), !own)
      .onClick(() => this.patchTable(table, { style: undefined, touched: true })));
    menu.addSeparator();
    for (const x of STYLES) {
      menu.addItem((i) => checked(i.setTitle(t(STYLE_KEYS[x])), own === x)
        .onClick(() => this.patchTable(table, { style: x, touched: true })));
    }
    return menu;
  }

  densityMenu(table, e) {
    const menu = new Menu();
    const dens = e ? (e.density || this.settings.density) : 'd';
    for (const d of DENSITIES) {
      menu.addItem((i) => checked(i.setTitle(t('d' + d.toUpperCase())), dens === d)
        .onClick(() => this.patchTable(table, { density: d, touched: true })));
    }
    return menu;
  }

  wrapMenu(table) {
    const r = this.resolve(table);
    if (!r) return null;
    const e = this.store.find(r.path, r.t, r.tables);
    const sized = table.classList.contains('tt-sized');
    const menu = new Menu();
    r.t.names.forEach((name, i) => {
      const wraps = this.colWraps(e, name, sized);
      menu.addItem((it) => checked(it.setTitle(t('alignColN', { n: i + 1, name: this.shortName(table, i) })), wraps)
        .onClick(() => this.setColField(table, 'colWrap', [i], !wraps)));
    });
    return menu;
  }

  copyMenu(table) {
    const menu = new Menu();
    [['csv', 'copyCsv'], ['tsv', 'copyTsv'], ['html', 'copyHtml'], ['latex', 'copyLatex']].forEach(([f, k]) => {
      menu.addItem((i) => i.setTitle(t(k)).onClick(() => this.copyAs(table, f)));
    });
    return menu;
  }

  shortName(table, col) {
    const head = table.rows[0] && table.rows[0].cells[col];
    let name = head ? (head.textContent || '').trim() : '';
    if (name.length > 14) name = name.slice(0, 13) + '…';
    return name;
  }

  /* ---------------- 对齐 / 颜色的对象 ---------------- */

  /** 选中的行 / 列（实时预览）和最后点击的单元格所在的行 / 列。 */
  cellTargets(table) {
    const out = [];
    const sel = this.selectedCells(table);
    if (sel.length >= 2) {
      const m = this.selectionMode(table, sel);
      if (m.kind === 'cols') out.push({ label: t('alignSelCols', { n: m.idx.length }), kind: 'cols', idx: m.idx });
      if (m.kind === 'rows') out.push({ label: t('alignSelRows', { n: m.idx.length }), kind: 'rows', idx: m.idx });
    }
    const cc = this.currentCell;
    if (cc && this.sameTable(cc, table)) {
      out.push({ label: t('alignColN', { n: cc.col + 1, name: this.shortName(table, cc.col) }), kind: 'cols', idx: [cc.col] });
      out.push({ label: cc.row === 0 ? t('alignHeaderRow') : t('alignRowN', { n: cc.row }), kind: 'rows', idx: [cc.row] });
    }
    return out;
  }

  sameTable(cc, table) {
    if (cc.table === table) return true;
    if (cc.table && cc.table.isConnected) return false;
    const r = this.resolve(table);
    return !!r && r.path === cc.path && r.t.start === cc.start;
  }

  alignMenu(table) {
    const menu = new Menu();
    const targets = this.cellTargets(table).concat([{ label: t('alignTable'), kind: 'table' }]);
    targets.forEach((tg, k) => {
      if (k) menu.addSeparator();
      for (const a of ALIGNS) {
        menu.addItem((i) => i.setTitle(t('targetAction', { target: tg.label, action: t(a) })).setIcon('align-' + a)
          .onClick(() => this.doAlign(table, tg, a)));
      }
      if (tg.kind === 'rows') {
        menu.addItem((i) => i.setTitle(t('targetAction', { target: tg.label, action: t('clearRowAlign') })).setIcon('eraser')
          .onClick(() => this.doAlign(table, tg, null)));
      }
    });
    return menu;
  }

  colorTargetMenu(table, pos) {
    const targets = this.cellTargets(table);
    if (!targets.length) { new Notice(t('needCell')); return null; }
    if (targets.length === 1) return this.colorMenu(table, targets[0]);
    const menu = new Menu();
    for (const tg of targets) {
      menu.addItem((i) => i.setTitle(tg.label + '…').setIcon(tg.kind === 'cols' ? 'columns' : 'rows')
        .onClick(() => this.sub(() => this.colorMenu(table, tg), pos)));
    }
    return menu;
  }

  colorMenu(table, tg) {
    const menu = new Menu();
    const field = tg.kind === 'cols' ? 'colColors' : 'rowColors';
    for (const c of COLORS) {
      menu.addItem((i) => i.setTitle(colorName(c)).setIcon('circle')
        .onClick(() => this.applyColor(table, tg, field, c)));
    }
    menu.addSeparator();
    menu.addItem((i) => i.setTitle(t('clearColor')).setIcon('eraser')
      .onClick(() => this.applyColor(table, tg, field, null)));
    return menu;
  }

  applyColor(table, tg, field, c) {
    if (field === 'colColors') this.setColField(table, field, tg.idx, c);
    else this.setRowField(table, field, tg.idx, c);
  }

  async doAlign(table, tg, a) {
    const r = this.resolve(table);
    if (!r) { new Notice(t('unresolved')); return; }
    if (tg.kind === 'rows') { this.setRowField(table, 'rowAlign', tg.idx, a); return; }
    const cols = tg.kind === 'table' ? r.t.header.map((_, i) => i) : tg.idx;
    const fields = { touched: true };
    if (tg.kind === 'table') fields.rowAlign = undefined;
    this.store.patch(r.path, r.t, r.tables, fields);
    await this.editTable(r, alignTransform(cols, a || 'left'));
    this.refreshAll();
  }

  /** 行级设置：rowAlign / rowColors。v 为 null 时清除。 */
  setRowField(table, field, rows, v) {
    const r = this.resolve(table);
    if (!r) { new Notice(t('unresolved')); return; }
    const keys = tableRowKeys(r.t);
    const e = this.store.find(r.path, r.t, r.tables);
    let list = e && e[field] ? e[field].slice() : [];
    list = list.filter((x) => !rows.some((i) => x.k === keys[i] || x.i === i));
    if (v) rows.forEach((i) => { if (keys[i] != null) list.push({ k: keys[i], i, v }); });
    this.store.patch(r.path, r.t, r.tables, { [field]: list.length ? list : undefined, touched: true });
    this.processTable(table, true);
    this.refreshAll();
  }

  /** 列级设置：colWrap / colColors（以列名为键）。v 为 null 时清除。 */
  setColField(table, field, cols, v) {
    const r = this.resolve(table);
    if (!r) { new Notice(t('unresolved')); return; }
    const e = this.store.find(r.path, r.t, r.tables);
    const obj = Object.assign({}, e && e[field]);
    for (const i of cols) {
      const n = r.t.names[i];
      if (n == null) continue;
      if (v == null) delete obj[n]; else obj[n] = v;
    }
    this.store.patch(r.path, r.t, r.tables, { [field]: Object.keys(obj).length ? obj : undefined, touched: true });
    this.processTable(table, true);
    this.refreshAll();
  }

  /* ---------------- 选中区域的浮动工具条（实时预览） ---------------- */

  selectedCells(table) {
    try {
      return Array.from(table.querySelectorAll(SEL_CELL)).filter((c) => c.closest('table') === table);
    } catch (e) { return []; }
  }

  selectionMode(table, cells) {
    const rows = new Set();
    const cols = new Set();
    cells.forEach((c) => { rows.add(c.parentElement.rowIndex); cols.add(c.cellIndex); });
    const nRows = table.rows.length;
    const nCols = table.rows[0] ? table.rows[0].cells.length : 0;
    const full = cells.length >= rows.size * cols.size;
    const sorted = (s) => Array.from(s).sort((x, y) => x - y);
    if (full && rows.size === nRows && cols.size === nCols) return { kind: 'table', idx: [] };
    if (full && rows.size === nRows) return { kind: 'cols', idx: sorted(cols) };
    if (full && cols.size === nCols) return { kind: 'rows', idx: sorted(rows) };
    return { kind: 'cols', idx: sorted(cols) };
  }

  scheduleSelCheck() {
    if (this.selTimer) return;
    this.selTimer = setTimeout(() => { this.selTimer = 0; this.checkSelection(); }, 40);
  }

  checkSelection() {
    for (const win of this.windows) {
      const tables = win.document.querySelectorAll('table.tt-managed');
      for (const tb of Array.from(tables)) {
        if (!this.contextOf(tb)) continue;
        const cells = this.selectedCells(tb);
        if (cells.length >= 2) { this.showSelBar(tb, cells); return; }
      }
    }
    this.hideSelBar();
  }

  showSelBar(table, cells) {
    const doc = table.ownerDocument;
    const u = this.getUI(doc);
    const m = this.selectionMode(table, cells);
    const bar = u.bar;
    bar.textContent = '';
    const label = doc.createElement('span');
    label.className = 'tt-sel-label';
    label.textContent = m.kind === 'table' ? t('tbTable') : t(m.kind === 'cols' ? 'tbCols' : 'tbRows', { n: m.idx.length });
    bar.appendChild(label);
    const target = { kind: m.kind, idx: m.idx };
    const addBtn = (icon, title, fn) => {
      const b = doc.createElement('button');
      b.className = 'tt-sel-btn clickable-icon';
      b.setAttribute('aria-label', title);
      if (setIcon) setIcon(b, icon); else b.textContent = title;
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(b); });
      bar.appendChild(b);
      return b;
    };
    for (const a of ALIGNS) addBtn('align-' + a, t(a), () => { this.hideSelBar(); this.doAlign(table, target, a); });
    if (m.kind === 'rows') addBtn('eraser', t('clearRowAlign'), () => { this.hideSelBar(); this.doAlign(table, target, null); });
    if (m.kind !== 'table') {
      addBtn('palette', t('tbColor'), (b) => {
        const rc = b.getBoundingClientRect();
        this.hideSelBar();
        this.sub(() => this.colorMenu(table, target), { x: Math.round(rc.left), y: Math.round(rc.bottom + 4) });
      });
    }

    let top = Infinity; let bottom = -Infinity; let left = Infinity; let right = -Infinity;
    for (const c of cells) {
      const r = c.getBoundingClientRect();
      top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom);
      left = Math.min(left, r.left); right = Math.max(right, r.right);
    }
    const y = top - 40 > 4 ? top - 40 : bottom + 8;
    bar.style.left = Math.round((left + right) / 2) + 'px';
    bar.style.top = Math.round(y) + 'px';
    bar.classList.add('is-visible');
  }

  hideSelBar() {
    for (const u of this.ui.values()) u.bar.classList.remove('is-visible');
  }

  /* ---------------- 表格级操作 ---------------- */

  patchTable(table, fields) {
    const r = this.resolve(table);
    if (!r) { new Notice(t('unresolved')); return; }
    this.store.patch(r.path, r.t, r.tables, fields);
    this.processTable(table, true);
    this.refreshAll();
  }

  fitColumns(table, cols) {
    const r = this.resolve(table);
    if (!r) { new Notice(t('unresolved')); return; }
    const widths = this.measure(table);
    for (const c of cols) widths[c] = this.naturalWidth(table, c);
    this.applyWidths(table, widths);
    this.store.patch(r.path, r.t, r.tables, { widths });
    this.processTable(table, true);
    this.refreshAll();
  }

  distribute(table) {
    const r = this.resolve(table);
    if (!r) return;
    const n = this.measure(table).length;
    if (!n) return;
    const host = table.closest('.el-table, .cm-table-widget, .callout-content') || table.parentElement;
    const avail = Math.max(n * this.settings.minWidth, (host ? host.clientWidth : 600) - 2);
    const widths = new Array(n).fill(Math.floor(avail / n));
    this.applyWidths(table, widths);
    this.store.patch(r.path, r.t, r.tables, { widths });
    this.processTable(table, true);
    this.refreshAll();
  }

  resetWidths(table) {
    const r = this.resolve(table);
    this.clearWidths(table);
    if (!r) return;
    this.store.patch(r.path, r.t, r.tables, { widths: null });
    this.processTable(table, true);
    this.refreshAll();
  }

  clearAdjustments(table) {
    const r = this.resolve(table);
    if (!r) return;
    this.store.remove(r.path, r.t, r.tables);
    this.processTable(table, true);
    this.refreshAll();
  }

  async copyAs(table, fmt) {
    const r = this.resolve(table);
    if (!r) { new Notice(t('unresolved')); return; }
    const grid = tableGrid(r.t);
    const aligns = r.t.aligns || [];
    const labels = { csv: 'CSV', tsv: 'TSV', html: 'HTML', latex: 'LaTeX' };
    let text = '';
    let html = null;
    if (fmt === 'csv') text = toCSV(grid);
    else if (fmt === 'tsv') text = toTSV(grid);
    else if (fmt === 'latex') text = toLaTeX(grid, aligns);
    else { html = toHTML(grid, aligns); text = html; }
    const win = table.ownerDocument.defaultView || window;
    const nav = win.navigator;
    try {
      if (html && win.ClipboardItem && nav.clipboard.write) {
        await nav.clipboard.write([new win.ClipboardItem({
          'text/html': new win.Blob([html], { type: 'text/html' }),
          'text/plain': new win.Blob([toTSV(grid)], { type: 'text/plain' }),
        })]);
      } else {
        await nav.clipboard.writeText(text);
      }
      new Notice(t('copied', { f: labels[fmt] }));
    } catch (err) {
      try { await nav.clipboard.writeText(text); new Notice(t('copied', { f: labels[fmt] })); } catch (e2) { new Notice(t('copyFailed')); }
    }
  }

  /** 改写笔记里的表格：编辑视图里走 editor（可撤销），否则直接改文件。 */
  async editTable(r, transform) {
    const view = this.editingViewFor(r.path);
    if (view) {
      const ed = view.editor;
      const res = applyTableEdit(ed.getValue(), r.t, transform);
      if (!res) { new Notice(t('editFailed')); return null; }
      ed.replaceRange(res.replacement, { line: res.start, ch: 0 }, { line: res.end, ch: ed.getLine(res.end).length });
      return res;
    }
    const f = this.app.vault.getAbstractFileByPath(r.path);
    if (!(f instanceof TFile)) { new Notice(t('editFailed')); return null; }
    let res = null;
    await this.app.vault.process(f, (data) => {
      res = applyTableEdit(data, r.t, transform);
      return res ? res.newText : data;
    });
    if (!res) new Notice(t('editFailed'));
    return res;
  }

  async transposeTable(table) {
    const r = this.resolve(table);
    if (!r) { new Notice(t('unresolved')); return; }
    await this.transposeResolved(r);
  }

  async transposeResolved(r) {
    const e = this.store.find(r.path, r.t, r.tables);
    const carry = {};
    if (e) {
      for (const k of ['density', 'headerRow', 'headerCol', 'style', 'freezeRow', 'freezeCol']) {
        if (e[k] != null) carry[k] = e[k];
      }
      this.store.removeEntry(r.path, e);
    }
    const res = await this.editTable(r, transposeTransform);
    if (!res) return;
    const tabs = parseTables(res.newText);
    const nt = tabs.find((x) => x.start === res.start);
    if (nt) this.store.patch(r.path, nt, tabs, Object.assign({ widths: null, touched: true }, carry));
    new Notice(t('transposed'));
    this.refreshAll();
  }

  /* ---------------- 命令 ---------------- */

  addCommands() {
    this.addCommand({
      id: 'reset-all-tables-in-note',
      name: t('cmdResetNote'),
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f) return false;
        if (!checking) {
          delete this.data.tables[f.path];
          this.requestSave();
          this.refreshAll();
          new Notice(t('noticeResetNote'));
        }
        return true;
      },
    });

    const tableAtCursor = (editor, view) => {
      const tables = parseTables(editor.getValue());
      const tb = findTableAtLine(tables, editor.getCursor().line, 0);
      return tb && view.file ? { path: view.file.path, t: tb, tables } : null;
    };
    const domTableFor = (view, r) => {
      for (const tb of Array.from(view.containerEl.querySelectorAll('table'))) {
        if (!this.contextOf(tb)) continue;
        const x = this.resolve(tb);
        if (x && x.path === r.path && x.t.start === r.t.start) return tb;
      }
      return null;
    };

    this.addCommand({
      id: 'reset-table-at-cursor',
      name: t('cmdResetCursor'),
      editorCheckCallback: (checking, editor, view) => {
        const r = tableAtCursor(editor, view);
        if (!r) return false;
        if (!checking) { this.store.remove(r.path, r.t, r.tables); this.refreshAll(); }
        return true;
      },
    });

    this.addCommand({
      id: 'fit-table-at-cursor',
      name: t('cmdFitCursor'),
      editorCheckCallback: (checking, editor, view) => {
        const r = tableAtCursor(editor, view);
        if (!r) return false;
        if (!checking) {
          const tb = domTableFor(view, r);
          if (!tb) { new Notice(t('tableNotVisible')); return true; }
          this.fitColumns(tb, this.measure(tb).map((_, k) => k));
        }
        return true;
      },
    });

    this.addCommand({
      id: 'transpose-table-at-cursor',
      name: t('cmdTransposeCursor'),
      editorCheckCallback: (checking, editor, view) => {
        const r = tableAtCursor(editor, view);
        if (!r) return false;
        if (!checking) this.transposeResolved(r);
        return true;
      },
    });
  }
}

/* ====================================================================== */
/* 设置页                                                                 */
/* ====================================================================== */

class TableStudioSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    const s = p.settings;
    const save = () => { p.requestSave(); p.refreshAll(); };
    containerEl.empty();

    containerEl.createEl('p', { text: t('help'), cls: 'setting-item-description' });

    new Setting(containerEl).setName(t('langSet')).setDesc(t('langSetDesc')).addDropdown((d) => {
      d.addOption('auto', t('langAuto'));
      for (const [code, name] of LANGS) d.addOption(code, name);
      d.setValue(s.language || 'auto').onChange((v) => { p.setLanguage(v); this.display(); });
    });

    new Setting(containerEl).setName(t('secLook')).setHeading();

    new Setting(containerEl).setName(t('styleSet')).setDesc(t('styleSetDesc')).addDropdown((d) => {
      for (const x of STYLES) d.addOption(x, t(STYLE_KEYS[x]));
      d.setValue(s.style).onChange((v) => { s.style = v; save(); });
    });

    new Setting(containerEl).setName(t('headerRowSet')).setDesc(t('headerRowSetDesc')).addToggle((x) =>
      x.setValue(s.headerRow).onChange((v) => { s.headerRow = v; save(); }));

    new Setting(containerEl).setName(t('headerColSet')).setDesc(t('headerColSetDesc')).addToggle((x) =>
      x.setValue(s.headerColDefault).onChange((v) => { s.headerColDefault = v; save(); }));

    new Setting(containerEl).setName(t('densitySet')).setDesc(t('densitySetDesc')).addDropdown((d) => {
      for (const k of DENSITIES) d.addOption(k, t('d' + k.toUpperCase()));
      d.setValue(s.density).onChange((v) => { s.density = v; save(); });
    });

    new Setting(containerEl).setName(t('valignSet')).setDesc(t('valignSetDesc')).addDropdown((d) => {
      d.addOption('middle', t('vaMiddle'));
      d.addOption('top', t('vaTop'));
      d.setValue(s.valign).onChange((v) => { s.valign = v; save(); });
    });

    new Setting(containerEl).setName(t('wrap')).setDesc(t('wrapDesc')).addToggle((x) =>
      x.setValue(s.wrap).onChange((v) => { s.wrap = v; save(); }));

    new Setting(containerEl).setName(t('secWidth')).setHeading();

    const num = (name, desc, key, lo, hi) => new Setting(containerEl).setName(name).setDesc(desc)
      .addText((x) => {
        x.inputEl.type = 'number';
        x.setValue(String(s[key])).onChange((v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n >= lo && n <= hi) { s[key] = n; save(); }
        });
      });
    num(t('minW'), t('minWDesc'), 'minWidth', 20, 400);
    num(t('defW'), t('defWDesc'), 'defaultWidth', 40, 1000);
    num(t('maxW'), t('maxWDesc'), 'maxAutoWidth', 100, 2000);

    new Setting(containerEl).setName(t('secGeneral')).setHeading();

    new Setting(containerEl).setName(t('enableReading')).addToggle((x) =>
      x.setValue(s.enableReading).onChange((v) => { s.enableReading = v; save(); }));

    new Setting(containerEl).setName(t('enableLive')).addToggle((x) =>
      x.setValue(s.enableLivePreview).onChange((v) => { s.enableLivePreview = v; save(); }));

    new Setting(containerEl)
      .setName(t('clear'))
      .setDesc(t('clearDesc', { n: p.store.count() }))
      .addButton((b) => b.setButtonText(t('clearBtn')).setWarning().onClick(() => {
        p.data.tables = {};
        p.requestSave();
        p.refreshAll();
        new Notice(t('cleared'));
        this.display();
      }));
  }
}

module.exports = TableStudioPlugin;
