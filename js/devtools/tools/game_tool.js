import { el, clear } from '../../ui/dom.js';

function safeTrim(v) {
  return String(v ?? '').trim();
}

function slugify(v) {
  const s = safeTrim(v).toLowerCase();
  return s.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'game';
}

function parseLines(text) {
  const src = String(text || '').replace(/\r/g, '');
  const out = [];
  const seen = new Set();
  for (const raw of src.split('\n')) {
    const line = safeTrim(raw);
    if (!line) continue;
    if (line.startsWith('#')) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

function toInt(v, fallback = 0, min = 0, max = 1_000_000) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function asBool(v, fallback = false) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = safeTrim(v).toLowerCase();
  if (!s) return fallback;
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return fallback;
}

function downloadTextFile(fileName, text, mime = 'text/plain') {
  const blob = new Blob([String(text || '')], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = safeTrim(fileName) || 'download.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }, 0);
  }
}

function parseCode2WorldsLastResult() {
  try {
    const raw = localStorage.getItem('devtools.code2worlds.lastResult');
    if (!raw) return null;
    const j = JSON.parse(raw);
    return (j && typeof j === 'object') ? j : null;
  } catch {
    return null;
  }
}

function parseJsonObjectLoose(text, fallback = {}) {
  const src = safeTrim(text);
  if (!src) return { ...(fallback || {}) };
  try {
    const parsed = JSON.parse(src);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* ignore */ }
  return { ...(fallback || {}) };
}

function parseJsonObjectDetailed(text, fallback = {}) {
  const src = safeTrim(text);
  if (!src) return { value: { ...(fallback || {}) }, error: '' };
  try {
    const parsed = JSON.parse(src);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { value: parsed, error: '' };
    }
    return { value: { ...(fallback || {}) }, error: 'JSON must be an object (not array/primitive).' };
  } catch (e) {
    return { value: { ...(fallback || {}) }, error: String(e?.message || e || 'Invalid JSON') };
  }
}

function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class GameTool {
  constructor() {
    this.id = 'game';
    this.label = 'Game';
    this._ctx = null;
    this._root = null;
    this._statusEl = null;
    this._characterChoicesStatusEl = null;
    this._characterChoices = [];
    this._viewerRoot = null;

    this._state = {
      gameName: 'My Game',
      gameSlug: 'my-game',
      version: '0.1.0',
      description: 'A packaged game build made from Scene + Character + Asset workflows.',

      // Start flow
      showStartMenu: true,
      menuTitle: 'Press Start',
      menuSubtitle: 'Choose your character and begin.',
      enableCharacterSelection: true,
      defaultCharacterId: 'hero',
      characterChoicesText: 'hero|Hero|assets/characters/hero/character_manifest.json',
      autoStartAfterSelection: true,

      // Loading
      showLoadingScreen: true,
      loadingTitle: 'Loading world...',
      loadingSubtitle: 'Preparing scene and assets',
      loadingBackgroundPath: '',
      loadingLogoPath: '',
      loadingTipsText: 'Use WASD to move.\nPress E to interact.',
      minLoadingMs: 1200,

      // Play content
      sceneSourceUrl: '',
      fallbackSceneSourceUrl: 'proc:arena',
      preloadAssetsText: '',

      // Runtime wiring
      sceneToolImportPath: './js/devtools/tools/scene_tool.js',
      gameLogicImportPath: '',
      gameLogicExportName: 'createGameLogic',
      gameLogicConfigJson: '{}',
      persistStateKey: 'game.save.default',
      autoSaveEnabled: true,
      autoSaveIntervalMs: 15000,

      // Export
      configRelDir: 'assets/games/',
      configNameHint: 'my-game',
      launcherFileName: 'game_launcher.html',
      configUrlForLauncher: './assets/games/my-game.json',
      packageManifestName: 'my-game.manifest.json',
    };
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;
    try {
      const raw = localStorage.getItem('devtools.game.state');
      if (raw) {
        const j = JSON.parse(raw);
        if (j && typeof j === 'object') Object.assign(this._state, j);
      }
    } catch { /* ignore */ }
    if (!safeTrim(this._state.gameSlug)) this._state.gameSlug = slugify(this._state.gameName);
    if (!safeTrim(this._state.configNameHint)) this._state.configNameHint = this._state.gameSlug;
    if (!safeTrim(this._state.configUrlForLauncher)) this._state.configUrlForLauncher = `./assets/games/${this._state.gameSlug}.json`;
    this._consumeSceneToolInbox({ onlyMissing: true });
    this._buildUi();
    void this._refreshCharacterChoices();
    this._renderMainViewer();
  }

  async unmount() {
    this._clearMainViewerPreview({ quiet: true });
    this._ctx = null;
    this._root = null;
    this._statusEl = null;
    this._characterChoicesStatusEl = null;
  }

  tick() {}

  getStats() {
    const cfg = this._buildConfig();
    return {
      scene: safeTrim(cfg?.content?.sceneSource || ''),
      assets: Array.isArray(cfg?.content?.preloadAssets) ? cfg.content.preloadAssets.length : 0,
      chars: Array.isArray(cfg?.start?.characterOptions) ? cfg.start.characterOptions.length : 0,
      logic: safeTrim(cfg?.logic?.importPath || '') ? 'custom' : 'none',
    };
  }

  _persistState() {
    try { localStorage.setItem('devtools.game.state', JSON.stringify(this._state)); } catch { /* ignore */ }
    try { this._renderMainViewer(); } catch { /* ignore */ }
  }

  _setStatus(text) {
    if (this._statusEl) this._statusEl.textContent = safeTrim(text);
  }

  _readSceneSourceFromLocalStorage() {
    const keys = [
      'devtools.scene.sourceUrl',
      'devtools.scene.lastGlbUrl',
      'devtools.lastGeneratedModelUrl',
    ];
    for (const k of keys) {
      try {
        const v = safeTrim(localStorage.getItem(k) || '');
        if (v) return v;
      } catch { /* ignore */ }
    }
    return '';
  }

  _clearMainViewerPreview({ quiet = false } = {}) {
    const host = this._ctx?.canvasHost;
    if (host) clear(host);
    this._viewerRoot = null;
    if (!quiet) this._setStatus('Cleared Game preview from main viewer.');
  }

  _renderMainViewer() {
    const host = this._ctx?.canvasHost;
    if (!host) return;
    clear(host);
    const cfg = this._buildConfig();
    const v = this._validateConfig(cfg);
    const chars = Array.isArray(cfg?.start?.characterOptions) ? cfg.start.characterOptions.length : 0;
    const preload = Array.isArray(cfg?.content?.preloadAssets) ? cfg.content.preloadAssets.length : 0;
    const scenePrimary = safeTrim(cfg?.content?.sceneSource || '');
    const sceneFallback = safeTrim(cfg?.content?.fallbackSceneSource || '');
    const logicPath = safeTrim(cfg?.logic?.importPath || '');

    const root = document.createElement('div');
    root.style.position = 'absolute';
    root.style.inset = '0';
    root.style.overflow = 'auto';
    root.style.padding = '18px';
    root.style.background = 'radial-gradient(circle at 20% 0%, rgba(51,95,180,0.2), rgba(7,11,18,0.97))';
    root.style.color = '#dce8ff';
    root.style.fontFamily = 'Inter, system-ui, sans-serif';
    root.innerHTML = `
      <div style="max-width:980px;margin:0 auto;">
        <div style="font-size:20px;font-weight:700;margin-bottom:6px;">Game Packaging Workspace</div>
        <div style="opacity:0.85;font-size:13px;margin-bottom:14px;">Main viewer is dedicated to packaging flow preview (menu, loading, logic wiring, scenes, and export assets).</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-bottom:12px;">
          <div style="padding:10px;border:1px solid rgba(180,210,255,0.2);border-radius:10px;background:rgba(0,0,0,0.32);"><div style="font-size:11px;opacity:.8;">Game</div><div style="font-size:15px;font-weight:700;">${escapeHtml(cfg?.game?.name || 'Game')}</div><div style="font-size:11px;opacity:.8;">${escapeHtml(cfg?.game?.id || '')} · v${escapeHtml(cfg?.game?.version || '')}</div></div>
          <div style="padding:10px;border:1px solid rgba(180,210,255,0.2);border-radius:10px;background:rgba(0,0,0,0.32);"><div style="font-size:11px;opacity:.8;">Startup</div><div style="font-size:15px;font-weight:700;">${cfg?.start?.showMenu ? 'Menu Enabled' : 'Auto Start'}</div><div style="font-size:11px;opacity:.8;">Characters: ${chars}</div></div>
          <div style="padding:10px;border:1px solid rgba(180,210,255,0.2);border-radius:10px;background:rgba(0,0,0,0.32);"><div style="font-size:11px;opacity:.8;">Loading</div><div style="font-size:15px;font-weight:700;">${cfg?.loading?.enabled ? 'Enabled' : 'Disabled'}</div><div style="font-size:11px;opacity:.8;">Min ${Number(cfg?.loading?.minMs || 0)}ms · Preload ${preload}</div></div>
          <div style="padding:10px;border:1px solid rgba(180,210,255,0.2);border-radius:10px;background:rgba(0,0,0,0.32);"><div style="font-size:11px;opacity:.8;">Logic</div><div style="font-size:15px;font-weight:700;">${logicPath ? 'Custom Module' : 'None'}</div><div style="font-size:11px;opacity:.8;">${escapeHtml(logicPath || 'No logic module set')}</div></div>
        </div>
        <div style="padding:12px;border:1px solid rgba(180,210,255,0.2);border-radius:10px;background:rgba(0,0,0,0.32);margin-bottom:12px;">
          <div style="font-weight:700;font-size:13px;margin-bottom:6px;">Packaging flow preview</div>
          <div style="font-size:12px;line-height:1.5;opacity:.9;">1) Start/menu: <b>${cfg?.start?.showMenu ? 'show menu' : 'skip menu'}</b> ${cfg?.start?.enableCharacterSelection ? 'with character selection.' : 'without character selection.'}</div>
          <div style="font-size:12px;line-height:1.5;opacity:.9;">2) Loading: <b>${cfg?.loading?.enabled ? 'show loading overlay' : 'no loading overlay'}</b> and preload <b>${preload}</b> assets.</div>
          <div style="font-size:12px;line-height:1.5;opacity:.9;">3) Scene: primary <code>${escapeHtml(scenePrimary || '(empty)')}</code>${sceneFallback ? `, fallback <code>${escapeHtml(sceneFallback)}</code>` : ''}.</div>
          <div style="font-size:12px;line-height:1.5;opacity:.9;">4) Runtime: SceneTool <code>${escapeHtml(cfg?.runtime?.sceneToolImportPath || '')}</code>${logicPath ? ` + logic <code>${escapeHtml(logicPath)}</code>` : ''}.</div>
          <div style="font-size:12px;line-height:1.5;opacity:.9;">5) Export: config <code>${escapeHtml(this._state.configUrlForLauncher || '')}</code>, launcher <code>${escapeHtml(this._state.launcherFileName || '')}</code>.</div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:10px;">
          <div style="padding:10px;border:1px solid rgba(180,210,255,0.2);border-radius:10px;background:rgba(0,0,0,0.32);">
            <div style="font-weight:700;font-size:12px;margin-bottom:6px;">Validation</div>
            <div style="font-size:12px;color:${v.errors.length ? '#ff9a9a' : '#aee2b1'};">${v.errors.length ? escapeHtml(v.errors.join(' | ')) : 'No blocking errors.'}</div>
            <div style="font-size:12px;color:#ffd89c;margin-top:6px;">${v.warnings.length ? escapeHtml(v.warnings.join(' | ')) : 'No warnings.'}</div>
          </div>
          <div style="padding:10px;border:1px solid rgba(180,210,255,0.2);border-radius:10px;background:rgba(0,0,0,0.32);">
            <div style="font-weight:700;font-size:12px;margin-bottom:6px;">Package intent</div>
            <div style="font-size:12px;opacity:.9;">Use the right-side controls to finalize menu/loading/runtime config, then export config + launcher + manifest as your full game package.</div>
          </div>
        </div>
      </div>
    `;
    host.appendChild(root);
    this._viewerRoot = root;
  }

  _refreshMainViewerPreview({ reason = 'manual' } = {}) {
    this._renderMainViewer();
    if (reason !== 'mount') this._setStatus('Updated Game packaging viewer.');
  }

  _syncDerivedExportDefaults() {
    const st = this._state;
    const slug = slugify(st.gameSlug || st.gameName || 'game');
    st.gameSlug = slug;
    if (!safeTrim(st.configNameHint)) st.configNameHint = slug;
    const cfgName = `${slug}.json`;
    if (!safeTrim(st.configUrlForLauncher) || /assets\/games\/.+\.json$/i.test(st.configUrlForLauncher)) {
      st.configUrlForLauncher = `./assets/games/${cfgName}`;
    }
    if (!safeTrim(st.launcherFileName)) st.launcherFileName = `${slug}_launcher.html`;
    if (!safeTrim(st.packageManifestName)) st.packageManifestName = `${slug}.manifest.json`;
  }

  _validateConfig(config) {
    const errors = [];
    const warnings = [];
    const cfg = (config && typeof config === 'object') ? config : this._buildConfig();
    const sceneSource = safeTrim(cfg?.content?.sceneSource || '');
    const fallback = safeTrim(cfg?.content?.fallbackSceneSource || '');
    if (!sceneSource && !fallback) {
      errors.push('Missing scene source: set Primary scene source or Fallback scene source.');
    }
    if (cfg?.start?.enableCharacterSelection && !Array.isArray(cfg?.start?.characterOptions)) {
      errors.push('Character selection enabled but character options are invalid.');
    }
    if (cfg?.start?.enableCharacterSelection && Array.isArray(cfg?.start?.characterOptions) && cfg.start.characterOptions.length === 0) {
      warnings.push('Character selection is enabled but no character options are configured.');
    }
    const logicImport = safeTrim(cfg?.logic?.importPath || '');
    const logicExport = safeTrim(cfg?.logic?.exportName || '');
    if (logicImport && !logicExport) {
      errors.push('Game logic export name is required when Game logic import path is set.');
    }
    const saveMs = toInt(cfg?.logic?.autoSaveIntervalMs, 0, 0, 3_600_000);
    if (cfg?.logic?.autoSaveEnabled && saveMs < 1000) {
      warnings.push('Auto-save interval is very low; recommended >= 1000 ms.');
    }
    const logicCfgJson = parseJsonObjectDetailed(this._state?.gameLogicConfigJson || '{}', {});
    if (logicCfgJson.error) {
      errors.push(`Game logic config JSON is invalid: ${logicCfgJson.error}`);
    }
    const sceneToolPath = safeTrim(cfg?.runtime?.sceneToolImportPath || '');
    if (!sceneToolPath) errors.push('SceneTool import path is required.');
    const launcherName = safeTrim(cfg?.packaging?.launcherFileName || this._state?.launcherFileName || '');
    if (!launcherName) errors.push('Launcher file name is required.');
    const relDir = safeTrim(cfg?.packaging?.configRelDir || this._state?.configRelDir || '');
    if (relDir && !relDir.startsWith('assets/')) warnings.push('Config rel dir should usually stay under assets/.');
    return { errors, warnings };
  }

  _buildPackageManifest(config = null) {
    const cfg = (config && typeof config === 'object') ? config : this._buildConfig();
    const st = this._state;
    const files = [];
    const add = (role, path, required = true) => {
      const v = safeTrim(path);
      if (!v) return;
      files.push({ role, path: v, required: !!required });
    };
    add('config', safeTrim(st.configUrlForLauncher).replace(/^\.\//, ''), true);
    add('launcher', safeTrim(st.launcherFileName), true);
    add('scene.primary', safeTrim(cfg?.content?.sceneSource || ''), false);
    add('scene.fallback', safeTrim(cfg?.content?.fallbackSceneSource || ''), false);
    for (const p of (Array.isArray(cfg?.content?.preloadAssets) ? cfg.content.preloadAssets : [])) add('asset.preload', p, false);
    add('loading.background', safeTrim(cfg?.loading?.backgroundPath || ''), false);
    add('loading.logo', safeTrim(cfg?.loading?.logoPath || ''), false);
    add('runtime.sceneTool', safeTrim(cfg?.runtime?.sceneToolImportPath || ''), true);
    add('logic.module', safeTrim(cfg?.logic?.importPath || ''), false);
    for (const c of (Array.isArray(cfg?.start?.characterOptions) ? cfg.start.characterOptions : [])) {
      add(`character.${safeTrim(c?.id || 'item')}`, safeTrim(c?.manifestPath || ''), false);
    }
    return {
      schema: 1,
      kind: 'game_package_manifest',
      gameId: safeTrim(cfg?.game?.id || slugify(st.gameSlug || st.gameName)),
      generatedAt: new Date().toISOString(),
      files,
    };
  }

  _parseCharacterChoices() {
    const out = [];
    const lines = parseLines(this._state.characterChoicesText);
    for (const line of lines) {
      const parts = line.split('|').map((p) => safeTrim(p));
      const id = parts[0] || '';
      if (!id) continue;
      out.push({
        id,
        label: parts[1] || id,
        manifestPath: parts[2] || '',
      });
    }
    return out;
  }

  _readSceneToolInbox() {
    try {
      const raw = safeTrim(localStorage.getItem('devtools.game.inboxJson') || '');
      if (!raw) return null;
      const j = JSON.parse(raw);
      if (!j || typeof j !== 'object') return null;
      if (safeTrim(j?.kind) !== 'scene_to_game_handoff') return null;
      return j;
    } catch {
      return null;
    }
  }

  _clearSceneToolInbox() {
    try { localStorage.removeItem('devtools.game.inboxJson'); } catch { /* ignore */ }
    try { localStorage.removeItem('devtools.game.inboxAt'); } catch { /* ignore */ }
  }

  _upsertPathLines(existingText, incomingList) {
    const cur = parseLines(existingText);
    const set = new Set(cur);
    for (const p of (Array.isArray(incomingList) ? incomingList : [])) {
      const v = safeTrim(p).replace(/\\/g, '/');
      if (!v) continue;
      if (set.has(v)) continue;
      set.add(v);
      cur.push(v);
    }
    return cur.join('\n');
  }

  _applySceneToolHandoff(payload, { onlyMissing = true } = {}) {
    const p = payload && typeof payload === 'object' ? payload : null;
    if (!p) return { changed: 0 };
    const st = this._state;
    const scene = (p.scene && typeof p.scene === 'object') ? p.scene : {};
    const loading = (p.loading && typeof p.loading === 'object') ? p.loading : {};
    const start = (p.start && typeof p.start === 'object') ? p.start : {};
    const runtime = (p.runtime && typeof p.runtime === 'object') ? p.runtime : {};

    let changed = 0;
    const setField = (key, next, { emptyCheck = null } = {}) => {
      const prev = st[key];
      const isEmpty = (typeof emptyCheck === 'function')
        ? !!emptyCheck(prev)
        : (typeof prev === 'string' ? !safeTrim(prev) : prev == null);
      if (onlyMissing && !isEmpty) return;
      if (prev === next) return;
      st[key] = next;
      changed++;
    };

    setField('sceneSourceUrl', safeTrim(scene.sourceUrl || ''), { emptyCheck: (v) => !safeTrim(v) });
    setField('fallbackSceneSourceUrl', safeTrim(scene.fallbackSourceUrl || 'proc:arena'), { emptyCheck: (v) => !safeTrim(v) });
    const mergedPreload = this._upsertPathLines(st.preloadAssetsText, scene.preloadAssets);
    if (mergedPreload !== st.preloadAssetsText) {
      st.preloadAssetsText = mergedPreload;
      changed++;
    }

    if (!onlyMissing) setField('showStartMenu', asBool(start.showMenu, true), { emptyCheck: () => true });
    setField('menuTitle', safeTrim(start.menuTitle || ''), { emptyCheck: (v) => !safeTrim(v) });
    setField('menuSubtitle', safeTrim(start.menuSubtitle || ''), { emptyCheck: (v) => !safeTrim(v) });

    if (!onlyMissing) setField('showLoadingScreen', asBool(loading.enabled, true), { emptyCheck: () => true });
    setField('loadingTitle', safeTrim(loading.title || ''), { emptyCheck: (v) => !safeTrim(v) });
    setField('loadingSubtitle', safeTrim(loading.subtitle || ''), { emptyCheck: (v) => !safeTrim(v) });
    setField('minLoadingMs', toInt(loading.minMs, 1200, 0, 60_000), { emptyCheck: (v) => !Number.isFinite(Number(v)) });

    const tips = Array.isArray(loading.tips) ? loading.tips : [];
    if (tips.length) {
      const mergedTips = this._upsertPathLines(st.loadingTipsText, tips);
      if (mergedTips !== st.loadingTipsText) {
        st.loadingTipsText = mergedTips;
        changed++;
      }
    }

    setField('sceneToolImportPath', safeTrim(runtime.sceneToolImportPath || ''), { emptyCheck: (v) => !safeTrim(v) });

    // Best-effort export defaults derived from scene handoff if empty.
    if (!safeTrim(st.gameName)) {
      st.gameName = safeTrim(scene.scenarioName || '') || 'My Game';
      changed++;
    }
    if (!safeTrim(st.gameSlug)) {
      st.gameSlug = slugify(st.gameName);
      changed++;
    }
    this._syncDerivedExportDefaults();
    return { changed };
  }

  _consumeSceneToolInbox({ onlyMissing = true } = {}) {
    const inbox = this._readSceneToolInbox();
    if (!inbox) return { changed: 0, consumed: false };
    const out = this._applySceneToolHandoff(inbox, { onlyMissing: !!onlyMissing });
    this._clearSceneToolInbox();
    if (out.changed > 0) this._persistState();
    return { changed: out.changed, consumed: true };
  }

  _buildConfig() {
    this._syncDerivedExportDefaults();
    const st = this._state;
    const characterOptions = this._parseCharacterChoices();
    const preloadAssets = parseLines(st.preloadAssetsText);
    const loadingTips = parseLines(st.loadingTipsText);
    const logicConfig = parseJsonObjectDetailed(st.gameLogicConfigJson, {}).value;
    return {
      schema: 1,
      kind: 'game_build_config',
      game: {
        id: slugify(st.gameSlug || st.gameName),
        name: safeTrim(st.gameName),
        version: safeTrim(st.version || '0.1.0'),
        description: safeTrim(st.description),
      },
      start: {
        showMenu: !!st.showStartMenu,
        menuTitle: safeTrim(st.menuTitle),
        menuSubtitle: safeTrim(st.menuSubtitle),
        enableCharacterSelection: !!st.enableCharacterSelection,
        defaultCharacterId: safeTrim(st.defaultCharacterId),
        autoStartAfterSelection: !!st.autoStartAfterSelection,
        characterOptions,
      },
      loading: {
        enabled: !!st.showLoadingScreen,
        title: safeTrim(st.loadingTitle),
        subtitle: safeTrim(st.loadingSubtitle),
        backgroundPath: safeTrim(st.loadingBackgroundPath),
        logoPath: safeTrim(st.loadingLogoPath),
        tips: loadingTips,
        minMs: toInt(st.minLoadingMs, 1200, 0, 60_000),
      },
      content: {
        sceneSource: safeTrim(st.sceneSourceUrl),
        fallbackSceneSource: safeTrim(st.fallbackSceneSourceUrl),
        preloadAssets,
      },
      runtime: {
        sceneToolImportPath: safeTrim(st.sceneToolImportPath || './js/devtools/tools/scene_tool.js'),
      },
      logic: {
        importPath: safeTrim(st.gameLogicImportPath),
        exportName: safeTrim(st.gameLogicExportName || 'createGameLogic'),
        config: logicConfig,
        persistStateKey: safeTrim(st.persistStateKey || `game.save.${slugify(st.gameSlug || st.gameName)}`),
        autoSaveEnabled: !!st.autoSaveEnabled,
        autoSaveIntervalMs: toInt(st.autoSaveIntervalMs, 15000, 250, 3_600_000),
      },
      packaging: {
        configRelDir: safeTrim(st.configRelDir || 'assets/games/'),
        configNameHint: safeTrim(st.configNameHint || st.gameSlug || 'game'),
        launcherFileName: safeTrim(st.launcherFileName || `${slugify(st.gameSlug || st.gameName)}_launcher.html`),
        packageManifestName: safeTrim(st.packageManifestName || `${slugify(st.gameSlug || st.gameName)}.manifest.json`),
      },
    };
  }

  _launcherHtml(configUrl) {
    const cfgUrl = safeTrim(configUrl) || './assets/games/game.json';
    const title = safeTrim(this._state.gameName) || 'Game';
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    html, body { margin: 0; height: 100%; background: #080b12; color: #d7e0f2; overflow: hidden; font-family: Inter, system-ui, sans-serif; }
    #canvasHost { position: fixed; inset: 0; }
    #uiRoot { position: fixed; inset: 0; z-index: 5; pointer-events: none; }
    #toolUi { display: none; }
    .overlay { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; background: radial-gradient(circle at 50% 30%, rgba(45,77,134,0.2), rgba(1,3,7,0.92)); pointer-events: auto; }
    .panel { width: min(640px, calc(100vw - 32px)); border: 1px solid rgba(173, 198, 255, 0.2); border-radius: 16px; padding: 18px; background: rgba(0,0,0,0.45); backdrop-filter: blur(12px); }
    .title { font-size: 24px; font-weight: 700; margin: 0 0 8px; }
    .muted { color: rgba(211,224,255,0.78); font-size: 13px; line-height: 1.35; }
    .row { display: flex; gap: 10px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
    .btn { appearance: none; border: 1px solid rgba(173,198,255,0.35); border-radius: 10px; padding: 10px 14px; color: #e9f1ff; background: linear-gradient(180deg, rgba(54,95,170,0.68), rgba(31,61,120,0.85)); font-weight: 700; cursor: pointer; }
    .btn:disabled { opacity: 0.6; cursor: default; }
    select { background: rgba(12, 17, 28, 0.9); color: #e8efff; border: 1px solid rgba(173,198,255,0.35); border-radius: 8px; padding: 8px 10px; min-width: 260px; }
    #loadingText { margin-top: 10px; font-size: 13px; color: rgba(226,236,255,0.88); }
    #loadingBar { margin-top: 10px; height: 8px; border-radius: 999px; background: rgba(255,255,255,0.09); overflow: hidden; }
    #loadingFill { height: 100%; width: 0%; background: linear-gradient(90deg, #4f8cff, #76b0ff); transition: width 180ms ease; }
    #loadingLogo { width: min(220px, 65%); max-height: 120px; object-fit: contain; margin-bottom: 12px; display: none; }
    #loadingTips { margin-top: 10px; font-size: 12px; color: rgba(226,236,255,0.82); min-height: 20px; }
  </style>
</head>
<body>
  <div id="canvasHost"></div>
  <div id="uiRoot"><div id="toolUi"></div></div>

  <div class="overlay" id="startOverlay">
    <div class="panel">
      <div class="title" id="startTitle">Start</div>
      <div class="muted" id="startSubtitle"></div>
      <div class="row" id="characterRow" style="display:none;">
        <label for="characterSel" class="muted">Character</label>
        <select id="characterSel"></select>
      </div>
      <div class="row"><button class="btn" id="startBtn">Start Game</button></div>
    </div>
  </div>

  <div class="overlay" id="loadingOverlay" style="display:none;">
    <div class="panel" id="loadingPanel">
      <img id="loadingLogo" alt="Loading logo" />
      <div class="title" id="loadingTitle">Loading...</div>
      <div class="muted" id="loadingSubtitle"></div>
      <div id="loadingText">Starting...</div>
      <div id="loadingBar"><div id="loadingFill"></div></div>
      <div id="loadingTips"></div>
    </div>
  </div>

  <script type="module">
    const CONFIG_URL = ${JSON.stringify(cfgUrl)};
    const canvasHost = document.getElementById('canvasHost');
    const uiHost = document.getElementById('uiRoot');
    const toolUi = document.getElementById('toolUi');
    const startOverlay = document.getElementById('startOverlay');
    const loadingOverlay = document.getElementById('loadingOverlay');
    const startTitle = document.getElementById('startTitle');
    const startSubtitle = document.getElementById('startSubtitle');
    const loadingTitle = document.getElementById('loadingTitle');
    const loadingSubtitle = document.getElementById('loadingSubtitle');
    const loadingText = document.getElementById('loadingText');
    const loadingFill = document.getElementById('loadingFill');
    const loadingPanel = document.getElementById('loadingPanel');
    const loadingLogo = document.getElementById('loadingLogo');
    const loadingTips = document.getElementById('loadingTips');
    const startBtn = document.getElementById('startBtn');
    const characterRow = document.getElementById('characterRow');
    const characterSel = document.getElementById('characterSel');
    let tool = null;
    let logicRuntime = null;
    let autoSaveTimer = 0;
    let raf = 0;

    function setLoadingProgress(cur, total, text) {
      const c = Number(cur) || 0;
      const t = Math.max(1, Number(total) || 1);
      const p = Math.max(0, Math.min(100, Math.round((c / t) * 100)));
      loadingFill.style.width = p + '%';
      if (text) loadingText.textContent = text;
    }

    async function loadConfig() {
      const url = new URL(location.href);
      const qp = String(url.searchParams.get('config') || '').trim();
      const target = qp || CONFIG_URL;
      const resp = await fetch(target, { cache: 'no-store' });
      if (!resp.ok) throw new Error('Failed loading config: ' + resp.status);
      return await resp.json();
    }

    async function preloadAssets(paths) {
      const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
      if (!list.length) return;
      let i = 0;
      for (const p of list) {
        i++;
        setLoadingProgress(i - 0.3, list.length, 'Preloading: ' + p);
        try { await fetch(p, { cache: 'force-cache' }); } catch {}
        setLoadingProgress(i, list.length, 'Preloading: ' + p);
      }
    }

    async function mountSceneTool(cfg) {
      const source = String(cfg?.content?.sceneSource || cfg?.content?.fallbackSceneSource || 'proc:arena').trim();
      const importPath = String(cfg?.runtime?.sceneToolImportPath || './js/devtools/tools/scene_tool.js').trim();
      const mod = await import(importPath);
      const SceneTool = mod?.SceneTool;
      if (!SceneTool) throw new Error('SceneTool import failed at ' + importPath);
      tool = new SceneTool();
      const ctx = {
        canvasHost,
        uiRoot: toolUi,
        log: (m) => { try { console.log('[game]', m); } catch {} },
        toast: (m) => { try { console.log('[game toast]', m); } catch {} },
        assetIndex: async () => [],
      };
      await tool.mount(ctx);
      if (source) {
        try {
          tool._state = tool._state || {};
          tool._state.sourceUrl = source;
          if (source.startsWith('proc:')) await tool._loadProcedural(source);
          else await tool._loadGlb(source);
        } catch (e) {
          console.warn('Scene source load warning:', e);
        }
      }
      let last = performance.now() * 0.001;
      const frame = () => {
        const t = performance.now() * 0.001;
        const dt = Math.max(0, Math.min(0.25, t - last));
        last = t;
        try { tool.tick(dt); } catch (e) { console.error(e); }
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    }

    async function initGameLogic(cfg) {
      const logicCfg = cfg?.logic || {};
      const importPath = String(logicCfg?.importPath || '').trim();
      const exportName = String(logicCfg?.exportName || 'createGameLogic').trim() || 'createGameLogic';
      if (!importPath) return null;
      const mod = await import(importPath);
      const factory = mod?.[exportName] || mod?.default;
      if (typeof factory !== 'function') {
        throw new Error('Game logic export not found: ' + exportName + ' in ' + importPath);
      }
      const runtime = await factory({
        config: cfg,
        sceneTool: tool,
        canvasHost,
        uiRoot: uiHost,
        selectedCharacterId: String(characterSel?.value || localStorage.getItem('game.selectedCharacterId') || '').trim(),
      });
      return runtime || null;
    }

    function startAutoSave(cfg) {
      try { if (autoSaveTimer) clearInterval(autoSaveTimer); } catch {}
      autoSaveTimer = 0;
      const logicCfg = cfg?.logic || {};
      if (!logicCfg?.autoSaveEnabled) return;
      const saveKey = String(logicCfg?.persistStateKey || 'game.save.default').trim() || 'game.save.default';
      const everyMs = Math.max(250, Number(logicCfg?.autoSaveIntervalMs || 15000));
      autoSaveTimer = window.setInterval(async () => {
        try {
          const state = await logicRuntime?.serializeState?.();
          if (state && typeof state === 'object') localStorage.setItem(saveKey, JSON.stringify(state));
        } catch {}
      }, everyMs);
    }

    async function startGame(cfg) {
      const loadingCfg = cfg?.loading || {};
      const loadingEnabled = loadingCfg?.enabled !== false;
      const minMs = Math.max(0, Number(loadingCfg?.minMs || 0));
      const t0 = performance.now();
      loadingOverlay.style.display = loadingEnabled ? '' : 'none';
      loadingPanel.style.backgroundImage = '';
      loadingPanel.style.backgroundSize = '';
      loadingPanel.style.backgroundPosition = '';
      loadingTitle.textContent = String(loadingCfg?.title || 'Loading...');
      loadingSubtitle.textContent = String(loadingCfg?.subtitle || '');
      const bg = String(loadingCfg?.backgroundPath || '').trim();
      if (bg && loadingEnabled) {
        loadingPanel.style.backgroundImage = 'linear-gradient(rgba(1,4,10,0.75), rgba(1,4,10,0.82)), url("' + bg.replace(/"/g, '%22') + '")';
        loadingPanel.style.backgroundSize = 'cover';
        loadingPanel.style.backgroundPosition = 'center';
      }
      const logo = String(loadingCfg?.logoPath || '').trim();
      if (logo && loadingEnabled) {
        loadingLogo.src = logo;
        loadingLogo.style.display = 'block';
      } else {
        loadingLogo.removeAttribute('src');
        loadingLogo.style.display = 'none';
      }
      const tips = Array.isArray(loadingCfg?.tips) ? loadingCfg.tips.filter(Boolean) : [];
      let tipIdx = 0;
      let tipTimer = 0;
      if (tips.length && loadingEnabled) {
        loadingTips.textContent = tips[0];
        tipTimer = window.setInterval(() => {
          tipIdx = (tipIdx + 1) % tips.length;
          loadingTips.textContent = tips[tipIdx];
        }, 1800);
      } else {
        loadingTips.textContent = '';
      }
      setLoadingProgress(0, 1, 'Starting...');

      const preload = Array.isArray(cfg?.content?.preloadAssets) ? cfg.content.preloadAssets : [];
      try {
        await Promise.all([
          mountSceneTool(cfg),
          preloadAssets(preload),
        ]);
        try {
          logicRuntime = await initGameLogic(cfg);
          await logicRuntime?.onGameStarted?.({
            config: cfg,
            sceneTool: tool,
            selectedCharacterId: String(characterSel?.value || '').trim(),
          });
          startAutoSave(cfg);
        } catch (logicErr) {
          console.warn('Game logic init warning:', logicErr);
          loadingText.textContent = 'Game logic warning: ' + String(logicErr?.message || logicErr);
        }
        const elapsed = performance.now() - t0;
        if (elapsed < minMs) await new Promise((r) => setTimeout(r, minMs - elapsed));
      } finally {
        if (tipTimer) clearInterval(tipTimer);
      }
      if (loadingEnabled) loadingOverlay.style.display = 'none';
    }

    window.addEventListener('beforeunload', () => {
      try { if (autoSaveTimer) clearInterval(autoSaveTimer); } catch {}
      autoSaveTimer = 0;
      try { if (raf) cancelAnimationFrame(raf); } catch {}
      try { logicRuntime?.dispose?.(); } catch {}
      try { tool?.unmount?.(); } catch {}
    });

    try {
      const cfg = await loadConfig();
      const startCfg = cfg?.start || {};
      const chars = Array.isArray(startCfg?.characterOptions) ? startCfg.characterOptions : [];
      startTitle.textContent = String(startCfg?.menuTitle || cfg?.game?.name || 'Start');
      startSubtitle.textContent = String(startCfg?.menuSubtitle || '');
      loadingTitle.textContent = String(cfg?.loading?.title || 'Loading...');
      loadingSubtitle.textContent = String(cfg?.loading?.subtitle || '');

      if (chars.length && startCfg?.enableCharacterSelection) {
        characterRow.style.display = '';
        for (const c of chars) {
          const opt = document.createElement('option');
          opt.value = String(c?.id || '');
          opt.textContent = String(c?.label || c?.id || 'character');
          characterSel.appendChild(opt);
        }
        const def = String(startCfg?.defaultCharacterId || '').trim();
        if (def) characterSel.value = def;
      }

      const autoStart = !startCfg?.showMenu;
      let started = false;
      const onStart = async () => {
        if (started) return;
        started = true;
        startBtn.disabled = true;
        try {
          const chosen = String(characterSel?.value || '').trim();
          if (chosen) localStorage.setItem('game.selectedCharacterId', chosen);
        } catch {}
        startOverlay.style.display = 'none';
        await startGame(cfg);
      };
      startBtn.addEventListener('click', () => { void onStart(); });
      if (startCfg?.enableCharacterSelection && startCfg?.autoStartAfterSelection) {
        characterSel.addEventListener('change', () => { void onStart(); });
      }

      if (autoStart) {
        startOverlay.style.display = 'none';
        await startGame(cfg);
      }
    } catch (err) {
      console.error(err);
      startOverlay.style.display = '';
      startTitle.textContent = 'Could not start game';
      startSubtitle.textContent = String(err?.message || err || 'Unknown error');
      startBtn.disabled = true;
    }
  </script>
</body>
</html>
`;
  }

  async _refreshCharacterChoices() {
    try {
      const resp = await fetch('/__devtools_character_manifests');
      const j = await resp.json().catch(() => null);
      const arr = Array.isArray(j?.items) ? j.items : [];
      const out = [];
      for (const v of arr) {
        const p = safeTrim(v);
        if (!p.endsWith('/character_manifest.json')) continue;
        const seg = p.split('/').filter(Boolean);
        const id = safeTrim(seg[seg.length - 2] || 'character');
        out.push({ id: slugify(id), label: id, manifestPath: p });
      }
      this._characterChoices = out;
      if (this._characterChoicesStatusEl) {
        this._characterChoicesStatusEl.textContent = out.length
          ? `Found ${out.length} character manifest(s).`
          : 'No character manifests found.';
      }
    } catch (e) {
      if (this._characterChoicesStatusEl) this._characterChoicesStatusEl.textContent = `Character scan failed: ${e?.message || e}`;
    }
  }

  _buildUi() {
    if (!this._root) return;
    clear(this._root);
    const st = this._state;
    this._syncDerivedExportDefaults();

    const gameName = el('input', {
      value: st.gameName,
      oninput: (e) => {
        st.gameName = safeTrim(e.target.value);
        if (!safeTrim(st.gameSlug) || st.gameSlug === slugify(st.configNameHint || '')) st.gameSlug = slugify(st.gameName);
        st.configNameHint = st.gameSlug;
        st.configUrlForLauncher = `./assets/games/${st.gameSlug}.json`;
        this._persistState();
      },
    });
    const gameSlug = el('input', {
      value: st.gameSlug,
      oninput: (e) => { st.gameSlug = slugify(e.target.value); st.configNameHint = st.gameSlug; st.configUrlForLauncher = `./assets/games/${st.gameSlug}.json`; this._persistState(); },
    });
    const version = el('input', {
      value: st.version,
      oninput: (e) => { st.version = safeTrim(e.target.value); this._persistState(); },
    });
    const description = el('textarea', {
      rows: 2,
      value: st.description,
      oninput: (e) => { st.description = String(e.target.value || ''); this._persistState(); },
    });

    const showStartMenu = el('input', {
      type: 'checkbox',
      checked: !!st.showStartMenu,
      onchange: (e) => { st.showStartMenu = !!e.target.checked; this._persistState(); },
    });
    const menuTitle = el('input', {
      value: st.menuTitle,
      oninput: (e) => { st.menuTitle = String(e.target.value || ''); this._persistState(); },
    });
    const menuSubtitle = el('input', {
      value: st.menuSubtitle,
      oninput: (e) => { st.menuSubtitle = String(e.target.value || ''); this._persistState(); },
    });
    const enableCharacterSelection = el('input', {
      type: 'checkbox',
      checked: !!st.enableCharacterSelection,
      onchange: (e) => { st.enableCharacterSelection = !!e.target.checked; this._persistState(); },
    });
    const defaultCharacterId = el('input', {
      value: st.defaultCharacterId,
      oninput: (e) => { st.defaultCharacterId = safeTrim(e.target.value); this._persistState(); },
      placeholder: 'hero',
    });
    const autoStartAfterSelection = el('input', {
      type: 'checkbox',
      checked: !!st.autoStartAfterSelection,
      onchange: (e) => { st.autoStartAfterSelection = !!e.target.checked; this._persistState(); },
    });
    const characterChoicesText = el('textarea', {
      rows: 5,
      value: st.characterChoicesText,
      placeholder: 'id|Label|assets/characters/<id>/character_manifest.json',
      oninput: (e) => { st.characterChoicesText = String(e.target.value || ''); this._persistState(); },
    });
    const pullCharacterChoicesBtn = el('button', {
      onclick: async () => {
        await this._refreshCharacterChoices();
        if (this._characterChoices.length) {
          st.characterChoicesText = this._characterChoices
            .map((c) => `${c.id}|${c.label}|${c.manifestPath}`)
            .join('\n');
          this._persistState();
          characterChoicesText.value = st.characterChoicesText;
          this._setStatus(`Loaded ${this._characterChoices.length} character choice row(s).`);
        } else {
          this._setStatus('No character manifests found to import.');
        }
      },
    }, ['Load choices from Character assets']);

    const showLoadingScreen = el('input', {
      type: 'checkbox',
      checked: !!st.showLoadingScreen,
      onchange: (e) => { st.showLoadingScreen = !!e.target.checked; this._persistState(); },
    });
    const loadingTitle = el('input', {
      value: st.loadingTitle,
      oninput: (e) => { st.loadingTitle = String(e.target.value || ''); this._persistState(); },
    });
    const loadingSubtitle = el('input', {
      value: st.loadingSubtitle,
      oninput: (e) => { st.loadingSubtitle = String(e.target.value || ''); this._persistState(); },
    });
    const loadingBackgroundPath = el('input', {
      value: st.loadingBackgroundPath,
      placeholder: 'assets/.../background.png',
      oninput: (e) => { st.loadingBackgroundPath = safeTrim(e.target.value); this._persistState(); },
    });
    const loadingLogoPath = el('input', {
      value: st.loadingLogoPath,
      placeholder: 'assets/.../logo.png',
      oninput: (e) => { st.loadingLogoPath = safeTrim(e.target.value); this._persistState(); },
    });
    const minLoadingMs = el('input', {
      type: 'number',
      value: String(toInt(st.minLoadingMs, 1200, 0, 60_000)),
      oninput: (e) => { st.minLoadingMs = toInt(e.target.value, 1200, 0, 60_000); this._persistState(); },
    });
    const loadingTipsText = el('textarea', {
      rows: 3,
      value: st.loadingTipsText,
      placeholder: 'One tip per line',
      oninput: (e) => { st.loadingTipsText = String(e.target.value || ''); this._persistState(); },
    });

    const sceneSourceUrl = el('input', {
      value: st.sceneSourceUrl,
      placeholder: 'proc:arena or assets/.../scene.glb',
      oninput: (e) => { st.sceneSourceUrl = safeTrim(e.target.value); this._persistState(); },
    });
    const fallbackSceneSourceUrl = el('input', {
      value: st.fallbackSceneSourceUrl,
      placeholder: 'proc:arena',
      oninput: (e) => { st.fallbackSceneSourceUrl = safeTrim(e.target.value); this._persistState(); },
    });
    const preloadAssetsText = el('textarea', {
      rows: 4,
      value: st.preloadAssetsText,
      placeholder: 'assets/...\noutputs/...',
      oninput: (e) => { st.preloadAssetsText = String(e.target.value || ''); this._persistState(); },
    });
    const useSceneToolBtn = el('button', {
      onclick: () => {
        const src = this._readSceneSourceFromLocalStorage();
        if (!src) {
          this._setStatus('No Scene Tool source found yet.');
          return;
        }
        st.sceneSourceUrl = src;
        sceneSourceUrl.value = src;
        this._persistState();
        this._setStatus(`Scene source set from Scene Tool: ${src}`);
        void this._refreshMainViewerPreview({ reason: 'scene-tool', force: true });
      },
    }, ['Use Scene Tool source']);
    const useCode2WorldsBtn = el('button', {
      onclick: () => {
        const j = parseCode2WorldsLastResult();
        const src = safeTrim(j?.sceneSourceUrl || '');
        if (!src) {
          this._setStatus('No Code2Worlds result found.');
          return;
        }
        st.sceneSourceUrl = src;
        sceneSourceUrl.value = src;
        this._persistState();
        this._setStatus(`Scene source set from Code2Worlds: ${src}`);
        void this._refreshMainViewerPreview({ reason: 'code2worlds', force: true });
      },
    }, ['Use Code2Worlds scene']);
    const importSceneHandoffBtn = el('button', {
      onclick: () => {
        const out = this._consumeSceneToolInbox({ onlyMissing: true });
        if (!out.consumed) {
          this._setStatus('No Scene Tool handoff payload found.');
          return;
        }
        this._persistState();
        sceneSourceUrl.value = st.sceneSourceUrl;
        fallbackSceneSourceUrl.value = st.fallbackSceneSourceUrl;
        preloadAssetsText.value = st.preloadAssetsText;
        this._setStatus(out.changed > 0
          ? `Imported Scene Tool handoff (${out.changed} fields updated).`
          : 'Imported Scene Tool handoff (no missing fields to fill).');
        void this._refreshMainViewerPreview({ reason: 'handoff', force: true });
      },
    }, ['Import Scene handoff']);
    const refreshPreviewBtn = el('button', {
      onclick: () => { void this._refreshMainViewerPreview({ reason: 'manual', force: true }); },
    }, ['Refresh game viewer']);
    const clearPreviewBtn = el('button', {
      onclick: () => { void this._clearMainViewerPreview(); },
    }, ['Clear game viewer']);

    const sceneToolImportPath = el('input', {
      value: st.sceneToolImportPath,
      oninput: (e) => { st.sceneToolImportPath = safeTrim(e.target.value) || './js/devtools/tools/scene_tool.js'; this._persistState(); },
    });
    const gameLogicImportPath = el('input', {
      value: st.gameLogicImportPath,
      placeholder: './js/game/logic.js',
      oninput: (e) => { st.gameLogicImportPath = safeTrim(e.target.value); this._persistState(); },
    });
    const gameLogicExportName = el('input', {
      value: st.gameLogicExportName,
      placeholder: 'createGameLogic',
      oninput: (e) => { st.gameLogicExportName = safeTrim(e.target.value) || 'createGameLogic'; this._persistState(); },
    });
    const gameLogicConfigJson = el('textarea', {
      rows: 5,
      value: st.gameLogicConfigJson,
      placeholder: '{\n  "difficulty": "normal"\n}',
      oninput: (e) => { st.gameLogicConfigJson = String(e.target.value || ''); this._persistState(); },
    });
    const persistStateKey = el('input', {
      value: st.persistStateKey,
      placeholder: 'game.save.my-game',
      oninput: (e) => { st.persistStateKey = safeTrim(e.target.value); this._persistState(); },
    });
    const autoSaveEnabled = el('input', {
      type: 'checkbox',
      checked: !!st.autoSaveEnabled,
      onchange: (e) => { st.autoSaveEnabled = !!e.target.checked; this._persistState(); },
    });
    const autoSaveIntervalMs = el('input', {
      type: 'number',
      value: String(toInt(st.autoSaveIntervalMs, 15000, 250, 3_600_000)),
      oninput: (e) => { st.autoSaveIntervalMs = toInt(e.target.value, 15000, 250, 3_600_000); this._persistState(); },
    });
    const configRelDir = el('input', {
      value: st.configRelDir,
      oninput: (e) => {
        const v = safeTrim(e.target.value).replace(/\\/g, '/');
        st.configRelDir = v.endsWith('/') ? v : `${v}/`;
        this._persistState();
      },
    });
    const configNameHint = el('input', {
      value: st.configNameHint,
      oninput: (e) => { st.configNameHint = slugify(e.target.value); this._persistState(); },
    });
    const launcherFileName = el('input', {
      value: st.launcherFileName,
      oninput: (e) => { st.launcherFileName = safeTrim(e.target.value) || `${st.gameSlug}_launcher.html`; this._persistState(); },
    });
    const packageManifestName = el('input', {
      value: st.packageManifestName,
      oninput: (e) => { st.packageManifestName = safeTrim(e.target.value) || `${st.gameSlug}.manifest.json`; this._persistState(); },
    });
    const configUrlForLauncher = el('input', {
      value: st.configUrlForLauncher,
      oninput: (e) => { st.configUrlForLauncher = safeTrim(e.target.value); this._persistState(); },
    });

    const getValidation = () => {
      const cfg = this._buildConfig();
      const val = this._validateConfig(cfg);
      return { cfg, val };
    };

    const saveConfigBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try {
          const { cfg: config, val } = getValidation();
          if (val.errors.length) {
            this._setStatus(`Cannot save config: ${val.errors.join(' | ')}`);
            this._ctx?.toast?.('Fix validation errors before saving config.', 'error', { title: 'Game export' });
            return;
          }
          if (val.warnings.length) {
            this._ctx?.toast?.(val.warnings.join(' | '), 'warning', { title: 'Game warnings' });
          }
          const resp = await fetch('/__devtools_write_json_asset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              relDir: safeTrim(st.configRelDir || 'assets/games/'),
              nameHint: safeTrim(st.configNameHint || st.gameSlug || 'game'),
              data: config,
            }),
          });
          const j = await resp.json().catch(() => null);
          if (!j?.ok) throw new Error(String(j?.error || 'write_json_asset failed'));
          st.configUrlForLauncher = `./${safeTrim(j.relPath || '')}`;
          configUrlForLauncher.value = st.configUrlForLauncher;
          this._persistState();
          this._setStatus(`Saved game config: ${j.relPath}`);
          this._ctx?.toast?.(`Saved ${j.relPath}`, 'success', { title: 'Game export' });
        } catch (e) {
          this._setStatus(`Save failed: ${e?.message || e}`);
        }
      },
    }, ['Save config to assets']);
    const saveManifestBtn = el('button', {
      onclick: async () => {
        try {
          const { cfg, val } = getValidation();
          if (val.errors.length) {
            this._setStatus(`Cannot save manifest: ${val.errors.join(' | ')}`);
            return;
          }
          const manifest = this._buildPackageManifest(cfg);
          const nameHint = safeTrim(st.packageManifestName || `${slugify(st.gameSlug || st.gameName)}.manifest.json`).replace(/\.json$/i, '');
          const resp = await fetch('/__devtools_write_json_asset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              relDir: safeTrim(st.configRelDir || 'assets/games/'),
              nameHint,
              data: manifest,
            }),
          });
          const j = await resp.json().catch(() => null);
          if (!j?.ok) throw new Error(String(j?.error || 'write_json_asset failed'));
          this._setStatus(`Saved package manifest: ${j.relPath}`);
          this._ctx?.toast?.(`Saved ${j.relPath}`, 'success', { title: 'Game export' });
        } catch (e) {
          this._setStatus(`Manifest save failed: ${e?.message || e}`);
        }
      },
    }, ['Save manifest to assets']);
    const downloadConfigBtn = el('button', {
      onclick: () => {
        try {
          const { cfg: config, val } = getValidation();
          if (val.errors.length) {
            this._setStatus(`Cannot download config: ${val.errors.join(' | ')}`);
            return;
          }
          const fileName = `${slugify(st.gameSlug || st.gameName)}.json`;
          downloadTextFile(fileName, `${JSON.stringify(config, null, 2)}\n`, 'application/json');
          this._setStatus(`Downloaded config: ${fileName}`);
        } catch (e) {
          this._setStatus(`Config download failed: ${e?.message || e}`);
        }
      },
    }, ['Download config']);
    const downloadManifestBtn = el('button', {
      onclick: () => {
        try {
          const { cfg, val } = getValidation();
          if (val.errors.length) {
            this._setStatus(`Cannot download manifest: ${val.errors.join(' | ')}`);
            return;
          }
          const manifest = this._buildPackageManifest(cfg);
          const fileName = safeTrim(st.packageManifestName) || `${slugify(st.gameSlug || st.gameName)}.manifest.json`;
          downloadTextFile(fileName, `${JSON.stringify(manifest, null, 2)}\n`, 'application/json');
          this._setStatus(`Downloaded manifest: ${fileName}`);
        } catch (e) {
          this._setStatus(`Manifest download failed: ${e?.message || e}`);
        }
      },
    }, ['Download manifest']);
    const downloadLauncherBtn = el('button', {
      onclick: () => {
        try {
          const { val } = getValidation();
          if (val.errors.length) {
            this._setStatus(`Cannot download launcher: ${val.errors.join(' | ')}`);
            return;
          }
          const html = this._launcherHtml(st.configUrlForLauncher);
          const fileName = safeTrim(st.launcherFileName) || `${slugify(st.gameSlug || st.gameName)}_launcher.html`;
          downloadTextFile(fileName, html, 'text/html');
          this._setStatus(`Downloaded launcher: ${fileName}`);
        } catch (e) {
          this._setStatus(`Launcher download failed: ${e?.message || e}`);
        }
      },
    }, ['Download launcher HTML']);
    const validatePackageBtn = el('button', {
      onclick: () => {
        const { val } = getValidation();
        if (!val.errors.length && !val.warnings.length) {
          this._setStatus('Validation passed: no errors or warnings.');
          return;
        }
        const lines = [];
        if (val.errors.length) lines.push(`Errors: ${val.errors.join(' | ')}`);
        if (val.warnings.length) lines.push(`Warnings: ${val.warnings.join(' | ')}`);
        this._setStatus(lines.join('\n'));
      },
    }, ['Validate package']);
    const exportPackageBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try {
          const { cfg: config, val } = getValidation();
          if (val.errors.length) {
            this._setStatus(`Cannot export package: ${val.errors.join(' | ')}`);
            this._ctx?.toast?.('Fix validation errors before exporting package.', 'error', { title: 'Game export' });
            return;
          }
          const manifest = this._buildPackageManifest(config);
          const cfgResp = await fetch('/__devtools_write_json_asset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              relDir: safeTrim(st.configRelDir || 'assets/games/'),
              nameHint: safeTrim(st.configNameHint || st.gameSlug || 'game'),
              data: config,
            }),
          });
          const cfgJ = await cfgResp.json().catch(() => null);
          if (!cfgJ?.ok) throw new Error(String(cfgJ?.error || 'write_json_asset config failed'));
          st.configUrlForLauncher = `./${safeTrim(cfgJ.relPath || '')}`;
          configUrlForLauncher.value = st.configUrlForLauncher;
          const manifestNameHint = safeTrim(st.packageManifestName || `${slugify(st.gameSlug || st.gameName)}.manifest.json`).replace(/\.json$/i, '');
          const manResp = await fetch('/__devtools_write_json_asset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              relDir: safeTrim(st.configRelDir || 'assets/games/'),
              nameHint: manifestNameHint,
              data: manifest,
            }),
          });
          const manJ = await manResp.json().catch(() => null);
          if (!manJ?.ok) throw new Error(String(manJ?.error || 'write_json_asset manifest failed'));
          const launcherName = safeTrim(st.launcherFileName) || `${slugify(st.gameSlug || st.gameName)}_launcher.html`;
          downloadTextFile(launcherName, this._launcherHtml(st.configUrlForLauncher), 'text/html');
          this._persistState();
          this._setStatus(`Exported package set: ${cfgJ.relPath}, ${manJ.relPath}, ${launcherName}`);
          this._ctx?.toast?.('Exported config + manifest + launcher.', 'success', { title: 'Game export' });
        } catch (e) {
          this._setStatus(`Export package failed: ${e?.message || e}`);
        }
      },
    }, ['Export package set']);
    const previewConfigBtn = el('button', {
      onclick: () => {
        const cfg = this._buildConfig();
        if (this._statusEl) this._statusEl.textContent = JSON.stringify(cfg, null, 2);
      },
    }, ['Preview config JSON']);

    this._characterChoicesStatusEl = el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-wrap' } }, ['Character scan not run yet.']);
    this._statusEl = el('div', { class: 'muted', style: { marginTop: '10px', whiteSpace: 'pre-wrap' } }, ['Ready.']);

    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Game']),
      el('div', { class: 'muted' }, [
        'Assemble game startup flow, loading UX, and scene/assets into an exportable game package.',
      ]),

      el('div', { class: 'row', style: { marginTop: '12px', flexWrap: 'wrap' } }, [
        el('div', { style: { flex: '1' } }, [el('div', { class: 'muted' }, ['Game name']), gameName]),
        el('div', { style: { width: '220px' } }, [el('div', { class: 'muted' }, ['Game slug']), gameSlug]),
        el('div', { style: { width: '160px' } }, [el('div', { class: 'muted' }, ['Version']), version]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Description']),
      description,

      el('div', { class: 'dockTitle', style: { marginTop: '14px' } }, ['Start flow']),
      el('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } }, [
        el('label', { class: 'row' }, [showStartMenu, el('span', {}, ['Show start menu'])]),
        el('label', { class: 'row' }, [enableCharacterSelection, el('span', {}, ['Character selection'])]),
        el('label', { class: 'row' }, [autoStartAfterSelection, el('span', {}, ['Auto start after select'])]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Menu title']), menuTitle,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Menu subtitle']), menuSubtitle,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Default character id']), defaultCharacterId,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Character choices (`id|Label|manifestPath`, one per line)']),
      characterChoicesText,
      el('div', { class: 'row', style: { marginTop: '8px' } }, [pullCharacterChoicesBtn]),
      this._characterChoicesStatusEl,

      el('div', { class: 'dockTitle', style: { marginTop: '14px' } }, ['Loading screen']),
      el('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } }, [
        el('label', { class: 'row' }, [showLoadingScreen, el('span', {}, ['Enable loading screen'])]),
        el('div', {}, [el('div', { class: 'muted' }, ['Min loading ms']), minLoadingMs]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Loading title']), loadingTitle,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Loading subtitle']), loadingSubtitle,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Loading background image path']), loadingBackgroundPath,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Loading logo path']), loadingLogoPath,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Tips (one per line)']), loadingTipsText,

      el('div', { class: 'dockTitle', style: { marginTop: '14px' } }, ['Scene and assets']),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Primary scene source (`proc:*` or `.glb/.gltf`)']),
      sceneSourceUrl,
      el('div', { class: 'row', style: { marginTop: '8px' } }, [useSceneToolBtn, useCode2WorldsBtn, importSceneHandoffBtn]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [refreshPreviewBtn, clearPreviewBtn]),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Fallback scene source']), fallbackSceneSourceUrl,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Preload assets (one path per line)']),
      preloadAssetsText,

      el('div', { class: 'dockTitle', style: { marginTop: '14px' } }, ['Runtime and export']),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['SceneTool import path (for launcher HTML)']), sceneToolImportPath,
      el('div', { class: 'dockTitle', style: { marginTop: '12px' } }, ['Game logic']),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Logic import path (optional)']), gameLogicImportPath,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Logic factory export name']), gameLogicExportName,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Logic config JSON object']), gameLogicConfigJson,
      el('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } }, [
        el('label', { class: 'row' }, [autoSaveEnabled, el('span', {}, ['Logic auto-save'])]),
        el('div', {}, [el('div', { class: 'muted' }, ['Auto-save ms']), autoSaveIntervalMs]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Persist state key']), persistStateKey,
      el('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } }, [
        el('div', { style: { flex: '1' } }, [el('div', { class: 'muted' }, ['Config rel dir (assets only)']), configRelDir]),
        el('div', { style: { width: '210px' } }, [el('div', { class: 'muted' }, ['Config name hint']), configNameHint]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Manifest file name']), packageManifestName,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Launcher file name']), launcherFileName,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Launcher config URL']), configUrlForLauncher,
      el('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, [
        validatePackageBtn,
        exportPackageBtn,
        saveConfigBtn,
        saveManifestBtn,
        downloadConfigBtn,
        downloadManifestBtn,
        downloadLauncherBtn,
        previewConfigBtn,
      ]),
      this._statusEl,
    ]));
  }
}

