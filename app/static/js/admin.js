(function () {
  'use strict';

  // api常量
  const API = {
    status: '/api/status',
    logs: '/api/logs',
    config: '/api/config',
    version: '/api/version',
    trigger: '/api/trigger-check',
    forceClose: '/api/force-close'
  };

  const POLL_INTERVAL_MS = 500;
  const MAX_LOG_LINES = 1000;
  const MAX_FAILURE_DURATION_MS = 5000;
  const ACTION_CONFIRM_TIMEOUT_MS = 30000;

  // 页面元素
  const $ = s => document.querySelector(s);
  const apiKeyInput = $('#apiKeyInput');
  const showApikeyBtn = $('#show-apikey');
  const loginBtn = $('#login-button');
  const rememberKey = $('#rememberKey');
  const loginModal = $('#loginModal');
  const statusEl = $('#status');
  const logContainer = $('#logContainer');
  const versionLogin = $(`#version-login`);
  const versionInline = $('#versionInline');
  const toggleBtn = $('#btnToggleCheck');
  const refreshLogsBtn = $('#refreshLogs');
  const saveCfgBtn = $('#saveCfg');
  const reloadCfgBtn = $('#reloadCfg');
  const configEditor = $('#configEditor');
  const highlightOverlay = $('#highlightOverlay');
  const editorContainer = $('#editorContainer');
  const progressBar = $('#progress');
  const progressText = $('#progressText');
  const successText = $('#successText');
  const progressPercent = $('#progressPercent');
  const downloadLogsBtnSide = $('#downloadLogsBtnSide');
  const logoutBtn = $('#logoutBtn');
  const logoutBtnMobile = $('#logoutBtnMobile');
  const openEditorBtn = $('#openEditor');
  const themeToggleBtn = $('#themeToggle');
  const iconMoon = $('#iconMoon');
  const iconSun = $('#iconSun');
  const shareBtn = document.getElementById("share");
  const shareMenu = document.getElementById("shareMenu");
  const btnShare = document.getElementById("btnShare");;
  const projectUrlBtn = document.getElementById('project-url');

  // 上次检测结果
  const lastCheckResult = $('#lastCheckResult');
  const lastCheckTime = $('#lastCheckTime');
  const lastCheckDuration = $('#lastCheckDuration');
  const lastCheckTotal = $('#lastCheckTotal');
  const lastCheckAvailable = $('#lastCheckAvailable');

  // ==================== 全局状态 ====================
  let sessionKey = null;
  let pollers = { logs: null, status: null };
  let lastLogLines = [];
  let autoScrollLogs = false;
  let lastProgress = { time: 0, processed: 0, total: 0 };
  let apiFailureCount = 0;
  let firstFailureAt = null;
  let logsPollRunning = false;
  let statusPollRunning = false;
  let actionState = 'unknown';
  let actionInFlight = false;
  let lastCheckInfo = null; // 存储上次检测信息
  let checkStartTime = null; // 记录检测开始时间

  // 工具函数
  function safeLS(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { return null; }
  }

  (function initToast() {
    if (!document.getElementById('toastContainer')) {
      const c = document.createElement('div');
      c.id = 'toastContainer';
      document.body.appendChild(c);
    }
  })();

  function showToast(msg, type = 'info', timeout = 3000) {
    const c = document.getElementById('toastContainer');
    if (!c) return;

    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');

    const ico = document.createElement('span');
    ico.className = 'icon';
    el.appendChild(ico);

    const t = document.createElement('div');
    t.style.flex = '1';
    t.textContent = msg;
    el.appendChild(t);

    // 进度条
    const bar = document.createElement('div');
    bar.className = 'progress-bar';
    bar.style.animationDuration = timeout + 'ms';
    el.appendChild(bar);

    c.appendChild(el);

    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(6px)';
    }, timeout);

    setTimeout(() => {
      try { c.removeChild(el); } catch (e) { }
    }, timeout + 420);
  }

  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  async function sfetch(url, opts = {}) {
    if (!sessionKey) return { ok: false, status: 401, error: '未认证' };
    opts.headers = { ...opts.headers, 'X-API-Key': sessionKey };
    try {
      const r = await fetch(url, opts);
      const ct = r.headers.get('content-type') || '';
      const text = await r.text();
      let payload = ct.includes('application/json') ? JSON.parse(text) : text;

      if (r.status === 401) {
        doLogout('未授权：API Key 无效或已失效');
        return { ok: false, status: 401, payload };
      }

      if (r.ok) {
        resetApiFailures();
        return { ok: true, status: r.status, payload };
      }

      apiFailureCount++;
      if (!firstFailureAt) firstFailureAt = Date.now();
      if (firstFailureAt && (Date.now() - firstFailureAt) >= MAX_FAILURE_DURATION_MS) {
        doLogout('连续无法连接 API 超过 5 秒');
        return { ok: false, status: r.status, payload };
      }
      return { ok: false, status: r.status, payload };
    } catch (e) {
      apiFailureCount++;
      if (!firstFailureAt) firstFailureAt = Date.now();
      if (firstFailureAt && (Date.now() - firstFailureAt) >= MAX_FAILURE_DURATION_MS) {
        doLogout('连续无法连接 API 超过 5 秒');
      }
      return { ok: false, error: e };
    }
  }

  function resetApiFailures() {
    apiFailureCount = 0;
    firstFailureAt = null;
  }

  // 认证
  function showLogin(show) {
    getPublicVersion();
    if (!loginModal) return;
    loginModal.classList.toggle('login-hidden', !show);
    if (show) {
      apiKeyInput?.focus();
    }
  }

  function updateToggleUI(state) {
    actionState = state;
    if (!toggleBtn) return;

    toggleBtn.className = 'toggle-btn state-' + state;
    const iconEl = toggleBtn.querySelector('.btn-icon');

    const config = {
       idle: {
        icon: `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          <path d="M8 5v14l11-7z"/>
        </svg>
      `,
        disabled: false,
        title: '开始检测',
        pressed: 'false'
      },
      starting: {
        icon: `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" xmlns="http://www.w3.org/2000/svg">
          <path d="M6 12h-2.25c0 5.5 4.25 10 9.75 10s9.75-4.5 9.75-10-4.25-10-9.75-10-9.75 4.5-9.75 10zM12 7.5v9"/>
        </svg>
      `,
        disabled: true,
        title: '正在开始',
        pressed: 'true'
      },
      checking: {
        icon: `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          <path d="M6 6h12v12H6z"/>
        </svg>
      `,
        disabled: false,
        title: '检测中 - 点击停止',
        pressed: 'true'
      },
      stopping: {
        icon: `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" xmlns="http://www.w3.org/2000/svg">
          <path d="M6 12h-2.25c0 5.5 4.25 10 9.75 10s9.75-4.5 9.75-10-4.25-10-9.75-10-9.75 4.5-9.75 10zM12 7.5v9"/>
        </svg>
      `,
        disabled: true,
        title: '正在结束',
        pressed: 'true'
      },
      disabled: {
        icon: `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" xmlns="http://www.w3.org/2000/svg">
          <path d="M5 12h14"/>
        </svg>
      `,
        disabled: true,
        title: '请先登录',
        pressed: 'false'
      }
    };

    const cfg = config[state] || config.disabled;
    toggleBtn.disabled = cfg.disabled;
    toggleBtn.title = cfg.title;
    toggleBtn.setAttribute('aria-pressed', cfg.pressed);
    if (iconEl) iconEl.innerHTML = cfg.icon;  // 改为innerHTML，支持SVG
  }

  function setAuthUI(ok) {
    statusEl.textContent = `状态：${ok ? '空闲' : '未登录'}`;
    statusEl.className = 'muted status-label ' + (ok ? 'status-logged' : 'status-idle');
    [toggleBtn, refreshLogsBtn, saveCfgBtn, reloadCfgBtn].forEach(b => b && (b.disabled = !ok));
    updateToggleUI(ok ? 'idle' : 'disabled');
  }

  async function onLoginBtnClick() {
    const k = apiKeyInput?.value?.trim();
    if (!k) {
      showToast('请输入 API 密钥', 'warn');
      apiKeyInput?.focus();
      return;
    }

    loginBtn.disabled = true;
    loginBtn.textContent = '验证中…';

    try {
      const resp = await fetch(API.status, { headers: { 'X-API-Key': k } });
      if (resp.status === 401) {
        showToast('API 密钥无效', 'error');
        return;
      }
      if (!resp.ok) {
        showToast('验证失败，HTTP ' + resp.status, 'error');
        return;
      }

      sessionKey = k;
      if (rememberKey?.checked) safeLS('subscheck_api_key', k);

      showLogin(false);
      document.activeElement?.blur();
      setAuthUI(true);
      await loadAll();
      startPollers();
      showToast('验证成功，已登录', 'success');
    } catch (e) {
      showToast('网络错误或服务器未响应', 'error');
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = '进入管理界面';
    }
  }

  function doLogout(reason = '已退出登录') {
    stopPollers();
    sessionKey = null;
    safeLS('subscheck_api_key', null);
    setAuthUI(false);
    if (logContainer) logContainer.innerHTML = '<div class="muted" style="font-family: system-ui;">已退出登录。</div>';
    if (configEditor) setEditorContent('');
    resetApiFailures();
    // 隐藏进度以避免残留 UI
    try { showProgressUI(false); } catch (e) { }
    showLogin(true);
    showToast(reason, 'info');
  }

  // 日志处理
  function colorize(line) {
    const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
    let out = escapeHtml(line);

    if (tsMatch) {
      const ts = tsMatch[0];
      out = '<span class="log-time">' + ts + '</span>' + escapeHtml(line.slice(ts.length));
    }

    // 关键字高亮
    out = out.replace(/\b(INF|INFO)\b/g, '<span class="log-info">INF</span>');
    out = out.replace(/\b(ERR|ERROR)\b/g, '<span class="log-error">ERR</span>');
    out = out.replace(/\b(WRN|WARN)\b/g, '<span class="log-warn">WRN</span>');
    out = out.replace(/\b(DBG|DEBUG)\b/g, '<span class="log-debug">DBG</span>');

    // 如果包含“发现新版本”
    if (/发现新版本/.test(out)) {
      // 给最新版本号加样式
      out = out.replace(/最新版本=([^\s]+)/, '最新版本=<span class="success-highlight">$1</span>');
      // 给整行加样式容器
      out = '<div class="log-new-version">' + out + '</div>';
    }

    return out;
  }


  let isMouseInsideLog = false;

  if (logContainer) {
    logContainer.addEventListener('mouseenter', () => {
      isMouseInsideLog = true;
    });
    logContainer.addEventListener('mouseleave', () => {
      isMouseInsideLog = false;
    });
  }

  function isUserSelectingOrHovering() {
    const sel = window.getSelection();
    const hasSelection = sel && sel.toString().length > 0;
    return isMouseInsideLog;
  }

  function renderLogLines(lines, IntervalRun) {
    if (!logContainer) return;
    if (isUserSelectingOrHovering() && IntervalRun) {
      logContainer.title = "暂停自动刷新";
      return; // 暂停刷新
    } else {
      // 移动到最底
      logContainer.scrollTop = logContainer.scrollHeight;
    }

    logContainer.innerHTML = lines.map(l => '<div>' + colorize(l) + '</div>').join('');

    requestAnimationFrame(() => {
      // 记录当前滚动位置
      const isScrolledToBottom = logContainer.scrollHeight - logContainer.clientHeight <= logContainer.scrollTop + 1;
      // 只有当用户在底部时才自动滚动
      if (isScrolledToBottom) {
        logContainer.scrollTop = logContainer.scrollHeight;
      }
    });
  }

  function appendLogLines(linesToAdd) {
    if (!logContainer || !linesToAdd?.length) return;
    // if (isUserSelectingOrHovering()){
    //     logContainer.title="暂停自动刷新";
    //     return; // 暂停刷新
    // } 

    const frag = document.createDocumentFragment();
    linesToAdd.forEach(l => {
      const d = document.createElement('div');
      d.innerHTML = colorize(l);
      frag.appendChild(d);
    });
    logContainer.appendChild(frag);

    while (logContainer.children.length > MAX_LOG_LINES) {
      logContainer.removeChild(logContainer.firstChild);
    }

    requestAnimationFrame(() => {
      // 记录当前滚动位置
      const isScrolledToBottom = logContainer.scrollHeight - logContainer.clientHeight <= logContainer.scrollTop + 1;
      // 只有当用户在底部时才自动滚动
      if (isScrolledToBottom) {
        logContainer.scrollTop = logContainer.scrollHeight;
      }
    });
  }


  async function loadLogsIncremental(IntervalRun) {
    if (!sessionKey || logsPollRunning) return;
    logsPollRunning = true;
    try {
      const r = await sfetch(API.logs);
      if (!r.ok) return;

      let lines = [];
      const p = r.payload;
      if (Array.isArray(p?.logs)) lines = p.logs.map(String);
      else if (typeof p?.logs === 'string') lines = p.logs.split('\n');
      else if (typeof p === 'string') lines = p.split('\n');
      else lines = [JSON.stringify(p)];

      const newTail = lines.slice(-MAX_LOG_LINES);

      if (lastLogLines.length === 0) {
        lastLogLines = newTail;
        renderLogLines(lastLogLines, IntervalRun);

        if (!lastCheckInfo) {
          const parsed = parseCheckResultFromLogs(newTail);
          if (parsed) {
            lastCheckInfo = parsed;
            showLastCheckResult(parsed);
          }
        }
        return;
      }

      const oldStr = lastLogLines.join('\n');
      const newStr = newTail.join('\n');

      if (newStr.startsWith(oldStr) && newStr.length > oldStr.length) {
        const addedPart = newStr.substring(oldStr.length + 1);
        const added = addedPart.split('\n').filter(s => s !== '');
        if (added.length > 0) {
          appendLogLines(added);

          if (added.some(line => line.includes('检测完成'))) {
            const parsed = parseCheckResultFromLogs(newTail);
            if (parsed) {
              lastCheckInfo = parsed;
              showLastCheckResult(parsed);
            }
          }
        }
        lastLogLines = newTail;
      } else {
        lastLogLines = newTail;
        renderLogLines(lastLogLines, IntervalRun);
      }
    } finally {
      logsPollRunning = false;
    }
  }

  // 从日志解析检测结果
  function parseCheckResultFromLogs(logs) {
    if (!logs || !Array.isArray(logs)) return null;

    const lines = logs.map(String);
    let startTime = null;
    let endTime = null;
    let totalNodes = 0;
    let availableNodes = 0;

    // 从后往前查找，获取最近一次完整的检测信息
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];

      // 检测完成标记
      if (!endTime && line.includes('检测完成')) {
        const timeMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
        if (timeMatch) endTime = timeMatch[1];
      }

      // 可用节点数量
      if (!availableNodes && line.includes('可用节点数量:')) {
        const match = line.match(/可用节点数量:\s*(\d+)/);
        if (match) availableNodes = parseInt(match[1]);
      }

      // 去重后节点数量（作为总数）
      if (!totalNodes && line.includes('去重后节点数量:')) {
        const match = line.match(/去重后节点数量:\s*(\d+)/);
        if (match) totalNodes = parseInt(match[1]);
      }

      // 开始检测标记
      if (!startTime && (line.includes('手动触发检测') || line.includes('开始准备检测代理'))) {
        const timeMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
        if (timeMatch) startTime = timeMatch[1];
        break; // 找到开始就停止
      }
    }

    // 如果找到了完整信息
    if (startTime && endTime && totalNodes > 0) {
      const start = new Date(startTime);
      const end = new Date(endTime);
      const duration = Math.round((end - start) / 1000); // 秒

      return {
        lastCheckTime: endTime,
        duration: duration,
        total: totalNodes,
        available: availableNodes
      };
    }

    return null;
  }

  // 语法高亮
  function highlightYAML(text) {
    const esc = s => escapeHtml(s);
    return (text + '\n').split('\n').map(line => {
      if (/^\s*$/.test(line)) return '';
      const leading = line.match(/^\s*/)[0];
      const trimmed = line.trim();

      if (trimmed.startsWith('#')) {
        return leading + '<span class="hl-comment">' + esc(trimmed) + '</span>';
      }

      if (trimmed.startsWith('- ')) {
        const itemContent = trimmed.slice(2);
        let formatted = esc(itemContent);
        const val = itemContent.trim();

        if (/^["'].*["']$/.test(itemContent)) {
          formatted = '<span class="hl-string">' + esc(itemContent) + '</span>';
        } else if (/^(true|false|yes|no)$/i.test(val)) {
          formatted = '<span class="hl-boolean">' + esc(itemContent) + '</span>';
        } else if (val && /^[0-9eE+\-.]+$/.test(val)) {
          formatted = '<span class="hl-number">' + esc(itemContent) + '</span>';
        } else if (/^(null|~)$/.test(val)) {
          formatted = '<span class="hl-null">' + esc(itemContent) + '</span>';
        } else if (/^https?:\/\//i.test(val)) {
          formatted = '<span class="hl-url">' + esc(itemContent) + '</span>';
        } else {
          formatted = '<span class="hl-string">' + esc(itemContent) + '</span>';
        }

        return leading + '<span class="hl-hyphen">-</span> ' + formatted;
      }

      const m = line.match(/^(\s*)([^:\s][^:]*?):(\s*)(.*)$/);
      if (m) {
        const [, indent, key, sep, valRaw] = m;
        let formatted = esc(valRaw);
        const val = valRaw.trim();

        if (/^["'].*["']$/.test(valRaw)) {
          formatted = '<span class="hl-string">' + esc(valRaw) + '</span>';
        } else if (/^(true|false|yes|no)$/i.test(val)) {
          formatted = '<span class="hl-boolean">' + esc(valRaw) + '</span>';
        } else if (val && /^[0-9eE+\-.]+$/.test(val)) {
          formatted = '<span class="hl-number">' + esc(valRaw) + '</span>';
        } else if (/^https?:\/\//i.test(val)) {
          formatted = '<span class="hl-url">' + esc(valRaw) + '</span>';
        } else if (/^(null|~)$/.test(val)) {
          formatted = '<span class="hl-null">' + esc(valRaw) + '</span>';
        } else {
          formatted = '<span class="hl-string">' + esc(valRaw) + '</span>';
        }

        return indent + '<span class="hl-key">' + esc(key) + '</span>:' + sep + formatted;
      }

      return esc(line);
    }).join('\n');
  }

  function syncOverlay() {
    if (!highlightOverlay || !configEditor) return;
    highlightOverlay.scrollTop = configEditor.scrollTop;
    highlightOverlay.scrollLeft = configEditor.scrollLeft;
  }

  configEditor?.addEventListener('input', () => {
    if (!highlightOverlay) return;
    highlightOverlay.innerHTML = highlightYAML(configEditor.value || '');
    requestAnimationFrame(syncOverlay);
  });

  configEditor?.addEventListener('scroll', syncOverlay);

  function setEditorContent(txt) {
    if (!configEditor || !highlightOverlay) return;
    const cleaned = (txt || '').replace(/\r\n/g, '\n');
    configEditor.value = cleaned;
    highlightOverlay.innerHTML = highlightYAML(cleaned);
    requestAnimationFrame(syncOverlay);
  }

  // 配置加载保存
  async function loadConfigValidated() {
    if (!sessionKey) return;
    const r = await sfetch(API.config);
    if (!r.ok) {
      showToast('读取配置失败', 'warn');
      return;
    }

    const p = r.payload;
    let raw = '';
    if (p?.content !== undefined) raw = p.content;
    else if (typeof p === 'string') raw = p;

    // YAML 校验
    if (typeof jsyaml !== 'undefined' && jsyaml.load) {
      try {
        const config = jsyaml.load(raw);
        setEditorContent(raw);
      } catch (e) {
        setEditorContent(raw);
        showToast('YAML 解析警告：' + e.message, 'warn', 5000);
      }
    } else {
      console.warn('jsyaml 未加载，跳过 YAML 校验');
      setEditorContent(raw);
    }
  }

  async function saveConfigWithValidation() {
    if (!sessionKey) {
      showLogin(true);
      showToast('请先登录', 'warn');
      return;
    }

    const rawContent = configEditor.value;

    // YAML 校验
    if (typeof jsyaml !== 'undefined' && jsyaml.load) {
      try {
        const parsed = jsyaml.load(rawContent);
        // 替换编辑器内容为格式化后的
        configEditor.value = parsed;
      } catch (e) {
        showToast('YAML 语法错误：' + e.message, 'error', 6000);
        console.error('YAML 校验失败:', e);
        return; // 阻止保存
      }
    } else {
      showToast('警告：无法进行 YAML 校验，js-yaml 库未加载', 'warn', 4000);
      console.error('jsyaml 未定义，无法校验 YAML');
      if (!window.confirm('无法进行 YAML 格式校验，是否仍要保存？')) {
        return;
      }
    }

    const r = await sfetch(API.config, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: rawContent })
    });

    if (!r.ok) {
      showToast('保存失败', 'error');
      return;
    }

    if (r.payload?.error) {
      showToast('保存失败：' + r.payload.error, 'error');
    } else {
      showToast(r.payload?.message || '保存成功', 'success');
      await loadConfigValidated();
    }
  }

  // 控制进度容器的显示/隐藏（隐藏: 'none'，显示: 恢复默认）
  function showProgressUI(visible) {
    const v = !!visible;
    try {
      const progWrapper = document.querySelector('#mainContent .progress-wrapper') || document.querySelector('.progress-wrapper');
      const progBarWrap = document.querySelector('#mainContent .progress-bar-wrap') || document.querySelector('.progress-bar-wrap');
      const history = document.getElementById('historyPlaceholder');
      const historyLine = $(`#history-line`)

      if (progWrapper) progWrapper.style.display = v ? '' : 'none';
      if (progBarWrap) progBarWrap.style.display = v ? '' : 'none';

      // 当显示进度时，隐藏历史占位；隐藏进度时，显示历史占位
      if (history) history.style.display = v ? 'none' : '';
      if (historyLine) historyLine.style.display = v ? 'none' : '';

      if (!v) {
        // 隐藏进度时清理进度显示，避免残留
        try { if (progressBar) progressBar.value = 0; } catch (e) { }
        if (progressText) progressText.textContent = '';
        if (progressPercent) progressPercent.textContent = '';
        if (successText) {
          successText.classList.remove("success-highlight");
          successText.textContent = '';
        }

        // 尝试获取历史信息：优先使用 lastCheckInfo -> 再尝试从 lastLogLines 解析 -> 再回退到 DOM 原有值
        let info = lastCheckInfo || null;
        if (!info) {
          try {
            const parsedFromLogs = parseCheckResultFromLogs(lastLogLines);
            if (parsedFromLogs) info = parsedFromLogs;
          } catch (e) { /* ignore parse errors */ }
        }

        if (!info) {
          // 回退读取旧 DOM（若页面上手动写过历史字段）
          const t = document.getElementById('lastCheckTime')?.textContent || '-';
          const d = document.getElementById('lastCheckDuration')?.textContent || '-';
          const tot = document.getElementById('lastCheckTotal')?.textContent || '-';
          const a = document.getElementById('lastCheckAvailable')?.textContent || '-';
          if (t !== '-' || d !== '-' || tot !== '-' || a !== '-') {
            info = { lastCheckTime: t, duration: d, total: tot, available: a };
          }
        }

        // 以下只修改四个 span 的文本，不替换 .history-line 的 HTML 结构，保证 CSS 不被破坏
        const histTimeEl = document.getElementById('historyLastTime');
        const histDurationEl = document.getElementById('historyLastDuration');
        const histTotalEl = document.getElementById('historyLastTotal');
        const histAvailableEl = document.getElementById('historyLastAvailable');
        const historyPlaceholderEl = document.getElementById('historyPlaceholder');
        const historyExitBtn = document.getElementById('btnHistoryExit');

        // 确保存在一个独立的“未发现检测记录”提示元素，避免覆盖 .history-line 的结构
        let notFoundEl = document.getElementById('historyNotFound');
        if (!notFoundEl && historyPlaceholderEl) {
          notFoundEl = document.createElement('div');
          notFoundEl.id = 'historyNotFound';
          notFoundEl.className = 'muted';
          notFoundEl.style.fontSize = '12px';
          notFoundEl.style.marginTop = '6px';
          notFoundEl.textContent = '未发现检测记录';
          const summary = historyPlaceholderEl.querySelector('.history-summary');
          if (summary) summary.insertAdjacentElement('afterend', notFoundEl);
          else historyPlaceholderEl.appendChild(notFoundEl);
        }

        if (info) {
          // 计算友好显示文本（时间格式化、时长格式化等）
          const prettyTime = (() => {
            try {
              const dt = info.lastCheckTime ? new Date(String(info.lastCheckTime).replace(' ', 'T')) : null;
              return dt && !isNaN(dt) ? dt.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : (info.lastCheckTime || '-');
            } catch (e) { return info.lastCheckTime || '未知'; }
          })();

          const prettyDuration = (typeof info.duration === 'number')
            ? (info.duration >= 60 ? Math.floor(info.duration / 60) + '分' + (info.duration % 60) + '秒' : info.duration + '秒')
            : (info.duration || '0');

          const prettyTotal = (() => {
            if (typeof info.total === 'number') {
              if (info.total >= 1000000) {
                return Math.floor(info.total / 10000) + '万';
              } else if (info.total >= 10000) {
                return (info.total / 10000).toFixed(1) + '万';
              } else {
                // 小于1万，直接显示
                return String(info.total);
              }
            }
            return info.total != null ? String(info.total) : '0';
          })();

          const prettyAvailable = info.available != null ? String(info.available) : '0';

          // 仅写入 span 的文本，不改 innerHTML
          if (histTimeEl) histTimeEl.textContent = prettyTime;
          if (histDurationEl) histDurationEl.textContent = prettyDuration;
          if (histTotalEl) histTotalEl.textContent = prettyTotal;
          if (histAvailableEl) histAvailableEl.textContent = prettyAvailable;

          // 隐藏“未发现检测记录”提示（若存在）
          if (notFoundEl) notFoundEl.style.display = 'none';

          // 显示历史占位与退出按钮
          if (historyPlaceholderEl) historyPlaceholderEl.style.display = '';
          if (historyLine) historyLine.style.display = '';

          // if (historyExitBtn) historyExitBtn.style.display = '';
          // 同步到可能存在的详细 lastCheck 元素（用于其他区域）
          if (lastCheckTime) lastCheckTime.textContent = info.lastCheckTime || '-';
          if (lastCheckDuration) lastCheckDuration.textContent = (typeof info.duration === 'number') ? (info.duration >= 60 ? Math.floor(info.duration / 60) + '分' + (info.duration % 60) + '秒' : info.duration + '秒') : (info.duration || '-');
          if (lastCheckTotal) lastCheckTotal.textContent = info.total != null ? String(info.total) : '-';
          if (lastCheckAvailable) lastCheckAvailable.textContent = info.available != null ? String(info.available) : '-';
        } else {
          if (notFoundEl) notFoundEl.style.display = '';
          if (historyPlaceholderEl) historyPlaceholderEl.style.display = '';
          if (historyLine) historyLine.style.display = 'none';
        }
      } else {
        // 进入显示进度状态时，隐藏历史摘要
        try { hideLastCheckResult(); } catch (e) { }
      }
    } catch (e) {
      console.warn('showProgressUI error', e);
    }
  }

  // 进度更新
  function updateProgress(total, processed, available) {
    total = Number(total) || 0;
    processed = Number(processed) || 0;
    const pct = total > 0 ? Math.min(100, (processed / total) * 100) : 0;

    if (progressBar) progressBar.value = pct;
    if (progressText) progressText.textContent = `${processed}/${total}`;
    if (successText) {
      successText.classList.add("success-highlight")
      successText.textContent = available;
    }
    if (progressPercent) progressPercent.textContent = pct.toFixed(1) + "%";

    const now = Date.now();
    let etaText = '';
    if (lastProgress.time && lastProgress.total === total && processed > lastProgress.processed) {
      const dt = (now - lastProgress.time) / 1000;
      const dproc = processed - lastProgress.processed;
      if (dproc > 0) {
        const rate = dproc / dt;
        const remain = Math.max(0, total - processed);
        const etaSec = Math.round(remain / rate);
        etaText = etaSec > 60 ? Math.round(etaSec / 60) + 'm' : etaSec + 's';
      }
    }

    if (statusEl) {
      if (processed < total && total > 0) {
        statusEl.textContent = `运行中,预计剩余: ${etaText}`;
        statusEl.title = etaText ? `预计剩余: ${etaText}` : '';
        statusEl.className = 'muted status-label status-checking';
      } else if (processed >= total && total > 0) {
        statusEl.textContent = '检测完成';
        statusEl.title = '';
        statusEl.className = 'muted status-label status-logged';
      } else {
        statusEl.textContent = '空闲';
        statusEl.title = '';
        statusEl.className = 'muted status-label status-idle';
      }
    }

    lastProgress = { time: now, processed, total };
  }


  // 显示上次检测结果
  function showLastCheckResult(info) {
    if (!info) return;
    // 记录供其它地方使用
    lastCheckInfo = info;

    // 触发一次 UI 填充（通过 showProgressUI(false) 的隐藏分支填充）
    try {
      // 保证历史占位可见并被填充
      showProgressUI(false);
    } catch (e) {
      console.warn('showLastCheckResult error', e);
    }
  }

  // 隐藏上次检测结果
  function hideLastCheckResult() {
    const history = document.getElementById('historyPlaceholder');
    if (history) history.style.display = 'none';
  }


  // 加载api状态
  async function loadStatus() {
    if (!sessionKey || statusPollRunning) return;
    statusPollRunning = true;
    try {
      const r = await sfetch(API.status);
      if (!r.ok) {
        if (statusEl) {
          statusEl.textContent = '获取状态失败';
          statusEl.className = 'muted status-label status-error';
        }
        return;
      }

      const d = r.payload || {};
      const checking = !!d.checking;

      if (checking) {
        updateToggleUI('checking');
        showProgressUI(true); // 开始检测：显示进度区域
        updateProgress(d.proxyCount || 0, d.progress || 0, d.available || 0);
        // 检测中时隐藏上次结果
        hideLastCheckResult();

        // 记录检测开始时间（如果还没记录）
        if (!checkStartTime) {
          checkStartTime = Date.now();
        }
      } else {
        // 检测结束：先隐藏进度相关 UI（再显示上次检测结果）
        showProgressUI(false);
        updateToggleUI('idle');
        updateProgress(d.proxyCount || 0, d.progress || 0, d.available || 0);
        if (progressBar && (d.progress === 0 || d.proxyCount === 0)) {
          progressBar.value = 0;
        }

        // 检测结束时显示上次检测结果
        // 优先使用后端返回的数据，如果没有则使用前端记录
        if (d.lastCheck) {
          showLastCheckResult({
            lastCheckTime: d.lastCheck.time || d.lastCheck.timestamp,
            duration: d.lastCheck.duration,
            total: d.lastCheck.total || d.proxyCount,
            available: d.lastCheck.available || d.available
          });
          checkStartTime = null; // 重置开始时间
        } else if (checkStartTime && lastCheckInfo) {
          // 如果前端记录了开始时间，计算用时
          const duration = Math.round((Date.now() - checkStartTime) / 1000);
          showLastCheckResult({
            lastCheckTime: new Date().toISOString().replace('T', ' ').split('.')[0],
            duration: duration,
            total: d.proxyCount || lastCheckInfo.total,
            available: d.available || lastCheckInfo.available
          });
          checkStartTime = null;
        } else if (lastCheckInfo) {
          // 显示之前的检测结果
          showLastCheckResult(lastCheckInfo);
        }
      }
    } finally {
      statusPollRunning = false;
    }
  }

  function sleep(ms) {
    return new Promise(res => setTimeout(res, ms));
  }

  async function waitForBackendChecking(desired, timeoutMs = ACTION_CONFIRM_TIMEOUT_MS) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const r = await sfetch(API.status);
        if (r.ok && Boolean(r.payload?.checking) === Boolean(desired)) {
          return { ok: true, payload: r.payload };
        }
      } catch (e) { /* ignore */ }
      await sleep(600);
    }
    return { ok: false, error: 'timeout' };
  }

  // ==================== 控件事件绑定 ====================
  function bindControls() {
    projectUrlBtn.addEventListener('click', (e) => {
      e.preventDefault(); // 防止默认行为（如如果有链接）
      const GITHUB_REPO_URL = 'https://github.com/sinspired/subs-check';
      window.open(GITHUB_REPO_URL, '_blank', 'noopener,noreferrer'); // 新标签打开
    });

    downloadLogsBtnSide?.addEventListener('click', () => {
      const t = logContainer?.innerText || '';
      const blob = new Blob([t], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'subs-check-logs.txt';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast('已开始下载日志', 'info');
    });

    toggleBtn?.addEventListener('click', async () => {
      if (!sessionKey) {
        showLogin(true);
        showToast('请先登录', 'warn');
        return;
      }
      if (actionInFlight) return;

      actionInFlight = true;
      try {
        if (actionState === 'checking') {
          // 停止检测
          updateToggleUI('stopping');
          showToast('已发送停止信号，等待后端响应...', 'info');

          try {
            const r = await sfetch(API.forceClose, { method: 'POST' });
            if (!r.ok) showToast('发送结束请求失败', 'error');
          } catch (e) {
            showToast('网络错误：无法发送结束请求', 'error');
          }

          const confirm = await waitForBackendChecking(false);
          if (confirm.ok) {
            showProgressUI(false); // 停止确认 -> 隐藏进度
            updateToggleUI('idle');
            showToast('检测已停止', 'success');
          } else {
            showProgressUI(false);
            updateToggleUI('idle');
            showToast('结束操作超时，请刷新查看状态', 'warn', 6000);
          }
        } else {
          // 开始检测
          updateToggleUI('starting');
          showProgressUI(true); // 立即展示进度区域（占位）
          showToast('正在启动检测...', 'info');

          // 记录开始时间
          checkStartTime = Date.now();

          try {
            const r = await sfetch(API.trigger, { method: 'POST' });
            if (!r.ok) showToast('触发检测请求失败', 'error');
          } catch (e) {
            showToast('网络错误：无法触发检测', 'error');
          }

          const confirm = await waitForBackendChecking(true);
          if (confirm.ok) {
            updateToggleUI('checking');
            await loadLogsIncremental(true).catch(() => { });
            showToast('检测已开始', 'success');
          } else {
            updateToggleUI('idle');
            checkStartTime = null; // 重置
            showProgressUI(false);
            showToast('启动超时，请检查服务端或重试', 'warn', 6000);
          }
        }
      } finally {
        await sleep(300);
        actionInFlight = false;
      }
    });

    saveCfgBtn?.addEventListener('click', saveConfigWithValidation);
    reloadCfgBtn?.addEventListener('click', () => {
      showToast('正在重载配置...', 'info');
      loadConfigValidated();
    });
    refreshLogsBtn?.addEventListener('click', () => {
      showToast('正在刷新日志...', 'info');
      loadLogsIncremental(false);
    });
    openEditorBtn?.addEventListener('click', () => {
      editorContainer?.scrollIntoView({ behavior: 'smooth' });
    });
    logoutBtn?.addEventListener('click', () => {
      if (window.confirm('确定退出并清除本地保存的 API 密钥？')) doLogout();
    });

    // 小屏退出按钮
    logoutBtnMobile?.addEventListener('click', () => {
      if (window.confirm('确定退出并清除本地保存的 API 密钥？')) doLogout();
    });

    apiKeyInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onLoginBtnClick();
      }
    });

    // 密钥可见性切换
    if (apiKeyInput && showApikeyBtn) {
      apiKeyInput.addEventListener('input', () => {
        const hasValue = (apiKeyInput.value || '').trim().length > 0;
        showApikeyBtn.classList.toggle('visible', hasValue);
      });

      showApikeyBtn.addEventListener('click', () => {
        const isPassword = apiKeyInput.type === 'password';
        apiKeyInput.type = isPassword ? 'text' : 'password';
        showApikeyBtn.textContent = isPassword ? '隐藏' : '显示';
        showApikeyBtn.classList.toggle('active', isPassword);
      });
    }

    const historyExitBtn = document.getElementById('btnHistoryExit');
    historyExitBtn?.addEventListener('click', () => {
      if (!window.confirm('确定退出并清除本地保存的 API 密钥？')) return;
      try {
        // 额外保险：立即清除本地存储
        safeLS('subscheck_api_key', null);
      } catch (e) { /* ignore */ }
      // doLogout 会停止轮询、清除 sessionKey 并展示登录界面
      try { doLogout('已退出并清除本地 API 密钥'); } catch (e) { console.warn(e); }
    });

    // 主题切换
    themeToggleBtn?.addEventListener('click', toggleTheme);
    themeToggleBtn?.addEventListener('dblclick', () => {
      safeLS('theme', null);
      const sys = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      applyTheme(sys);
      showToast('主题已重置为系统默认', 'info');
    });
  }

  // 轮询
  function startPollers() {
    if (!sessionKey) return;
    stopPollers();
    loadLogsIncremental(true).catch(() => { });
    loadStatus().catch(() => { });
    pollers.logs = setInterval(() => {
      if (!logsPollRunning) loadLogsIncremental(true).catch(() => { });
    }, POLL_INTERVAL_MS);
    pollers.status = setInterval(() => {
      if (!statusPollRunning) loadStatus().catch(() => { });
    }, POLL_INTERVAL_MS);
  }

  function stopPollers() {
    if (pollers.logs) clearInterval(pollers.logs);
    if (pollers.status) clearInterval(pollers.status);
    pollers.logs = pollers.status = null;
  }

  // 获取版本号
  async function getVersion() {
    if (!sessionKey) return;
    try {
      const r = await sfetch(API.version);
      if (r.payload?.version && versionInline) {
        versionInline.textContent = r.payload.version;
      }
    } catch (e) { /* ignore */ }
  }
  // 登录界面时获取版本号（不需要验证）
  async function getPublicVersion() {
    try {
      const r = await fetch('/version');   // 注意这里是 /version
      const data = await r.json();
      versionLogin.textContent = data.version;

    } catch (e) {
      console.error('获取版本失败', e);
    }
  }

  // 加载所有
  async function loadAll() {
    if (!sessionKey) {
      showLogin(true);
      setAuthUI(false);
      return;
    }
    await Promise.all([
      loadConfigValidated().catch(() => { }),
      loadLogsIncremental(false).catch(() => { }),
      loadStatus().catch(() => { }),
      getVersion()
    ]);
  }

  // 勾选保存密钥时自动登录
  (async function initAutoLogin() {
    try {
      const saved = safeLS('subscheck_api_key');
      if (saved) {
        sessionKey = saved;
        const r = await sfetch(API.status);
        if (r.status === 401) {
          sessionKey = null;
          safeLS('subscheck_api_key', null);
          showLogin(true);
          setAuthUI(false);
          return;
        }
        if (r.ok) {
          showLogin(false);
          setAuthUI(true);
          await loadAll();
          startPollers();
          showToast('自动登录成功', 'success');
          return;
        }
      }
    } catch (e) { /* ignore */ }
    showLogin(true);
    setAuthUI(false);
  })();

  // ==================== 主题处理 ====================
  const THEME_KEY = 'theme';

  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.setAttribute('data-theme', 'dark');
      themeToggleBtn?.setAttribute('aria-pressed', 'true');
      if (iconMoon) iconMoon.style.display = '';
      if (iconSun) iconSun.style.display = 'none';
      if (themeToggleBtn) themeToggleBtn.title = '切换到浅色模式';
    } else {
      root.removeAttribute('data-theme');
      themeToggleBtn?.setAttribute('aria-pressed', 'false');
      if (iconMoon) iconMoon.style.display = 'none';
      if (iconSun) iconSun.style.display = '';
      if (themeToggleBtn) themeToggleBtn.title = '切换到深色模式';
    }
  }

  function getInitialTheme() {
    const saved = safeLS(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function hasSavedTheme() {
    const saved = safeLS(THEME_KEY);
    return saved === 'dark' || saved === 'light';
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    safeLS(THEME_KEY, next);
  }

  // 初始化主题
  (function initTheme() {
    const initial = getInitialTheme();
    applyTheme(initial);

    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener?.('change', (e) => {
        if (!hasSavedTheme()) {
          applyTheme(e.matches ? 'dark' : 'light');
        }
      });
    }
  })();

  // 初始化分享按钮
  function setupShareButton(btnId) {
    const btn = document.getElementById(btnId);
    if (!btn) return;

    btn.addEventListener("click", async (e) => {
      e.stopPropagation();

      // 检查是否已经是显示状态：如果是，则直接隐藏
      if (shareMenu.classList.contains("active")) {
        shareMenu.classList.remove("active");
        return; // 提前退出，无需其他逻辑
      }

      try {
        // 1. 获取配置
        if (!sessionKey) { showLogin(true); return; };
        const r = await sfetch(API.config);
        if (!r.ok) { showToast('读取配置失败', 'warn'); return; }

        const p = r.payload;
        let yamlContent = '';
        if (p?.content !== undefined) yamlContent = p.content;

        const config = jsyaml.load(yamlContent);

        const port = config["sub-store-port"] || "";
        const path = config["sub-store-path"] || "";

        // 2. 去掉当前 URL 的端口
        const url = `${window.location.protocol}//${window.location.hostname}`;

        // 3. 拼接 baseUrl
        const baseUrl = `${url}${port}${path}`;

        // 4. 设置链接（存储到 data-link 属性）
        document.getElementById("commonSub-item").dataset.link = baseUrl + "/download/sub";
        document.getElementById("mihomoSub-item").dataset.link = baseUrl + "/api/file/mihomo";

        // 5. 绑定复制事件（只绑定一次）
        bindCopyOnClick("commonSub-item");
        bindCopyOnClick("mihomoSub-item");

        // 6. 定位菜单
        const shareMenu = document.getElementById("shareMenu");
        if (window.innerWidth < 768) {
          // 小屏幕：居中显示
          const rect = btn.getBoundingClientRect();
          shareMenu.style.top = `${rect.top}px`;
          shareMenu.style.left = `${rect.left - 160}px`;
          shareMenu.style.transform = "none";
        } else {
          // 大屏幕：跟随按钮
          const rect = btn.getBoundingClientRect();
          shareMenu.style.top = `${rect.top}px`;
          shareMenu.style.left = `${rect.right * 0.9}px`;
          shareMenu.style.transform = "none";
        }

        // 7. 显示菜单
        shareMenu.classList.add("active");
      } catch (e) {
        console.error("获取订阅链接失败", e);
      }
    });
  }

  // 初始化绑定两个按钮
  setupShareButton("share");
  setupShareButton("btnShare");

  // 点击空白处关闭菜单
  document.addEventListener("click", (e) => {
    const shareMenu = document.getElementById("shareMenu");
    if (shareMenu.classList.contains("active") &&
      !shareMenu.contains(e.target) &&
      e.target.id !== "share" &&
      e.target.id !== "btnShare") {
      shareMenu.classList.remove("active");
    }
  });

  // 复制事件绑定函数（现在绑定到 list-item）
  function bindCopyOnClick(itemId) {
    const el = document.getElementById(itemId);
    if (!el || el.dataset.bound === "true") return;
    el.dataset.bound = "true";

    const handler = async (e) => {
      e.preventDefault();
      const url = el.dataset.link; // 从 data-link 获取 URL
      if (!url) return; // 安全检查

      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(url);
          showToast("已复制链接到剪贴板", "info", 2000);
        } else {
          fallbackCopy(url);
          return; // fallback 已处理隐藏
        }
      } catch (err) {
        console.error("复制失败", err);
        fallbackCopy(url);
        return;
      }

      // 复制成功：隐藏菜单
      const shareMenu = document.getElementById("shareMenu");
      shareMenu.classList.remove("active");

      // 复制后自动打开新标签（如果需要，取消注释下一行）
      // window.open(url, '_blank');
    };

    // 绑定多种事件，支持键盘访问（Enter/Space）
    el.addEventListener("click", handler);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handler(e);
      }
    });
    el.addEventListener("touchend", handler, { passive: false }); // 移动端，现代 passive 选项
  }

  function fallbackCopy(text) {
    const input = document.createElement("input");
    input.value = text;
    input.style.opacity = "0"; // 现代：隐藏 input，提升 UX
    input.style.position = "absolute";
    document.body.appendChild(input);
    input.select();
    input.setSelectionRange(0, 99999); // 现代：兼容移动端全选
    try {
      document.execCommand("copy");
      showToast("已复制链接到剪贴板", "info", 2000);
    } catch (err) {
      showToast("复制失败，请手动复制", "error", 2000);
    }
    document.body.removeChild(input);

    // 复制成功：隐藏菜单
    const shareMenu = document.getElementById("shareMenu");
    shareMenu.classList.remove("active");
  }

  // ==================== 启动 ====================
  (function bootstrap() {
    try {
      const saved = safeLS('subscheck_api_key');
      if (saved && apiKeyInput) apiKeyInput.value = saved;
    } catch (e) { /* ignore */ }

    bindControls();
    loginBtn?.addEventListener('click', onLoginBtnClick);
    window.addEventListener('beforeunload', () => stopPollers());
    setAuthUI(false);

    // 初始化时隐藏进度区（避免页面加载时看到残留进度）
    try { showProgressUI(false); } catch (e) { }
  })();
})();
