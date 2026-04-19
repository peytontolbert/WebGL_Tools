import { el, clear } from '../../ui/dom.js';
import { createDropZone, createProgressBar, createAssetPicker, createJobRunner } from '../components/ui_components.js';

function safeTrim(s) { return String(s ?? '').trim(); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function bytesToMiB(n) {
  const b = Number(n) || 0;
  return (b / (1024 * 1024)).toFixed(2);
}

function bytesToGiB(n) {
  const b = Number(n) || 0;
  return (b / (1024 * 1024 * 1024)).toFixed(2);
}

function isModelExt(ext) {
  return ext === '.glb' || ext === '.gltf' || ext === '.usd' || ext === '.usda' || ext === '.usdc' || ext === '.usdz' || ext === '.fbx';
}

function isImageExt(ext) {
  return ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp' || ext === '.gif';
}

function extOf(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i).toLowerCase() : '';
}

function isUsdExt(ext) {
  return ext === '.usd' || ext === '.usda' || ext === '.usdc' || ext === '.usdz';
}

function isMotionExt(ext) {
  return ext === '.bvh' || ext === '.fbx' || ext === '.usd' || ext === '.usda' || ext === '.usdc' || ext === '.usdz';
}

/**
 * Dedicated Omniverse tool -- consolidates pack management, asset browsing,
 * USD inspection, and GLB conversion into a single cohesive panel.
 */
export class OmniverseTool {
  constructor() {
    this.id = 'omniverse';
    this.label = 'Omniverse';

    this._ctx = null;
    this._root = null;

    // ── Tab state ──
    this._activeTab = 'packs'; // packs | browse | catalog | characters | inspect

    // ── Pack management ──
    this._packs = [];
    this._selectedPacks = new Map();
    this._importJob = { id: '', status: '', stdout: '', stderr: '' };
    this._pollingImport = false;

    // ── Browse state ──
    this._browseState = {
      pack: '(all)',
      category: 'any',
      path: '',
      kind: 'models',
      sort: 'path',
      limit: 300,
    };
    this._browseItems = [];
    this._browseDirs = [];
    this._selectedAsset = '';

    // ── Characters state ──
    this._charState = {
      pack: '(all)',
      query: '',
      limit: 400,
    };
    this._charItems = [];
    this._selectedChar = null;

    // ── Catalog state (tagged omniverse index) ──
    this._catalogState = {
      pack: '(all)',
      q: '',
      kind: 'any',        // any | model | motion
      type: 'any',        // any | character | animation | city | building | prop | vehicle | environment | other
      requireMesh: true,  // default on: prevents meshless conversions by default
      requireRig: false,
      limit: 400,
      usePackTags: true,  // use precomputed pack tags report when available (faster than live inspect)
      autoInspect: true,  // inspect USDs for visible items
    };
    this._catalogItems = [];
    this._catalogSelected = null;
    this._catalogStatsByPath = new Map(); // path -> { ok, stats, missingFiles, meta?, compositionStats?, dependencyStats? }
    this._packTagsLoaded = new Set(); // packName -> loaded
    this._packTagsPartial = new Set(); // packName -> partial/limited tags report (allow autoInspect to fill gaps)
    this._packTagsByPathCount = new Map(); // packName -> number of paths loaded (best-effort)

    // ── Inspect state ──
    this._inspectPath = '';
    this._inspectResult = '';
    this._inspecting = false;

    // ── Convert state ──
    this._convertJob = { id: '', status: '', stdout: '', stderr: '', outGlb: '' };
    this._pollingConvert = false;

    // ── UI element refs ──
    this._tabBar = null;
    this._tabContent = null;
    this._packsListEl = null;
    this._packsStatusEl = null;
    this._packsLogEl = null;
    this._browseListEl = null;
    this._browseStatusEl = null;
    this._browseDirsSel = null;
    this._browsePreviewEl = null;
    this._catalogStatusEl = null;
    this._catalogListEl = null;
    this._catalogPreviewEl = null;
    this._inspectResultEl = null;
    this._inspectStatusEl = null;
    this._convertStatusEl = null;
    this._convertLogEl = null;
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;
    this._restorePrefs();
    this._buildUi();
  }

  async unmount() {
    this._pollingImport = false;
    this._pollingConvert = false;
    this._ctx = null;
    this._root = null;
  }

  tick() {}

  getStats() {
    return {
      tab: this._activeTab,
      pack: this._browseState.pack,
      items: this._browseItems.length,
      selected: this._selectedAsset || '',
    };
  }

  // ──────────────────── Preferences ────────────────────

  _restorePrefs() {
    try { this._browseState.pack = String(localStorage.getItem('devtools.omni.pack') || '(all)'); } catch { /* */ }
    try { this._browseState.category = String(localStorage.getItem('devtools.omni.category') || 'any'); } catch { /* */ }
    try { this._browseState.path = String(localStorage.getItem('devtools.omni.path') || ''); } catch { /* */ }
    try { this._browseState.kind = String(localStorage.getItem('devtools.omni.kind') || 'models'); } catch { /* */ }
    try { this._activeTab = String(localStorage.getItem('devtools.omni.tab') || 'packs'); } catch { /* */ }
    try { this._charState.pack = String(localStorage.getItem('devtools.omni.char.pack') || '(all)'); } catch { /* */ }
    try { this._charState.query = String(localStorage.getItem('devtools.omni.char.query') || ''); } catch { /* */ }
    try { this._catalogState.pack = String(localStorage.getItem('devtools.omni.catalog.pack') || '(all)'); } catch { /* */ }
    try { this._catalogState.q = String(localStorage.getItem('devtools.omni.catalog.q') || ''); } catch { /* */ }
    try { this._catalogState.kind = String(localStorage.getItem('devtools.omni.catalog.kind') || 'any'); } catch { /* */ }
    try { this._catalogState.type = String(localStorage.getItem('devtools.omni.catalog.type') || 'any'); } catch { /* */ }
    try { this._catalogState.requireMesh = !!Number(localStorage.getItem('devtools.omni.catalog.requireMesh') || '1'); } catch { /* */ }
    try { this._catalogState.requireRig = !!Number(localStorage.getItem('devtools.omni.catalog.requireRig') || '0'); } catch { /* */ }
    try { this._catalogState.usePackTags = !!Number(localStorage.getItem('devtools.omni.catalog.usePackTags') || '1'); } catch { /* */ }
    try { this._catalogState.autoInspect = !!Number(localStorage.getItem('devtools.omni.catalog.autoInspect') || '1'); } catch { /* */ }
  }

  _savePrefs() {
    try {
      localStorage.setItem('devtools.omni.pack', this._browseState.pack);
      localStorage.setItem('devtools.omni.category', this._browseState.category);
      localStorage.setItem('devtools.omni.path', this._browseState.path);
      localStorage.setItem('devtools.omni.kind', this._browseState.kind);
      localStorage.setItem('devtools.omni.tab', this._activeTab);
      localStorage.setItem('devtools.omni.char.pack', this._charState.pack);
      localStorage.setItem('devtools.omni.char.query', this._charState.query);
      localStorage.setItem('devtools.omni.catalog.pack', this._catalogState.pack);
      localStorage.setItem('devtools.omni.catalog.q', this._catalogState.q);
      localStorage.setItem('devtools.omni.catalog.kind', this._catalogState.kind);
      localStorage.setItem('devtools.omni.catalog.type', this._catalogState.type);
      localStorage.setItem('devtools.omni.catalog.requireMesh', this._catalogState.requireMesh ? '1' : '0');
      localStorage.setItem('devtools.omni.catalog.requireRig', this._catalogState.requireRig ? '1' : '0');
      localStorage.setItem('devtools.omni.catalog.usePackTags', this._catalogState.usePackTags ? '1' : '0');
      localStorage.setItem('devtools.omni.catalog.autoInspect', this._catalogState.autoInspect ? '1' : '0');
    } catch { /* */ }
  }

  // ──────────────────── Main UI ────────────────────

  _buildUi() {
    if (!this._root) return;
    clear(this._root);

    // Tab bar
    this._tabBar = el('div', { style: {
      display: 'flex', gap: '2px', marginBottom: '12px',
      borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0',
    } });
    this._root.appendChild(this._tabBar);

    // Tab content
    this._tabContent = el('div', { class: 'fadeIn' });
    this._root.appendChild(this._tabContent);

    this._renderTabs();
  }

  _renderTabs() {
    if (!this._tabBar || !this._tabContent) return;
    clear(this._tabBar);
    clear(this._tabContent);

    const tabs = [
      { id: 'packs',   label: 'Pack Manager',  icon: '▣' },
      { id: 'browse',  label: 'Browse Assets',  icon: '▤' },
      { id: 'catalog', label: 'Catalog', icon: '⌗' },
      { id: 'characters', label: 'Characters', icon: '☺' },
      { id: 'inspect', label: 'Inspect & Convert', icon: '◎' },
    ];

    for (const t of tabs) {
      const isActive = this._activeTab === t.id;
      const btn = el('button', {
        style: {
          flex: '1',
          padding: '8px 4px',
          fontSize: '11px',
          fontWeight: isActive ? '600' : '400',
          color: isActive ? 'var(--text-accent)' : 'var(--text-secondary)',
          background: isActive ? 'var(--accent-soft)' : 'transparent',
          border: 'none',
          borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
          borderRadius: '6px 6px 0 0',
          transition: 'all var(--transition)',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
        },
        onclick: () => {
          this._activeTab = t.id;
          this._savePrefs();
          this._renderTabs();
        },
      }, [
        el('span', { style: { fontSize: '12px' } }, [t.icon]),
        document.createTextNode(t.label),
      ]);
      this._tabBar.appendChild(btn);
    }

    if (this._activeTab === 'packs') this._renderPacksTab();
    else if (this._activeTab === 'browse') this._renderBrowseTab();
    else if (this._activeTab === 'catalog') this._renderCatalogTab();
    else if (this._activeTab === 'characters') this._renderCharactersTab();
    else if (this._activeTab === 'inspect') this._renderInspectTab();
  }

  // ──────────────────── Catalog tab ────────────────────

  _renderCatalogTab() {
    const host = this._tabContent;
    if (!host) return;
    clear(host);

    host.appendChild(el('div', { class: 'panelSubtitle' }, [
      'Tag + filter Omniverse assets using USD inspection stats. Use this to quickly find mesh+rig characters vs motion-only animations, and to avoid converting meshless stages.',
    ]));

    const st = this._catalogState;

    const packSel = el('select', { value: st.pack }, [
      el('option', { value: '(all)' }, ['All packs']),
    ]);
    packSel.onchange = async (e) => {
      st.pack = String(e.target.value || '(all)');
      this._savePrefs();
      await this._catalogRefresh();
    };

    const kindSel = el('select', { value: st.kind }, [
      el('option', { value: 'any' }, ['Any kind']),
      el('option', { value: 'model' }, ['Models']),
      el('option', { value: 'motion' }, ['Motions / Animations']),
    ]);
    kindSel.onchange = async (e) => {
      st.kind = String(e.target.value || 'any');
      this._savePrefs();
      await this._catalogRefresh();
    };

    const typeSel = el('select', { value: st.type }, [
      el('option', { value: 'any' }, ['Any type']),
      el('option', { value: 'character' }, ['Characters (mesh+rig)']),
      el('option', { value: 'animation' }, ['Animations (motion-only)']),
      el('option', { value: 'city' }, ['Cities']),
      el('option', { value: 'building' }, ['Buildings']),
      el('option', { value: 'prop' }, ['Props']),
      el('option', { value: 'vehicle' }, ['Vehicles']),
      el('option', { value: 'environment' }, ['Environment']),
      el('option', { value: 'other' }, ['Other']),
    ]);
    typeSel.onchange = async (e) => {
      st.type = String(e.target.value || 'any');
      this._savePrefs();
      await this._catalogRefresh();
    };

    const qInput = el('input', {
      value: st.q,
      placeholder: 'filter by name/path (e.g. debra, walk, tower)',
      oninput: (e) => {
        st.q = safeTrim(e.target.value);
        this._savePrefs();
      },
    });
    qInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._catalogRefresh(); });

    const reqMesh = el('input', {
      type: 'checkbox',
      checked: !!st.requireMesh,
      onchange: async (e) => {
        st.requireMesh = !!e.target.checked;
        this._savePrefs();
        await this._catalogRefresh();
      },
      title: 'Hide meshless USDs (prevents converting motion-only stages)',
    });
    const reqRig = el('input', {
      type: 'checkbox',
      checked: !!st.requireRig,
      onchange: async (e) => {
        st.requireRig = !!e.target.checked;
        this._savePrefs();
        await this._catalogRefresh();
      },
      title: 'Only show assets with a skeleton binding (SkelRoot)',
    });
    const autoInspect = el('input', {
      type: 'checkbox',
      checked: !!st.autoInspect,
      onchange: (e) => {
        st.autoInspect = !!e.target.checked;
        this._savePrefs();
      },
      title: 'Inspect visible USDs to enable mesh/rig filtering',
    });

    const usePackTags = el('input', {
      type: 'checkbox',
      checked: !!st.usePackTags,
      onchange: async (e) => {
        st.usePackTags = !!e.target.checked;
        this._savePrefs();
        await this._catalogRefresh();
      },
      title: 'Use outputs/omniverse/<pack>_tags.json when available (fast badges + filtering)',
    });

    const refreshBtn = el('button', { class: 'primary', onclick: () => this._catalogRefresh() }, ['Refresh']);
    const loadTagsBtn = el('button', {
      onclick: async () => {
        const pack = String(st.pack || '').trim();
        if (!pack || pack === '(all)') {
          this._ctx?.toast?.('Pick a specific pack first (not “All packs”).', 'info', { title: 'Omniverse' });
          return;
        }
        await this._loadPackTagsReport(pack);
        await this._catalogRefresh();
      },
      title: 'Load precomputed tags report for this pack (if present)',
    }, ['Load tags report']);
    const inspectVisibleBtn = el('button', {
      onclick: () => this._catalogInspectVisible(),
      title: 'Run cached USD inspection on currently visible items',
    }, ['Inspect visible']);

    this._catalogStatusEl = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    this._catalogListEl = el('div', { class: 'scrollArea', style: { height: '260px', marginTop: '8px' } }, ['(refresh to load)']);
    this._catalogPreviewEl = el('div', { style: { marginTop: '8px' } }, ['']);

    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Catalog filters']),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
        el('div', { style: { minWidth: '180px', flex: '1 1 240px' } }, [el('div', { class: 'fieldLabel' }, ['Pack']), packSel]),
        el('div', { style: { minWidth: '160px', flex: '1 1 200px' } }, [el('div', { class: 'fieldLabel' }, ['Kind']), kindSel]),
        el('div', { style: { minWidth: '160px', flex: '1 1 200px' } }, [el('div', { class: 'fieldLabel' }, ['Type']), typeSel]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'fieldLabel' }, ['Query']), qInput]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '10px', flexWrap: 'wrap' } }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center', flex: '0 0 auto' } }, [reqMesh, el('span', { class: 'muted' }, ['Require mesh'])]),
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center', flex: '0 0 auto' } }, [reqRig, el('span', { class: 'muted' }, ['Require rig'])]),
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center', flex: '0 0 auto' } }, [usePackTags, el('span', { class: 'muted' }, ['Use tags report (fast)'])]),
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center', flex: '0 0 auto' } }, [autoInspect, el('span', { class: 'muted' }, ['Auto-inspect USD'])]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } }, [
        refreshBtn,
        loadTagsBtn,
        inspectVisibleBtn,
      ]),
      this._catalogStatusEl,
      this._catalogListEl,
    ]));

    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Selected item']),
      this._catalogPreviewEl,
    ]));

    // Populate pack list lazily.
    void (async () => {
      try {
        const resp = await fetch('/__devtools_omniverse_packs');
        const j = await resp.json();
        if (!j?.ok) return;
        const packs = Array.isArray(j?.packs) ? j.packs : [];
        while (packSel.childNodes.length > 1) packSel.removeChild(packSel.lastChild);
        for (const p of packs) {
          const name = safeTrim(p?.name);
          if (name) packSel.appendChild(el('option', { value: name }, [name]));
        }
        packSel.value = st.pack;
      } catch { /* ignore */ }
    })();

    void this._catalogRefresh();
  }

  async _catalogRefresh() {
    const st = this._catalogState;
    const listEl = this._catalogListEl;
    const statusEl = this._catalogStatusEl;
    if (!listEl || !statusEl) return;

    listEl.textContent = 'Loading…';
    statusEl.textContent = 'Scanning Omniverse catalog…';
    this._catalogItems = [];
    this._catalogSelected = null;
    this._syncCatalogPreview();

    try {
      // Fast-path: if we have a per-pack tags report, load it and populate stats upfront.
      // This avoids spamming /__devtools_usd_inspect for common character packs.
      if (st.usePackTags && st.pack && st.pack !== '(all)') {
        await this._loadPackTagsReport(st.pack);
      }

      const params = new URLSearchParams();
      if (st.pack && st.pack !== '(all)') params.set('pack', st.pack);
      if (st.q) params.set('q', st.q);
      if (st.kind && st.kind !== 'any') params.set('kind', st.kind);
      if (st.type && st.type !== 'any') params.set('type', st.type);
      params.set('limit', String(Math.max(50, Math.min(2000, Number(st.limit) || 400))));

      const resp = await fetch(`/__devtools_omniverse_catalog?${params.toString()}`);
      const j = await resp.json();
      if (!j?.ok) throw new Error(String(j?.error || 'catalog endpoint failed'));
      const items = Array.isArray(j?.items) ? j.items : [];

      // If filters depend on inspection (mesh/rig), we may need to inspect visible items first.
      this._catalogItems = items;

      // Pre-inspect a first page so mesh/rig filters work quickly.
      if (st.autoInspect && !(st.usePackTags && st.pack && this._packTagsLoaded.has(st.pack) && !this._packTagsPartial.has(st.pack))) {
        await this._catalogInspectItems(items.slice(0, 60));
      }

      const filtered = this._catalogApplyLocalFilters(items);

      const packTagNote = (st.pack && st.pack !== '(all)' && this._packTagsLoaded.has(st.pack))
        ? ` · tags report loaded (${Number(this._packTagsByPathCount.get(st.pack) || 0)} paths${this._packTagsPartial.has(st.pack) ? ', partial' : ''})`
        : '';
      statusEl.textContent = `${filtered.length} item(s)${(items.length !== filtered.length) ? ` (from ${items.length})` : ''}${packTagNote}`;
      clear(listEl);
      if (!filtered.length) {
        listEl.textContent = 'No matches. Try disabling “Require mesh/rig” or adjust query/type.';
        return;
      }

      for (const it of filtered.slice(0, 400)) {
        const p = safeTrim(it?.path);
        if (!p) continue;
        const name = safeTrim(it?.name) || (p.split('/').pop() || p);
        const pack = safeTrim(it?.pack);
        const kind = safeTrim(it?.kind) || 'any';

        const stats = this._catalogStatsByPath.get(p) || null;
        const meshCount = Number(stats?.stats?.meshCount) || 0;
        const skelRoot = Number(stats?.stats?.skelRootCount) || 0;
        const skelAnim = Number(stats?.stats?.skelAnimationCount) || 0;

        const badges = [];
        if (stats?.ok) {
          badges.push(`mesh:${meshCount}`);
          if (skelRoot) badges.push(`rig:${skelRoot}`);
          if (skelAnim) badges.push(`anim:${skelAnim}`);
        } else if (isUsdExt(extOf(p))) {
          badges.push('usd');
        }

        listEl.appendChild(el('button', {
          class: 'toolBtn',
          style: { marginTop: '6px', textAlign: 'left' },
          onclick: async () => {
            this._catalogSelected = it;
            await this._catalogInspectItems([it]);
            this._syncCatalogPreview();
          },
          title: p,
        }, [
          el('div', { style: { fontWeight: '600' } }, [`${name}${pack ? ` [${pack}]` : ''}`]),
          el('div', { class: 'muted', style: { fontSize: '10px', marginTop: '2px' } }, [
            `${kind}${badges.length ? ` · ${badges.join('  ')}` : ''}`,
          ]),
        ]));
      }
    } catch (e) {
      listEl.textContent = `Error: ${e?.message || e}`;
      statusEl.textContent = 'Failed to load catalog.';
    }
  }

  async _loadPackTagsReport(packName) {
    const pack = safeTrim(packName);
    if (!pack || pack === '(all)') return;
    if (this._packTagsLoaded.has(pack)) return;
    try {
      const resp = await fetch(`/__devtools_omniverse_pack_tags?pack=${encodeURIComponent(pack)}`);
      const j = await resp.json();
      if (!j?.ok) throw new Error(String(j?.error || 'pack tags not available'));
      const byPath = j?.byPath && typeof j.byPath === 'object' ? j.byPath : {};

      let loaded = 0;
      for (const [p, v] of Object.entries(byPath)) {
        const sp = safeTrim(p);
        if (!sp) continue;
        const stats = v?.stats || {};
        this._catalogStatsByPath.set(sp, { ok: true, stats, missingFiles: [] });
        loaded++;
      }
      this._packTagsLoaded.add(pack);
      this._packTagsByPathCount.set(pack, loaded);
      if (j?.partial) this._packTagsPartial.add(pack);
      else this._packTagsPartial.delete(pack);
    } catch (e) {
      // Non-fatal: we can still fall back to live inspect.
      this._ctx?.log?.(`Omniverse: pack tags report not loaded for ${pack}: ${e?.message || e}`);
    }
  }

  _catalogApplyLocalFilters(items) {
    const st = this._catalogState;
    if (!st.requireMesh && !st.requireRig) return items;
    return items.filter((it) => {
      const p = safeTrim(it?.path);
      if (!p) return false;
      const stats = this._catalogStatsByPath.get(p);
      if (!stats?.ok) return !isUsdExt(extOf(p)); // if we can't inspect a USD, hide it only when filters require it
      const meshCount = Number(stats?.stats?.meshCount) || 0;
      const skelRoot = Number(stats?.stats?.skelRootCount) || 0;
      if (st.requireMesh && meshCount <= 0) return false;
      if (st.requireRig && skelRoot <= 0) return false;
      return true;
    });
  }

  async _catalogInspectVisible() {
    const listEl = this._catalogListEl;
    if (!listEl) return;
    const st = this._catalogState;
    const items = this._catalogItems || [];
    // Inspect a reasonable chunk.
    const chunk = items.slice(0, 120);
    if (st.autoInspect) await this._catalogInspectItems(chunk);
    // Re-render with updated badges/filters.
    await this._catalogRefresh();
  }

  async _catalogInspectItems(items) {
    const ctx = this._ctx;
    const arr = Array.isArray(items) ? items : [];
    const toInspect = [];
    for (const it of arr) {
      const p = safeTrim(it?.path);
      if (!p) continue;
      if (this._catalogStatsByPath.has(p)) continue;
      const ext = extOf(p);
      if (!isUsdExt(ext)) continue; // only USD has fast structured inspect right now
      toInspect.push(p);
    }
    if (!toInspect.length) return;

    // Concurrency-limited inspect to keep the UI responsive.
    const limit = 2;
    let i = 0;
    const worker = async () => {
      while (i < toInspect.length) {
        const idx = i++;
        const p = toInspect[idx];
        try {
          const resp = await fetch('/__devtools_usd_inspect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runner: 'blender_5', inputPath: p }),
          });
          const j = await resp.json();
          const summary = j?.json;
          if (j?.ok && summary?.ok) {
            this._catalogStatsByPath.set(p, {
              ok: true,
              stats: summary?.stats || {},
              missingFiles: summary?.missingFiles || [],
              meta: summary?.meta || {},
              compositionStats: summary?.compositionStats || {},
              dependencyStats: summary?.dependencyStats || {},
            });
          } else {
            this._catalogStatsByPath.set(p, { ok: false, stats: {}, missingFiles: [], meta: {}, compositionStats: {}, dependencyStats: {} });
          }
        } catch (e) {
          this._catalogStatsByPath.set(p, { ok: false, stats: {}, missingFiles: [], meta: {}, compositionStats: {}, dependencyStats: {} });
          ctx?.log?.(`Omniverse catalog: inspect failed: ${p}: ${e?.message || e}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, toInspect.length) }, () => worker()));
  }

  _syncCatalogPreview() {
    const host = this._catalogPreviewEl;
    if (!host) return;
    clear(host);

    const it = this._catalogSelected;
    if (!it) {
      host.appendChild(el('div', { class: 'muted' }, ['Select a catalog item to see details and safe actions.']));
      return;
    }

    const p = safeTrim(it?.path);
    const name = safeTrim(it?.name) || (p.split('/').pop() || p);
    const kind = safeTrim(it?.kind) || 'any';
    const pack = safeTrim(it?.pack);
    const assetType = safeTrim(it?.assetType) || safeTrim(it?.type) || '';

    host.appendChild(el('div', { style: { fontWeight: '700', fontSize: '12px' } }, [
      `${name}${pack ? ` [${pack}]` : ''}`,
    ]));
    host.appendChild(el('div', { class: 'muted', style: { marginTop: '4px', fontSize: '10px', wordBreak: 'break-all' } }, [p]));
    host.appendChild(el('div', { class: 'muted', style: { marginTop: '4px', fontSize: '10px' } }, [
      `${kind}${assetType ? ` · ${assetType}` : ''}`,
    ]));

    const stats = this._catalogStatsByPath.get(p) || null;
    if (stats?.ok) {
      const meshCount = Number(stats?.stats?.meshCount) || 0;
      const skelRoot = Number(stats?.stats?.skelRootCount) || 0;
      const skelAnim = Number(stats?.stats?.skelAnimationCount) || 0;
      const skeletonCount = Number(stats?.stats?.skeletonCount) || 0;
      const skelBindingCount = Number(stats?.stats?.skelBindingCount) || 0;

      const meta = stats?.meta && typeof stats.meta === 'object' ? stats.meta : {};
      const upAxis = safeTrim(meta?.upAxis);
      const metersPerUnit = Number(meta?.metersPerUnit);
      const defaultPrim = safeTrim(meta?.defaultPrim);

      const dep = stats?.dependencyStats && typeof stats.dependencyStats === 'object' ? stats.dependencyStats : {};
      const layers = Number(dep?.layerCount) || 0;
      const assets = Number(dep?.assetCount) || 0;
      const unresolved = Number(dep?.unresolvedCount) || 0;
      const missing = Array.isArray(stats?.missingFiles) ? stats.missingFiles.length : 0;

      const comp = stats?.compositionStats && typeof stats.compositionStats === 'object' ? stats.compositionStats : {};
      const refs = Number(comp?.primsWithReferences) || 0;
      const payloads = Number(comp?.primsWithPayloads) || 0;
      const variants = Number(comp?.primsWithVariants) || 0;

      host.appendChild(el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap', fontSize: '10px' } }, [
        `meshCount=${meshCount}  skelRootCount=${skelRoot}  skelAnimationCount=${skelAnim}  skeletonCount=${skeletonCount}  skelBindingCount=${skelBindingCount}`,
      ]));
      if (upAxis || Number.isFinite(metersPerUnit) || defaultPrim) {
        const mpuStr = Number.isFinite(metersPerUnit) && metersPerUnit > 0 ? `  metersPerUnit=${metersPerUnit}` : '';
        host.appendChild(el('div', { class: 'muted', style: { marginTop: '4px', whiteSpace: 'pre-wrap', fontSize: '10px' } }, [
          `${upAxis ? `upAxis=${upAxis}` : 'upAxis=?'}${mpuStr}${defaultPrim ? `  defaultPrim=${defaultPrim}` : ''}`,
        ]));
      }
      host.appendChild(el('div', { class: 'muted', style: { marginTop: '4px', whiteSpace: 'pre-wrap', fontSize: '10px' } }, [
        `deps: layers=${layers}  assets=${assets}  unresolved=${unresolved}  missing=${missing}`,
      ]));
      if (refs || payloads || variants) {
        host.appendChild(el('div', { class: 'muted', style: { marginTop: '4px', whiteSpace: 'pre-wrap', fontSize: '10px' } }, [
          `composition: refs=${refs}  payloads=${payloads}  variants=${variants}`,
        ]));
      }
    }

    const actions = el('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } });
    actions.appendChild(el('button', {
      onclick: async () => { try { await navigator.clipboard.writeText(p); } catch { /* ignore */ } },
    }, ['Copy path']));

    const ext = extOf(p);
    const canConvert = !isUsdExt(ext) || (stats?.ok && Number(stats?.stats?.meshCount || 0) > 0);

    if (kind === 'model') {
      actions.appendChild(el('button', {
        class: 'primary',
        title: 'Open in Model Viewer (USD/FBX will auto-convert; meshless USDs are blocked)',
        onclick: () => {
          try { localStorage.setItem('devtools.modelViewer.modelUrl', p); } catch { /* */ }
          globalThis.__devtools?.setActiveTool?.('model_viewer');
        },
      }, ['Open in Viewer']));

      actions.appendChild(el('button', {
        class: 'primary',
        title: 'Play this asset as a scenario (opens Scene tool). For USD/FBX you can convert to GLB from the Scene tool.',
        onclick: () => {
          try { localStorage.setItem('devtools.scene.sourceUrl', p); } catch { /* */ }
          globalThis.__devtools?.setActiveTool?.('scene');
        },
      }, ['Play in Scene']));

      actions.appendChild(el('button', {
        class: 'primary',
        disabled: !canConvert,
        title: !canConvert ? 'Blocked: USD has no mesh prims' : 'Convert to GLB (uses Inspect & Convert pipeline)',
        onclick: () => this._runConvert(p, 'conda_trellis', ''),
      }, ['Convert → GLB']));
    }

    if (kind === 'motion' || isMotionExt(ext)) {
      actions.appendChild(el('button', {
        class: 'primary',
        title: 'Use as motionPath (opens Animation tool)',
        onclick: () => {
          try { localStorage.setItem('devtools.lastMotionUrl', p); } catch { /* ignore */ }
          globalThis.__devtools?.setActiveTool?.('animation');
        },
      }, ['Use motion']));
    }

    host.appendChild(actions);
  }

  // ──────────────────── Characters tab ────────────────────

  _renderCharactersTab() {
    const host = this._tabContent;
    if (!host) return;
    clear(host);

    host.appendChild(el('div', { class: 'panelSubtitle' }, [
      'Structured character view (entry USD + motions/materials/textures) using pack-specific heuristics.',
    ]));

    const st = this._charState;

    const packSel = el('select', { value: st.pack }, [
      el('option', { value: '(all)' }, ['All packs']),
    ]);
    packSel.onchange = async (e) => {
      st.pack = String(e.target.value || '(all)');
      this._savePrefs();
      await this._loadCharacters();
    };

    const queryInput = el('input', {
      value: st.query,
      placeholder: 'filter characters (e.g. Uniform_M_0001)',
      oninput: (e) => {
        st.query = safeTrim(e.target.value);
        this._savePrefs();
      },
    });
    queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._loadCharacters(); });

    const refreshBtn = el('button', { class: 'primary', onclick: () => this._loadCharacters() }, ['Refresh']);

    this._charStatusEl = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    this._charListEl = el('div', { class: 'scrollArea', style: { height: '260px', marginTop: '8px' } }, ['(refresh to load)']);
    this._charPreviewEl = el('div', { style: { marginTop: '8px' } }, ['']);

    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Characters']),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } }, [
        el('div', { style: { flex: '1' } }, [el('div', { class: 'fieldLabel' }, ['Pack']), packSel]),
        el('div', { style: { flex: '2' } }, [el('div', { class: 'fieldLabel' }, ['Filter']), queryInput]),
        refreshBtn,
      ]),
      this._charStatusEl,
      this._charListEl,
    ]));

    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Selected Character']),
      this._charPreviewEl,
    ]));

    // Populate pack list lazily.
    void (async () => {
      try {
        const resp = await fetch('/__devtools_omniverse_packs');
        const j = await resp.json();
        if (!j?.ok) return;
        const packs = Array.isArray(j?.packs) ? j.packs : [];
        while (packSel.childNodes.length > 1) packSel.removeChild(packSel.lastChild);
        for (const p of packs) {
          const name = safeTrim(p?.name);
          if (name) packSel.appendChild(el('option', { value: name }, [name]));
        }
        packSel.value = st.pack;
      } catch { /* ignore */ }
    })();

    void this._loadCharacters();
  }

  async _loadCharacters() {
    const st = this._charState;
    const listEl = this._charListEl;
    const statusEl = this._charStatusEl;
    if (!listEl || !statusEl) return;

    listEl.textContent = 'Loading…';
    statusEl.textContent = 'Scanning packs…';
    this._charItems = [];
    this._selectedChar = null;
    this._syncCharacterPreview();

    try {
      // If this is a single pack, try to load its tags report once so we can display
      // clear mesh/rig/anim badges without running USD inspection.
      if (st.pack && st.pack !== '(all)') {
        await this._loadPackTagsReport(st.pack);
      }

      const params = new URLSearchParams();
      if (st.pack && st.pack !== '(all)') params.set('pack', st.pack);
      if (st.query) params.set('query', st.query);
      const resp = await fetch(`/__devtools_omniverse_characters?${params.toString()}`);
      const j = await resp.json();
      if (!j?.ok) throw new Error(String(j?.error || 'characters endpoint failed'));
      const items = Array.isArray(j?.characters) ? j.characters : [];
      this._charItems = items;

      statusEl.textContent = `${Number(j?.count || items.length) || items.length} characters`;
      clear(listEl);

      if (!items.length) {
        listEl.textContent = 'No characters found. (Tip: import the Characters pack, then refresh.)';
        return;
      }

      for (const c of items.slice(0, Math.max(20, Math.min(2000, Number(st.limit) || 400)))) {
        const name = safeTrim(c?.name);
        const pack = safeTrim(c?.pack);
        const entry = safeTrim(c?.entry?.path);
        const motions = Number(c?.counts?.motions) || 0;
        const mats = Number(c?.counts?.materials) || 0;
        const tex = Number(c?.counts?.textures) || 0;
        const isActorCore = !!c?.tags?.isActorCore;

        const st0 = entry ? (this._catalogStatsByPath.get(entry) || null) : null;
        const meshCount = Number(st0?.stats?.meshCount) || 0;
        const skelRoot = Number(st0?.stats?.skelRootCount) || 0;
        const skelAnim = Number(st0?.stats?.skelAnimationCount) || 0;
        const badge = (st0?.ok)
          ? ` · mesh:${meshCount}${skelRoot ? ` rig:${skelRoot}` : ''}${skelAnim ? ` anim:${skelAnim}` : ''}`
          : '';

        const label = `${name || '(unnamed)'}${pack ? ` [${pack}]` : ''}`;
        const meta = `${isActorCore ? 'ActorCore · ' : ''}${motions} motions · ${mats} materials · ${tex} textures${badge}`;

        listEl.appendChild(el('button', {
          class: 'toolBtn',
          style: { marginTop: '6px', textAlign: 'left' },
          onclick: () => {
            this._selectedChar = c;
            this._syncCharacterPreview();
          },
          title: entry || '',
        }, [
          el('div', { style: { fontWeight: '600' } }, [label]),
          el('div', { class: 'muted', style: { fontSize: '10px', marginTop: '2px' } }, [meta]),
        ]));
      }
    } catch (e) {
      listEl.textContent = `Error: ${e?.message || e}`;
      statusEl.textContent = 'Failed to load characters.';
    }
  }

  _syncCharacterPreview() {
    const host = this._charPreviewEl;
    if (!host) return;
    clear(host);

    const c = this._selectedChar;
    if (!c) {
      host.appendChild(el('div', { class: 'muted' }, ['Select a character to see entry USD and related assets.']));
      return;
    }

    const name = safeTrim(c?.name) || '(unnamed)';
    const pack = safeTrim(c?.pack);
    const entry = safeTrim(c?.entry?.path);
    const isActorCore = !!c?.tags?.isActorCore;
    const vendor = safeTrim(c?.tags?.vendor);

    host.appendChild(el('div', { style: { fontWeight: '700', fontSize: '12px' } }, [
      `${name}${pack ? ` [${pack}]` : ''}`,
    ]));
    host.appendChild(el('div', { class: 'muted', style: { marginTop: '4px', fontSize: '10px', wordBreak: 'break-all' } }, [
      entry || '(missing entry path)',
    ]));
    host.appendChild(el('div', { class: 'muted', style: { marginTop: '4px', fontSize: '10px' } }, [
      `${isActorCore ? 'ActorCore' : 'Character'}${vendor ? ` · ${vendor}` : ''}`,
    ]));

    const entryStats = entry ? (this._catalogStatsByPath.get(entry) || null) : null;
    if (entryStats?.ok) {
      const meshCount = Number(entryStats?.stats?.meshCount) || 0;
      const skelRoot = Number(entryStats?.stats?.skelRootCount) || 0;
      const skelAnim = Number(entryStats?.stats?.skelAnimationCount) || 0;
      host.appendChild(el('div', { class: 'muted', style: { marginTop: '6px', fontSize: '10px' } }, [
        `mesh:${meshCount}  rig:${skelRoot}  anim:${skelAnim}`,
      ]));
    }

    const actions = el('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } });
    actions.appendChild(el('button', {
      onclick: async () => {
        if (!entry) return;
        try { await navigator.clipboard.writeText(entry); } catch { /* ignore */ }
      },
    }, ['Copy entry path']));

    actions.appendChild(el('button', {
      class: 'primary',
      onclick: () => {
        if (!entry) return;
        try { localStorage.setItem('devtools.modelViewer.modelUrl', entry); } catch { /* */ }
        globalThis.__devtools?.setActiveTool?.('model_viewer');
      },
      title: 'Open entry USD/FBX in the Model Viewer (auto-converts if needed)',
    }, ['Open in Viewer']));

    actions.appendChild(el('button', {
      class: 'primary',
      onclick: () => {
        if (!entry) return;
        try { localStorage.setItem('devtools.scene.sourceUrl', entry); } catch { /* */ }
        globalThis.__devtools?.setActiveTool?.('scene');
      },
      title: 'Play entry USD/FBX as a scenario (opens Scene tool)',
    }, ['Play in Scene']));

    actions.appendChild(el('button', {
      onclick: () => {
        if (!entry) return;
        this._inspectPath = entry;
        this._activeTab = 'inspect';
        this._savePrefs();
        this._renderTabs();
      },
      title: 'Send entry path to Inspect & Convert tab',
    }, ['Inspect / Convert']));

    host.appendChild(actions);

    const motions = Array.isArray(c?.motions) ? c.motions : [];
    if (!motions.length) {
      host.appendChild(el('div', { class: 'muted', style: { marginTop: '10px' } }, ['No motions detected under this character folder.']));
      return;
    }

    host.appendChild(el('div', { style: { marginTop: '10px', fontWeight: '600', fontSize: '11px' } }, [
      `Motions (${motions.length})`,
    ]));

    const list = el('div', { class: 'scrollArea', style: { height: '180px', marginTop: '6px' } }, []);
    for (const m of motions.slice(0, 200)) {
      const p = safeTrim(m?.path);
      if (!p) continue;
      const file = p.split('/').pop() || p;
      const st0 = this._catalogStatsByPath.get(p) || null;
      const meshCount = Number(st0?.stats?.meshCount) || 0;
      const skelAnim = Number(st0?.stats?.skelAnimationCount) || 0;
      const motionBadge = st0?.ok
        ? (meshCount > 0 ? `mesh+anim (${meshCount} meshes)` : (skelAnim > 0 ? 'motion-only' : 'usd'))
        : 'usd';
      list.appendChild(el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '4px 0' } }, [
        el('button', {
          class: 'toolBtn',
          style: { flex: '1', padding: '4px 6px', textAlign: 'left' },
          title: p,
          onclick: () => {
            try { localStorage.setItem('devtools.lastMotionUrl', p); } catch { /* ignore */ }
            globalThis.__devtools?.setActiveTool?.('animation');
          },
        }, [file]),
        el('span', { class: 'muted', style: { fontSize: '10px' } }, [motionBadge]),
        el('button', {
          onclick: async () => {
            try { await navigator.clipboard.writeText(p); } catch { /* ignore */ }
          },
          title: 'Copy motion path',
        }, ['Copy']),
      ]));
    }
    host.appendChild(list);
  }

  // ──────────────────── Pack Manager tab ────────────────────

  _renderPacksTab() {
    const host = this._tabContent;
    if (!host) return;
    clear(host);

    // Intro
    host.appendChild(el('div', { class: 'panelSubtitle' }, [
      'Download and extract NVIDIA Omniverse asset packs. Requires ',
      el('span', { class: 'kbd' }, ['wget']),
      ' and ',
      el('span', { class: 'kbd' }, ['unzip']),
      '.',
    ]));

    // Controls row
    const catFilter = el('select', { value: 'city' }, [
      el('option', { value: '' }, ['All categories']),
      el('option', { value: 'city' }, ['City / AEC']),
      el('option', { value: 'characters' }, ['Characters']),
      el('option', { value: 'industrial' }, ['Industrial / Warehouse']),
      el('option', { value: 'furniture' }, ['Furniture']),
      el('option', { value: 'aec' }, ['AEC Demos']),
      el('option', { value: 'extensions' }, ['Extensions']),
      el('option', { value: 'other' }, ['Other']),
    ]);
    catFilter.value = 'city';

    const maxGbInput = el('input', {
      value: '10',
      style: { width: '60px' },
      title: 'Maximum download size in GiB',
    });

    const downloadOnlyChk = el('input', { type: 'checkbox', checked: false });

    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Filters']),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', { style: { flex: '2' } }, [el('div', { class: 'fieldLabel' }, ['Category']), catFilter]),
        el('div', { style: { flex: '1' } }, [el('div', { class: 'fieldLabel' }, ['Max GiB']), maxGbInput]),
      ]),
      el('div', { style: { marginTop: '8px' } }, [
        el('label', { class: 'row', style: { gap: '8px' } }, [
          downloadOnlyChk,
          el('span', { class: 'muted' }, ['Download only (skip extraction)']),
        ]),
      ]),
    ]));

    // Pack list
    this._packsListEl = el('div', { class: 'scrollArea', style: { height: '240px', marginTop: '8px' } }, ['Loading packs\u2026']);

    const selectAllBtn = el('button', {
      onclick: () => {
        for (const [k] of this._selectedPacks) this._selectedPacks.set(k, true);
        if (this._packsListEl) for (const chk of this._packsListEl.querySelectorAll('input[type="checkbox"]')) chk.checked = true;
      },
    }, ['Select all']);

    const selectNoneBtn = el('button', {
      onclick: () => {
        for (const [k] of this._selectedPacks) this._selectedPacks.set(k, false);
        if (this._packsListEl) for (const chk of this._packsListEl.querySelectorAll('input[type="checkbox"]')) chk.checked = false;
      },
    }, ['Select none']);

    const refreshBtn = el('button', {
      onclick: () => this._refreshPacks(catFilter.value),
    }, ['Refresh']);

    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Available Packs']),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '6px' } }, [
        selectAllBtn, selectNoneBtn, refreshBtn,
      ]),
      this._packsListEl,
    ]));

    // Import controls
    this._importProgress = createProgressBar();
    this._packsStatusEl = el('div', { class: 'muted', style: { marginTop: '8px', display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'pre-wrap' } }, ['']);
    this._packsLogEl = el('div', { class: 'scrollArea', style: { height: '140px', marginTop: '8px' } }, ['']);

    const importBtn = el('button', {
      class: 'primary',
      onclick: () => this._startImport(maxGbInput.value, downloadOnlyChk.checked),
    }, ['Download & extract selected packs']);

    const killBtn = el('button', {
      class: 'danger',
      onclick: () => this._killImport(),
    }, ['Kill import']);

    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Download Packs']),
      el('div', { class: 'muted', style: { marginTop: '4px' } }, [
        'Downloads pack ZIPs from NVIDIA CDN and extracts them locally. This does NOT convert assets — use the Inspect & Convert tab to convert USD/FBX to GLB.',
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [importBtn, killBtn]),
      this._importProgress.element,
      this._packsStatusEl,
      this._packsLogEl,
    ]));

    catFilter.onchange = () => this._refreshPacks(catFilter.value);
    void this._refreshPacks(catFilter.value);
  }

  async _refreshPacks(category) {
    if (!this._packsListEl) return;
    this._packsListEl.textContent = 'Loading\u2026';
    try {
      const cat = safeTrim(category);
      const url = `/__devtools_omniverse_available${cat ? `?category=${encodeURIComponent(cat)}` : ''}`;
      const resp = await fetch(url);
      const j = await resp.json();
      if (!j?.ok) throw new Error(String(j?.error || 'failed'));
      this._packs = Array.isArray(j?.packs) ? j.packs : [];

      clear(this._packsListEl);
      if (!this._packs.length) {
        this._packsListEl.textContent = 'No packs match this filter.';
        return;
      }

      for (const p of this._packs) {
        const name = String(p?.name || '');
        if (!name) continue;
        const extracted = !!p?.extracted;
        const zipMiB = p?.zipSizeBytes ? `${bytesToMiB(p.zipSizeBytes)} MiB` : '';
        const statusTag = extracted ? 'extracted' : (p?.status === 'downloaded' ? 'downloaded' : 'not downloaded');
        const statusColor = extracted ? 'var(--success)' : (p?.status === 'downloaded' ? 'var(--text-accent)' : 'var(--text-tertiary)');

        const chk = el('input', {
          type: 'checkbox',
          checked: this._selectedPacks.has(name) ? this._selectedPacks.get(name) : !extracted,
          onchange: (e) => { this._selectedPacks.set(name, !!e.target.checked); },
        });
        if (!this._selectedPacks.has(name)) this._selectedPacks.set(name, !extracted);

        this._packsListEl.appendChild(el('label', {
          style: {
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '5px 4px', borderRadius: '4px', cursor: 'pointer',
            opacity: extracted ? '0.55' : '1',
            transition: 'background var(--transition)',
          },
        }, [
          chk,
          el('div', { style: { flex: '1', fontSize: '11px', lineHeight: '1.35' } }, [
            el('div', { style: { fontWeight: '500', color: 'var(--text-primary)' } }, [name]),
            el('div', { style: { display: 'flex', gap: '8px', marginTop: '2px' } }, [
              el('span', { style: { color: statusColor, fontSize: '10px', fontWeight: '600' } }, [statusTag]),
              zipMiB ? el('span', { style: { color: 'var(--text-tertiary)', fontSize: '10px' } }, [zipMiB]) : null,
              p?.category ? el('span', { style: { color: 'var(--text-tertiary)', fontSize: '10px' } }, [String(p.category)]) : null,
            ].filter(Boolean)),
          ]),
        ]));
      }
    } catch (e) {
      this._packsListEl.textContent = `Error: ${e?.message || e}`;
    }
  }

  async _startImport(maxGbStr, downloadOnly) {
    const packs = [];
    for (const [name, checked] of this._selectedPacks) {
      if (checked) packs.push(name);
    }
    if (!packs.length) {
      if (this._packsStatusEl) this._packsStatusEl.textContent = 'No packs selected.';
      return;
    }
    const maxGb = Math.max(0.1, Number(maxGbStr) || 10);

    try {
      this._updateImportStatus('Starting import\u2026', 'running');
      this._importProgress?.setIndeterminate();
      if (this._packsLogEl) this._packsLogEl.textContent = '(starting\u2026)';
      this._importJob = { id: '', status: 'running', stdout: '', stderr: '' };
      this._pollingImport = false;

      const resp = await fetch('/__devtools_omniverse_import_start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packs, maxGb, downloadOnly: !!downloadOnly }),
      });
      const j = await resp.json();
      if (!j?.ok) throw new Error(String(j?.error || 'start failed'));

      this._importJob.id = String(j.id || '');
      this._pollingImport = true;
      this._ctx?.log?.(`Omniverse: import started (${packs.length} packs, max ${maxGb} GiB)`);
      this._ctx?.toast?.(`Importing ${packs.length} packs`, 'info', { title: 'Omniverse' });
      void this._pollImportLoop();
    } catch (e) {
      this._ctx?.log?.(`Omniverse: import failed: ${e?.message || e}`);
      this._updateImportStatus(`Import failed: ${e?.message || e}`, 'error');
      this._importProgress?.hide();
      this._ctx?.toast?.(`Import failed: ${e?.message || e}`, 'error', { title: 'Omniverse' });
    }
  }

  async _killImport() {
    const id = this._importJob?.id;
    if (!id) return;
    try {
      await fetch('/__devtools_omniverse_import_kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
    } catch { /* */ }
    this._pollingImport = false;
  }

  _updateImportStatus(text, dotClass = 'idle') {
    if (!this._packsStatusEl) return;
    clear(this._packsStatusEl);
    this._packsStatusEl.appendChild(el('div', { class: `statusDot ${dotClass}` }));
    this._packsStatusEl.appendChild(document.createTextNode(text));
  }

  async _pollImportLoop() {
    const id = this._importJob?.id;
    if (!id) return;
    let backoff = 500;
    while (this._pollingImport && this._importJob?.id === id) {
      try {
        const resp = await fetch(`/__devtools_omniverse_import_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'poll failed'));
        this._importJob.status = String(j.status || '');
        this._importJob.stdout = String(j.stdout || '');
        this._importJob.stderr = String(j.stderr || '');

        const code = (j.exitCode == null) ? '' : ` (exit ${j.exitCode})`;
        const dotClass = (this._importJob.status === 'done') ? 'done'
          : (this._importJob.status === 'error' || this._importJob.status === 'killed') ? 'error' : 'running';
        this._updateImportStatus(`Import: ${this._importJob.status}${code}`, dotClass);

        if (this._packsLogEl) {
          const out = this._importJob.stdout || '';
          const err = this._importJob.stderr || '';
          this._packsLogEl.textContent = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output)';
          try { this._packsLogEl.scrollTop = this._packsLogEl.scrollHeight; } catch { /* */ }
        }
        if (this._importJob.status === 'done' || this._importJob.status === 'error' || this._importJob.status === 'killed') {
          this._pollingImport = false;
          this._importProgress?.hide();
          if (this._importJob.status === 'done') {
            this._importProgress?.set(1);
            this._ctx?.log?.('Omniverse: import complete');
            this._ctx?.toast?.('Pack import complete', 'success', { title: 'Omniverse' });
          } else {
            this._ctx?.toast?.(`Import ${this._importJob.status}`, 'error', { title: 'Omniverse' });
          }
          return;
        }
        backoff = 1000;
      } catch (e) {
        this._updateImportStatus(`Poll error: ${e?.message || e}`, 'error');
        backoff = Math.min(4000, Math.floor(backoff * 1.4));
      }
      await sleep(backoff);
    }
  }

  // ──────────────────── Browse Assets tab ────────────────────

  _renderBrowseTab() {
    const host = this._tabContent;
    if (!host) return;
    clear(host);

    const bs = this._browseState;

    host.appendChild(el('div', { class: 'panelSubtitle' }, [
      'Browse extracted Omniverse packs. Navigate folders and preview assets.',
    ]));

    // Pack selector
    const packSel = el('select', { value: bs.pack }, [
      el('option', { value: '(all)' }, ['All packs']),
    ]);
    packSel.onchange = async (e) => {
      bs.pack = String(e.target.value || '(all)');
      bs.path = '';
      this._savePrefs();
      await this._loadBrowseDirs();
      await this._browseRefresh();
    };

    // Category
    const catSel = el('select', { value: bs.category }, [
      el('option', { value: 'any' }, ['Any']),
      el('option', { value: 'characters' }, ['Characters']),
      el('option', { value: 'models' }, ['Models']),
      el('option', { value: 'motions' }, ['Motions']),
      el('option', { value: 'images' }, ['Images']),
      el('option', { value: 'materials' }, ['Materials']),
      el('option', { value: 'extensions' }, ['Extensions']),
    ]);
    catSel.onchange = async (e) => {
      bs.category = String(e.target.value || 'any');
      this._savePrefs();
      await this._browseRefresh();
    };

    // Kind (file type)
    const kindSel = el('select', { value: bs.kind }, [
      el('option', { value: 'models' }, ['Models (USD/FBX/GLB)']),
      el('option', { value: 'images' }, ['Images']),
      el('option', { value: 'motion' }, ['Motion (BVH/FBX/USD)']),
      el('option', { value: 'any' }, ['All files']),
    ]);
    kindSel.onchange = async (e) => {
      bs.kind = String(e.target.value || 'models');
      this._savePrefs();
      await this._browseRefresh();
    };

    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Pack & Filters']),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', { style: { flex: '2' } }, [el('div', { class: 'fieldLabel' }, ['Pack']), packSel]),
        el('div', { style: { flex: '1' } }, [el('div', { class: 'fieldLabel' }, ['Category']), catSel]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'fieldLabel' }, ['File Type']), kindSel]),
      ]),
    ]));

    // Folder browser (breadcrumb style)
    const pathInput = el('input', {
      value: bs.path,
      placeholder: 'Subfolder path (e.g. Assets/Characters/)',
      oninput: (e) => {
        bs.path = safeTrim(e.target.value).replace(/\\/g, '/');
        this._savePrefs();
      },
    });

    this._browseDirsSel = el('select', { value: '' }, [
      el('option', { value: '' }, ['(folders)']),
    ]);
    this._browseDirsSel.onchange = async (e) => {
      const v = safeTrim(e.target.value);
      if (!v) return;
      bs.path = (String(bs.path || '').trim().replace(/\\/g, '/') + v + '/').replace(/\/{2,}/g, '/');
      pathInput.value = bs.path;
      this._savePrefs();
      await this._loadBrowseDirs();
      await this._browseRefresh();
    };

    const upBtn = el('button', {
      onclick: async () => {
        const parts = String(bs.path || '').replace(/\\/g, '/').split('/').filter(Boolean);
        parts.pop();
        bs.path = parts.length ? (parts.join('/') + '/') : '';
        pathInput.value = bs.path;
        this._savePrefs();
        await this._loadBrowseDirs();
        await this._browseRefresh();
      },
      title: 'Go up one directory',
    }, ['\u2191 Up']);

    const goBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        bs.path = safeTrim(pathInput.value).replace(/\\/g, '/');
        this._savePrefs();
        await this._loadBrowseDirs();
        await this._browseRefresh();
      },
    }, ['Go']);

    // Breadcrumb
    this._breadcrumbEl = el('div', { class: 'muted', style: { marginTop: '6px', fontSize: '10px' } }, ['']);

    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Folder Browser']),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', { style: { flex: '3' } }, [pathInput]),
        upBtn,
        goBtn,
      ]),
      el('div', { class: 'row', style: { marginTop: '6px' } }, [
        el('div', { style: { flex: '1' } }, [el('div', { class: 'fieldLabel' }, ['Subfolders']), this._browseDirsSel]),
      ]),
      this._breadcrumbEl,
    ]));

    // Results
    this._browseStatusEl = el('div', { class: 'muted', style: { marginTop: '8px' } }, ['']);
    this._browseListEl = el('div', { class: 'scrollArea', style: { height: '260px', marginTop: '8px' } }, ['']);
    this._browsePreviewEl = el('div', { style: { marginTop: '8px' } });

    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Results']),
      this._browseStatusEl,
      this._browseListEl,
    ]));

    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Preview']),
      this._browsePreviewEl,
    ]));

    // Populate pack list + initial browse
    this._packSelectEl = packSel;
    void this._loadPackList().then(() => {
      if (bs.pack && bs.pack !== '(all)') void this._loadBrowseDirs();
      void this._browseRefresh();
    });
  }

  async _loadPackList() {
    try {
      const resp = await fetch('/__devtools_omniverse_packs');
      const j = await resp.json();
      if (!j?.ok) return;
      const packs = Array.isArray(j?.packs) ? j.packs : [];
      const sel = this._packSelectEl;
      if (!sel) return;
      while (sel.childNodes.length > 1) sel.removeChild(sel.lastChild);
      for (const p of packs) {
        const name = safeTrim(p?.name);
        if (name) sel.appendChild(el('option', { value: name }, [name]));
      }
      sel.value = this._browseState.pack;
    } catch { /* */ }
  }

  async _loadBrowseDirs() {
    const sel = this._browseDirsSel;
    if (!sel) return;
    clear(sel);
    sel.appendChild(el('option', { value: '' }, ['(folders)']));

    const bs = this._browseState;
    if (!bs.pack || bs.pack === '(all)') return;

    try {
      const url = `/__devtools_omniverse_ls?pack=${encodeURIComponent(bs.pack)}&path=${encodeURIComponent(bs.path || '')}`;
      const resp = await fetch(url);
      const j = await resp.json();
      if (!j?.ok) return;
      const dirs = Array.isArray(j?.dirs) ? j.dirs : [];
      for (const d of dirs) {
        const name = safeTrim(d?.name);
        if (name) sel.appendChild(el('option', { value: name }, [name]));
      }
    } catch { /* */ }

    // Update breadcrumb
    this._updateBreadcrumb();
  }

  _updateBreadcrumb() {
    if (!this._breadcrumbEl) return;
    const bs = this._browseState;
    const parts = [bs.pack !== '(all)' ? bs.pack : '', ...(bs.path || '').split('/').filter(Boolean)];
    this._breadcrumbEl.textContent = parts.filter(Boolean).join(' / ') || '(root)';
  }

  _kindToExtCsv(kind) {
    if (kind === 'images') return '.png,.jpg,.jpeg,.webp,.gif';
    if (kind === 'models') return '.glb,.gltf,.fbx,.usd,.usda,.usdc,.usdz';
    if (kind === 'motion') return '.bvh,.fbx,.usd,.usda,.usdc,.usdz';
    return '';
  }

  async _browseRefresh() {
    const ctx = this._ctx;
    if (!ctx || !this._browseListEl) return;

    const bs = this._browseState;
    const base = 'assets/external/omniverse/packs/';
    const packPart = (bs.pack && bs.pack !== '(all)') ? `${bs.pack}/` : '';
    const pth = String(bs.path || '').trim().replace(/^\/+/, '').replace(/\\/g, '/');
    const q = (base + packPart + (pth ? pth.replace(/\/{2,}/g, '/') : '')).replace(/\/{2,}/g, '/');

    const ext = this._kindToExtCsv(bs.kind);

    this._browseListEl.textContent = 'Loading\u2026';
    if (this._browseStatusEl) this._browseStatusEl.textContent = `query: ${q}`;

    try {
      const items = await ctx.assetIndex({ query: q, ext });
      this._browseItems = items;

      if (this._browseStatusEl) this._browseStatusEl.textContent = `${items.length} results  \u00b7  ${q}`;

      clear(this._browseListEl);
      if (!items.length) {
        this._browseListEl.textContent = 'No files found. Try a different pack or path.';
        return;
      }

      for (const it of items.slice(0, bs.limit)) {
        const p = String(it?.path || '');
        const bytes = Number(it?.bytes) || 0;
        const ext = extOf(p);
        const isModel = isModelExt(ext);
        const fileName = p.split('/').pop() || p;

        const row = el('button', {
          class: 'toolBtn',
          style: { marginTop: '2px', padding: '5px 8px' },
          onclick: () => {
            this._selectedAsset = p;
            this._syncBrowsePreview();
          },
        }, [
          el('span', { class: 'toolIcon', style: { fontSize: '11px' } }, [isModel ? '◇' : (isImageExt(ext) ? '▧' : '▪')]),
          el('span', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, [fileName]),
          el('span', { class: 'muted', style: { flexShrink: '0', fontSize: '10px' } }, [`${bytesToMiB(bytes)} MiB`]),
        ]);
        this._browseListEl.appendChild(row);
      }
    } catch (e) {
      this._browseListEl.textContent = `Error: ${e?.message || e}`;
    }
  }

  _syncBrowsePreview() {
    const host = this._browsePreviewEl;
    if (!host) return;
    clear(host);

    const p = this._selectedAsset;
    if (!p) {
      host.appendChild(el('div', { class: 'muted' }, ['Select a file to preview.']));
      return;
    }

    const ext = extOf(p);
    const fileName = p.split('/').pop() || p;

    host.appendChild(el('div', { style: { fontWeight: '600', fontSize: '12px', wordBreak: 'break-all' } }, [fileName]));
    host.appendChild(el('div', { class: 'muted', style: { marginTop: '2px', wordBreak: 'break-all', fontSize: '10px' } }, [p]));

    // Action buttons
    const actions = el('div', { class: 'row', style: { marginTop: '8px', gap: '6px', flexWrap: 'wrap' } });

    // Copy path
    actions.appendChild(el('button', {
      onclick: async () => {
        try { await navigator.clipboard.writeText(p); this._ctx?.log?.('Copied path'); } catch { /* */ }
      },
    }, ['Copy path']));

    // Open in Model Viewer
    if (isModelExt(ext)) {
      actions.appendChild(el('button', {
        class: 'primary',
        onclick: () => {
          try { localStorage.setItem('devtools.modelViewer.modelUrl', p); } catch { /* */ }
          globalThis.__devtools?.setActiveTool?.('model_viewer');
        },
      }, ['Open in Viewer']));

      actions.appendChild(el('button', {
        class: 'primary',
        onclick: () => {
          try { localStorage.setItem('devtools.scene.sourceUrl', p); } catch { /* */ }
          globalThis.__devtools?.setActiveTool?.('scene');
        },
      }, ['Play in Scene']));
    }

    // Send to Inspect tab
    if (ext === '.usd' || ext === '.usda' || ext === '.usdc' || ext === '.usdz' || ext === '.fbx') {
      actions.appendChild(el('button', {
        onclick: () => {
          this._inspectPath = p;
          this._activeTab = 'inspect';
          this._savePrefs();
          this._renderTabs();
        },
      }, ['Inspect / Convert']));
    }

    // Image preview
    if (isImageExt(ext)) {
      const img = el('img', {
        src: p,
        style: {
          maxWidth: '100%', maxHeight: '200px', objectFit: 'contain',
          borderRadius: '8px', marginTop: '8px',
          border: '1px solid var(--border-subtle)',
        },
      });
      host.appendChild(actions);
      host.appendChild(img);
    } else {
      host.appendChild(actions);
    }
  }

  // ──────────────────── Inspect & Convert tab ────────────────────

  _renderInspectTab() {
    const host = this._tabContent;
    if (!host) return;
    clear(host);

    host.appendChild(el('div', { class: 'panelSubtitle' }, [
      'Inspect USD stages and convert USD/FBX assets to GLB for use in the runtime.',
    ]));

    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Learn OpenUSD (reference)']),
      el('div', { class: 'muted' }, ['Use these to interpret the inspector stats:']),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '10px', flexWrap: 'wrap' } }, [
        el('a', { href: 'https://docs.nvidia.com/learn-openusd/latest/stage-setting/index.html', target: '_blank', rel: 'noreferrer' }, ['Stage setting']),
        el('a', { href: 'https://docs.nvidia.com/learn-openusd/latest/composition-basics/index.html', target: '_blank', rel: 'noreferrer' }, ['Composition basics']),
        el('a', { href: 'https://docs.nvidia.com/learn-openusd/latest/data-exchange/index.html', target: '_blank', rel: 'noreferrer' }, ['Data exchange']),
      ]),
    ]));

    // Inspect section
    const inspectInput = el('input', {
      value: this._inspectPath,
      placeholder: 'assets/external/omniverse/packs/.../model.usd',
      oninput: (e) => { this._inspectPath = safeTrim(e.target.value); },
    });

    this._inspectStatusEl = el('div', { class: 'muted', style: { marginTop: '8px' } }, ['']);
    this._inspectResultEl = el('div', { class: 'scrollArea', style: { height: '220px', marginTop: '8px' } }, ['']);

    const inspectBtn = el('button', {
      class: 'primary',
      onclick: () => this._runInspect(),
    }, ['Inspect USD']);

    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['USD Inspector']),
      el('div', { class: 'fieldLabel' }, ['USD File Path']),
      inspectInput,
      el('div', { class: 'row', style: { marginTop: '8px' } }, [inspectBtn]),
      this._inspectStatusEl,
      this._inspectResultEl,
    ]));

    // Convert section
    const convertInput = el('input', {
      value: this._inspectPath,
      placeholder: 'assets/external/omniverse/packs/.../model.usd',
      oninput: (e) => { this._inspectPath = safeTrim(e.target.value); },
    });
    // Sync: when inspect path changes, so does convert input.
    inspectInput.addEventListener('input', () => { convertInput.value = inspectInput.value; });

    const runnerSel = el('select', { value: 'conda_trellis' }, [
      el('option', { value: 'conda_trellis' }, ['conda run -n trellis']),
      el('option', { value: 'python3' }, ['python3 (current env)']),
    ]);

    const outNameInput = el('input', {
      value: '',
      placeholder: 'output name (optional)',
    });

    this._convertProgress = createProgressBar();
    this._convertStatusEl = el('div', { class: 'muted', style: { marginTop: '8px', display: 'flex', alignItems: 'center', gap: '6px' } }, ['']);
    this._convertLogEl = el('div', { class: 'scrollArea', style: { height: '160px', marginTop: '8px' } }, ['']);

    const convertBtn = el('button', {
      class: 'primary',
      onclick: () => this._runConvert(convertInput.value || inspectInput.value, runnerSel.value, outNameInput.value),
    }, ['Convert to GLB']);

    const killConvertBtn = el('button', {
      class: 'danger',
      onclick: () => this._killConvert(),
    }, ['Kill']);

    const openResultBtn = el('button', {
      onclick: () => {
        const p = this._convertJob?.outGlb;
        if (!p) return;
        try { localStorage.setItem('devtools.modelViewer.modelUrl', p); } catch { /* */ }
        globalThis.__devtools?.setActiveTool?.('model_viewer');
      },
    }, ['Open result in Viewer']);

    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Convert to GLB']),
      el('div', { class: 'muted' }, ['Uses Blender with OpenUSD to convert USD/FBX to runtime-ready GLB.']),
      el('div', { class: 'fieldLabel' }, ['Input Path']),
      convertInput,
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', { style: { flex: '2' } }, [el('div', { class: 'fieldLabel' }, ['Runner']), runnerSel]),
        el('div', { style: { flex: '1' } }, [el('div', { class: 'fieldLabel' }, ['Output Name']), outNameInput]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [convertBtn, killConvertBtn, openResultBtn]),
      this._convertProgress.element,
      this._convertStatusEl,
      this._convertLogEl,
    ]));

    // Asset picker (shared component)
    host.appendChild(createAssetPicker({
      ctx: this._ctx,
      title: 'Find USD/FBX Assets',
      ext: '.usd,.usda,.usdc,.usdz,.fbx',
      placeholder: 'Search (e.g. character, building, orc)',
      onPick: (p) => {
        this._inspectPath = p;
        inspectInput.value = p;
        convertInput.value = p;
      },
    }));
  }

  async _runInspect() {
    const path = safeTrim(this._inspectPath);
    if (!path) {
      if (this._inspectStatusEl) this._inspectStatusEl.textContent = 'Enter a USD file path.';
      return;
    }
    if (this._inspectStatusEl) this._inspectStatusEl.textContent = 'Inspecting\u2026';
    if (this._inspectResultEl) this._inspectResultEl.textContent = '(running\u2026)';

    try {
      const resp = await fetch('/__devtools_usd_inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runner: 'blender_5', inputPath: path }),
      });
      const j = await resp.json();
      if (!j?.ok) throw new Error(String(j?.error || 'inspect failed'));

      const out = String(j.stdout || '');
      const err = String(j.stderr || '');
      const text = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output)';

      if (this._inspectResultEl) this._inspectResultEl.textContent = text;
      if (this._inspectStatusEl) this._inspectStatusEl.textContent = `Inspection complete for: ${path}`;
      this._ctx?.log?.(`Omniverse: inspected ${path}`);
    } catch (e) {
      if (this._inspectStatusEl) this._inspectStatusEl.textContent = `Inspect error: ${e?.message || e}`;
      if (this._inspectResultEl) this._inspectResultEl.textContent = `Error: ${e?.message || e}`;
    }
  }

  _updateConvertStatus(text, dotClass = 'idle') {
    if (!this._convertStatusEl) return;
    clear(this._convertStatusEl);
    this._convertStatusEl.appendChild(el('div', { class: `statusDot ${dotClass}` }));
    this._convertStatusEl.appendChild(document.createTextNode(text));
  }

  async _runConvert(inputPath, runner, outName) {
    const path = safeTrim(inputPath);
    if (!path) {
      this._updateConvertStatus('Enter an input path.', 'idle');
      return;
    }

    // Preflight: avoid converting meshless USDs (common for motion-only stages).
    // Best-effort only: if USD inspection isn't available, continue.
    try {
      const ext = path.lastIndexOf('.') >= 0 ? path.slice(path.lastIndexOf('.')).toLowerCase() : '';
      const isUsd = ext === '.usd' || ext === '.usda' || ext === '.usdc' || ext === '.usdz';
      if (isUsd) {
        this._updateConvertStatus('Preflight USD (mesh check)\u2026', 'running');
        const ir = await fetch('/__devtools_usd_inspect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runner: 'blender_5', inputPath: path }),
        });
        const ij = await ir.json();
        const summary = ij?.json;
        if (ij?.ok && summary?.ok) {
          const stats = summary?.stats || {};
          const meshCount = Number(stats.meshCount) || 0;
          if (meshCount <= 0) {
            const skelAnim = Number(stats.skelAnimationCount) || 0;
            const skelRoot = Number(stats.skelRootCount) || 0;
            if (skelAnim <= 0) {
              const msg = `Convert blocked: USD has no Mesh prims (meshCount=0) and no SkelAnimation prims (skelAnim=0). (skelRoot=${skelRoot})`;
              this._updateConvertStatus(msg, 'error');
              this._convertProgress?.hide();
              if (this._convertLogEl) this._convertLogEl.textContent = '(blocked before conversion)';
              this._ctx?.toast?.(msg, 'warning', { title: 'Omniverse' });
              return;
            }

            // Motion-only USD: allow conversion (armature + clips). Output GLB will be used for retargeting.
            const msg = `USD is motion-only (meshCount=0) but has SkelAnimation (skelAnim=${skelAnim}, skelRoot=${skelRoot}) — converting anyway`;
            this._updateConvertStatus(msg, 'running');
            this._ctx?.toast?.(msg, 'info', { title: 'Omniverse' });
          }
        }
      }
    } catch (e) {
      this._ctx?.log?.(`Omniverse: USD preflight skipped: ${e?.message || e}`);
    }

    this._updateConvertStatus('Starting conversion\u2026', 'running');
    this._convertProgress?.setIndeterminate();
    if (this._convertLogEl) this._convertLogEl.textContent = '(starting\u2026)';
    this._convertJob = { id: '', status: 'running', stdout: '', stderr: '', outGlb: '' };
    this._pollingConvert = false;

    try {
      const payload = {
        runner: String(runner || 'conda_trellis'),
        inPath: path,
        outName: safeTrim(outName) || undefined,
      };
      const resp = await fetch('/__devtools_convert_start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await resp.json();
      if (!j?.ok) throw new Error(String(j?.error || 'convert start failed'));

      this._convertJob.id = String(j.id || '');
      this._convertJob.outGlb = String(j.outGlb || '');
      this._pollingConvert = true;
      this._ctx?.log?.(`Omniverse: convert started (${path})`);
      this._ctx?.toast?.('Conversion started', 'info', { title: 'Omniverse' });
      void this._pollConvertLoop();
    } catch (e) {
      this._updateConvertStatus(`Convert error: ${e?.message || e}`, 'error');
      this._convertProgress?.hide();
      this._ctx?.log?.(`Omniverse: convert failed: ${e?.message || e}`);
      this._ctx?.toast?.(`Convert failed: ${e?.message || e}`, 'error', { title: 'Omniverse' });
    }
  }

  async _killConvert() {
    const id = this._convertJob?.id;
    if (!id) return;
    try {
      await fetch('/__devtools_convert_kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
    } catch { /* */ }
    this._pollingConvert = false;
  }

  async _pollConvertLoop() {
    const id = this._convertJob?.id;
    if (!id) return;
    let backoff = 500;
    while (this._pollingConvert && this._convertJob?.id === id) {
      try {
        const resp = await fetch(`/__devtools_convert_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'poll failed'));
        this._convertJob.status = String(j.status || '');
        this._convertJob.stdout = String(j.stdout || '');
        this._convertJob.stderr = String(j.stderr || '');
        this._convertJob.outGlb = String(j.outGlb || this._convertJob.outGlb || '');

        const code = (j.exitCode == null) ? '' : ` (exit ${j.exitCode})`;
        const out = this._convertJob.outGlb ? ` \u2192 ${this._convertJob.outGlb}` : '';
        const dotClass = (this._convertJob.status === 'done') ? 'done'
          : (this._convertJob.status === 'error' || this._convertJob.status === 'killed') ? 'error' : 'running';
        this._updateConvertStatus(`${this._convertJob.status}${code}${out}`, dotClass);

        if (this._convertLogEl) {
          const stdout = this._convertJob.stdout || '';
          const stderr = this._convertJob.stderr || '';
          this._convertLogEl.textContent = (stderr ? (stdout + '\n--- stderr ---\n' + stderr) : stdout) || '(no output)';
          try { this._convertLogEl.scrollTop = this._convertLogEl.scrollHeight; } catch { /* */ }
        }
        if (this._convertJob.status === 'done' || this._convertJob.status === 'error' || this._convertJob.status === 'killed') {
          this._pollingConvert = false;
          this._convertProgress?.hide();
          if (this._convertJob.status === 'done') {
            this._convertProgress?.set(1);
            this._ctx?.log?.(`Omniverse: convert done \u2192 ${this._convertJob.outGlb}`);
            this._ctx?.toast?.(`Converted \u2192 ${this._convertJob.outGlb.split('/').pop()}`, 'success', { title: 'Omniverse' });
          } else {
            this._ctx?.toast?.(`Convert ${this._convertJob.status}`, 'error', { title: 'Omniverse' });
          }
          return;
        }
        backoff = 800;
      } catch (e) {
        this._updateConvertStatus(`Poll error: ${e?.message || e}`, 'error');
        backoff = Math.min(4000, Math.floor(backoff * 1.4));
      }
      await sleep(backoff);
    }
  }

}
