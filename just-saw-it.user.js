// ==UserScript==
// @name         刚刚刷到 - PC原型 v0.1
// @namespace    https://example.invalid/just-seen
// @version      0.1.0
// @description  只在知乎和小红书网页版首页，自动保存可见页面文字的历史快照，刷新后可找回。记录只保存在本地。
// @match        https://www.zhihu.com/*
// @match        https://www.xiaohongshu.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  // PC 验证版仅作用于信息流首页，不读取私信、个人中心和文章详情。
  const isZhihuHome = location.hostname === 'www.zhihu.com' && location.pathname === '/';
  const isXhsHome = location.hostname === 'www.xiaohongshu.com' &&
    (location.pathname === '/' || location.pathname === '/explore');
  if (!isZhihuHome && !isXhsHome) return;

  const isHomepageNow = () => (location.hostname === 'www.zhihu.com' && location.pathname === '/') ||
    (location.hostname === 'www.xiaohongshu.com' &&
      (location.pathname === '/' || location.pathname === '/explore'));

  const SAVE_KEY = 'justseen_snapshots_v01';
  const LIMIT_KEY = 'justseen_limit_v01';
  const PAUSE_KEY = 'justseen_pause_v01';
  const SITE = isZhihuHome ? '知乎' : '小红书';
  const CHECK_INTERVAL_MS = 2000;
  const TEXT_MAX_LENGTH = 16000;
  const MIN_TEXT_LENGTH = 60;

  let history = GM_getValue(SAVE_KEY, []);
  if (!Array.isArray(history)) history = [];
  let limit = normalizeLimit(GM_getValue(LIMIT_KEY, 20));
  let paused = Boolean(GM_getValue(PAUSE_KEY, false));
  let lastText = '';
  let selectedId = null;

  // Shadow DOM 使悬浮按钮样式不受知乎、小红书页面 CSS 影响。
  const host = document.createElement('div');
  host.id = 'justseen-pc-host';
  host.style.cssText = 'position:fixed;z-index:2147483647;right:18px;bottom:22px;';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    * { box-sizing:border-box; }
    button,input,textarea { font:inherit; }
    button { cursor:pointer; }
    #launch { border:0; border-radius:24px; padding:12px 16px; background:#222c41; color:white;
      box-shadow:0 5px 20px #0004; font:600 14px system-ui,sans-serif; }
    #panel { display:none; width:min(360px,calc(100vw - 36px)); max-height:min(520px,calc(100vh - 88px));
      overflow:auto; background:white; border:1px solid #dce1e9; border-radius:15px; box-shadow:0 14px 44px #0004;
      color:#202b3e; margin-bottom:8px; padding:15px; font:13px/1.5 system-ui,sans-serif; }
    .row { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:9px; }
    .row.wrap { flex-wrap:wrap; }
    button.small { border:1px solid #ccd4df; border-radius:7px; padding:4px 8px; background:#f7f9fc; color:#202b3e; }
    #clear { color:#b92b39; }
    #limit { width:55px; padding:3px 5px; border:1px solid #ccd4df; border-radius:6px; }
    #list { border-top:1px solid #edf0f4; margin-top:9px; padding-top:6px; }
    .entry { text-align:left; width:100%; display:block; background:white; border:0;
      border-bottom:1px solid #eff1f5; padding:9px 4px; color:#202b3e; }
    .entry:hover { background:#f5f7fa; }
    .date { display:block; font-size:11px; color:#7a8392; }
    .preview { display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    #details { display:none; margin-top:10px; }
    #text { width:100%; height:230px; resize:vertical; padding:8px; border:1px solid #ccd4df;
      border-radius:7px; background:#fafcff; font:12px/1.5 monospace; }
    .hint { color:#718096; font-size:11px; }
  `;
  shadow.appendChild(style);

  const panel = document.createElement('section');
  panel.id = 'panel';
  panel.innerHTML = `
    <div class="row"><strong>🐒 刚刚刷到 · PC测试版</strong><button class="small" id="close">关闭</button></div>
    <div class="row wrap"><label>保留记录 <input id="limit" type="number" min="1" max="100"> 条</label>
      <button class="small" id="pause">暂停</button><button class="small" id="save">立即记录</button>
      <button class="small" id="clear">清空</button></div>
    <div class="hint" id="status"></div>
    <div id="list"></div>
    <div id="details"><div class="row"><strong id="detailTitle"></strong><button class="small" id="copy">复制文字</button></div>
      <textarea id="text" readonly></textarea></div>
    <p class="hint">只记录本页已有的文字，不过滤广告；不会上传服务器。刷新后打开历史查看。</p>
  `;
  shadow.appendChild(panel);

  const launch = document.createElement('button');
  launch.id = 'launch';
  shadow.appendChild(launch);
  const $ = (id) => shadow.getElementById(id);
  $('limit').value = String(limit);

  function normalizeLimit(n) {
    n = Number(n);
    return Number.isFinite(n) ? Math.max(1, Math.min(100, Math.round(n))) : 20;
  }

  function updateLaunch() {
    launch.textContent = `🐒 历史 ${history.length}${paused ? ' · 已暂停' : ''}`;
    $('pause').textContent = paused ? '继续' : '暂停';
    $('status').textContent = `${SITE}首页 · 每2秒检查文字变化 · ${paused ? '记录已暂停' : '正在自动记录'}`;
  }

  function currentText() {
    // v0.1 不过滤广告与无关 UI；直接取页面目前渲染出来的文字。
    // innerText 不等同于屏幕视野内文字：滚动出视野的已渲染内容也可能包含在内。
    return (document.body?.innerText || '')
      .replace(/\n\s*\n\s*\n+/g, '\n\n')
      .trim()
      .slice(0, TEXT_MAX_LENGTH);
  }

  function capture(force = false) {
    // 单页应用在无刷新跳转后，也绝不记录私信等其他页面。
    if (!isHomepageNow()) return;
    if (paused && !force) return;
    const text = currentText();
    if (text.length < MIN_TEXT_LENGTH) return;
    if (!force && text === lastText) return;
    lastText = text;
    // 与上一条相同就不重复添加，避免用户反复点“立即记录”复制相同数据。
    if (history.length && history[0].text === text && history[0].site === SITE) return;
    history.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      site: SITE, time: Date.now(), text });
    history = history.slice(0, limit);
    GM_setValue(SAVE_KEY, history);
    updateLaunch();
    if (panel.style.display === 'block') renderHistory();
  }

  function renderHistory() {
    const list = $('list');
    list.replaceChildren();
    if (history.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = '还没有记录。请保持首页打开几秒钟，或者点击「立即记录」。';
      list.appendChild(empty);
    }
    for (const item of history) {
      const entry = document.createElement('button');
      entry.className = 'entry';
      const date = document.createElement('span');
      date.className = 'date';
      date.textContent = `${item.site} · ${new Date(item.time).toLocaleString('zh-CN', {hour12:false})}`;
      const preview = document.createElement('span');
      preview.className = 'preview';
      preview.textContent = item.text.replace(/\s+/g, ' ').slice(0, 100);
      entry.append(date, preview);
      entry.addEventListener('click', () => {
        selectedId = item.id;
        showDetails();
      });
      list.appendChild(entry);
    }
    showDetails();
  }

  function showDetails() {
    const item = history.find(x => x.id === selectedId);
    $('details').style.display = item ? 'block' : 'none';
    if (item) {
      $('detailTitle').textContent = `${item.site} · ${new Date(item.time).toLocaleTimeString('zh-CN',{hour12:false})}`;
      $('text').value = item.text;
    }
  }

  launch.addEventListener('click', () => {
    const opening = panel.style.display !== 'block';
    panel.style.display = opening ? 'block' : 'none';
    if (opening) renderHistory();
  });
  $('close').addEventListener('click', () => { panel.style.display = 'none'; });
  $('pause').addEventListener('click', () => {
    paused = !paused;
    GM_setValue(PAUSE_KEY, paused);
    if (!paused) lastText = '';
    updateLaunch();
  });
  $('save').addEventListener('click', () => capture(true));
  $('clear').addEventListener('click', () => {
    if (!confirm('确定清空「刚刚刷到」的全部文字记录吗？')) return;
    history = [];
    selectedId = null;
    GM_setValue(SAVE_KEY, history);
    renderHistory();
    updateLaunch();
  });
  $('limit').addEventListener('change', () => {
    limit = normalizeLimit($('limit').value);
    $('limit').value = String(limit);
    GM_setValue(LIMIT_KEY, limit);
    history = history.slice(0, limit);
    GM_setValue(SAVE_KEY, history);
    updateLaunch();
    renderHistory();
  });
  $('copy').addEventListener('click', async () => {
    const txt = $('text').value;
    try {
      await navigator.clipboard.writeText(txt);
      $('copy').textContent = '已复制';
    } catch {
      $('text').focus();
      $('text').select();
      $('copy').textContent = '已选中，请按 Ctrl+C';
    }
    setTimeout(() => { $('copy').textContent = '复制文字'; }, 2500);
  });

  updateLaunch();
  setInterval(() => capture(false), CHECK_INTERVAL_MS);
  setTimeout(() => capture(false), 750);
})();