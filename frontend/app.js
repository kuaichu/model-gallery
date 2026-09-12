(() => {
  'use strict';

  const apiBase = (window.GALLERY_CONFIG?.apiBaseUrl || 'http://127.0.0.1:8766').replace(/\/+$/, '') + '/';
  function backendUrl(path) {
    return new URL(path.replace(/^\/+/, ''), apiBase).href;
  }
  function projectUrl(project, split = false) {
    const raw = project.previewUrl || project.entry || '';
    if (!raw.startsWith('/projects/')) return raw;
    const url = new URL(backendUrl(raw));
    if (split) url.searchParams.set('split', '1');
    return url.href;
  }

  const $ = (selector, root = document) => root.querySelector(selector);
  const elements = {
    groupList: $('#group-list'),
    groupKicker: $('#group-kicker'),
    workspaceTitle: $('#workspace-title'),
    projectCount: $('#project-count'),
    modelCount: $('#model-count'),
    promptPanel: $('#prompt-panel'),
    promptText: $('#prompt-text'),
    projectSearch: $('#project-search'),
    filterModel: $('#filter-model'),
    sortProjects: $('#sort-projects'),
    projectList: $('#project-list'),
    compareButton: $('#compare-selected'),
    groupDialog: $('#group-dialog'),
    groupForm: $('#group-form'),
    groupDialogTitle: $('#group-dialog-title'),
    projectDialog: $('#project-dialog'),
    projectForm: $('#project-form'),
    projectDialogTitle: $('#project-dialog-title'),
    loginDialog: $('#login-dialog'),
    loginForm: $('#login-form'),
    loginError: $('#login-error'),
    compareDialog: $('#compare-dialog'),
    compareGroupName: $('#compare-group-name'),
    comparisonGrid: $('#comparison-grid'),
    toast: $('#toast')
  };

  const state = {
    library: { groups: [], projects: [] },
    activeGroupId: null,
    search: '',
    model: '',
    sort: 'custom',
    selected: new Set(),
    authenticated: false,
    authExpiresAt: 0
  };
  const authKey = `prompt-gallery-auth:${apiBase}`;
  let authToken = '';
  let authExpiryTimer = null;
  let loginAttempt = 0;
  try { authToken = sessionStorage.getItem(authKey) || ''; } catch {}
  const viewKey = 'prompt-gallery-view-v1';
  let pageScrollLock = null;
  let restoringView = true;
  function saveView() {
    if (restoringView) return;
    try { localStorage.setItem(viewKey, JSON.stringify({group:state.activeGroupId, search:state.search, model:state.model, sort:state.sort, y:pageScrollLock?.y ?? scrollY})); } catch {}
  }
  function restoreView() {
    try {
      const view = JSON.parse(localStorage.getItem(viewKey) || '{}');
      state.activeGroupId = typeof view.group === 'string' ? view.group : null;
      state.search = typeof view.search === 'string' ? view.search : '';
      state.model = typeof view.model === 'string' ? view.model : '';
      state.sort = ['custom','newest','rating','title'].includes(view.sort) ? view.sort : 'custom';
      elements.projectSearch.value = state.search; elements.sortProjects.value = state.sort;
      return Number.isFinite(view.y) ? Math.max(0, view.y) : 0;
    } catch { return 0; }
  }
  const restoreScrollY = restoreView();
  function releasePageScroll() {
    if (!pageScrollLock || document.querySelector('dialog[open]')) return;
    const position = pageScrollLock;
    document.documentElement.classList.remove('modal-open');
    document.documentElement.style.removeProperty('--modal-scroll-x');
    document.documentElement.style.removeProperty('--modal-scroll-y');
    window.scrollTo({left:position.x, top:position.y, behavior:'instant'});
    pageScrollLock = null;
  }
  function openDialog(dialog) {
    if (!pageScrollLock) {
      pageScrollLock = {x:window.scrollX, y:window.scrollY};
      document.documentElement.style.setProperty('--modal-scroll-x', `${-pageScrollLock.x}px`);
      document.documentElement.style.setProperty('--modal-scroll-y', `${-pageScrollLock.y}px`);
      document.documentElement.classList.add('modal-open');
    }
    try { dialog.showModal(); } catch (error) { releasePageScroll(); throw error; }
  }
  let toastTimer;
  const cameraChannel = 'prompt-gallery-camera-v1';
  const readyFrames = new Set();
  let syncTimer;
  let comparisonKey = '';
  let thumbnailsEnabled = true;
  try { thumbnailsEnabled = localStorage.getItem('gallery-thumbnails-enabled') !== 'false'; } catch {}
  const PREVIEW_TIMEOUT = 45000;
  const PREVIEW_GAP = 800;
  let loadingPreview = false;
  let activePreviewLoad = null;
  let viewportTick = 0;
  const observedCards = new Set();
  const renderStates = new WeakMap();

  function cardInViewport(frame, margin = 0) {
    const card = frame.closest('.project-card');
    if (!frame.isConnected || !card || card.hidden) return false;
    const rect = frame.parentElement.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > -margin && rect.top < innerHeight + margin && rect.right > 0 && rect.left < innerWidth;
  }
  function thumbnailsCanLoad() {
    return thumbnailsEnabled && !document.hidden && navigator.onLine !== false && !restoringView && !editingData() && !elements.compareDialog.open;
  }
  function previewStatus(frame, message, retry = false, hidden = false) {
    const status = frame.parentElement.querySelector('.preview-load-status');
    if (!status) return;
    status.hidden = hidden;
    status.querySelector('.preview-load-message').textContent = message;
    status.querySelector('[data-retry-preview]').hidden = !retry;
  }
  function updateThumbnailToggle() {
    const button = $('#thumbnail-toggle');
    button.setAttribute('aria-pressed', String(thumbnailsEnabled));
    button.textContent = `缩略图预览：${thumbnailsEnabled ? '开启' : '暂停'}`;
    button.title = thumbnailsEnabled ? '点击暂停缩略图动画和后续加载' : '点击恢复缩略图动画和排队加载';
    elements.projectList.querySelectorAll('iframe[data-preview-src]:not([src])').forEach(frame => {
      if (frame.dataset.failed === 'true') return;
      const message = !thumbnailsEnabled ? '缩略图已暂停，可放大查看' : navigator.onLine === false ? '网络已断开，恢复后继续' : cardInViewport(frame, 240) ? '等待依次加载…' : '滚动到附近后加载';
      previewStatus(frame, message);
    });
  }
  function nextCardPreview() {
    if (document.hidden || navigator.onLine === false || editingData()) return null;
    if (elements.compareDialog.open) {
      return [...elements.comparisonGrid.querySelectorAll('iframe[data-preview-src]:not([src])')]
        .find(frame => frame.isConnected && frame.dataset.failed !== 'true');
    }
    if (!thumbnailsCanLoad()) return null;
    return [...elements.projectList.querySelectorAll('iframe[data-preview-src]:not([src])')]
      .filter(frame => frame.dataset.failed !== 'true' && cardInViewport(frame, 240))
      .sort((a,b) => Number(cardInViewport(b)) - Number(cardInViewport(a)) || Number(a.closest('.project-card').style.order) - Number(b.closest('.project-card').style.order))[0];
  }
  async function queueCardPreviews() {
    if (loadingPreview) return;
    loadingPreview = true;
    try {
      let frame;
      while ((frame = nextCardPreview())) {
        if (location.protocol === 'https:' && new URL(frame.dataset.previewSrc).protocol !== 'https:') {
          frame.dataset.failed = 'true';
          frame.dataset.previewState = 'error';
          previewStatus(frame, '此作品使用 HTTP，HTTPS 页面无法嵌入；请单独打开');
          continue;
        }
        previewStatus(frame, '正在加载…');
        frame.dataset.previewState = 'loading';
        await new Promise(resolve => {
          let timer, settled = false;
          function finish(result) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            frame.removeEventListener('load', loaded);
            frame.removeEventListener('error', failed);
            if (activePreviewLoad?.frame === frame) activePreviewLoad = null;
            if (result === 'ready') {
              frame.dataset.previewState = 'ready';
              previewStatus(frame, '', false, true);
              configureRendering(frame);
            } else {
              frame.dataset.previewState = result === 'cancelled' ? 'queued' : 'error';
              frame.dataset.failed = String(result !== 'cancelled');
              renderStates.delete(frame);
              frame.removeAttribute('src');
              if (result !== 'cancelled') previewStatus(frame, '预览未能加载，请重试或单独打开', true);
            }
            if (elements.compareDialog.open) updateSyncStatus();
            resolve();
          }
          // Managed pages explicitly acknowledge window.load. A bare iframe load
          // also fires for error documents, so it is insufficient for local assets.
          const loaded = () => { if (frame.dataset.managed !== 'true') finish('ready'); };
          const failed = () => finish('error');
          activePreviewLoad = {frame, finish};
          frame.addEventListener('load', loaded);
          frame.addEventListener('error', failed);
          timer = setTimeout(failed, PREVIEW_TIMEOUT);
          frame.src = frame.dataset.previewSrc;
        });
        await new Promise(resolve => setTimeout(resolve, PREVIEW_GAP));
      }
    } finally { loadingPreview = false; }
  }

  function editingData() {
    return elements.projectDialog.open || elements.groupDialog.open || elements.loginDialog.open || $('#delete-dialog').open;
  }
  function configureRendering(frame) {
    const comparison = frame.closest('#comparison-grid');
    const paused = document.hidden || editingData() || (comparison ? !elements.compareDialog.open : !thumbnailsEnabled || elements.compareDialog.open || !cardInViewport(frame));
    if (renderStates.get(frame) === !!paused) return;
    renderStates.set(frame, !!paused);
    frame.contentWindow?.postMessage({channel:'prompt-gallery-render-v1', type:'configure', paused:!!paused}, '*');
  }
  function updateRendering() {
    if (activePreviewLoad && (!activePreviewLoad.frame.isConnected || activePreviewLoad.frame.closest('.project-card')?.hidden || (activePreviewLoad.frame.closest('#comparison-grid') && !elements.compareDialog.open))) activePreviewLoad.finish('cancelled');
    document.querySelectorAll('.preview-frame iframe, .comparison-preview iframe').forEach(configureRendering);
    updateThumbnailToggle();
    queueCardPreviews();
  }
  function scheduleViewportUpdate() {
    if (viewportTick) return;
    viewportTick = requestAnimationFrame(() => { viewportTick = 0; updateRendering(); });
  }
  const cardObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(scheduleViewportUpdate, {rootMargin:'240px 0px'}) : null;
  function observeCardPreviews() {
    const wrappers = new Set(elements.projectList.querySelectorAll('.preview-frame'));
    for (const wrapper of observedCards) {
      if (!wrappers.has(wrapper)) { cardObserver?.unobserve(wrapper); observedCards.delete(wrapper); }
    }
    for (const wrapper of wrappers) {
      if (!observedCards.has(wrapper)) { observedCards.add(wrapper); cardObserver?.observe(wrapper); }
    }
  }
  window.addEventListener('message', event => {
    if (event.data?.channel !== 'prompt-gallery-render-v1') return;
    const frame = [...document.querySelectorAll('.preview-frame iframe, .comparison-preview iframe')].find(frame => frame.contentWindow === event.source);
    if (!frame) return;
    if (event.data.type === 'ready') { renderStates.delete(frame); configureRendering(frame); }
    if (event.data.type === 'loaded' && activePreviewLoad?.frame === frame && frame.dataset.managed === 'true') activePreviewLoad.finish('ready');
  });
  const splitFrames = () => [...elements.comparisonGrid.querySelectorAll('iframe')];
  const sendCamera = (frame, type, extra = {}) => frame.contentWindow?.postMessage({channel:cameraChannel, type, ...extra}, '*');
  function updateSyncStatus() {
    const total = splitFrames().length;
    const loading = splitFrames().some(frame => !['ready','error'].includes(frame.dataset.previewState));
    $('#sync-status').textContent = readyFrames.size >= 2
      ? `${readyFrames.size}/${total} 个作品可联动${$('#sync-camera').checked ? ' · 已开启' : ' · 独立操作'}`
      : loading ? '正在按序加载作品视角…' : '需要至少两个支持相机接口的作品；当前可独立查看';
    $('#align-camera').disabled = readyFrames.size < 2 || !readyFrames.has(splitFrames()[0]);
  }
  window.addEventListener('message', event => {
    if (event.data?.channel !== cameraChannel) return;
    const frame = splitFrames().find(item => item.contentWindow === event.source);
    if (!frame) return;
    if (event.data.type === 'ready') {
      readyFrames.add(frame);
      sendCamera(frame, 'configure', {enabled:elements.compareDialog.open && $('#sync-camera').checked});
      updateSyncStatus();
      if (elements.compareDialog.open && readyFrames.size >= 2 && readyFrames.has(splitFrames()[0]) && $('#sync-camera').checked) sendCamera(splitFrames()[0], 'read');
    } else if (event.data.type === 'unsupported') {
      updateSyncStatus();
    } else if (elements.compareDialog.open && event.data.type === 'camera' && readyFrames.has(frame) && ($('#sync-camera').checked || event.data.align)) {
      readyFrames.forEach(other => { if (other !== frame) sendCamera(other, 'camera', {state:event.data.state, align:event.data.align === true}); });
    }
  });
  // Render each project at a usable desktop viewport, then fit the whole page.
  const previewObserver = new ResizeObserver(entries => {
    for (const { target } of entries) {
      const frame = target.querySelector('iframe');
      if (!frame) continue;
      if (!target.clientWidth || !target.clientHeight) continue;
      if (target.closest('.is-single')) {
        const native = $('#single-sizing').value === 'native';
        const width = native ? target.clientWidth : 1280;
        const height = native ? target.clientHeight : 900;
        const scale = native ? 1 : Math.min(target.clientWidth / width, target.clientHeight / height);
        frame.style.width = `${width}px`;
        frame.style.height = `${height}px`;
        frame.style.transform = `scale(${scale})`;
        frame.style.left = `${Math.max(0, (target.clientWidth - width * scale) / 2)}px`;
        frame.style.top = `${Math.max(0, (target.clientHeight - height * scale) / 2)}px`;
        continue;
      }
      frame.style.left = '0px'; frame.style.top = '0px';
      if (target.closest('.is-split')) {
        frame.style.width = `${target.clientWidth}px`;
        frame.style.height = `${target.clientHeight}px`;
        frame.style.transform = 'none';
        continue;
      }
      const scale = target.clientWidth / 1280;
      frame.style.width = '1280px';
      frame.style.height = '800px';
      frame.style.transform = `scale(${scale})`;
    }
  });

  function fitPreviews() {
    previewObserver.disconnect();
    document.querySelectorAll('.preview-frame, .comparison-preview').forEach(target => previewObserver.observe(target));
    observeCardPreviews();
    updateRendering();
  }

  const escapeHTML = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
  const byId = (items, id) => items.find((item) => item.id === id);
  const groupFor = (project) => byId(state.library.groups, project.groupId);
  const activeGroup = () => state.activeGroupId ? byId(state.library.groups, state.activeGroupId) : null;

  function showToast(message) {
    clearTimeout(toastTimer);
    (document.querySelector('dialog[open]') || document.body).appendChild(elements.toast);
    elements.toast.textContent = message;
    elements.toast.classList.add('is-visible');
    toastTimer = setTimeout(() => elements.toast.classList.remove('is-visible'), 2800);
  }

  function setAuthState(authenticated, token = '') {
    const changed = state.authenticated !== !!authenticated;
    state.authenticated = !!authenticated;
    authToken = authenticated ? token || authToken : '';
    if (!authenticated) {
      state.authExpiresAt = 0;
      clearTimeout(authExpiryTimer);
      authExpiryTimer = null;
    }
    document.documentElement.classList.toggle('is-admin', state.authenticated);
    document.documentElement.classList.toggle('is-guest', !state.authenticated);
    try {
      if (authToken) sessionStorage.setItem(authKey, authToken);
      else sessionStorage.removeItem(authKey);
    } catch {}
    if (changed) {
      [elements.groupDialog, elements.projectDialog, $('#delete-dialog')].forEach(dialog => { if (dialog.open) dialog.close(); });
    }
    if (!state.authenticated) {
      dragState = null;
    }
  }

  function scheduleAuthExpiry(expiresAt) {
    clearTimeout(authExpiryTimer);
    state.authExpiresAt = Number.isFinite(Number(expiresAt)) ? Number(expiresAt) : 0;
    if (!state.authExpiresAt) return;
    const delay = Math.min(2147483647, Math.max(0, state.authExpiresAt * 1000 - Date.now()));
    authExpiryTimer = setTimeout(async () => {
      if (!state.authenticated) return;
      if (state.authExpiresAt * 1000 > Date.now()) {
        scheduleAuthExpiry(state.authExpiresAt);
        return;
      }
      setAuthState(false);
      await loadLibrary();
      showToast('登录已过期，请重新登录。');
    }, delay);
  }

  function requireAdmin() {
    if (state.authenticated) return true;
    showToast('请先登录管理员账号。');
    return false;
  }

  let unauthorizedRefresh = false;
  async function handleUnauthorized(refreshLibrary) {
    const wasAuthenticated = state.authenticated || !!authToken;
    setAuthState(false);
    if (wasAuthenticated) showToast('登录已失效，请重新登录。');
    if (refreshLibrary && !unauthorizedRefresh) {
      unauthorizedRefresh = true;
      try { await loadLibrary(); } finally { unauthorizedRefresh = false; }
    }
  }

  async function request(url, options = {}, meta = {}) {
    const sentToken = authToken;
    const headers = new Headers(options.headers || {});
    const multipart = typeof FormData !== 'undefined' && options.body instanceof FormData;
    if (options.body && !multipart && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (authToken) headers.set('Authorization', `Bearer ${authToken}`);
    const response = await fetch(backendUrl(url), {
      ...options,
      headers
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      await handleUnauthorized(meta.refreshOn401 !== false && url !== '/api/auth/session' && url !== '/api/library');
      if (url === '/api/library' && sentToken && !meta.retried) {
        return request(url, options, {...meta, retried:true, refreshOn401:false});
      }
    }
    if (!response.ok) throw new Error(data.error || '操作没有完成，请稍后重试。');
    return data;
  }

  async function restoreSession() {
    if (authToken) {
      try {
        const session = await request('/api/auth/session', {}, {refreshOn401:false});
        setAuthState(true, authToken);
        scheduleAuthExpiry(session.expiresAt);
      } catch {
        setAuthState(false);
      }
    } else setAuthState(false);
    await loadLibrary();
  }

  async function loadLibrary() {
    try {
      const data = await request('/api/library');
      state.library = {
        groups: Array.isArray(data.groups) ? data.groups : [],
        projects: Array.isArray(data.projects) ? data.projects : []
      };
      if (state.activeGroupId && !activeGroup()) state.activeGroupId = null;
      state.selected = new Set([...state.selected].filter((id) => byId(state.library.projects, id)));
      const selectedProjects = [...state.selected].map(id => byId(state.library.projects, id));
      if (new Set(selectedProjects.map(project => project.groupId)).size > 1) state.selected.clear();
      render();
      elements.filterModel.value = state.model;
      if (restoringView) requestAnimationFrame(() => { scrollTo(0, restoreScrollY); restoringView = false; updateRendering(); });
    } catch (error) {
      elements.projectList.innerHTML = `<div class="empty-state"><div><p>作品库暂时无法读取</p><small>${escapeHTML(error.message)}</small></div></div>`;
      showToast(error.message);
    }
  }

  function modelFamily(model) {
    const original = String(model || '').trim();
    // Accept model IDs such as anthropic/claude-sonnet-4 and qwen:qwen3-coder.
    const name = original.normalize('NFKC').replace(/[‐‑–—_]/g, '-').replace(
      /^(?:(?:openrouter|openai|anthropic|google|google-deepmind|meta|meta-llama|qwen|alibaba|deepseek|deepseek-ai|mistralai|mistral|x-ai|xai|moonshotai|moonshot|z-ai|zai|zhipu|thudm|minimax|xiaomi|tencent|baidu|bytedance|stepfun|meituan|microsoft|nvidia|amazon|cohere|ai21|tiiuae|ibm-granite|allenai|nousresearch|liquid|upstage|lgai-exaone|rekaai)[/:]\s*)+/i, ''
    );
    const families = [
      ['Gemini', 'gemini|双子座'],
      ['GPT', 'gpt|chatgpt|o[134](?:-mini|-pro)?'],
      ['Claude', 'claude|克劳德'],
      ['DeepSeek', 'deepseek|deep-seek|深度求索'],
      ['Qwen', 'qwen|qwq|qvq|通义千问|通义|千问'],
      ['Muse Spark', 'muse[ -]*spark'],
      ['MiMo', 'mimo(?:x)?'],
      ['MiniMax', 'minimax|mini-max|abab'],
      ['Hy', 'hy|hunyuan|hunyuan-turbos|混元|腾讯混元'],
      ['Grok', 'grok'],
      ['Kimi', 'kimi|moonshot'],
      ['GLM', 'glm|chatglm|智谱|智谱清言'],
      ['Doubao', 'doubao|豆包'],
      ['Seed', 'seed|seed-oss'],
      ['ERNIE', 'ernie|文心|文心一言'],
      ['Step', 'step|stepfun|阶跃星辰'],
      ['LongCat', 'longcat|long-cat'],
      ['Baichuan', 'baichuan|百川'],
      ['Yi', 'yi|零一万物'],
      ['SenseNova', 'sensenova|sensechat|日日新|商汤日日新'],
      ['InternLM', 'internlm|书生|书生浦语'],
      ['Spark', 'spark|sparkdesk|讯飞星火|星火'],
      ['TeleChat', 'telechat|星辰'],
      ['CodeGeeX', 'codegeex'],
      ['Nemotron', 'nemotron|llama[ -]\\d+(?:[.-]\\d+)*[ -]nemotron'],
      ['Llama', 'llama|meta-llama'],
      ['Gemma', 'gemma|codegemma|paligemma|medgemma'],
      ['Mistral', 'mistral|mixtral|ministral|magistral|devstral|codestral|pixtral'],
      ['Phi', 'phi'],
      ['MAI', 'mai'],
      ['Nova', 'nova|amazon-nova'],
      ['Titan', 'titan|amazon-titan'],
      ['Command', 'command|cohere-command'],
      ['Aya', 'aya'],
      ['Jamba', 'jamba'],
      ['Jurassic', 'jurassic|j2'],
      ['Falcon', 'falcon'],
      ['Granite', 'granite'],
      ['OLMo', 'olmo|olmoe'],
      ['DBRX', 'dbrx'],
      ['Reka', 'reka'],
      ['LFM', 'lfm|liquid'],
      ['Solar', 'solar'],
      ['EXAONE', 'exaone'],
      ['Hermes', 'hermes|deephermes'],
      ['DeepCoder', 'deepcoder'],
      ['Dolphin', 'dolphin'],
      ['SmolLM', 'smollm'],
      ['Stable LM', 'stable[ -]*lm'],
      ['Arctic', 'arctic|snowflake-arctic'],
      ['Apertus', 'apertus'],
      ['Dots', 'dots|dots1'],
      ['Ling', 'ling|ring|bailing|百灵'],
      ['CWM', 'cwm'],
    ];
    // Boundaries stop unrelated names like "Phoenix" or "Yiwu" being grouped.
    // Unknown names remain visible without guessing a provider.
    return families.find(([, aliases]) => new RegExp(`^(?:${aliases})(?=$|[\\s.\\-/:()+]|\\d)`, 'i').test(name))?.[0] || original || '待补充';
  }

  function filteredProjects() {
    const keyword = state.search.trim().toLocaleLowerCase();
    const projects = state.library.projects.filter((project) => {
      const matchesGroup = !state.activeGroupId || project.groupId === state.activeGroupId;
      const matchesModel = !state.model || modelFamily(project.model) === state.model;
      const searchText = [project.title, project.model, project.modelProvider, project.agentTool, project.notes, groupFor(project)?.title].join(' ').toLocaleLowerCase();
      return matchesGroup && matchesModel && (!keyword || searchText.includes(keyword));
    });
    return projects.sort((a, b) => {
      if (state.sort === 'custom') {
        const rankA = a.displayOrder ?? Number.MAX_SAFE_INTEGER;
        const rankB = b.displayOrder ?? Number.MAX_SAFE_INTEGER;
        if (rankA !== rankB) return rankA - rankB;
      }
      if (state.sort === 'rating') return Number(b.rating || 0) - Number(a.rating || 0) || String(a.title).localeCompare(String(b.title), 'zh-CN');
      if (state.sort === 'title') return String(a.title).localeCompare(String(b.title), 'zh-CN');
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
  }

  function renderGroupList() {
    const allCount = state.library.projects.length;
    const groups = [{ id: '', title: '所有作品', count: allCount, all: true }, ...state.library.groups.map((group) => ({
      ...group,
      count: state.library.projects.filter((project) => project.groupId === group.id).length
    }))];
    elements.groupList.innerHTML = groups.map((group, index) => `
      <button class="group-item ${String(group.id) === String(state.activeGroupId || '') ? 'is-active' : ''}" type="button" data-group-id="${escapeHTML(group.id)}">
        <span class="group-item-mark">${group.all ? '□' : String(index).padStart(2, '0')}</span>
        <span class="group-item-title">${escapeHTML(group.title)}</span>
        <span class="group-item-count">${group.count}</span>
      </button>`).join('');
  }

  function renderModelFilter() {
    const previous = state.model;
    const scopedProjects = state.library.projects.filter(project => !state.activeGroupId || project.groupId === state.activeGroupId);
    const families = new Map();
    scopedProjects.forEach(project => {
      const family = modelFamily(project.model);
      if (!families.has(family)) families.set(family, new Set());
      families.get(family).add(project.model?.trim() || '待补充');
    });
    const models = [...families.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    elements.filterModel.innerHTML = `<option value="">全部模型系列</option>${models.map(model => {
      return `<option value="${escapeHTML(model)}">${escapeHTML(model)}</option>`;
    }).join('')}`;
    elements.filterModel.value = models.includes(previous) ? previous : '';
    state.model = elements.filterModel.value;
  }

  function renderHeader(projects) {
    const group = activeGroup();
    elements.groupKicker.textContent = group ? '同题实验 / PROMPT COHORT' : '全部档案 / PROMPT GALLERY';
    elements.workspaceTitle.textContent = group ? group.title : '所有作品';
    elements.projectCount.textContent = projects.length;
    elements.modelCount.textContent = new Set(projects.map((project) => project.model || '待补充')).size;
    elements.promptPanel.hidden = !group;
    if (group) elements.promptText.textContent = group.prompt || '这组作品尚未补录统一提示词。点击右上角补充，才能让后续比较有据可循。';
  }

  function rating(value) {
    const score = Number(value || 0);
    return score ? `${'★'.repeat(score)}${'☆'.repeat(5 - score)}` : '<span class="is-empty">未评分</span>';
  }

  function completionText(project) {
    const seconds = project.durationSeconds;
    if (seconds == null) return '未填写';
    const minutes = Math.floor(seconds / 60);
    return minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
  }

  function projectCard(project, index) {
    const selected = state.selected.has(project.id);
    const title = escapeHTML(project.title || '未命名作品');
    const model = escapeHTML(project.model || '待补充');
    const preview = escapeHTML(projectUrl(project));
    const notes = escapeHTML(project.notes || '尚未记录观察笔记。');
    return `<article class="project-card" data-project-id="${escapeHTML(project.id)}" style="--delay:${Math.min(index, 10) * 35}ms">
      <button class="drag-handle" type="button" data-admin-only data-drag-id="${escapeHTML(project.id)}" aria-label="调整${title}的顺序：拖动或按方向键移动" title="拖动排序，也可用方向键移动">⠿ <span>排序</span></button>
      <label class="compare-check" title="加入同题对比">
        <input class="compare-toggle" type="checkbox" data-select-id="${escapeHTML(project.id)}" ${selected ? 'checked' : ''}>
        <span>对比</span>
      </label>
      <div class="preview-frame">
        ${preview ? `<div class="preview-load-status"><span class="preview-load-message">等待依次加载…</span><button type="button" data-retry-preview="${escapeHTML(project.id)}" hidden>重新加载</button></div><iframe data-managed="${String((project.previewUrl || project.entry || '').startsWith('/projects/'))}" data-preview-src="${preview}" title="${title} 的作品缩略预览" sandbox="allow-scripts allow-pointer-lock" referrerpolicy="no-referrer"></iframe>` : '<div class="preview-placeholder">没有可预览的入口</div>'}
        <button class="preview-open" type="button" data-preview-project="${escapeHTML(project.id)}">放大预览 <span>↗</span></button>
      </div>
      <div class="project-card-body">
        <div class="project-card-top"><span class="project-index">{ ${String(index + 1).padStart(2, '0')} }</span><span class="rating" aria-label="评分">${rating(project.rating)}</span></div>
        <button class="project-name" type="button" data-project-title="${escapeHTML(project.id)}">${title}</button>
        <p class="project-model">${model} · ${escapeHTML(project.reasoningEffort || '未设置')}</p>
        <p class="project-model">${escapeHTML(project.modelProvider || '未填写')} · ${escapeHTML(project.agentTool || '未填写')}</p>
        <p class="project-model">${completionText(project)}</p>
        <p class="project-model">${escapeHTML(project.projectDate || '未填写')}</p>
        <p class="project-notes">${notes}</p>
        <div class="project-actions">
          <a href="${preview}" target="_blank" rel="noopener noreferrer">打开</a>
          <button type="button" data-admin-only data-edit-project="${escapeHTML(project.id)}">编辑</button>
          <button type="button" data-admin-only data-delete-project="${escapeHTML(project.id)}">移除</button>
        </div>
      </div>
    </article>`;
  }

  function renderProjects(projects) {
    const existing = new Map([...elements.projectList.querySelectorAll('[data-project-id]')].map(card => [card.dataset.projectId, card]));
    const validIds = new Set(state.library.projects.map(project => project.id));
    const visibleIds = new Set(projects.map(project => project.id));
    for (const [id, card] of existing) {
      if (!validIds.has(id)) { card.remove(); existing.delete(id); }
      else card.hidden = !visibleIds.has(id);
    }
    elements.projectList.querySelector('.empty-state')?.remove();
    projects.forEach((project, index) => {
      // Selection and display order do not change the embedded project.
      const { displayOrder, source, ...content } = project;
      const signature = JSON.stringify(content);
      let card = existing.get(project.id);
      if (!card || card.dataset.signature !== signature) {
        const template = document.createElement('template');
        template.innerHTML = projectCard(project, index);
        const replacement = template.content.firstElementChild;
        replacement.dataset.signature = signature;
        if (card) card.replaceWith(replacement);
        else elements.projectList.appendChild(replacement);
        card = replacement;
      }
      card.hidden = false;
      // CSS order avoids detaching an existing iframe, which reloads it.
      card.style.order = index;
      card.classList.toggle('is-only', projects.length === 1);
      card.querySelector('.project-index').textContent = `{ ${String(index + 1).padStart(2, '0')} }`;
      card.querySelector('[data-select-id]').checked = state.selected.has(project.id);
    });
    if (!projects.length) {
      const hasSearch = state.search || state.model;
      elements.projectList.insertAdjacentHTML('beforeend', `<div class="empty-state"><div><p>${hasSearch ? '没有符合条件的作品' : '这里还没有作品'}</p><small>${hasSearch ? '换个关键词或模型筛选试试。' : '作品收录后会显示在这里。'}</small>${hasSearch ? '' : '<br><button class="primary-button" type="button" data-open-project data-admin-only>＋ 收录作品</button>'}</div></div>`);
    }
    fitPreviews();
    queueCardPreviews();
  }

  function updateCompareButton() {
    const selected = [...state.selected].map((id) => byId(state.library.projects, id)).filter(Boolean);
    elements.compareButton.disabled = selected.length < 2;
    elements.compareButton.innerHTML = `对比已选 <span>${selected.length}</span>`;
  }

  function render() {
    renderGroupList();
    renderModelFilter();
    const projects = filteredProjects();
    renderHeader(projects);
    renderProjects(projects);
    updateCompareButton();
  }

  function openGroupDialog(group = null) {
    if (!requireAdmin()) return;
    elements.groupForm.reset();
    elements.groupForm.dataset.id = group?.id || '';
    elements.groupDialogTitle.textContent = group ? '编辑提示词组' : '新建提示词组';
    elements.groupForm.elements.title.value = group?.title || '';
    elements.groupForm.elements.prompt.value = group?.prompt || '';
    openDialog(elements.groupDialog);
    updateRendering();
    elements.groupForm.elements.title.focus();
  }

  function populateProjectGroups(selectedGroupId) {
    const select = elements.projectForm.elements.groupId;
    select.innerHTML = state.library.groups.map((group) => `<option value="${escapeHTML(group.id)}">${escapeHTML(group.title)}</option>`).join('');
    select.value = selectedGroupId || state.activeGroupId || state.library.groups[0]?.id || '';
  }

  function openProjectDialog(project = null) {
    if (!requireAdmin()) return;
    if (!project && !state.library.groups.length) {
      showToast('先建立一个提示词组，再收录作品。');
      openGroupDialog();
      return;
    }
    elements.projectForm.reset();
    elements.projectDialogTitle.textContent = project ? '编辑作品' : '收录作品';
    const form = elements.projectForm.elements;
    form.id.value = project?.id || '';
    form.title.value = project?.title || '';
    form.model.value = project?.model === '待补充' ? '' : project?.model || '';
    form.htmlFile.required = !project;
    $('#project-file-hint').textContent = project
      ? `已保留当前作品${project.originalFilename ? '（' + project.originalFilename + '）' : ''}。不选择文件只更新信息；选择新 HTML 可替换作品，原副本仍保留。最大 20 MB。`
      : '上传可独立运行的 HTML 文件（UTF-8，最大 20 MB）。图片、样式和脚本应内嵌，或使用可公开访问的 HTTPS 资源。';
    $('#project-save-status').textContent = '';
    form.notes.value = project?.notes || '';
    form.rating.value = String(project?.rating || 0);
    form.reasoningEffort.value = project?.reasoningEffort || '';
    form.projectDate.value = project?.projectDate || '';
    form.modelProvider.value = project?.modelProvider || '';
    form.agentTool.value = project?.agentTool || '';
    form.durationMinutes.value = project?.durationSeconds == null ? '' : String(Math.floor(project.durationSeconds / 60));
    form.durationRemainder.value = project?.durationSeconds == null ? '' : String(project.durationSeconds % 60);
    populateProjectGroups(project?.groupId);
    openDialog(elements.projectDialog);
    updateRendering();
    form.title.focus();
  }

  async function saveGroup(event) {
    event.preventDefault();
    if (!requireAdmin()) return;
    const id = elements.groupForm.dataset.id;
    const payload = Object.fromEntries(new FormData(elements.groupForm));
    const button = $('button[type="submit"]', elements.groupForm);
    button.disabled = true;
    try {
      const saved = await request(id ? `/api/groups/${encodeURIComponent(id)}` : '/api/groups', {
        method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload)
      });
      elements.groupDialog.close();
      state.activeGroupId = saved.id;
      await loadLibrary();
      showToast(id ? '提示词组已更新。' : '新的提示词组已建立。');
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function saveProject(event) {
    event.preventDefault();
    if (!requireAdmin()) return;
    const values = Object.fromEntries(new FormData(elements.projectForm));
    delete values.htmlFile;
    const id = values.id;
    delete values.id;
    values.rating = Number(values.rating || 0);
    values.durationSeconds = values.durationMinutes === '' && values.durationRemainder === '' ? null : Number(values.durationMinutes || 0) * 60 + Number(values.durationRemainder || 0);
    delete values.durationMinutes;
    delete values.durationRemainder;
    const button = $('button[type="submit"]', elements.projectForm);
    if (button.disabled) return;
    const file = elements.projectForm.elements.htmlFile.files[0];
    const status = $('#project-save-status');
    if (!id && !file) { status.textContent = '请选择一个 HTML 作品文件。'; return; }
    if (file && (!/\.html?$/i.test(file.name) || !file.size || file.size > 20 * 1024 * 1024)) {
      status.textContent = '请选择不超过 20 MB 的非空 .html 或 .htm 文件。';
      return;
    }
    let body = JSON.stringify(values);
    if (file) {
      body = new FormData();
      body.append('metadata', JSON.stringify(values));
      body.append('file', file, file.name);
    }
    button.disabled = true;
    status.textContent = file ? '正在上传并保存，请稍候…' : '正在保存…';
    try {
      await request(id ? `/api/projects/${encodeURIComponent(id)}` : '/api/projects', {
        method: id ? 'PATCH' : 'POST', body
      });
      elements.projectDialog.close();
      await loadLibrary();
      showToast(id ? '作品信息已更新。' : '作品已收录到对照库。');
    } catch (error) {
      status.textContent = error.message;
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function deleteProject(project) {
    if (!requireAdmin() || !project) return;
    const dialog = $('#delete-dialog');
    $('#delete-message').textContent = `确定移除「${project.title}」的记录吗？`;
    dialog.returnValue = 'cancel';
    const confirmed = new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'remove'), {once:true}));
    openDialog(dialog);
    updateRendering();
    if (!await confirmed) return;
    try {
      await request(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
      state.selected.delete(project.id);
      await loadLibrary();
      showToast('作品记录已移除。');
    } catch (error) {
      showToast(error.message);
    }
  }

  function selectProject(id, checked) {
    const project = byId(state.library.projects, id);
    if (!project) return;
    if (checked) {
      const alreadySelected = [...state.selected].map((item) => byId(state.library.projects, item)).filter(Boolean);
      const incompatible = alreadySelected.some((item) => item.groupId !== project.groupId);
      if (incompatible) {
        showToast('一次对比只能选择同一个提示词组的作品。');
        render();
        return;
      }
      if (state.selected.size >= 3) {
        showToast('一次最多并排对比 3 件作品。');
        render();
        return;
      }
      state.selected.add(id);
    } else {
      state.selected.delete(id);
    }
    updateCompareButton();
  }

  function openComparison(singleProject = null) {
    const projects = singleProject ? [singleProject] : [...state.selected].map((id) => byId(state.library.projects, id)).filter(Boolean);
    if (!projects.length || (!singleProject && projects.length < 2) || new Set(projects.map(project => project.groupId)).size !== 1) return;
    elements.compareDialog.querySelector('h2').textContent = singleProject ? '作品预览' : '实时分屏对比';
    const nextKey = JSON.stringify([!!singleProject, projects]);
    const reuse = nextKey === comparisonKey;
    if (!reuse) readyFrames.clear();
    clearTimeout(syncTimer);
    elements.compareDialog.classList.toggle('is-split', !singleProject);
    elements.compareDialog.classList.toggle('is-single', !!singleProject);
    $('#single-info').hidden = true;
    $('#single-info-toggle').setAttribute('aria-expanded', 'false');
    if (singleProject) {
      $('#single-name').textContent = singleProject.title;
      $('#single-model').textContent = [singleProject.model, singleProject.reasoningEffort].filter(Boolean).join(' · ');
      $('#single-open').href = projectUrl(singleProject);
      $('#single-info').innerHTML = `<p>${escapeHTML(groupFor(singleProject)?.title || '')}</p><p>${escapeHTML(singleProject.modelProvider || '未填写')} · ${escapeHTML(singleProject.agentTool || '未填写')}</p><p>${completionText(singleProject)} · ${escapeHTML(singleProject.projectDate || '未填写')}</p><p>${rating(singleProject.rating)}</p><p>${escapeHTML(singleProject.notes || '尚未记录观察笔记。')}</p>`;
    }
    $('#split-toolbar').hidden = !!singleProject;
    $('#sync-camera').checked = false;
    $('#sync-switch-label').textContent = '已关闭';
    $('#align-camera').disabled = true;
    $('#sync-status').textContent = '正在连接作品视角…';
    const group = groupFor(projects[0]);
    elements.compareGroupName.textContent = group?.title || '未命名提示词组';
    elements.comparisonGrid.style.setProperty('--columns', projects.length);
    if (!reuse) elements.comparisonGrid.innerHTML = projects.map((project) => {
      const title = escapeHTML(project.title || '未命名作品');
      const model = escapeHTML(project.model || '待补充');
      const notes = escapeHTML(project.notes || '尚未记录观察笔记。');
      const preview = escapeHTML(projectUrl(project));
      const framePreview = escapeHTML(projectUrl(project, !singleProject));
      return `<article class="comparison-column"><h3>${title}</h3><p class="comparison-model">${model} · ${escapeHTML(project.reasoningEffort || '未设置')} · ${rating(project.rating)}</p><p class="project-model">${escapeHTML(project.modelProvider || '未填写')} · ${escapeHTML(project.agentTool || '未填写')}</p><p class="project-model">${completionText(project)}</p><p class="project-model">${escapeHTML(project.projectDate || '未填写')}</p><div class="comparison-preview">${preview ? `<div class="preview-load-status"><span class="preview-load-message">等待依次加载…</span><button type="button" data-retry-preview="${escapeHTML(project.id)}" hidden>重新加载</button></div><iframe data-managed="${String((project.previewUrl || project.entry || '').startsWith('/projects/'))}" data-preview-src="${framePreview}" title="${title} 的作品预览" sandbox="allow-scripts allow-pointer-lock" referrerpolicy="no-referrer"></iframe>` : '<div class="preview-placeholder">没有可预览的入口</div>'}</div><p class="comparison-notes">${notes}</p><a class="comparison-open" href="${preview}" target="_blank" rel="noopener noreferrer">在新窗口打开作品 ↗</a></article>`;
    }).join('');
    comparisonKey = nextKey;
    openDialog(elements.compareDialog);
    readyFrames.forEach(frame => sendCamera(frame, 'configure', {enabled:false}));
    if (reuse && !singleProject) updateSyncStatus();
    fitPreviews();
    if (!singleProject) syncTimer = setTimeout(updateSyncStatus, 13000);
  }

  async function exportLibrary() {
    if (!requireAdmin()) return;
    try {
      const data = await request('/api/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `同题集备份-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      showToast('资料库 JSON 已导出。');
    } catch (error) {
      showToast(error.message);
    }
  }

  let reorderBusy = false;
  let dragState = null;
  async function moveProject(fromId, toId) {
    if (!requireAdmin() || reorderBusy || fromId === toId) return;
    const ids = filteredProjects().map(project => project.id);
    const from = ids.indexOf(fromId), to = ids.indexOf(toId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, fromId);
    reorderBusy = true;
    elements.projectList.classList.add('is-saving-order');
    try {
      const library = await request('/api/projects/reorder', {method:'POST', body:JSON.stringify({ids})});
      state.library = library;
      state.sort = 'custom';
      elements.sortProjects.value = 'custom';
      render();
      elements.projectList.querySelector(`[data-drag-id="${CSS.escape(fromId)}"]`)?.focus({preventScroll:true});
      showToast('展示顺序已保存。');
    } catch (error) { showToast(error.message); }
    finally { reorderBusy = false; elements.projectList.classList.remove('is-saving-order'); }
  }
  elements.projectList.addEventListener('pointerdown', event => {
    if (!state.authenticated) return;
    const handle = event.target.closest('[data-drag-id]');
    if (!handle || event.button !== 0 || reorderBusy) return;
    handle.setPointerCapture(event.pointerId);
    dragState = {id:handle.dataset.dragId, target:null, pointer:event.pointerId, x:event.clientX, y:event.clientY};
    handle.closest('.project-card').classList.add('is-dragging');
  });
  elements.projectList.addEventListener('pointermove', event => {
    if (!state.authenticated) return;
    if (!dragState || event.pointerId !== dragState.pointer) return;
    if (Math.hypot(event.clientX-dragState.x, event.clientY-dragState.y) < 6) return;
    elements.projectList.querySelectorAll('.drop-target').forEach(card => card.classList.remove('drop-target'));
    const card = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-project-id]');
    dragState.target = card && elements.projectList.contains(card) ? card.dataset.projectId : null;
    if (dragState.target !== dragState.id) card?.classList.add('drop-target');
    if (event.clientY < 75) window.scrollBy(0,-24);
    else if (event.clientY > innerHeight-75) window.scrollBy(0,24);
  });
  function endDrag(event) {
    if (!dragState || event.pointerId !== dragState.pointer) return;
    const drag = dragState;
    dragState = null;
    elements.projectList.querySelectorAll('.is-dragging, .drop-target').forEach(card => card.classList.remove('is-dragging','drop-target'));
    if (event.type === 'pointerup' && drag.target) moveProject(drag.id, drag.target);
  }
  elements.projectList.addEventListener('pointerup', endDrag);
  elements.projectList.addEventListener('pointercancel', endDrag);
  elements.projectList.addEventListener('lostpointercapture', endDrag);
  elements.projectList.addEventListener('keydown', event => {
    if (!state.authenticated) return;
    const handle = event.target.closest('[data-drag-id]');
    if (!handle || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const ids = filteredProjects().map(project => project.id);
    const next = ids.indexOf(handle.dataset.dragId) + (['ArrowLeft','ArrowUp'].includes(event.key) ? -1 : 1);
    if (ids[next]) moveProject(handle.dataset.dragId, ids[next]);
  });

  document.addEventListener('click', (event) => {
    const retry = event.target.closest('[data-retry-preview]');
    if (retry) {
      const wrapper = retry.closest('.preview-frame, .comparison-preview');
      if (!thumbnailsEnabled && wrapper.classList.contains('preview-frame')) { showToast('请先开启缩略图预览。'); return; }
      const frame = wrapper.querySelector('iframe');
      if (frame.dataset.failed === 'true') {
        frame.dataset.failed = 'false';
        frame.dataset.previewState = 'queued';
        updateRendering();
      }
      return;
    }

    const groupButton = event.target.closest('[data-group-id]');
    if (groupButton) {
      state.activeGroupId = groupButton.dataset.groupId || null;
      state.selected.clear();
      render();
      saveView();
      return;
    }
    if (event.target.closest('[data-open-group]')) return openGroupDialog();
    if (event.target.closest('[data-open-project]')) return openProjectDialog();
    if (event.target.closest('#edit-group')) return openGroupDialog(activeGroup());
    if (event.target.closest('#export-library')) return exportLibrary();
    if (event.target.closest('#compare-selected')) return openComparison();
    const preview = event.target.closest('[data-preview-project]');
    if (preview) return openComparison(byId(state.library.projects, preview.dataset.previewProject));
    const edit = event.target.closest('[data-edit-project]');
    if (edit) return openProjectDialog(byId(state.library.projects, edit.dataset.editProject));
    const title = event.target.closest('[data-project-title]');
    if (title) {
      const project = byId(state.library.projects, title.dataset.projectTitle);
      return state.authenticated ? openProjectDialog(project) : openComparison(project);
    }
    const remove = event.target.closest('[data-delete-project]');
    if (remove) return deleteProject(byId(state.library.projects, remove.dataset.deleteProject));
    if (event.target.closest('[data-close-dialog]')) {
      const dialog = event.target.closest('dialog');
      if (dialog) dialog.close();
    }
  });

  document.addEventListener('change', (event) => {
    const checkbox = event.target.closest('[data-select-id]');
    if (checkbox) selectProject(checkbox.dataset.selectId, checkbox.checked);
  });
  elements.projectSearch.addEventListener('input', (event) => { state.search = event.target.value; const projects = filteredProjects(); renderProjects(projects); renderHeader(projects); updateCompareButton(); saveView(); });
  elements.filterModel.addEventListener('change', (event) => { state.model = event.target.value; render(); saveView(); });
  elements.sortProjects.addEventListener('change', (event) => { state.sort = event.target.value; renderProjects(filteredProjects()); saveView(); });
  elements.groupForm.addEventListener('submit', saveGroup);
  elements.projectForm.addEventListener('submit', saveProject);
  elements.loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('button[type="submit"]', elements.loginForm);
    if (button.disabled) return;
    const attempt = ++loginAttempt;
    elements.loginError.hidden = true;
    button.disabled = true;
    try {
      const password = elements.loginForm.elements.password.value;
      const result = await request('/api/auth/login', {method:'POST', body:JSON.stringify({password})}, {refreshOn401:false});
      if (loginAttempt !== attempt) return;
      if (!result.authenticated || !result.token) throw new Error('登录响应无效。');
      setAuthState(true, result.token);
      scheduleAuthExpiry(result.expiresAt);
      elements.loginForm.reset();
      elements.loginDialog.close();
      await loadLibrary();
      showToast('已进入管理模式。');
    } catch (error) {
      if (loginAttempt !== attempt) return;
      elements.loginForm.elements.password.value = '';
      elements.loginError.textContent = error.message;
      elements.loginError.hidden = false;
      elements.loginForm.elements.password.focus();
    } finally { button.disabled = false; }
  });
  elements.loginDialog.addEventListener('close', () => {
    loginAttempt += 1;
    elements.loginForm.reset();
    elements.loginError.hidden = true;
  });
  [elements.groupDialog, elements.projectDialog, elements.loginDialog, $('#delete-dialog'), elements.compareDialog].forEach(dialog => dialog.addEventListener('close', releasePageScroll));
  $('#single-sizing').addEventListener('change', fitPreviews);
  $('#single-info-toggle').addEventListener('click', () => {
    const panel = $('#single-info'); panel.hidden = !panel.hidden;
    $('#single-info-toggle').setAttribute('aria-expanded', String(!panel.hidden));
  });
  [elements.groupDialog, elements.projectDialog, elements.loginDialog, $('#delete-dialog')].forEach(dialog => dialog.addEventListener('close', updateRendering));
  $('#sync-camera').addEventListener('change', () => {
    $('#sync-switch-label').textContent = $('#sync-camera').checked ? '已开启' : '已关闭';
    readyFrames.forEach(frame => sendCamera(frame, 'configure', {enabled:$('#sync-camera').checked}));
    if ($('#sync-camera').checked && readyFrames.has(splitFrames()[0])) sendCamera(splitFrames()[0], 'read');
    updateSyncStatus();
  });
  $('#align-camera').addEventListener('click', () => { if (readyFrames.has(splitFrames()[0])) sendCamera(splitFrames()[0], 'read'); });
  elements.compareDialog.addEventListener('close', () => {
    clearTimeout(syncTimer);
    readyFrames.forEach(frame => sendCamera(frame, 'configure', {enabled:false}));
    fitPreviews();
  });
  [elements.groupDialog, elements.projectDialog, elements.loginDialog, elements.compareDialog].forEach((dialog) => dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  }));

  const columnSelect = $('#grid-columns');
  $('#thumbnail-toggle').addEventListener('click', () => {
    thumbnailsEnabled = !thumbnailsEnabled;
    try { localStorage.setItem('gallery-thumbnails-enabled', String(thumbnailsEnabled)); } catch {}
    updateRendering();
  });
  updateThumbnailToggle();
  function applyColumns(value) {
    const columns = ['3','4','5','6'].includes(value) ? value : '4';
    columnSelect.value = columns;
    elements.projectList.style.setProperty('--gallery-columns', columns);
  }
  let savedColumns;
  try { savedColumns = localStorage.getItem('gallery-columns'); } catch {}
  applyColumns(savedColumns);
  columnSelect.addEventListener('change', () => {
    applyColumns(columnSelect.value);
    try { localStorage.setItem('gallery-columns', columnSelect.value); } catch {}
  });
  $('#login-button').addEventListener('click', () => {
    elements.loginForm.reset();
    elements.loginError.hidden = true;
    openDialog(elements.loginDialog);
    updateRendering();
    elements.loginForm.elements.password.focus();
  });
  $('#logout-button').addEventListener('click', async () => {
    if (!state.authenticated) return;
    let revoked = false;
    try {
      await request('/api/auth/logout', {method:'POST', body:'{}'}, {refreshOn401:false});
      revoked = true;
    } catch (error) {
      if (state.authenticated) {
        showToast(`退出失败，服务端会话尚未撤销：${error.message}`);
        return;
      }
    }
    setAuthState(false);
    await loadLibrary();
    if (revoked) showToast('已退出管理模式。');
  });
  restoreSession();
  addEventListener('scroll', () => { if (!editingData()) saveView(); }, {passive:true});
  addEventListener('pagehide', saveView);
  addEventListener('scroll', scheduleViewportUpdate, {passive:true});
  addEventListener('resize', scheduleViewportUpdate, {passive:true});
  addEventListener('online', updateRendering);
  addEventListener('offline', updateRendering);
  document.addEventListener('visibilitychange', updateRendering);
})();
