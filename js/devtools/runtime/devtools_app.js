import { el, clear } from '../../ui/dom.js';

function nowSec() {
  return performance.now() * 0.001;
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function debounce(fn, ms = 150) {
  let t = 0;
  return (...args) => {
    try { clearTimeout(t); } catch { /* ignore */ }
    t = setTimeout(() => fn(...args), Math.max(0, Number(ms) || 0));
  };
}

function clampNum(n, a, b) {
  const x = Number(n);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

export class DevToolsApp {
  /**
   * @param {{ canvasHost: HTMLDivElement, uiRoot: HTMLDivElement, toolCategories: any[] }} opts
   */
  constructor({ canvasHost, uiRoot, toolCategories }) {
    this.canvasHost = canvasHost;
    this.uiRoot = uiRoot;

    // Flatten categories into a flat tool list + store category metadata.
    this._categories = Array.isArray(toolCategories) ? toolCategories : [];
    this.tools = [];
    this._toolIconMap = new Map();
    this._toolCategoryMap = new Map();
    this._toolProductMap = new Map();
    this._toolSummaryMap = new Map();
    this._toolsByProduct = new Map();
    for (const cat of this._categories) {
      for (const entry of (cat.tools || [])) {
        const t = entry.tool;
        if (!t) continue;
        const id = String(t.id || '');
        const product = String(entry.product || cat.label || 'Other');
        this.tools.push(t);
        this._toolIconMap.set(id, String(entry.icon || ''));
        this._toolCategoryMap.set(id, String(cat.label || ''));
        this._toolProductMap.set(id, product);
        this._toolSummaryMap.set(id, String(entry.summary || ''));
        if (!this._toolsByProduct.has(product)) this._toolsByProduct.set(product, []);
        this._toolsByProduct.get(product).push(id);
      }
    }

    this.activeTool = null;
    this._activeToolId = '';
    this._running = false;
    this._lastT = nowSec();

    this._logLines = [];
    this._maxLogLines = 250;

    this._leftDock = el('div', { class: 'leftDock' });
    this._rightDock = el('div', { class: 'rightDock' });
    this._bottomDock = el('div', { class: 'bottomDock' });
    this._topBar = el('div', { class: 'topBar' });

    this._toolButtons = new Map();
    this._visibleToolIds = [];
    this._toolSearch = '';
    this._activeProduct = 'all';
    this._productButtons = new Map();
    this._productSwitchHost = null;
    this._logArea = null;
    this._toolSearchInput = null;
    this._toolSearchApply = debounce((v) => {
      this._toolSearch = String(v || '');
      this._rebuildToolList();
    }, 120);

    // Pinned tools
    this._pinnedToolIds = [];
    this._loadPinnedTools();

    // Dock visibility (collapsible docks)
    this._dockVisibility = { sidebar: true, panel: true, console: true };
    this._dockVisibilityLoadedFromStorage = false;
    this._loadDockVisibility();

    // Toast notifications
    this._toastContainer = el('div', { class: 'toastContainer' });
    this._toasts = [];
    this._maxToasts = 5;

    // Modal overlay (command palette, help, etc.)
    this._modalOverlay = el('div', { class: 'modalOverlay', style: { display: 'none' } });
    this._modalCard = null;

    // Command palette state
    this._paletteOpen = false;
    this._paletteQuery = '';
    this._paletteItems = [];
    this._paletteSelected = 0;
    this._paletteInputEl = null;
    this._paletteListEl = null;

    // Help modal state
    this._helpOpen = false;

    // HUD / perf
    this._hud = el('div', { class: 'devHud' }, ['']);
    this._hudVisible = true;
    this._fps = { ema: 0, last: nowSec() };
    this._hudLastUpdate = 0;
    this._keyHandler = (e) => this._onKeyDown(e);

    // Dock resize persistence
    this._dockSizes = { sidebarW: 240, panelW: 420, bottomH: 160 };
    this._activeDrag = null;
    this._loadDockSizes();

    // Console UX
    this._logFilter = '';
    this._logAutoScroll = true;

    // Per-category open/closed state
    this._catOpen = new Map();
    this._loadCategoryOpenState();
  }

  start() {
    if (this._running) return;
    this._running = true;

    clear(this.uiRoot);
    this.uiRoot.appendChild(this._leftDock);
    this.uiRoot.appendChild(this._rightDock);
    this.uiRoot.appendChild(this._bottomDock);
    this.uiRoot.appendChild(this._hud);
    this.uiRoot.appendChild(this._toastContainer);
    this.uiRoot.appendChild(this._modalOverlay);
    this.uiRoot.appendChild(this._topBar);

    this._applyMobileDockDefaults();
    this._applyDockSizes();
    this._applyDockVisibility();
    this._renderShell();

    // Restore last tool if possible; else first tool.
    const saved = String(localStorage.getItem('devtools.activeToolId') || '');
    const hasSaved = saved && this.tools.some((t) => String(t?.id || '') === saved);
    const first = this.tools[0];
    const pick = hasSaved ? saved : String(first?.id || '');
    if (pick) this.setActiveTool(pick);

    window.addEventListener('keydown', this._keyHandler);

    // Surface runtime errors in the console + toast (devtools should fail loud, not silent).
    try {
      window.addEventListener('error', (ev) => {
        const msg = String(ev?.message || ev?.error?.message || 'Unknown error');
        this.log(`Error: ${msg}`);
        this.toast(msg, 'error', { title: 'Runtime error' });
      });
      window.addEventListener('unhandledrejection', (ev) => {
        const reason = ev?.reason;
        const msg = String(reason?.message || reason || 'Unhandled rejection');
        this.log(`Unhandled rejection: ${msg}`);
        this.toast(msg, 'error', { title: 'Unhandled rejection' });
      });
    } catch { /* ignore */ }

    requestAnimationFrame(() => this._frame());
  }

  stop() {
    this._running = false;
    try { window.removeEventListener('keydown', this._keyHandler); } catch { /* ignore */ }
    try { this.setActiveTool(''); } catch { /* ignore */ }
  }

  log(msg) {
    const s = String(msg ?? '').trim();
    if (!s) return;
    const t = new Date().toLocaleTimeString();
    this._logLines.push(`[${t}] ${s}`);
    if (this._logLines.length > this._maxLogLines) this._logLines.splice(0, this._logLines.length - this._maxLogLines);
    this._scheduleLogRender();
  }

  /* ────────────────── Toast notifications ────────────────── */

  /**
   * Show a brief toast notification.
   * @param {string} message - The message to display.
   * @param {'info'|'success'|'error'|'warning'} type - Toast type.
   * @param {{ title?: string, durationMs?: number }} opts
   */
  toast(message, type = 'info', { title = '', durationMs = 4000 } = {}) {
    const icons = { info: '●', success: '✓', error: '✕', warning: '▲' };
    const icon = icons[type] || icons.info;

    const toastEl = el('div', { class: `toast toast-${type}` }, [
      el('div', { class: 'toastIcon' }, [icon]),
      el('div', { class: 'toastBody' }, [
        title ? el('div', { class: 'toastTitle' }, [title]) : null,
        el('div', { class: 'toastMsg' }, [String(message || '')]),
      ].filter(Boolean)),
    ]);

    // Click to dismiss
    toastEl.addEventListener('click', () => this._dismissToast(toastEl));

    this._toastContainer.appendChild(toastEl);
    this._toasts.push(toastEl);

    // Enforce max visible
    while (this._toasts.length > this._maxToasts) {
      this._dismissToast(this._toasts[0]);
    }

    // Auto-dismiss
    setTimeout(() => this._dismissToast(toastEl), durationMs);
  }

  _dismissToast(toastEl) {
    if (!toastEl || !toastEl.parentNode) return;
    if (toastEl.classList.contains('toast-exit')) return;
    toastEl.classList.add('toast-exit');
    setTimeout(() => {
      try { toastEl.parentNode?.removeChild(toastEl); } catch { /* */ }
      this._toasts = this._toasts.filter((t) => t !== toastEl);
    }, 220);
  }

  /* ────────────────── Pinned tools ────────────────── */

  _loadPinnedTools() {
    try {
      const raw = localStorage.getItem('devtools.pinnedTools');
      const arr = raw ? JSON.parse(raw) : [];
      this._pinnedToolIds = Array.isArray(arr) ? arr.map((s) => String(s)).filter(Boolean) : [];
    } catch {
      this._pinnedToolIds = [];
    }
  }

  _savePinnedTools() {
    try { localStorage.setItem('devtools.pinnedTools', JSON.stringify(this._pinnedToolIds)); } catch { /* */ }
  }

  _isPinned(toolId) {
    return this._pinnedToolIds.includes(String(toolId));
  }

  _togglePin(toolId) {
    const id = String(toolId);
    if (this._isPinned(id)) {
      this._pinnedToolIds = this._pinnedToolIds.filter((x) => x !== id);
    } else {
      this._pinnedToolIds.push(id);
    }
    this._savePinnedTools();
    this._rebuildToolList();
  }

  /* ────────────────── Shell ────────────────── */

  _renderShell() {
    clear(this._leftDock);
    clear(this._rightDock);
    clear(this._bottomDock);
    clear(this._topBar);

    // ─── Left sidebar ───
    this._renderSidebar();

    // ─── Right panel (empty state) ───
    this._renderRightEmpty();

    // ─── Bottom dock (log) ───
    this._renderBottomDock();

    // ─── Top actions ───
    this._renderTopBar();

    // ─── Dock resizers (must be after clears) ───
    this._installDockResizers();
  }

  _renderSidebar() {
    const dock = this._leftDock;

    // Brand header
    const brand = el('div', { class: 'sidebarBrand' }, [
      el('div', {}, [
        el('div', { class: 'brandTitle' }, ['DevTools']),
        el('div', { class: 'brandSub' }, ['Pick a product, then a tool']),
      ]),
    ]);
    dock.appendChild(brand);

    // Product switcher
    this._productSwitchHost = el('div', { class: 'sidebarProducts' });
    dock.appendChild(this._productSwitchHost);
    this._renderProductSwitcher();

    // Search
    const searchWrap = el('div', { class: 'sidebarSearch' }, [
      el('div', { class: 'sidebarSearchWrap' }, [
        (this._toolSearchInput = el('input', {
          value: this._toolSearch || '',
          placeholder: 'Search tools\u2026',
          'aria-label': 'Search tools',
          oninput: (e) => {
            this._toolSearchApply(String(e.target.value || ''));
          },
          onkeydown: (e) => this._onSidebarSearchKeyDown(e),
        })),
      ]),
    ]);
    dock.appendChild(searchWrap);

    // Tool list container
    this._toolListContainer = el('div', {});
    dock.appendChild(this._toolListContainer);

    this._rebuildToolList();

    // Keyboard shortcuts hint at bottom
    dock.appendChild(el('div', {
      class: 'muted',
      style: { marginTop: '12px', padding: '0 4px', fontSize: '10px', lineHeight: '1.5' },
    }, [
      el('span', { class: 'kbd' }, ['Ctrl']),
      '+',
      el('span', { class: 'kbd' }, ['K']),
      ' palette   ',
      el('span', { class: 'kbd' }, ['[']),
      ' ',
      el('span', { class: 'kbd' }, [']']),
      ' cycle tools   ',
      el('span', { class: 'kbd' }, ['/']),
      ' search   ',
      el('span', { class: 'kbd' }, ['?']),
      ' help   ',
      el('span', { class: 'kbd' }, ['`']),
      ' toggle HUD',
    ]));
  }

  _rebuildToolList() {
    const container = this._toolListContainer;
    if (!container) return;
    clear(container);
    this._toolButtons.clear();
    this._visibleToolIds = [];

    const q = String(this._toolSearch || '').trim().toLowerCase();
    const activeProduct = String(this._activeProduct || 'all');

    // Helper: build a single tool button row with pin toggle
    const makeToolBtn = (entry, cat) => {
      const t = entry.tool;
      const id = String(t.id || '');
      const label = String(t.label || id || 'Tool');
      const icon = String(entry.icon || '');
      const isPinned = this._isPinned(id);
      const summary = String(this._toolSummaryMap.get(id) || '');

      const pinBtn = el('button', {
        class: `pinBtn${isPinned ? ' pinned' : ''}`,
        onclick: (e) => { e.stopPropagation(); this._togglePin(id); },
        title: isPinned ? 'Unpin from top' : 'Pin to top',
      }, [isPinned ? '★' : '☆']);

      const btnChildren = [];
      if (icon) btnChildren.push(el('span', { class: 'toolIcon' }, [icon]));
      btnChildren.push(el('div', { class: 'toolText' }, [
        el('div', { class: 'toolLabel' }, [label]),
        el('div', { class: 'toolMeta muted' }, [summary || id]),
      ]));
      btnChildren.push(pinBtn);

      const btn = el('button', {
        class: `toolBtn${id === this._activeToolId ? ' active' : ''}`,
        onclick: () => this.setActiveTool(id),
        title: `${label} (${id})`,
      }, btnChildren);

      this._toolButtons.set(id, btn);
      this._visibleToolIds.push(id);
      return btn;
    };

    // Collect all entries that match the search
    const allEntries = [];
    for (const cat of this._categories) {
      for (const entry of (cat.tools || [])) {
        const t = entry.tool;
        if (!t) continue;
        const id = String(t.id || '');
        const label = String(t.label || id || '');
        const product = String(this._toolProductMap.get(id) || '');
        if (!id) continue;
        if (activeProduct !== 'all' && product !== activeProduct) continue;
        if (q) {
          const hay = `${id} ${label} ${cat.label || ''} ${product} ${this._toolSummaryMap.get(id) || ''}`.toLowerCase();
          if (!hay.includes(q)) continue;
        }
        allEntries.push({ entry, cat });
      }
    }

    // Pinned tools section
    const pinnedEntries = allEntries.filter(({ entry }) => this._isPinned(String(entry.tool?.id || '')));
    if (pinnedEntries.length > 0) {
      const pinnedGroup = el('details', { class: 'catGroupDetails pinnedGroup', open: true });
      pinnedGroup.appendChild(el('summary', { class: 'catSummary pinnedLabel' }, [
        el('span', {}, ['★ Pinned']),
        el('span', { class: 'catCount badge' }, [String(pinnedEntries.length)]),
      ]));
      const body = el('div', { class: 'catBody' });
      for (const { entry, cat } of pinnedEntries) body.appendChild(makeToolBtn(entry, cat));
      pinnedGroup.appendChild(body);
      container.appendChild(pinnedGroup);
    }

    // Regular categorized list
    for (const cat of this._categories) {
      const catTools = (cat.tools || []).filter((entry) => {
        const t = entry.tool;
        if (!t) return false;
        const id = String(t.id || '');
        const label = String(t.label || id || '');
        const product = String(this._toolProductMap.get(id) || '');
        if (!id) return false;
        if (activeProduct !== 'all' && product !== activeProduct) return false;
        if (q) {
          const hay = `${id} ${label} ${cat.label || ''} ${product} ${this._toolSummaryMap.get(id) || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      if (catTools.length === 0) continue;

      const catLabel = String(cat.label || 'Other');
      const open = q ? true : this._isCategoryOpen(catLabel);
      const group = el('details', {
        class: 'catGroupDetails',
        open,
        ontoggle: (e) => {
          try { this._setCategoryOpen(catLabel, !!e.target.open); } catch { /* ignore */ }
        },
      });
      group.appendChild(el('summary', { class: 'catSummary' }, [
        el('span', { class: 'catLabelText' }, [catLabel]),
        el('span', { class: 'catCount badge' }, [String(catTools.length)]),
      ]));

      const body = el('div', { class: 'catBody' });
      for (const entry of catTools) body.appendChild(makeToolBtn(entry, cat));
      group.appendChild(body);

      container.appendChild(group);
    }
  }

  _renderProductSwitcher() {
    const host = this._productSwitchHost;
    if (!host) return;
    clear(host);
    this._productButtons.clear();

    const products = ['all', ...Array.from(this._toolsByProduct.keys())];
    host.appendChild(el('div', { class: 'productLabel muted' }, ['Products']));
    const row = el('div', { class: 'productChipRow' });
    host.appendChild(row);

    for (const p0 of products) {
      const p = String(p0 || 'all');
      const count = p === 'all' ? this.tools.length : (this._toolsByProduct.get(p)?.length || 0);
      const label = p === 'all' ? `All (${count})` : `${p} (${count})`;
      const btn = el('button', {
        class: `productChip${p === this._activeProduct ? ' active' : ''}`,
        onclick: () => {
          this._activeProduct = p;
          this._renderProductSwitcher();
          this._rebuildToolList();
          if (p !== 'all') this._activatePreferredToolForProduct(p);
        },
        title: p === 'all' ? 'Show all tools' : `Switch to ${p}`,
      }, [label]);
      this._productButtons.set(p, btn);
      row.appendChild(btn);
    }
  }

  _activatePreferredToolForProduct(product) {
    const p = String(product || '');
    if (!p) return;
    const ids = this._toolsByProduct.get(p) || [];
    if (!ids.length) return;
    const cur = String(this._activeToolId || '');
    if (ids.includes(cur)) return;
    this.setActiveTool(ids[0]);
  }

  _renderRightEmpty() {
    const dock = this._rightDock;
    clear(dock);
    dock.appendChild(el('div', { class: 'emptyState fadeIn' }, [
      el('div', { class: 'emptyIcon' }, ['◈']),
      el('div', { class: 'emptyText' }, ['Select a tool from the sidebar to get started.']),
    ]));
  }

  _renderBottomDock() {
    const dock = this._bottomDock;

    const header = el('div', { class: 'logHeader' }, [
      el('div', { class: 'dockTitle' }, ['Console']),
      el('input', {
        value: this._logFilter || '',
        placeholder: 'Filter\u2026',
        title: 'Filter console lines',
        style: { maxWidth: '160px', padding: '3px 8px', fontSize: '10px', background: 'rgba(255,255,255,0.04)' },
        oninput: (e) => {
          this._logFilter = String(e.target.value || '');
          this._renderLog();
        },
      }),
      el('button', {
        onclick: () => { this._logAutoScroll = !this._logAutoScroll; },
        title: 'Toggle auto-scroll',
      }, ['Auto']),
      el('button', {
        onclick: () => { this._logLines = []; this._renderLog(); },
      }, ['Clear']),
      el('button', {
        onclick: async () => {
          try { await navigator.clipboard.writeText(this._logLines.join('\n')); } catch { /* ignore */ }
        },
        title: 'Copy log to clipboard',
      }, ['Copy']),
    ]);
    dock.appendChild(header);

    this._logArea = el('div', { class: 'logBody' }, ['']);
    dock.appendChild(this._logArea);
    this._renderLog();
  }

  _scheduleLogRender() {
    if (this._logScheduled) return;
    this._logScheduled = true;
    requestAnimationFrame(() => {
      this._logScheduled = false;
      this._renderLog();
    });
  }

  _renderLog() {
    if (!this._logArea) return;
    const q = String(this._logFilter || '').trim().toLowerCase();
    const lines = q ? this._logLines.filter((l) => String(l).toLowerCase().includes(q)) : this._logLines;
    this._logArea.textContent = lines.join('\n');
    // Keep tail in view (only when not filtering and auto-scroll enabled).
    if (!q && this._logAutoScroll) {
      try { this._logArea.scrollTop = this._logArea.scrollHeight; } catch { /* ignore */ }
    }
  }

  _loadDockSizes() {
    try {
      const raw = localStorage.getItem('devtools.dockSizes');
      const j = raw ? JSON.parse(raw) : null;
      if (j && typeof j === 'object') {
        const sidebarW = clampNum(j.sidebarW, 180, 520);
        const panelW = clampNum(j.panelW, 320, 900);
        const bottomH = clampNum(j.bottomH, 120, 520);
        this._dockSizes = { sidebarW, panelW, bottomH };
      }
    } catch {
      // ignore
    }
  }

  _saveDockSizes() {
    try { localStorage.setItem('devtools.dockSizes', JSON.stringify(this._dockSizes)); } catch { /* ignore */ }
  }

  _applyDockSizes() {
    const r = document.documentElement;
    if (!r) return;
    const { sidebarW, panelW, bottomH } = this._dockSizes || {};
    // Note: sidebar may be collapsed; visibility pass will override to 0px.
    try { r.style.setProperty('--sidebar-w', `${clampNum(sidebarW, 180, 520)}px`); } catch { /* ignore */ }
    try { r.style.setProperty('--panel-w-user', `${clampNum(panelW, 320, 900)}px`); } catch { /* ignore */ }
    try { r.style.setProperty('--bottom-dock-h-user', `${clampNum(bottomH, 120, 520)}px`); } catch { /* ignore */ }
  }

  _loadDockVisibility() {
    try {
      const raw = localStorage.getItem('devtools.dockVisibility');
      const j = raw ? JSON.parse(raw) : null;
      if (j && typeof j === 'object') {
        this._dockVisibility.sidebar = (j.sidebar !== false);
        this._dockVisibility.panel = (j.panel !== false);
        this._dockVisibility.console = (j.console !== false);
        this._dockVisibilityLoadedFromStorage = true;
      }
    } catch { /* ignore */ }
  }

  _saveDockVisibility() {
    try { localStorage.setItem('devtools.dockVisibility', JSON.stringify(this._dockVisibility)); } catch { /* ignore */ }
  }

  _applyDockVisibility() {
    const r = document.documentElement;
    if (!r) return;
    const showSidebar = !!this._dockVisibility.sidebar;
    const showPanel = !!this._dockVisibility.panel;
    const showConsole = !!this._dockVisibility.console;

    // Layout variables (so other docks expand when one is hidden)
    try {
      r.style.setProperty('--sidebar-w', showSidebar ? `${clampNum(this._dockSizes.sidebarW, 180, 520)}px` : '0px');
    } catch { /* ignore */ }
    try {
      r.style.setProperty('--panel-w', showPanel ? `min(${clampNum(this._dockSizes.panelW, 320, 900)}px, calc(100vw - 32px))` : '0px');
    } catch { /* ignore */ }
    try {
      r.style.setProperty('--bottom-dock-h', showConsole ? `${clampNum(this._dockSizes.bottomH, 120, 520)}px` : '0px');
    } catch { /* ignore */ }

    // Actual dock visibility (with CSS transitions handled in devtools.html)
    try { this._leftDock.classList.toggle('dockCollapsed', !showSidebar); } catch { /* ignore */ }
    try { this._rightDock.classList.toggle('dockCollapsed', !showPanel); } catch { /* ignore */ }
    try { this._bottomDock.classList.toggle('dockCollapsed', !showConsole); } catch { /* ignore */ }
  }

  _isMobileLikeViewport() {
    try {
      const narrow = (window.innerWidth || 0) <= 820;
      const coarse = !!window.matchMedia?.('(pointer: coarse)').matches;
      return narrow || coarse;
    } catch {
      return (window.innerWidth || 0) <= 820;
    }
  }

  _applyMobileDockDefaults() {
    if (!this._isMobileLikeViewport()) return;
    if (this._dockVisibilityLoadedFromStorage) return;
    // On first mobile visit, maximize working area for the active tool.
    this._dockVisibility.sidebar = false;
    this._dockVisibility.console = false;
    this._dockVisibility.panel = true;
  }

  _installDockResizers() {
    if (this._isMobileLikeViewport()) return;
    const left = this._leftDock;
    const right = this._rightDock;
    const bottom = this._bottomDock;
    if (!left || !right || !bottom) return;

    // Sidebar width
    left.appendChild(el('div', {
      class: 'dockResizer dockResizer-ew dockResizer-right',
      title: 'Drag to resize sidebar',
      onmousedown: (e) => this._beginDockDrag(e, 'sidebar'),
    }));

    // Right panel width
    right.appendChild(el('div', {
      class: 'dockResizer dockResizer-ew dockResizer-left',
      title: 'Drag to resize tool panel',
      onmousedown: (e) => this._beginDockDrag(e, 'panel'),
    }));

    // Bottom log height
    bottom.appendChild(el('div', {
      class: 'dockResizer dockResizer-ns dockResizer-top',
      title: 'Drag to resize console',
      onmousedown: (e) => this._beginDockDrag(e, 'bottom'),
    }));
  }

  _beginDockDrag(e, which) {
    try { e.preventDefault?.(); } catch { /* ignore */ }
    try { e.stopPropagation?.(); } catch { /* ignore */ }
    const dockPad = 16;

    const onMove = (ev) => {
      try { ev.preventDefault?.(); } catch { /* ignore */ }
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      if (which === 'sidebar') {
        const w = clampNum((ev.clientX || 0) - dockPad, 180, Math.max(220, vw - 420));
        this._dockSizes.sidebarW = w;
        // If currently hidden, keep it hidden but remember size.
      } else if (which === 'panel') {
        const w = clampNum((vw - dockPad) - (ev.clientX || 0), 320, Math.max(360, vw - 220));
        this._dockSizes.panelW = w;
      } else if (which === 'bottom') {
        const h = clampNum((vh - dockPad) - (ev.clientY || 0), 120, Math.max(160, vh - 120));
        this._dockSizes.bottomH = h;
      }
      this._applyDockSizes();
      this._applyDockVisibility();
    };

    const onUp = () => {
      try { window.removeEventListener('mousemove', onMove); } catch { /* ignore */ }
      try { window.removeEventListener('mouseup', onUp); } catch { /* ignore */ }
      this._saveDockSizes();
    };

    try { window.addEventListener('mousemove', onMove); } catch { /* ignore */ }
    try { window.addEventListener('mouseup', onUp); } catch { /* ignore */ }
  }

  /* ────────────────── Tool switching ────────────────── */

  /**
   * @param {string} toolId
   */
  async setActiveTool(toolId) {
    const id = String(toolId || '');
    if (id === this._activeToolId) return;

    // Unmount old tool.
    if (this.activeTool) {
      try { await this.activeTool.unmount?.(); } catch (e) { this.log(`Tool unmount error: ${e?.message || e}`); }
      this.activeTool = null;
    }
    this._activeToolId = '';
    clear(this.canvasHost);

    // Update buttons.
    for (const [tid, btn] of this._toolButtons.entries()) {
      if (tid === id) btn.classList.add('active');
      else btn.classList.remove('active');
    }

    // Find new tool.
    const t = this.tools.find((x) => String(x?.id || '') === id) || null;
    if (!t) {
      this._renderRightEmpty();
      return;
    }

    this.activeTool = t;
    this._activeToolId = id;
    this._activeProduct = String(this._toolProductMap.get(id) || this._activeProduct || 'all');
    try { localStorage.setItem('devtools.activeToolId', id); } catch { /* ignore */ }
    try { this._updateTopBarToolLabel(); } catch { /* ignore */ }
    try { this._renderProductSwitcher(); } catch { /* ignore */ }
    try { this._rebuildToolList(); } catch { /* ignore */ }

    // Build right panel with header.
    clear(this._rightDock);

    const toolIcon = this._toolIconMap.get(id) || '◇';
    const toolLabel = String(t.label || t.id || 'Tool');
    const toolCategory = this._toolCategoryMap.get(id) || '';
    const toolProduct = this._toolProductMap.get(id) || '';
    const toolSummary = this._toolSummaryMap.get(id) || '';

    const header = el('div', { class: 'toolHeader fadeIn' }, [
      el('div', { class: 'toolHeaderIcon' }, [toolIcon]),
      el('div', {}, [
        el('div', { class: 'toolHeaderTitle' }, [toolLabel]),
        (toolProduct || toolCategory)
          ? el('div', { class: 'muted', style: { fontSize: '10px', marginTop: '1px' } }, [[toolProduct, toolCategory].filter(Boolean).join(' · ')])
          : null,
        toolSummary
          ? el('div', { class: 'muted', style: { fontSize: '10px', marginTop: '3px' } }, [toolSummary])
          : null,
      ].filter(Boolean)),
    ]);
    this._rightDock.appendChild(header);

    const ui = el('div', { class: 'fadeIn' });
    this._rightDock.appendChild(ui);

    const ctx = {
      canvasHost: this.canvasHost,
      uiRoot: ui,
      log: (m) => this.log(m),
      toast: (msg, type, opts) => this.toast(msg, type, opts),
      // helper: list assets via vite middleware
      assetIndex: async ({ query = '', ext = '' } = {}) => {
        const q = encodeURIComponent(String(query || ''));
        const e = encodeURIComponent(String(ext || ''));
        const url = `/__editor_assets_index?query=${q}&ext=${e}`;
        const resp = await fetch(url);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'asset index failed'));
        return j?.items || [];
      },
    };

    try {
      await t.mount?.(ctx);
    } catch (e) {
      this.log(`Tool mount error: ${e?.message || e}`);
      ui.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'muted' }, ['Failed to mount tool. See console for details.']),
      ]));
    }
  }

  /* ────────────────── Keyboard ────────────────── */

  _onKeyDown(e) {
    // Global hotkeys:
    // - Ctrl+1..9: pick tool by index
    // - [ / ]: previous/next tool
    // - ` (backtick): toggle HUD
    // - Ctrl+K: command palette
    // - /: focus tool search
    // - ?: help
    // - Ctrl+B: toggle sidebar
    // - Ctrl+J: toggle console
    // - Ctrl+\: toggle right panel
    try {
      if (!e) return;

      // If a modal is open, it owns the keyboard.
      if (this._paletteOpen) {
        this._onPaletteKeyDown(e);
        return;
      }
      if (this._helpOpen) {
        if (e.key === 'Escape') { this._closeModal(); }
        return;
      }

      // Don't steal keys when typing in inputs/textareas/selects/contenteditable
      const target = /** @type {any} */ (e.target);
      const tag = String(target?.tagName || '').toLowerCase();
      const isTyping = !!(target?.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select');
      const isCtrl = !!(e.ctrlKey || e.metaKey);

      // Ctrl+K / Cmd+K: command palette
      if (isCtrl && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault?.();
        this._openPalette();
        return;
      }

      // Dock toggles (match common editor muscle memory)
      if (isCtrl && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault?.();
        this._dockVisibility.sidebar = !this._dockVisibility.sidebar;
        this._applyDockVisibility();
        this._saveDockVisibility();
        return;
      }
      if (isCtrl && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault?.();
        this._dockVisibility.console = !this._dockVisibility.console;
        this._applyDockVisibility();
        this._saveDockVisibility();
        return;
      }
      if (isCtrl && (e.key === '\\' || e.code === 'Backslash')) {
        e.preventDefault?.();
        this._dockVisibility.panel = !this._dockVisibility.panel;
        this._applyDockVisibility();
        this._saveDockVisibility();
        return;
      }

      // / focuses tool search (unless user is typing)
      if (!isTyping && e.key === '/') {
        e.preventDefault?.();
        try { this._toolSearchInput?.focus?.(); } catch { /* ignore */ }
        return;
      }

      // ? opens help (Shift+/)
      if (!isTyping && e.key === '?') {
        e.preventDefault?.();
        this._openHelp();
        return;
      }

      if (e.key === '`') {
        this._hudVisible = !this._hudVisible;
        this._hud.style.display = this._hudVisible ? 'block' : 'none';
        return;
      }
      if (isCtrl && /^[1-9]$/.test(String(e.key))) {
        const idx = Math.max(0, Number(e.key) - 1);
        const t = this.tools[idx];
        const id = String(t?.id || '');
        if (id) this.setActiveTool(id);
        return;
      }
      if (e.key === '[' || e.key === ']') {
        const dir = (e.key === '[') ? -1 : 1;
        const ids = this.tools.map((t) => String(t?.id || '')).filter(Boolean);
        const cur = String(this._activeToolId || '');
        const i0 = Math.max(0, ids.indexOf(cur));
        const i1 = (i0 + dir + ids.length) % ids.length;
        const next = ids[i1];
        if (next) this.setActiveTool(next);
      }
    } catch {
      // ignore
    }
  }

  /* ────────────────── Modals (help / palette) ────────────────── */

  _showModal(cardEl) {
    this._modalCard = cardEl;
    clear(this._modalOverlay);
    this._modalOverlay.appendChild(cardEl);
    this._modalOverlay.style.display = 'flex';
    // Click outside modal to close.
    try {
      this._modalOverlay.onclick = (e) => {
        if (e?.target === this._modalOverlay) this._closeModal();
      };
    } catch { /* ignore */ }
  }

  _closeModal() {
    this._paletteOpen = false;
    this._helpOpen = false;
    this._paletteItems = [];
    this._paletteSelected = 0;
    this._paletteInputEl = null;
    this._paletteListEl = null;
    this._modalCard = null;
    try { this._modalOverlay.style.display = 'none'; } catch { /* ignore */ }
    try { clear(this._modalOverlay); } catch { /* ignore */ }
  }

  _openHelp() {
    this._helpOpen = true;
    const card = el('div', { class: 'modalCard' }, [
      el('div', { class: 'modalHeader' }, [
        el('div', { class: 'modalTitle' }, ['Keyboard shortcuts']),
        el('button', { onclick: () => this._closeModal(), title: 'Close' }, ['Esc']),
      ]),
      el('div', { class: 'modalBody' }, [
        el('div', { class: 'modalSectionTitle' }, ['Navigation']),
        el('div', { class: 'modalGrid' }, [
          el('div', { class: 'modalRow' }, [el('span', { class: 'kbd' }, ['Ctrl']), '+', el('span', { class: 'kbd' }, ['K']), ' Command palette']),
          el('div', { class: 'modalRow' }, [el('span', { class: 'kbd' }, ['/']), ' Focus tool search']),
          el('div', { class: 'modalRow' }, [el('span', { class: 'kbd' }, ['[']), ' / ', el('span', { class: 'kbd' }, [']']), ' Previous/next tool']),
          el('div', { class: 'modalRow' }, [el('span', { class: 'kbd' }, ['Ctrl']), '+', el('span', { class: 'kbd' }, ['1-9']), ' Activate tool by index']),
        ]),
        el('div', { class: 'modalSectionTitle', style: { marginTop: '10px' } }, ['Layout']),
        el('div', { class: 'modalGrid' }, [
          el('div', { class: 'modalRow' }, [el('span', { class: 'kbd' }, ['Ctrl']), '+', el('span', { class: 'kbd' }, ['B']), ' Toggle sidebar']),
          el('div', { class: 'modalRow' }, [el('span', { class: 'kbd' }, ['Ctrl']), '+', el('span', { class: 'kbd' }, ['J']), ' Toggle console']),
          el('div', { class: 'modalRow' }, [el('span', { class: 'kbd' }, ['Ctrl']), '+', el('span', { class: 'kbd' }, ['\\']), ' Toggle right panel']),
          el('div', { class: 'modalRow' }, [el('span', { class: 'kbd' }, ['`']), ' Toggle HUD']),
        ]),
        el('div', { class: 'infoBanner' }, [
          el('div', { class: 'infoIcon' }, ['i']),
          el('div', {}, ['Tip: use the palette to toggle pins and jump between tools fast.']),
        ]),
      ]),
    ]);
    this._showModal(card);
  }

  _openPalette() {
    this._paletteOpen = true;
    this._paletteQuery = '';
    this._paletteSelected = 0;
    this._paletteItems = this._buildPaletteItems('');

    const input = el('input', {
      placeholder: 'Search tools and actions\u2026',
      value: '',
      oninput: (e) => {
        this._paletteQuery = String(e.target.value || '');
        this._paletteItems = this._buildPaletteItems(this._paletteQuery);
        this._paletteSelected = 0;
        this._renderPaletteList();
      },
    });
    this._paletteInputEl = input;

    const list = el('div', { class: 'paletteList' }, []);
    this._paletteListEl = list;

    const card = el('div', { class: 'modalCard' }, [
      el('div', { class: 'modalHeader' }, [
        el('div', { class: 'modalTitle' }, ['Command palette']),
        el('button', { onclick: () => this._closeModal(), title: 'Close' }, ['Esc']),
      ]),
      el('div', { class: 'modalBody' }, [
        input,
        list,
        el('div', { class: 'paletteFooter muted' }, [
          el('span', { class: 'kbd' }, ['↑']),
          el('span', { class: 'kbd', style: { marginLeft: '4px' } }, ['↓']),
          ' select   ',
          el('span', { class: 'kbd' }, ['Enter']),
          ' open   ',
          el('span', { class: 'kbd' }, ['Esc']),
          ' close',
        ]),
      ]),
    ]);

    this._showModal(card);
    this._renderPaletteList();
    setTimeout(() => { try { input.focus(); } catch { /* ignore */ } }, 0);
  }

  _buildPaletteItems(query) {
    const q = String(query || '').trim().toLowerCase();
    /** @type {{ kind: 'tool'|'action', id: string, label: string, subtitle?: string, icon?: string, run: () => void }[]} */
    const items = [];

    // Actions
    const actions = [
      {
        id: 'toggleSidebar',
        label: this._dockVisibility.sidebar ? 'Hide sidebar' : 'Show sidebar',
        subtitle: 'Layout',
        icon: '⇤',
        run: () => {
          this._dockVisibility.sidebar = !this._dockVisibility.sidebar;
          this._applyDockVisibility();
          this._saveDockVisibility();
        },
      },
      {
        id: 'togglePanel',
        label: this._dockVisibility.panel ? 'Hide right panel' : 'Show right panel',
        subtitle: 'Layout',
        icon: '⇢',
        run: () => {
          this._dockVisibility.panel = !this._dockVisibility.panel;
          this._applyDockVisibility();
          this._saveDockVisibility();
        },
      },
      {
        id: 'toggleConsole',
        label: this._dockVisibility.console ? 'Hide console' : 'Show console',
        subtitle: 'Layout',
        icon: '⇵',
        run: () => {
          this._dockVisibility.console = !this._dockVisibility.console;
          this._applyDockVisibility();
          this._saveDockVisibility();
        },
      },
      {
        id: 'toggleHud',
        label: this._hudVisible ? 'Hide HUD' : 'Show HUD',
        subtitle: 'Layout',
        icon: '`',
        run: () => { this._hudVisible = !this._hudVisible; this._hud.style.display = this._hudVisible ? 'block' : 'none'; },
      },
      {
        id: 'help',
        label: 'Show keyboard shortcuts',
        subtitle: 'Help',
        icon: '?',
        run: () => this._openHelp(),
      },
      {
        id: 'clearConsole',
        label: 'Clear console',
        subtitle: 'Console',
        icon: '⊟',
        run: () => { this._logLines = []; this._renderLog(); },
      },
      {
        id: 'copyConsole',
        label: 'Copy console to clipboard',
        subtitle: 'Console',
        icon: '⎘',
        run: async () => {
          try { await navigator.clipboard.writeText(this._logLines.join('\n')); } catch { /* ignore */ }
        },
      },
    ];

    for (const a of actions) {
      const hay = `${a.id} ${a.label} ${a.subtitle || ''}`.toLowerCase();
      if (!q || hay.includes(q)) items.push({ kind: 'action', ...a });
    }

    // Tools
    for (const t of this.tools) {
      const id = String(t?.id || '');
      if (!id) continue;
      const label = String(t?.label || id);
      const category = this._toolCategoryMap.get(id) || '';
      const product = this._toolProductMap.get(id) || '';
      const summary = this._toolSummaryMap.get(id) || '';
      const icon = this._toolIconMap.get(id) || '◇';
      const pinned = this._isPinned(id) ? 'pinned' : '';
      const hay = `${id} ${label} ${category} ${product} ${summary} ${pinned}`.toLowerCase();
      if (!q || hay.includes(q)) {
        items.push({
          kind: 'tool',
          id,
          label,
          subtitle: [product, category].filter(Boolean).join(' · '),
          icon,
          run: () => this.setActiveTool(id),
        });
      }
    }

    // Sort: actions first, then tools; within: pinned tools near top
    items.sort((a, b) => {
      if (a.kind !== b.kind) return (a.kind === 'action') ? -1 : 1;
      if (a.kind === 'tool' && b.kind === 'tool') {
        const ap = this._isPinned(a.id) ? 0 : 1;
        const bp = this._isPinned(b.id) ? 0 : 1;
        if (ap !== bp) return ap - bp;
      }
      return a.label.localeCompare(b.label);
    });

    return items.slice(0, 60);
  }

  _renderPaletteList() {
    const list = this._paletteListEl;
    if (!list) return;
    clear(list);
    const items = this._paletteItems || [];
    if (!items.length) {
      list.appendChild(el('div', { class: 'muted', style: { padding: '10px 2px' } }, ['No matches.']));
      return;
    }
    const clampSel = Math.max(0, Math.min(items.length - 1, this._paletteSelected || 0));
    this._paletteSelected = clampSel;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const active = (i === clampSel);
      list.appendChild(el('div', {
        class: `paletteItem${active ? ' active' : ''}`,
        onclick: () => { this._paletteSelected = i; this._runPaletteSelection(); },
        title: it.subtitle ? `${it.subtitle}` : '',
      }, [
        el('div', { class: 'paletteIcon' }, [String(it.icon || '◇')]),
        el('div', { class: 'paletteText' }, [
          el('div', { class: 'paletteLabel' }, [it.label]),
          it.subtitle ? el('div', { class: 'paletteSub muted' }, [it.subtitle]) : null,
        ].filter(Boolean)),
        (it.kind === 'tool' && this._isPinned(it.id)) ? el('div', { class: 'badge' }, ['PIN']) : null,
      ].filter(Boolean)));
    }
  }

  _runPaletteSelection() {
    const items = this._paletteItems || [];
    const i = Math.max(0, Math.min(items.length - 1, this._paletteSelected || 0));
    const it = items[i];
    if (!it) return;
    this._closeModal();
    try { it.run?.(); } catch (e) { this.log(`Palette action failed: ${e?.message || e}`); }
  }

  _onPaletteKeyDown(e) {
    try {
      if (!e) return;
      if (e.key === 'Escape') {
        e.preventDefault?.();
        this._closeModal();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault?.();
        this._paletteSelected = Math.min((this._paletteItems?.length || 1) - 1, (this._paletteSelected || 0) + 1);
        this._renderPaletteList();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault?.();
        this._paletteSelected = Math.max(0, (this._paletteSelected || 0) - 1);
        this._renderPaletteList();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault?.();
        this._runPaletteSelection();
      }
    } catch { /* ignore */ }
  }

  /* ────────────────── Sidebar keyboard navigation ────────────────── */

  _onSidebarSearchKeyDown(e) {
    try {
      if (!e) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault?.();
        const first = this._visibleToolIds?.[0];
        if (first) this._toolButtons.get(first)?.focus?.();
        return;
      }
      if (e.key === 'Enter') {
        const first = this._visibleToolIds?.[0];
        if (first) {
          e.preventDefault?.();
          this.setActiveTool(first);
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault?.();
        e.target?.blur?.();
      }
    } catch { /* ignore */ }
  }

  /* ────────────────── Category open state ────────────────── */

  _loadCategoryOpenState() {
    try {
      const raw = localStorage.getItem('devtools.catOpen');
      const j = raw ? JSON.parse(raw) : null;
      if (j && typeof j === 'object') {
        for (const [k, v] of Object.entries(j)) this._catOpen.set(String(k), !!v);
      }
    } catch { /* ignore */ }
  }

  _saveCategoryOpenState() {
    try {
      const obj = {};
      for (const [k, v] of this._catOpen.entries()) obj[k] = !!v;
      localStorage.setItem('devtools.catOpen', JSON.stringify(obj));
    } catch { /* ignore */ }
  }

  _isCategoryOpen(label) {
    const key = String(label || '');
    if (!key) return true;
    if (!this._catOpen.has(key)) return true;
    return !!this._catOpen.get(key);
  }

  _setCategoryOpen(label, isOpen) {
    const key = String(label || '');
    if (!key) return;
    this._catOpen.set(key, !!isOpen);
    this._saveCategoryOpenState();
  }

  /* ────────────────── Top bar ────────────────── */

  _renderTopBar() {
    clear(this._topBar);
    const activeProduct = this._toolProductMap.get(String(this._activeToolId || '')) || '';
    const left = el('div', { class: 'topBarLeft' }, [
      el('div', { class: 'topBarTitle' }, ['DevTools']),
      el('div', { class: 'topBarCrumb muted' }, [activeProduct ? `· ${activeProduct}` : '· no product']),
    ]);
    this._topBarToolLabelEl = el('div', { class: 'topBarToolLabel' }, ['']);

    left.appendChild(this._topBarToolLabelEl);

    const mkBtn = (txt, title, onClick, { primary = false } = {}) => el('button', {
      class: `topBarBtn${primary ? ' primary' : ''}`,
      onclick: onClick,
      title,
      'aria-label': title,
    }, [txt]);

    const right = el('div', { class: 'topBarRight' }, [
      mkBtn(this._dockVisibility.sidebar ? '⇤' : '⇥', 'Toggle sidebar (Ctrl+B)', () => {
        this._dockVisibility.sidebar = !this._dockVisibility.sidebar;
        this._applyDockVisibility();
        this._saveDockVisibility();
        this._renderTopBar();
      }),
      mkBtn(this._dockVisibility.panel ? '⇢' : '⇠', 'Toggle right panel (Ctrl+\\)', () => {
        this._dockVisibility.panel = !this._dockVisibility.panel;
        this._applyDockVisibility();
        this._saveDockVisibility();
        this._renderTopBar();
      }),
      mkBtn(this._dockVisibility.console ? '⇵' : '⇳', 'Toggle console (Ctrl+J)', () => {
        this._dockVisibility.console = !this._dockVisibility.console;
        this._applyDockVisibility();
        this._saveDockVisibility();
        this._renderTopBar();
      }),
      mkBtn('⌘', 'Command palette (Ctrl+K)', () => this._openPalette(), { primary: true }),
      mkBtn('?', 'Help / shortcuts (?)', () => this._openHelp()),
    ]);

    this._topBar.appendChild(left);
    this._topBar.appendChild(right);
    this._updateTopBarToolLabel();
  }

  _updateTopBarToolLabel() {
    const el0 = this._topBarToolLabelEl;
    if (!el0) return;
    const label = String(this.activeTool?.label || '');
    el0.textContent = label ? `· ${label}` : '';
    try {
      const crumb = this._topBar?.querySelector?.('.topBarCrumb');
      if (crumb) {
        const activeProduct = this._toolProductMap.get(String(this._activeToolId || '')) || '';
        crumb.textContent = activeProduct ? `· ${activeProduct}` : '· no product';
      }
    } catch { /* ignore */ }
  }

  /* ────────────────── HUD ────────────────── */

  _renderHud(dt) {
    if (!this._hudVisible) return;
    const t0 = nowSec();
    if ((t0 - (this._hudLastUpdate || 0)) < 0.10) return; // ~10 fps
    this._hudLastUpdate = t0;
    const t = t0;
    const d = Math.max(1e-6, Number(dt) || (t - (this._fps.last || t)));
    this._fps.last = t;
    const fpsNow = 1.0 / d;
    this._fps.ema = this._fps.ema ? (this._fps.ema * 0.92 + fpsNow * 0.08) : fpsNow;

    const tool = this.activeTool;
    const stats = tool?.getStats?.() || null;

    const lines = [];
    lines.push(`${String(this._activeToolId || '—')}  ·  ${this._fps.ema.toFixed(0)} fps  ·  ${(d * 1000).toFixed(1)} ms`);
    if (stats && typeof stats === 'object') {
      for (const [k, v] of Object.entries(stats)) {
        const s = (typeof v === 'string') ? v : (typeof v === 'number') ? String(v) : safeJson(v);
        if (!s) continue;
        lines.push(`${k}: ${s}`);
      }
    }
    this._hud.textContent = lines.join('\n');
  }

  /* ────────────────── Frame loop ────────────────── */

  _frame() {
    if (!this._running) return;
    const t = nowSec();
    const dt = Math.max(0, Math.min(0.25, t - this._lastT));
    this._lastT = t;

    try { this.activeTool?.tick?.(dt, t); } catch (e) { this.log(`Tool tick error: ${e?.message || e}`); }
    try { this._renderHud(dt); } catch { /* ignore */ }
    // If tools are chatty, keep log rendering cheap.
    try { if (this._logScheduled) { /* noop */ } } catch { /* ignore */ }

    requestAnimationFrame(() => this._frame());
  }
}
