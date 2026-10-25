// ==UserScript==
// @name         刚刚刷到 - PC原型 v0.3
// @namespace    https://example.invalid/just-seen
// @version      0.3.3
// @description  在知乎和小红书网页版信息流中保存当前可见的推荐卡片，刷新后可找回。记录只保存在本地。
// @match        https://www.zhihu.com/*
// @match        https://www.xiaohongshu.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const zhihu = location.hostname === 'www.zhihu.com' && location.pathname === '/';
  const xhs = location.hostname === 'www.xiaohongshu.com' && (
    location.pathname === '/' ||
    location.pathname === '/explore' ||
    location.pathname === '/explore/'
  );
  if (!zhihu && !xhs) return;

  // 只在信息流首页运行；单篇笔记详情页不作为信息流处理。
  const isHome = () =>
    (location.hostname === 'www.zhihu.com' && location.pathname === '/') ||
    (location.hostname === 'www.xiaohongshu.com' && (
      location.pathname === '/' ||
      location.pathname === '/explore' ||
      location.pathname === '/explore/'
    ));

  const SAVE_KEY = 'justseen_snapshots_v01';
  const LIMIT_KEY = 'justseen_limit_v01';
  const PAUSE_KEY = 'justseen_pause_v01';
  const MODE_KEY = 'justseen_mode_v02';
  const TEMP_KEY = 'justseen_reload_temp_v02';
  const SITE = zhihu ? '知乎' : '小红书';
  const CHECK_INTERVAL_MS = 2000;
  const TEXT_MAX_LENGTH = 16000;
  const MIN_TEXT_LENGTH = 60;
  const MAX_VISIBLE_CARDS = 7;
  const MAX_VISIBLE_XHS_CARDS = 15;

  const normalizeLimit = n => Number.isFinite(Number(n))
    ? Math.max(1, Math.min(100, Math.round(Number(n)))) : 20;
  const normalizeForComparison = text => String(text || '').replace(/\s+/g, ' ').trim();

  let history = GM_getValue(SAVE_KEY, []);
  if (!Array.isArray(history)) history = [];
  let limit = normalizeLimit(GM_getValue(LIMIT_KEY, 20));
  let paused = Boolean(GM_getValue(PAUSE_KEY, false));
  let mode = GM_getValue(MODE_KEY, 'protect');
  if (mode !== 'protect' && mode !== 'auto') mode = 'protect';
  let selectedId = null;
  let lastText = '';

  function cardKey(card) {
    if (!card) return '';
    if (card.id) return `id:${card.site || SITE}:${card.id}`;
    if (card.url) return `url:${card.site || SITE}:${card.url}`;
    const title = normalizeForComparison(card.title);
    const text = normalizeForComparison(card.text);
    return title || text ? `text:${title}|${text}` : '';
  }

  const savedCardKeys = new Set();
  for (const item of history) {
    const key = cardKey(item);
    if (key) savedCardKeys.add(key);
  }

  const host = document.createElement('div');
  host.id = 'justseen-pc-host';
  host.style.cssText = 'position:fixed;z-index:2147483647;right:18px;bottom:22px;';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    *{box-sizing:border-box}button,input,textarea{font:inherit}button{cursor:pointer}
    #launch{border:0;border-radius:24px;padding:12px 16px;background:#222c41;color:white;box-shadow:0 5px 20px #0004;font:600 14px system-ui,sans-serif}
    #panel{display:none;width:min(380px,calc(100vw - 36px));max-height:min(600px,calc(100vh - 88px));overflow:auto;background:white;border:1px solid #dce1e9;border-radius:15px;box-shadow:0 14px 44px #0004;color:#202b3e;margin-bottom:8px;padding:15px;font:13px/1.5 system-ui,sans-serif}
    .row{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:9px}.row.wrap{flex-wrap:wrap}
    .mode-box{border:1px solid #edf0f4;border-radius:9px;padding:8px 10px;margin-bottom:10px;background:#fafcff}
    .mode-title{font-weight:600;margin-bottom:6px}.mode-label{display:block;margin:5px 0;cursor:pointer}.mode-label input{margin-right:6px}
    button.small{border:1px solid #ccd4df;border-radius:7px;padding:4px 8px;background:#f7f9fc;color:#202b3e}
    #clear{color:#b92b39}#limit{width:55px;padding:3px 5px;border:1px solid #ccd4df;border-radius:6px}
    #list{border-top:1px solid #edf0f4;margin-top:9px;padding-top:6px}
    .entry{text-align:left;width:100%;display:block;background:white;border:0;border-bottom:1px solid #eff1f5;padding:9px 4px;color:#202b3e}.entry:hover{background:#f5f7fa}
    .date{display:block;font-size:11px;color:#7a8392;margin-bottom:2px}.title{display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .preview{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#566174}
    .author{display:block;font-size:11px;color:#7a8392;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #details{display:none;margin-top:10px}#text{width:100%;height:230px;resize:vertical;padding:8px;border:1px solid #ccd4df;border-radius:7px;background:#fafcff;font:12px/1.5 monospace}
    #url,#imageUrl{width:100%;margin-top:7px;padding:7px;border:1px solid #ccd4df;border-radius:7px;background:#fafcff;font:11px/1.4 monospace}.hint{color:#718096;font-size:11px}
  `;
  shadow.appendChild(style);

  const panel = document.createElement('section');
  panel.id = 'panel';
  panel.innerHTML = `
    <div class="row"><strong>🐒 刚刚刷到 · PC测试版</strong><button class="small" id="close">关闭</button></div>
    <div class="mode-box"><div class="mode-title">记录模式</div>
      <label class="mode-label"><input type="radio" name="justseen-mode" value="protect">刷新保护</label>
      <label class="mode-label"><input type="radio" name="justseen-mode" value="auto">自动记录</label>
    </div>
    <div class="row wrap"><label>保留记录 <input id="limit" type="number" min="1" max="100"> 条</label>
      <button class="small" id="pause">暂停</button><button class="small" id="save">立即记录</button><button class="small" id="clear">清空</button>
    </div>
    <div class="hint" id="status"></div><div id="list"></div>
    <div id="details"><div class="row"><strong id="detailTitle"></strong><button class="small" id="copy">复制文字</button></div>
      <textarea id="text" readonly></textarea><input id="url" readonly placeholder="来源 URL">
      <input id="imageUrl" readonly placeholder="封面图片 URL（如有）">
    </div>
    <p class="hint">刷新保护：主要保存刷新前刚刚看到的内容。自动记录：持续记录新的可见内容。所有记录只保存在本地。</p>
  `;
  shadow.appendChild(panel);
  const launch = document.createElement('button');
  launch.id = 'launch';
  shadow.appendChild(launch);
  const $ = id => shadow.getElementById(id);
  $('limit').value = String(limit);

  function updateModeUI() {
    shadow.querySelectorAll('input[name="justseen-mode"]').forEach(r => r.checked = r.value === mode);
  }

  function updateLaunch() {
    launch.textContent = `🐒 历史 ${history.length}${paused ? ' · 已暂停' : ''}`;
    $('pause').textContent = paused ? '继续' : '暂停';
    updateModeUI();
    if (SITE === '知乎') {
      $('status').textContent = mode === 'protect'
        ? `知乎首页 · 刷新保护 · 当前视口最多保存 ${MAX_VISIBLE_CARDS} 条`
        : `知乎首页 · 自动记录 · 当前视口最多处理 ${MAX_VISIBLE_CARDS} 条`;
    } else {
      $('status').textContent = mode === 'protect'
        ? `小红书信息流 · 刷新保护 · 当前视口最多处理 ${MAX_VISIBLE_XHS_CARDS} 篇`
        : `小红书信息流 · 自动记录 · 当前视口最多处理 ${MAX_VISIBLE_XHS_CARDS} 篇`;
    }
  }

  function currentText() {
    return (document.body?.innerText || '').replace(/\n\s*\n\s*\n+/g, '\n\n')
      .trim().slice(0, TEXT_MAX_LENGTH);
  }

  function getZhihuCardId(card, url, title, text) {
    const zop = card?.getAttribute('data-zop');
    if (zop) {
      try {
        const data = JSON.parse(zop);
        if (data?.itemId) return String(data.itemId);
      } catch {}
    }
    const name = card?.getAttribute('name');
    if (name) return name;
    if (url) return url;
    return `${normalizeForComparison(title)}|${normalizeForComparison(text)}`;
  }

  function extractZhihuCards() {
    const selector =
      '.ContentItem[data-za-detail-view-path-module="AnswerItem"],' +
      '.ContentItem[data-za-detail-view-path-module="PostItem"]';
    const visible = [];
    for (const card of document.querySelectorAll(selector)) {
      const rect = card.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < window.innerHeight) visible.push({ card, rect });
    }
    visible.sort((a, b) => a.rect.top - b.rect.top);
    return visible.slice(0, MAX_VISIBLE_CARDS).map(({card}) => {
      const titleNode = card.querySelector('.ContentItem-title a');
      const title = titleNode?.innerText?.trim() || '';
      const url = titleNode?.href || '';
      const textNode = card.querySelector('[itemprop="text"]') ||
        card.querySelector('[itemprop="articleBody"]') || card;
      const text = textNode?.innerText?.trim() || '';
      if (!title && !text) return null;
      return { id:getZhihuCardId(card,url,title,text), site:'知乎', time:Date.now(), title, text, url, kind:'card' };
    }).filter(Boolean);
  }


  function getXhsNoteIdFromUrl(rawUrl) {
    if (!rawUrl) return '';
    try {
      const parsed = new URL(rawUrl, location.origin);
      const match = parsed.pathname.match(/\/explore\/([^/]+)/);
      return match ? decodeURIComponent(match[1]) : '';
    } catch {
      return '';
    }
  }

  function getXhsCardCandidates() {
    // 依据用户提供的真实小红书首页 DOM：每篇笔记对应一个 section.note-item。
    // 不再用泛化的 section 选择器猜测，避免把页面其他区域误认成笔记。
    return Array.from(document.querySelectorAll('section.note-item'));
  }

  function extractXhsCards() {
    const visible = [];
    for (const card of getXhsCardCandidates()) {
      const rect = card.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 ||
          rect.bottom <= 0 || rect.top >= window.innerHeight ||
          rect.right <= 0 || rect.left >= window.innerWidth) continue;

      // 优先使用标题链接，其次使用封面链接；避免先拿到隐藏的占位链接。
      const titleLink = card.querySelector('a.title[href*="/explore/"]');
      const coverLink = card.querySelector('a.cover[href*="/explore/"]');
      const link = titleLink || coverLink ||
        Array.from(card.querySelectorAll('a[href*="/explore/"]')).find(a => a.getClientRects().length > 0);
      const url = link?.href || '';
      const noteId = getXhsNoteIdFromUrl(url) ||
        card.getAttribute('data-note-id') ||
        card.getAttribute('data-id') || '';

      const titleNode = titleLink || card.querySelector('.title') ||
        card.querySelector('[class*="title"]');
      let title = titleNode?.innerText?.trim() ||
        link?.getAttribute('aria-label')?.trim() || '';

      const authorNode = card.querySelector('.author-wrapper .name, .author .name, .author-name');
      const author = authorNode?.innerText?.trim() || '';

      // 只取笔记封面，不把作者头像误当作笔记图片。
      const coverImage = card.querySelector('a.cover img[data-xhs-img], a.cover img, img[data-preload-cover]');
      const imageUrl = coverImage
        ? (coverImage.currentSrc || coverImage.src || coverImage.getAttribute('data-src') ||
          coverImage.getAttribute('data-original') || '')
        : '';
      const imageAlt = coverImage?.alt?.trim() || '';
      if (!title) title = imageAlt;

      const text = (card.innerText || '').replace(/\n{2,}/g, '\n').trim().slice(0, 1600);
      if (!title && !text && !url && !imageUrl) continue;

      const id = noteId || `${normalizeForComparison(title)}|${normalizeForComparison(author)}`;
      visible.push({
        card: { id, site: '小红书', time: Date.now(), title, author, text, url, imageUrl, kind: 'card' },
        top: rect.top,
        left: rect.left
      });
    }

    visible.sort((a, b) => a.top - b.top || a.left - b.left);
    const unique = new Map();
    for (const item of visible) {
      const key = cardKey(item.card);
      if (key && !unique.has(key)) unique.set(key, item.card);
    }
    return Array.from(unique.values()).slice(0, MAX_VISIBLE_XHS_CARDS);
  }

  function hasSavedCard(card) {
    const key = cardKey(card);
    return !key || savedCardKeys.has(key);
  }

  function saveCards(cards) {
    let changed = false;
    // extractor 按屏幕从上到下返回；反向 unshift 后，历史列表仍保持屏幕顺序。
    for (const card of Array.from(cards || []).reverse()) {
      const key = cardKey(card);
      if (!key || hasSavedCard(card)) continue;
      const item = {
        id: card.id || `${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
        site: card.site || SITE, time:Number.isFinite(card.time) ? card.time : Date.now(),
        title:card.title || '', author:card.author || '', text:card.text || '',
        url:card.url || '', imageUrl:card.imageUrl || '', kind:'card'
      };
      history.unshift(item);
      savedCardKeys.add(key);
      changed = true;
    }
    if (!changed) return;
    history = history.slice(0, limit);
    GM_setValue(SAVE_KEY, history);
    updateLaunch();
    if (panel.style.display === 'block') renderHistory();
  }

  function capturePageText(force = false) {
    if (!isHome() || (paused && !force)) return;
    const text = currentText();
    if (text.length < MIN_TEXT_LENGTH) return;
    const comparisonText = normalizeForComparison(text);
    if (!force && comparisonText === lastText) return;
    lastText = comparisonText;
    if (history.length && history[0].site === SITE &&
        normalizeForComparison(history[0].text) === comparisonText) return;
    history.unshift({id:`${Date.now()}-${Math.random().toString(36).slice(2,7)}`,site:SITE,time:Date.now(),text});
    history = history.slice(0, limit);
    GM_setValue(SAVE_KEY, history);
    updateLaunch();
    if (panel.style.display === 'block') renderHistory();
  }

  function captureAutoCards(force = false) {
    if (!isHome() || (paused && !force)) return;
    if (SITE === '知乎') {
      const cards = extractZhihuCards();
      if (cards.length) saveCards(cards);
    } else {
      const cards = extractXhsCards();
      if (cards.length) saveCards(cards);
    }
  }

  function saveReloadSnapshot() {
    if (!isHome() || paused) return;
    try {
      if (SITE === '知乎') {
        const cards = extractZhihuCards();
        if (!cards.length) return;
        sessionStorage.setItem(TEMP_KEY, JSON.stringify({site:'知乎',time:Date.now(),cards}));
      } else {
        const cards = extractXhsCards();
        if (!cards.length) return;
        sessionStorage.setItem(TEMP_KEY, JSON.stringify({site:'小红书',time:Date.now(),cards}));
      }
    } catch {}
  }

  function restoreReloadSnapshot() {
    let raw;
    try { raw = sessionStorage.getItem(TEMP_KEY); } catch { return; }
    if (!raw) return;
    try { sessionStorage.removeItem(TEMP_KEY); } catch {}
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav?.type !== 'reload') return;

    let snapshot;
    try { snapshot = JSON.parse(raw); } catch { return; }
    if (!snapshot || snapshot.site !== SITE ||
        !Number.isFinite(snapshot.time) || Date.now() - snapshot.time > 30 * 60 * 1000) return;

    if ((SITE === '知乎' || SITE === '小红书') && Array.isArray(snapshot.cards)) {
      saveCards(snapshot.cards);
      return;
    }
    // 兼容升级前遗留的临时整页文字快照；新版本不会再创建此类小红书快照。
    if (typeof snapshot.text !== 'string' || snapshot.text.length < MIN_TEXT_LENGTH) return;
    const comparisonText = normalizeForComparison(snapshot.text);
    if (history.length && history[0].site === SITE &&
        normalizeForComparison(history[0].text) === comparisonText) return;
    history.unshift({id:`${Date.now()}-${Math.random().toString(36).slice(2,7)}`,site:SITE,time:snapshot.time,text:snapshot.text});
    history = history.slice(0, limit);
    GM_setValue(SAVE_KEY, history);
    updateLaunch();
  }

  function renderHistory() {
    const list = $('list');
    list.replaceChildren();
    if (!history.length) {
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
      date.textContent = `${item.site} · ${new Date(item.time).toLocaleString('zh-CN',{hour12:false})}`;
      entry.appendChild(date);
      if (item.kind === 'card' && item.title) {
        const title = document.createElement('span');
        title.className = 'title';
        title.textContent = item.title;
        entry.appendChild(title);
        if (item.author) {
          const author = document.createElement('span');
          author.className = 'author';
          author.textContent = item.author;
          entry.appendChild(author);
        }
        if (item.text) {
          const preview = document.createElement('span');
          preview.className = 'preview';
          preview.textContent = item.text.replace(/\s+/g,' ').slice(0,100);
          entry.appendChild(preview);
        }
      } else {
        const preview = document.createElement('span');
        preview.className = 'preview';
        preview.textContent = (item.text || '').replace(/\s+/g,' ').slice(0,100);
        entry.appendChild(preview);
      }
      entry.addEventListener('click', () => { selectedId = item.id; showDetails(); });
      list.appendChild(entry);
    }
    showDetails();
  }

  function showDetails() {
    const item = history.find(x => x.id === selectedId);
    $('details').style.display = item ? 'block' : 'none';
    if (!item) return;
    $('detailTitle').textContent = item.kind === 'card' && item.title
      ? `${item.site} · ${item.title}`
      : `${item.site} · ${new Date(item.time).toLocaleTimeString('zh-CN',{hour12:false})}`;
    $('text').value = item.text || '';
    $('url').value = item.url || '';
    $('imageUrl').value = item.imageUrl || '';
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
  $('save').addEventListener('click', () => captureAutoCards(true));
  $('clear').addEventListener('click', () => {
    if (!confirm('确定清空「刚刚刷到」的全部记录吗？')) return;
    history = [];
    selectedId = null;
    savedCardKeys.clear();
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
  shadow.querySelectorAll('input[name="justseen-mode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      mode = radio.value;
      GM_setValue(MODE_KEY, mode);
      lastText = '';
      updateLaunch();
    });
  });
  $('copy').addEventListener('click', async () => {
    const txt = $('text').value;
    try {
      await navigator.clipboard.writeText(txt);
      $('copy').textContent = '已复制';
    } catch {
      $('text').focus(); $('text').select(); $('copy').textContent = '已选中，请按 Ctrl+C';
    }
    setTimeout(() => { $('copy').textContent = '复制文字'; }, 2500);
  });

  window.addEventListener('pagehide', () => { if (mode === 'protect') saveReloadSnapshot(); });
  updateLaunch();
  restoreReloadSnapshot();
  setInterval(() => { if (mode === 'auto') captureAutoCards(false); }, CHECK_INTERVAL_MS);
  setTimeout(() => { if (mode === 'auto') captureAutoCards(false); }, 750);
})();