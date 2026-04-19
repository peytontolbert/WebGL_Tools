import { el, clear } from '../../ui/dom.js';

function safeTrim(s) {
  return String(s ?? '').trim();
}

function extOf(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i).toLowerCase() : '';
}

function isImageExt(ext) {
  return ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp' || ext === '.gif';
}

function isModelExt(ext) {
  return ext === '.glb' || ext === '.gltf';
}

function isVideoExt(ext) {
  return ext === '.mp4' || ext === '.webm';
}

function isMotionExt(ext) {
  return ext === '.bvh' || ext === '.fbx' || ext === '.usd' || ext === '.usda' || ext === '.usdc' || ext === '.usdz';
}

function isModelSourceExt(ext) {
  // Files that usually represent a scene/character, not just "motion".
  return ext === '.fbx' || ext === '.usd' || ext === '.usda' || ext === '.usdc' || ext === '.usdz';
}

function bytesToMiB(bytes) {
  const b = Number(bytes) || 0;
  return (b / (1024 * 1024)).toFixed(2);
}

function fmtTime(ms) {
  const t = Number(ms) || 0;
  if (!t) return '';
  try { return new Date(t).toLocaleString(); } catch { return ''; }
}

function isTextPreviewExt(ext) {
  return ext === '.usda' || ext === '.json' || ext === '.yaml' || ext === '.yml' || ext === '.txt' || ext === '.md' || ext === '.ini';
}

function isUsdBinaryExt(ext) {
  return ext === '.usd' || ext === '.usdc' || ext === '.usdz';
}

function isUsdExt(ext) {
  return ext === '.usd' || ext === '.usda' || ext === '.usdc' || ext === '.usdz';
}

function readJsonLs(key, fallback) {
  try {
    const raw = String(localStorage.getItem(key) || '').trim();
    if (!raw) return fallback;
    const j = JSON.parse(raw);
    return j ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJsonLs(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

export class AssetsTool {
  constructor() {
    this.id = 'assets';
    this.label = 'Assets';

    this._ctx = null;
    this._root = null;

    this._state = {
      preset: 'generated', // generated | animations | outputs | maps | datasets | all | custom
      query: 'assets/generated/',
      kind: 'images', // images | models | videos | motion | maps | any
      sort: 'recent', // recent | path | size
      limit: 350,
      omniPack: '(all)', // when preset=omniverse: which pack
      omniCategory: 'any', // any | characters | motions | models | images | materials | extensions
      omniPath: '', // when preset=omniverse: subdir within the selected pack (folder browsing)
    };

    this._items = [];
    this._selected = '';
    this._statusEl = null;
    this._listEl = null;
    this._previewEl = null;

    this._favorites = [];
    this._recents = [];
    this._favoritesEl = null;
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;
    this._buildUi();
    await this._refresh();
  }

  async unmount() {
    this._ctx = null;
    this._root = null;
  }

  tick() {}

  getStats() {
    return {
      query: this._state.query || '',
      selected: this._selected || '',
      count: Array.isArray(this._items) ? this._items.length : 0,
    };
  }

  _presetToQuery(preset) {
    if (preset === 'generated') return 'assets/generated/';
    if (preset === 'animations') return 'assets/animations/';
    if (preset === 'outputs') return 'outputs/';
    if (preset === 'maps') return 'tools/rigging/mappings/';
    if (preset === 'datasets') return 'assets/datasets/';
    if (preset === 'omniverse') return 'assets/external/omniverse/packs/';
    if (preset === 'all') return 'assets/';
    return this._state.query || '';
  }

  _kindToExtCsv(kind) {
    if (kind === 'images') return '.png,.jpg,.jpeg,.webp,.gif';
    // "Models" includes both runtime-ready GLB/GLTF and common source formats
    // (USD/FBX) that we can convert in the Model tool.
    if (kind === 'models') return '.glb,.gltf,.fbx,.usd,.usda,.usdc,.usdz';
    if (kind === 'videos') return '.mp4,.webm';
    if (kind === 'motion') return '.bvh,.fbx,.usd,.usda,.usdc,.usdz';
    if (kind === 'maps') return '.json';
    return '';
  }

  _omniverseCategorySuffix(cat) {
    // NOTE: pack layouts differ wildly (Assets vs Demos vs Usd_Explorer, etc).
    // We no longer hardcode a suffix here; folder browsing via `omniPath`
    // drives the query instead. Category is used to set `kind`.
    return '';
  }

  _applyOmniverseQuery(queryInput, presetSel, kindSel) {
    const st = this._state;
    if (String(st.preset || '') !== 'omniverse') return;
    if (String(presetSel?.value || '') !== 'omniverse') return;

    const base = this._presetToQuery('omniverse');
    const pack = String(st.omniPack || '(all)').trim();
    const packPart = (pack && pack !== '(all)') ? `${pack}/` : '';
    const pth = String(st.omniPath || '').trim().replace(/^\/+/, '').replace(/\\/g, '/');
    const q = (base + packPart + (pth ? (pth.replace(/^\/+/, '').replace(/\/{2,}/g, '/').replace(/^\/+/, '') + (pth.endsWith('/') ? '' : '/')) : '')).replace(/\/{2,}/g, '/');
    st.query = q;
    if (queryInput) queryInput.value = q;
    // Best-effort: set reasonable kind for category.
    if (st.omniCategory === 'images') { st.kind = 'images'; if (kindSel) kindSel.value = 'images'; }
    else if (st.omniCategory === 'motions') { st.kind = 'motion'; if (kindSel) kindSel.value = 'motion'; }
    else if (st.omniCategory === 'models' || st.omniCategory === 'characters') { st.kind = 'models'; if (kindSel) kindSel.value = 'models'; }
    else if (st.omniCategory === 'materials') { st.kind = 'any'; if (kindSel) kindSel.value = 'any'; }
    else if (st.omniCategory === 'extensions') { st.kind = 'any'; if (kindSel) kindSel.value = 'any'; }
  }

  _loadPrefs() {
    this._favorites = Array.isArray(readJsonLs('devtools.assets.favorites', []))
      ? readJsonLs('devtools.assets.favorites', []).map((s) => safeTrim(s)).filter(Boolean).slice(0, 200)
      : [];
    this._recents = Array.isArray(readJsonLs('devtools.assets.recents', []))
      ? readJsonLs('devtools.assets.recents', []).map((s) => safeTrim(s)).filter(Boolean).slice(0, 200)
      : [];
  }

  _savePrefs() {
    writeJsonLs('devtools.assets.favorites', this._favorites.slice(0, 200));
    writeJsonLs('devtools.assets.recents', this._recents.slice(0, 200));
  }

  _rememberRecent(p) {
    const path = safeTrim(p);
    if (!path) return;
    this._recents = [path, ...this._recents.filter((x) => x !== path)].slice(0, 40);
    this._savePrefs();
    this._syncFavoritesUi();
  }

  _toggleFavorite(p) {
    const path = safeTrim(p);
    if (!path) return;
    const has = this._favorites.includes(path);
    this._favorites = has ? this._favorites.filter((x) => x !== path) : [path, ...this._favorites].slice(0, 80);
    this._savePrefs();
    this._syncFavoritesUi();
  }

  _syncFavoritesUi() {
    const host = this._favoritesEl;
    if (!host) return;
    clear(host);

    const favs = this._favorites.slice(0, 12);
    const recs = this._recents.slice(0, 12);

    const mkRow = (title, items) => el('div', { style: { marginTop: '8px' } }, [
      el('div', { class: 'muted' }, [title]),
      ...(items.length ? [
        el('div', { class: 'row', style: { marginTop: '6px', flexWrap: 'wrap', gap: '8px' } }, items.map((p) => (
          el('button', {
            title: p,
            onclick: () => {
              this._selected = p;
              this._syncPreview();
            },
          }, [p.split('/').slice(-1)[0] || p])
        ))),
      ] : [el('div', { class: 'muted', style: { marginTop: '4px' } }, ['(none)'])]),
    ]);

    host.appendChild(mkRow('Favorites', favs));
    host.appendChild(mkRow('Recents', recs));
  }

  _buildUi() {
    const root = this._root;
    if (!root) return;
    clear(root);

    const st = this._state;
    this._loadPrefs();

    const presetSel = el('select', {
      value: st.preset,
      onchange: async (e) => {
        st.preset = String(e.target.value || 'generated');
        if (st.preset !== 'custom') st.query = this._presetToQuery(st.preset);
        queryInput.value = st.query;
        try { omniRow.style.display = (st.preset === 'omniverse') ? 'flex' : 'none'; } catch { /* ignore */ }
        // Sensible default: Omniverse packs are mostly USD/FBX.
        if (st.preset === 'omniverse' && st.kind === 'images') {
          st.kind = 'motion';
          kindSel.value = 'motion';
        }
        if (st.preset === 'omniverse') {
          this._applyOmniverseQuery(queryInput, presetSel, kindSel);
        }
        await this._refresh();
      },
    }, [
      el('option', { value: 'generated' }, ['Generated (assets/generated/)']),
      el('option', { value: 'animations' }, ['Animations (assets/animations/)']),
      el('option', { value: 'outputs' }, ['Outputs (outputs/)']),
      el('option', { value: 'maps' }, ['Rig maps (tools/rigging/mappings/)']),
      el('option', { value: 'datasets' }, ['Datasets (assets/datasets/)']),
      el('option', { value: 'omniverse' }, ['Omniverse packs (assets/external/omniverse/packs/)']),
      el('option', { value: 'all' }, ['All assets (assets/)']),
      el('option', { value: 'custom' }, ['Custom query']),
    ]);

    const omniPackSel = el('select', {
      value: st.omniPack,
      onchange: async (e) => {
        st.omniPack = String(e.target.value || '(all)');
        try { localStorage.setItem('devtools.assets.omniPack', st.omniPack); } catch { /* ignore */ }
        // Reset folder browsing when switching packs.
        st.omniPath = '';
        try { localStorage.setItem('devtools.assets.omniPath', st.omniPath); } catch { /* ignore */ }
        this._applyOmniverseQuery(queryInput, presetSel, kindSel);
        await loadOmniDirs();
        await this._refresh();
      },
    }, [
      el('option', { value: '(all)' }, ['(all packs)']),
    ]);
    const omniCatSel = el('select', {
      value: st.omniCategory,
      onchange: async (e) => {
        st.omniCategory = String(e.target.value || 'any');
        try { localStorage.setItem('devtools.assets.omniCategory', st.omniCategory); } catch { /* ignore */ }
        this._applyOmniverseQuery(queryInput, presetSel, kindSel);
        await this._refresh();
      },
    }, [
      el('option', { value: 'any' }, ['Any']),
      el('option', { value: 'characters' }, ['Characters (folder heuristic)']),
      el('option', { value: 'models' }, ['Models (USD/FBX/GLB)']),
      el('option', { value: 'motions' }, ['Motions / Animations (folder heuristic)']),
      el('option', { value: 'images' }, ['Images']),
      el('option', { value: 'materials' }, ['Materials (MDL/USD)']),
      el('option', { value: 'extensions' }, ['Extensions']),
    ]);

    const kindSel = el('select', {
      value: st.kind,
      onchange: async (e) => {
        st.kind = String(e.target.value || 'images');
        await this._refresh();
      },
    }, [
      el('option', { value: 'images' }, ['Images']),
      el('option', { value: 'models' }, ['Models (GLB/GLTF/USD/FBX)']),
      el('option', { value: 'videos' }, ['Videos']),
      el('option', { value: 'motion' }, ['Motion (BVH/FBX/USD)']),
      el('option', { value: 'maps' }, ['Maps (JSON)']),
      el('option', { value: 'any' }, ['Any']),
    ]);

    const sortSel = el('select', {
      value: st.sort,
      onchange: async (e) => {
        st.sort = String(e.target.value || 'recent');
        await this._refresh();
      },
    }, [
      el('option', { value: 'recent' }, ['Recent (mtime)']),
      el('option', { value: 'path' }, ['Path (A→Z)']),
      el('option', { value: 'size' }, ['Size (largest)']),
    ]);

    const queryInput = el('input', {
      value: st.query,
      placeholder: 'substring match (empty = all assets)',
      oninput: (e) => {
        st.query = safeTrim(e.target.value);
        st.preset = 'custom';
        presetSel.value = 'custom';
      },
    });
    // Omniverse folder browser (uses server-side directory listing to adapt to pack layouts).
    const omniPathInput = el('input', {
      value: String(st.omniPath || ''),
      placeholder: 'subdir within pack (e.g. Assets/Characters/)',
      oninput: (e) => {
        st.omniPath = safeTrim(e.target.value).replace(/\\/g, '/');
        try { localStorage.setItem('devtools.assets.omniPath', st.omniPath); } catch { /* ignore */ }
        this._applyOmniverseQuery(queryInput, presetSel, kindSel);
      },
    });
    const omniDirsSel = el('select', { value: '' }, [
      el('option', { value: '' }, ['(browse folders)']),
    ]);
    const omniDirsStatus = el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-wrap' } }, ['']);

    const loadOmniDirs = async () => {
      try {
        const pack = String(st.omniPack || '(all)').trim();
        if (!pack || pack === '(all)') {
          omniDirsStatus.textContent = 'Select a pack to browse folders.';
          clear(omniDirsSel);
          omniDirsSel.appendChild(el('option', { value: '' }, ['(browse folders)']));
          return;
        }
        const pth = String(st.omniPath || '').trim();
        omniDirsStatus.textContent = 'Loading folders...';
        clear(omniDirsSel);
        omniDirsSel.appendChild(el('option', { value: '' }, ['(loading...)']));
        const url = `/__devtools_omniverse_ls?pack=${encodeURIComponent(pack)}&path=${encodeURIComponent(pth)}`;
        const resp = await fetch(url);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'ls failed'));
        const dirs = Array.isArray(j?.dirs) ? j.dirs : [];
        clear(omniDirsSel);
        omniDirsSel.appendChild(el('option', { value: '' }, ['(browse folders)']));
        for (const d of dirs) {
          const name = safeTrim(d?.name);
          if (!name) continue;
          omniDirsSel.appendChild(el('option', { value: name }, [name]));
        }
        omniDirsStatus.textContent = j.absExists ? `Folders: ${dirs.length}` : '(path not found)';
      } catch (e) {
        omniDirsStatus.textContent = `Folder browse failed: ${e?.message || e}`;
        clear(omniDirsSel);
        omniDirsSel.appendChild(el('option', { value: '' }, ['(browse folders)']));
      }
    };

    const omniUpBtn = el('button', {
      onclick: async () => {
        const cur = String(st.omniPath || '').replace(/\\/g, '/');
        const parts = cur.split('/').filter(Boolean);
        parts.pop();
        st.omniPath = parts.length ? (parts.join('/') + '/') : '';
        omniPathInput.value = st.omniPath;
        try { localStorage.setItem('devtools.assets.omniPath', st.omniPath); } catch { /* ignore */ }
        this._applyOmniverseQuery(queryInput, presetSel, kindSel);
        await loadOmniDirs();
        await this._refresh();
      },
      title: 'Go up one folder within the selected pack',
    }, ['Up']);

    const omniRefreshDirsBtn = el('button', {
      onclick: async () => { await loadOmniDirs(); },
      title: 'Refresh folder list for current pack/path',
    }, ['Folders']);

    omniDirsSel.onchange = async (e) => {
      const v = safeTrim(e.target.value);
      if (!v) return;
      const cur = String(st.omniPath || '').trim().replace(/\\/g, '/');
      st.omniPath = (cur + v + '/').replace(/\/{2,}/g, '/');
      omniPathInput.value = st.omniPath;
      try { localStorage.setItem('devtools.assets.omniPath', st.omniPath); } catch { /* ignore */ }
      this._applyOmniverseQuery(queryInput, presetSel, kindSel);
      await loadOmniDirs();
      await this._refresh();
    };


    queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._refresh(); });

    const limitInput = el('input', {
      value: String(st.limit),
      placeholder: 'limit',
      oninput: (e) => { st.limit = Math.max(20, Math.min(2000, Number(e.target.value) || 350)); },
    });

    const refreshBtn = el('button', { class: 'primary', onclick: async () => this._refresh() }, ['Refresh']);
    const clearSelBtn = el('button', {
      onclick: () => {
        this._selected = '';
        this._syncPreview();
      },
      title: 'Clear preview selection',
    }, ['Clear']);

    const omniRow = el('div', {
      class: 'row',
      style: { marginTop: '8px', display: (st.preset === 'omniverse') ? 'flex' : 'none' },
    }, [
      el('div', {}, [el('div', { class: 'muted' }, ['pack']), omniPackSel]),
      el('div', {}, [el('div', { class: 'muted' }, ['omniverse filter']), omniCatSel]),
    ]);

    const omniBrowseRow = el('div', {
      class: 'row',
      style: { marginTop: '8px', gap: '8px', alignItems: 'center', display: (st.preset === 'omniverse') ? 'flex' : 'none', flexWrap: 'wrap' },
    }, [
      el('div', { style: { minWidth: '220px', flex: '1 1 320px' } }, [el('div', { class: 'muted' }, ['pack folder path']), omniPathInput]),
      omniUpBtn,
      omniRefreshDirsBtn,
      el('div', { style: { minWidth: '220px', flex: '0 0 260px' } }, [el('div', { class: 'muted' }, ['subfolders']), omniDirsSel]),
    ]);

    this._statusEl = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);

    this._previewEl = el('div', { style: { marginTop: '10px' } }, []);
    this._listEl = el('div', { class: 'scrollArea', style: { height: '320px', marginTop: '10px' } }, ['(loading...)']);
    this._favoritesEl = el('div', { style: { marginTop: '10px' } }, []);

    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Asset browser']),
      el('div', { class: 'muted' }, [
        'Searches under `assets/` via the local Vite endpoint ',
        el('span', { class: 'kbd' }, ['/__editor_assets_index']),
        '.',
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['preset']), presetSel]),
        el('div', {}, [el('div', { class: 'muted' }, ['kind']), kindSel]),
      ]),
      omniRow,
      omniBrowseRow,
      omniDirsStatus,
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['sort']), sortSel]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['query']), queryInput]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['limit']), limitInput]),
        refreshBtn,
        clearSelBtn,
      ]),
      this._statusEl,
      this._favoritesEl,
    ]));

    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Preview']),
      this._previewEl,
    ]));

    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Results']),
      this._listEl,
    ]));

    this._syncFavoritesUi();

    // Restore Omniverse selectors (if any), and populate pack list.
    try { st.omniPack = String(localStorage.getItem('devtools.assets.omniPack') || st.omniPack); } catch { /* ignore */ }
    try { st.omniCategory = String(localStorage.getItem('devtools.assets.omniCategory') || st.omniCategory); } catch { /* ignore */ }
    try { st.omniPath = String(localStorage.getItem('devtools.assets.omniPath') || st.omniPath); } catch { /* ignore */ }
    try { omniPackSel.value = st.omniPack; } catch { /* ignore */ }
    try { omniCatSel.value = st.omniCategory; } catch { /* ignore */ }
    try { omniPathInput.value = st.omniPath; } catch { /* ignore */ }
    try { omniRow.style.display = (st.preset === 'omniverse') ? 'flex' : 'none'; } catch { /* ignore */ }
    try { omniBrowseRow.style.display = (st.preset === 'omniverse') ? 'flex' : 'none'; } catch { /* ignore */ }
    if (st.preset === 'omniverse') this._applyOmniverseQuery(queryInput, presetSel, kindSel);
    if (st.preset === 'omniverse') void loadOmniDirs();

    // Populate pack list lazily; safe even if omniverse isn't installed.
    void (async () => {
      try {
        const resp = await fetch('/__devtools_omniverse_packs');
        const j = await resp.json();
        if (!j?.ok) return;
        const packs = Array.isArray(j?.packs) ? j.packs : [];
        // Keep first option "(all)" and replace the rest.
        const keep0 = omniPackSel.firstChild;
        while (omniPackSel.childNodes.length > 1) omniPackSel.removeChild(omniPackSel.lastChild);
        for (const p of packs) {
          const name = safeTrim(p?.name);
          if (!name) continue;
          omniPackSel.appendChild(el('option', { value: name }, [name]));
        }
        omniPackSel.value = st.omniPack;
      } catch { /* ignore */ }
    })();
  }

  async _refresh() {
    const ctx = this._ctx;
    if (!ctx || !this._listEl) return;

    const st = this._state;
    const q = String(st.query || '').trim();
    const ext = this._kindToExtCsv(String(st.kind || 'images'));
    const sort = String(st.sort || 'recent');
    const limit = Math.max(20, Math.min(2000, Number(st.limit) || 350));

    this._items = [];
    this._selected = '';
    this._syncPreview();

    this._listEl.textContent = 'Loading...';
    if (this._statusEl) this._statusEl.textContent = `query: ${q || '(empty)'}\next: ${ext || '(any)'}`;

    try {
      const items = await ctx.assetIndex({ query: q, ext });
      this._items = Array.isArray(items) ? items : [];
    } catch (e) {
      this._listEl.textContent = `(error) ${e?.message || e}`;
      return;
    }

    if (!this._items.length) {
      this._listEl.textContent = '(no matches)';
      return;
    }

    // Sort (best-effort: mtimeMs is optional for backward compatibility).
    try {
      if (sort === 'path') {
        this._items.sort((a, b) => String(a?.path || '').localeCompare(String(b?.path || '')));
      } else if (sort === 'size') {
        this._items.sort((a, b) => (Number(b?.bytes) || 0) - (Number(a?.bytes) || 0));
      } else {
        this._items.sort((a, b) => (Number(b?.mtimeMs) || 0) - (Number(a?.mtimeMs) || 0));
      }
    } catch { /* ignore */ }

    clear(this._listEl);
    const show = this._items.slice(0, limit);
    for (const it of show) {
      const p = String(it?.path || '');
      if (!p) continue;
      const bytes = Number(it?.bytes) || 0;
      const mtimeMs = Number(it?.mtimeMs) || 0;
      const extp = extOf(p);
      const isMap = extp === '.json' && p.startsWith('tools/rigging/mappings/');

      const btn = el('button', {
        class: 'toolBtn',
        style: { marginTop: '6px' },
        onclick: () => {
          this._selected = p;
          this._syncPreview();
        },
        title: `${bytes} bytes${mtimeMs ? `\n${fmtTime(mtimeMs)}` : ''}`,
      }, [`${p} (${bytesToMiB(bytes)} MiB${mtimeMs ? ` • ${fmtTime(mtimeMs)}` : ''})`]);

      // Quick actions
      const actions = el('div', { class: 'row', style: { gap: '8px', marginTop: '6px' } }, [
        el('button', {
          title: this._favorites.includes(p) ? 'Unfavorite' : 'Favorite',
          onclick: () => this._toggleFavorite(p),
        }, [this._favorites.includes(p) ? '★' : '☆']),
        el('button', {
          onclick: async () => {
            try { await navigator.clipboard.writeText(p); ctx?.log?.(`Assets: copied path ${p}`); } catch { /* ignore */ }
          },
          title: 'Copy relative path',
        }, ['Copy']),
        ...(isMap ? [el('button', {
          class: 'primary',
          title: 'Use as retarget map (opens Animation tool)',
          onclick: () => {
            try { localStorage.setItem('devtools.lastAnimMapUrl', p); } catch { /* ignore */ }
            try { globalThis.__devtools?.setActiveTool?.('animation'); } catch { /* ignore */ }
            ctx?.log?.(`Assets: use as map → ${p}`);
          },
        }, ['Use map'])] : []),
        ...(isMotionExt(extp) ? [el('button', {
          class: 'primary',
          title: 'Use as motionPath (opens Animation tool)',
          onclick: () => {
            try { localStorage.setItem('devtools.lastMotionUrl', p); } catch { /* ignore */ }
            try { globalThis.__devtools?.setActiveTool?.('animation'); } catch { /* ignore */ }
            ctx?.log?.(`Assets: use as motion → ${p}`);
          },
        }, ['Use motion'])] : []),
        ...(isModelSourceExt(extp) ? [el('button', {
          class: 'primary',
          title: 'Open in Model tool (supports Convert → GLB for USD/FBX)',
          onclick: () => {
            // Model tool already syncs from lastGeneratedModelUrl on mount; re-use it as a "last opened model" channel.
            try { localStorage.setItem('devtools.lastGeneratedModelUrl', p); } catch { /* ignore */ }
            try { globalThis.__devtools?.setActiveTool?.('model'); } catch { /* ignore */ }
            ctx?.log?.(`Assets: open in Model tool → ${p}`);
          },
        }, ['Open in Model'])] : []),
        ...(isModelSourceExt(extp) ? [el('button', {
          class: 'primary',
          title: 'Convert USD/FBX to GLB, then open in Model Viewer',
          onclick: () => this._convertAndView(p),
        }, ['Convert → GLB'])] : []),
        ...((isModelSourceExt(extp) || isModelExt(extp)) ? [el('button', {
          class: 'primary',
          title: 'Render a turntable MP4 preview (USD/FBX will auto-convert to GLB first)',
          onclick: () => {
            try { localStorage.setItem('devtools.lastGeneratedModelUrl', p); } catch { /* ignore */ }
            try { globalThis.__devtools?.setActiveTool?.('turntable'); } catch { /* ignore */ }
            ctx?.log?.(`Assets: send to Turntable → ${p}`);
          },
        }, ['Turntable'])] : []),
        ...(isModelExt(extp) ? [el('button', {
          class: 'primary',
          onclick: () => {
            try { localStorage.setItem('devtools.lastGeneratedModelUrl', p); } catch { /* ignore */ }
            try { globalThis.__devtools?.setActiveTool?.('model_viewer'); } catch { /* ignore */ }
            ctx?.log?.(`Assets: send to Model Viewer → ${p}`);
          },
        }, ['Open model'])] : []),
        ...(isImageExt(extp) ? [el('button', {
          class: 'primary',
          onclick: () => {
            try { localStorage.setItem('devtools.texture.path', p); } catch { /* ignore */ }
            try { globalThis.__devtools?.setActiveTool?.('texture'); } catch { /* ignore */ }
            ctx?.log?.(`Assets: send to Textures → ${p}`);
          },
        }, ['Open image'])] : []),
        ...(isVideoExt(extp) ? [el('button', {
          class: 'primary',
          onclick: () => {
            this._selected = p;
            this._syncPreview();
          },
        }, ['Preview'])] : []),
      ]);

      const row = el('div', { style: { marginTop: '8px' } }, [btn, actions]);
      this._listEl.appendChild(row);
    }

    if (this._statusEl) this._statusEl.textContent = `matches: ${this._items.length}\nshowing: ${show.length}\nquery: ${q || '(empty)'}\next: ${ext || '(any)'}`;
  }

  async _convertAndView(inPath) {
    const ctx = this._ctx;
    const host = this._previewEl;
    if (!host) return;
    clear(host);

    const statusEl = el('div', { class: 'muted', style: { whiteSpace: 'pre-wrap' } }, [`Converting ${inPath} → GLB...`]);
    const logEl = el('div', { class: 'scrollArea', style: { height: '180px', marginTop: '8px', whiteSpace: 'pre' } }, ['(starting...)']);
    host.appendChild(statusEl);
    host.appendChild(logEl);

    // Preflight: block meshless USDs (often motion-only stages) when converting for viewing.
    // Best-effort only: if inspection isn't available, continue with conversion.
    try {
      const ext = extOf(inPath);
      if (isUsdExt(ext)) {
        statusEl.textContent = `Preflight USD (mesh check): ${inPath}`;
        const ir = await fetch('/__devtools_usd_inspect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runner: 'blender_5', inputPath: inPath }),
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
              statusEl.textContent = [
                'Convert blocked: USD has no Mesh prims (meshCount=0) and no SkelAnimation prims (skelAnim=0).',
                `skelRootCount=${skelRoot}`,
                'Pick a character/body USD that includes geometry.',
              ].join('\n');
              logEl.textContent = '(blocked before conversion)';
              ctx?.log?.(`Assets: convert blocked (meshCount=0, skelAnim=0): ${inPath}`);
              return;
            }

            // Motion-only USD is a valid conversion target (armature + actions). The viewer may show no mesh.
            statusEl.textContent = [
              'USD is motion-only (meshCount=0) but contains SkelAnimation prims.',
              `skelRootCount=${skelRoot}  skelAnimationCount=${skelAnim}`,
              'Converting anyway (output GLB will be armature + animation clips).',
            ].join('\n');
          }
        }
      }
    } catch (e) {
      ctx?.log?.(`Assets: USD preflight skipped: ${e?.message || e}`);
    }

    let jobId = '';
    let outGlb = '';
    try {
      const resp = await fetch('/__devtools_convert_start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runner: 'conda_trellis',
          inPath,
          blenderPath: '',
          exportFormat: 'GLB',
          outName: '',
          splitMeshes: false,
        }),
      });
      const j = await resp.json();
      if (!j?.ok) throw new Error(String(j?.error || 'convert start failed'));
      jobId = String(j.id || '');
      outGlb = String(j.outGlb || '');
      statusEl.textContent = `Convert job started (${jobId})...`;
    } catch (e) {
      statusEl.textContent = `Convert failed to start: ${e?.message || e}`;
      return;
    }

    // Poll until done.
    let backoff = 400;
    while (true) {
      await new Promise((r) => setTimeout(r, backoff));
      try {
        const resp = await fetch(`/__devtools_convert_job?id=${encodeURIComponent(jobId)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));
        const status = String(j.status || '');
        const stdout = String(j.stdout || '');
        const stderr = String(j.stderr || '');
        outGlb = String(j.outGlb || outGlb || '');

        statusEl.textContent = `Convert: ${status}` + (outGlb ? `\nOutput: ${outGlb}` : '');
        logEl.textContent = (stderr ? (stdout + '\n--- stderr ---\n' + stderr) : stdout) || '(no output yet)';
        try { logEl.scrollTop = logEl.scrollHeight; } catch { /* ignore */ }

        if (status === 'done' || status === 'error' || status === 'killed') {
          if (status === 'done' && outGlb) {
            statusEl.textContent = `Convert done → ${outGlb}`;
            ctx?.log?.(`Assets: convert done → ${outGlb}`);
            // Auto-open in Model Viewer.
            const openBtn = el('button', {
              class: 'primary',
              style: { marginTop: '8px' },
              onclick: () => {
                try { localStorage.setItem('devtools.lastGeneratedModelUrl', outGlb); } catch { /* ignore */ }
                try { globalThis.__devtools?.setActiveTool?.('model_viewer'); } catch { /* ignore */ }
                ctx?.log?.(`Assets: open converted GLB in Model Viewer → ${outGlb}`);
              },
            }, ['Open in Model Viewer']);
            host.appendChild(openBtn);
          } else {
            statusEl.textContent = `Convert ${status}` + (outGlb ? `\nOutput: ${outGlb}` : '');
          }
          return;
        }
        backoff = 500;
      } catch (e) {
        statusEl.textContent = `Convert poll error: ${e?.message || e}`;
        return;
      }
    }
  }

  _syncPreview() {
    const ctx = this._ctx;
    const host = this._previewEl;
    if (!host) return;
    clear(host);

    const p = String(this._selected || '');
    if (!p) {
      host.appendChild(el('div', { class: 'muted' }, ['Select an asset from the list to preview.']));
      return;
    }
    this._rememberRecent(p);

    const e = extOf(p);
    host.appendChild(el('div', { class: 'muted', style: { whiteSpace: 'pre-wrap' } }, [`${p}`]));

    if (isImageExt(e)) {
      host.appendChild(el('img', {
        src: `${p}?t=${Date.now()}`,
        alt: p,
        style: {
          width: '100%',
          maxHeight: '240px',
          objectFit: 'contain',
          borderRadius: '10px',
          border: '1px solid rgba(255,255,255,0.14)',
          background: 'rgba(0,0,0,0.25)',
          marginTop: '8px',
        },
      }));
    } else if (isVideoExt(e)) {
      host.appendChild(el('video', {
        src: p,
        controls: true,
        style: {
          width: '100%',
          maxHeight: '240px',
          borderRadius: '10px',
          border: '1px solid rgba(255,255,255,0.14)',
          background: 'rgba(0,0,0,0.25)',
          marginTop: '8px',
        },
      }));
    } else if (isModelExt(e)) {
      host.appendChild(el('div', { class: 'muted', style: { marginTop: '8px' } }, [
        'This is a model file. Use ',
        el('span', { class: 'kbd' }, ['Open model']),
        ' to send it to the Model Viewer.',
      ]));
    } else if (isTextPreviewExt(e)) {
      const pre = el('div', { class: 'scrollArea', style: { height: '240px', marginTop: '8px', whiteSpace: 'pre' } }, ['Loading text preview...']);
      host.appendChild(pre);
      void (async () => {
        try {
          const resp = await fetch(`${p}?t=${Date.now()}`);
          const txt = await resp.text();
          const lines = String(txt || '').split(/\r?\n/);
          const head = lines.slice(0, 240).join('\n');
          pre.textContent = head + (lines.length > 240 ? `\n\n... (${lines.length - 240} more lines)` : '');
        } catch (err) {
          pre.textContent = `(preview error) ${err?.message || err}`;
        }
      })();
    } else if (isUsdBinaryExt(e)) {
      const status = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, [
        'Binary USD file. Use Inspect to see a stage summary + unresolved references.',
      ]);
      const out = el('div', { class: 'scrollArea', style: { height: '240px', marginTop: '8px', whiteSpace: 'pre' } }, ['(not inspected yet)']);
      const inspectBtn = el('button', {
        class: 'primary',
        onclick: async () => {
          try {
            inspectBtn.disabled = true;
          } catch { /* ignore */ }
          try {
            status.textContent = 'Inspecting USD...';
            out.textContent = '(running...)';
            const resp = await fetch('/__devtools_usd_inspect', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ runner: 'blender_5', inputPath: p }),
            });
            const j = await resp.json();
            if (!j?.ok) throw new Error(String(j?.error || 'inspect failed'));
            if (j?.json?.ok) {
              const summary = j.json;
              const missing = Array.isArray(summary?.missingFiles) ? summary.missingFiles : [];
              const stats = summary?.stats || {};
              status.textContent = [
                `USD: ok`,
                `meshCount: ${Number(stats.meshCount) || 0}`,
                `materialCount: ${Number(stats.materialCount) || 0}`,
                `skelRootCount: ${Number(stats.skelRootCount) || 0}`,
                `skelAnimationCount: ${Number(stats.skelAnimationCount) || 0}`,
                `missingFiles: ${missing.length}`,
              ].join('\n');
              out.textContent = JSON.stringify(summary, null, 2);
            } else {
              status.textContent = `USD: inspect finished (exit ${j.exitCode ?? 'n/a'})`;
              out.textContent = (j.stderr ? (String(j.stdout || '') + '\n--- stderr ---\n' + String(j.stderr || '')) : String(j.stdout || '')) || '(no output)';
            }
          } catch (err) {
            status.textContent = `Inspect failed: ${err?.message || err}`;
            out.textContent = String(err?.stack || err?.message || err || '(unknown error)');
          }
          try {
            inspectBtn.disabled = false;
          } catch { /* ignore */ }
        },
      }, ['Inspect USD']);
      host.appendChild(el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, [
        inspectBtn,
        status,
      ]));
      host.appendChild(out);
    } else {
      host.appendChild(el('div', { class: 'muted', style: { marginTop: '8px' } }, ['No inline preview for this file type.']));
    }

    ctx?.log?.(`Assets: selected ${p}`);
  }
}

