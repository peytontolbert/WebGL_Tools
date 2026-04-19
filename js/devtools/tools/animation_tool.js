import { el, clear, clamp } from '../../ui/dom.js';

function isNvidiaAnimName(name) {
  const s = String(name || '').trim();
  if (!s) return false;
  const low = s.toLowerCase();
  if (low.startsWith('@nvidia')) return true;
  if (low.startsWith('@nvd')) return true;
  if (low.startsWith('animgraph_nvd_')) return true;
  if (low.includes('animgraph_nvd_')) return true;
  if (low.startsWith('nvd_')) return true;
  if (low.includes('nvidia')) return true;
  return false;
}

function slugifyName(s, { maxLen = 64 } = {}) {
  const raw = String(s || '').trim().replace(/^@+/, '');
  if (!raw) return '';
  const out = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  return out.length > maxLen ? out.slice(0, maxLen) : out;
}

function normClipName(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[-_.:]/g, '');
}

function pickClipByAliases(clips, aliases, { preferNvidia = false } = {}) {
  const arr = Array.isArray(clips) ? clips : [];
  if (!arr.length) return '';
  const byNorm = new Map();
  for (const c of arr) {
    const name = String(c?.name || '').trim();
    if (!name) continue;
    byNorm.set(normClipName(name), name);
  }
  const want = Array.isArray(aliases) ? aliases : [];

  const tryFind = (filterFn) => {
    for (const a of want) {
      const key = normClipName(a);
      const hit = byNorm.get(key);
      if (hit && (!filterFn || filterFn(hit))) return hit;
    }
    // fallback: substring match (helps for verbose AnimGraph names)
    for (const a of want) {
      const key = normClipName(a);
      for (const name of byNorm.values()) {
        const nn = normClipName(name);
        if (nn.includes(key) && (!filterFn || filterFn(name))) return name;
      }
    }
    return '';
  };

  if (preferNvidia) {
    const nvd = tryFind((name) => isNvidiaAnimName(name));
    if (nvd) return nvd;
  }
  return tryFind(null) || '';
}

export class AnimationTool {
  constructor() {
    this.id = 'animation';
    this.label = 'Animation / Retarget';

    this._ctx = null;
    this._root = null;

    this._state = {
      // Inputs
      rigUrl: '',
      motionUrl: '',
      mapUrl: 'tools/rigging/mappings/example_map.json',

      // Inspect/retarget runner settings
      runner: 'conda_trellis', // python3 | conda_trellis
      blenderPath: '',

      // Clip selection + output naming
      motionClip: '',
      clipName: 'walk',
      rootMotion: 0,
      includeMesh: 1,
      exportFormat: 'GLB',
      outName: '',
      jobAutoLoad: 1,

      // Motion clip library UI (for big multi-clip assets like AnimGraph)
      clipLibVendor: 'all', // all | nvidia | other
      clipLibMax: 200,

      // Locomotion pack (batch retarget)
      loco: {
        outName: 'locomotion_pack',
        includeMesh: 1,
        exportFormat: 'GLB',
        // clipKey -> { motionPath, motionClip }
        clips: {
          idle: { motionPath: '', motionClip: '' },
          walk_fwd: { motionPath: '', motionClip: '' },
          walk_back: { motionPath: '', motionClip: '' },
          walk_left: { motionPath: '', motionClip: '' },
          walk_right: { motionPath: '', motionClip: '' },
          run_fwd: { motionPath: '', motionClip: '' },
          run_back: { motionPath: '', motionClip: '' },
          run_left: { motionPath: '', motionClip: '' },
          run_right: { motionPath: '', motionClip: '' },
          jump_start: { motionPath: '', motionClip: '' },
          jump_air: { motionPath: '', motionClip: '' },
          jump_land: { motionPath: '', motionClip: '' },
        },
      },
    };

    this._animJob = { id: '', status: '', stdout: '', stderr: '', outGlb: '' };
    this._pollingAnim = false;

    // Motion-asset clip cache + UI refs
    this._motionClips = [];
    this._uiClipLibFilterEl = null;
    this._uiClipLibListEl = null;
    this._uiClipLibVendorEl = null;
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;

    // Defaults from shared keys.
    try {
      const savedRig = String(localStorage.getItem('devtools.lastGeneratedModelUrl') || '').trim();
      if (savedRig && !String(this._state.rigUrl || '').trim()) this._state.rigUrl = savedRig;
    } catch { /* ignore */ }
    try {
      const savedMotion = String(localStorage.getItem('devtools.lastMotionUrl') || '').trim();
      if (savedMotion && !this._state.motionUrl) this._state.motionUrl = savedMotion;
    } catch { /* ignore */ }
    try {
      const savedMotionClip = String(localStorage.getItem('devtools.lastMotionClip') || '').trim();
      if (savedMotionClip && !this._state.motionClip) this._state.motionClip = savedMotionClip;
    } catch { /* ignore */ }
    try {
      const savedMap = String(localStorage.getItem('devtools.lastAnimMapUrl') || '').trim();
      const defaultMap = 'tools/rigging/mappings/example_map.json';
      if (savedMap && (String(this._state.mapUrl || '').trim() === defaultMap)) this._state.mapUrl = savedMap;
    } catch { /* ignore */ }
    try {
      const p = String(localStorage.getItem('devtools.lastAnimBlenderPath') || '').trim();
      if (p && !this._state.blenderPath) this._state.blenderPath = p;
    } catch { /* ignore */ }

    this._buildUi();

    // Optional: auto-load motion clips and auto-fill locomotion pack from the current motionUrl.
    // This is used by the Omniverse tool / quick workflows.
    try {
      const flag = String(localStorage.getItem('devtools.anim.autoFillLocoFromMotionUrl') || '').trim();
      if (flag) {
        localStorage.removeItem('devtools.anim.autoFillLocoFromMotionUrl');
        // Fire and forget; UI will rebuild when done.
        void this._autoFillLocomotionPackFromMotionUrl({ preferNvidia: true });
      }
    } catch { /* ignore */ }
  }

  async unmount() {
    this._pollingAnim = false;
    this._ctx = null;
    this._root = null;
  }

  tick() {}

  getStats() {
    return {
      rig: this._state.rigUrl || '',
      motion: this._state.motionUrl || '',
      clips: Array.isArray(this._motionClips) ? this._motionClips.length : 0,
      job: this._animJob?.status || '',
    };
  }

  _setMotionClip(name) {
    const st = this._state;
    const n = String(name || '').trim();
    if (!n) return;
    st.motionClip = n;
    try { localStorage.setItem('devtools.lastMotionClip', st.motionClip); } catch { /* ignore */ }

    // NVIDIA convenience: auto-select mapping if user hasn't switched away.
    const defaultMap = 'tools/rigging/mappings/example_map.json';
    const nvdMap = 'tools/rigging/mappings/nvidia_biped_demo_to_zimage.json';
    const looksNvd = /^@?AnimGraph_NVD_/i.test(String(st.motionClip || ''));
    if (looksNvd && String(st.mapUrl || '').trim() === defaultMap) {
      st.mapUrl = nvdMap;
      try { localStorage.setItem('devtools.lastAnimMapUrl', st.mapUrl); } catch { /* ignore */ }
    }

    // Helpful default naming for preview/retarget outputs if user left them blank.
    const hint = slugifyName(st.motionClip, { maxLen: 48 });
    if (hint) {
      // If the user hasn't typed a custom name, keep it in sync.
      if (!String(st.clipName || '').trim() || String(st.clipName || '').trim().toLowerCase() === 'walk') st.clipName = hint;
      if (!String(st.outName || '').trim()) st.outName = hint;
    }
  }

  _syncClipLibrary() {
    const host = this._uiClipLibListEl;
    if (!host) return;
    clear(host);

    const clips = Array.isArray(this._motionClips) ? this._motionClips : [];
    if (!clips.length) {
      host.textContent = '(load clips to populate)';
      return;
    }

    const st = this._state;
    const q = String(this._uiClipLibFilterEl?.value || '').trim().toLowerCase();
    const vendor = String(st.clipLibVendor || 'all');
    const max = Math.max(20, Math.min(5000, Number(st.clipLibMax) || 200));
    const active = String(st.motionClip || '').trim();

    const all = clips.map((c) => {
      const name = String(c?.name || '').trim();
      return { name, isNvidia: isNvidiaAnimName(name) };
    }).filter((c) => !!c.name);
    const nNvidia = all.reduce((acc, c) => acc + (c.isNvidia ? 1 : 0), 0);
    const nOther = Math.max(0, all.length - nNvidia);

    const filtered = all
      .filter((c) => {
        if (vendor === 'nvidia') return !!c.isNvidia;
        if (vendor === 'other') return !c.isNvidia;
        return true;
      })
      .filter((c) => !q || c.name.toLowerCase().includes(q));

    if (!filtered.length) {
      host.textContent = '(no matches)';
      return;
    }

    const shown = filtered.slice(0, max);

    host.appendChild(el('div', { class: 'muted', style: { marginBottom: '6px', whiteSpace: 'pre-wrap' } }, [
      `showing: ${shown.length}/${filtered.length} match(es)`,
      `total clips: ${all.length}   nvidia: ${nNvidia}   other: ${nOther}`,
    ].join('\n')));

    for (const c of shown) {
      const name = c.name;
      host.appendChild(el('button', {
        class: 'toolBtn' + ((name === active) ? ' active' : ''),
        style: { marginTop: '6px' },
        onclick: () => {
          this._state.clipLibMax = Math.max(this._state.clipLibMax || 200, 200);
          this._setMotionClip(name);
          this._buildUi(); // keep inputs synced (map auto-select, outName defaults)
        },
        title: 'Click to select this motionClip',
      }, [name]));
    }

    if (filtered.length > shown.length) {
      host.appendChild(el('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } }, [
        el('button', {
          class: 'primary',
          onclick: () => {
            this._state.clipLibMax = Math.min(5000, max + 200);
            this._syncClipLibrary();
          },
        }, ['Show more (+200)']),
        el('div', { class: 'muted' }, [`(${filtered.length - shown.length} more)`]),
      ]));
    }
  }

  async _loadMotionClipsForCurrentMotionUrl() {
    const st = this._state;
    const motionPath = String(st.motionUrl || '').trim();
    if (!motionPath) throw new Error('Set motionPath first');
    const resp = await fetch('/__devtools_anim_list_clips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runner: st.runner,
        blenderPath: st.blenderPath,
        motionPath,
      }),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'list clips failed'));
    const clips = Array.isArray(j?.clips) ? j.clips : [];
    this._motionClips = clips;
    return clips;
  }

  _autoFillLocomotionPackFromLoadedClips({ preferNvidia = true } = {}) {
    const st = this._state;
    const clips = Array.isArray(this._motionClips) ? this._motionClips : [];
    if (!clips.length) throw new Error('Load clips first');

    const loco = st.loco || (st.loco = { outName: 'locomotion_pack', includeMesh: 1, exportFormat: 'GLB', clips: {} });
    const ensure = (k) => {
      loco.clips = loco.clips && typeof loco.clips === 'object' ? loco.clips : {};
      loco.clips[k] = loco.clips[k] && typeof loco.clips[k] === 'object' ? loco.clips[k] : { motionPath: '', motionClip: '' };
      return loco.clips[k];
    };

    const aliases = {
      // Include some common library-specific names (UAL2, etc).
      idle: ['idle', 'stand', 'rest', 'idle_loop', 'idle_default', 'idle_no_loop', 'idle_foldarms_loop', 'zombie_idle_loop'],
      walk_fwd: ['walk_fwd', 'walkforward', 'walk_forward', 'walk', 'locomotion_walk', 'nvidia_walk'],
      walk_back: ['walk_back', 'walkback', 'walkbackward', 'walk_backward', 'backwalk', 'walk_bwd'],
      walk_left: ['walk_left', 'walkleft', 'strafeleft', 'strafe_left', 'leftwalk', 'walk_l'],
      walk_right: ['walk_right', 'walkright', 'straferight', 'strafe_right', 'rightwalk', 'walk_r'],
      run_fwd: ['run_fwd', 'runforward', 'run_forward', 'run', 'jog', 'sprint', 'locomotion_run', 'nvidia_run'],
      run_back: ['run_back', 'runback', 'runbackward', 'run_backward', 'backrun', 'run_bwd'],
      run_left: ['run_left', 'runleft', 'strafeleft_run', 'runstrafeleft', 'run_l'],
      run_right: ['run_right', 'runright', 'straferight_run', 'runstraferight', 'run_r'],
      jump_start: ['jump_start', 'jumpstart', 'jump_takeoff', 'takeoff', 'jump', 'ninjajump_start'],
      jump_air: ['jump_air', 'jumpair', 'inair', 'air', 'fall', 'ninjajump_idle_loop'],
      jump_land: ['jump_land', 'jumpland', 'land', 'landing', 'ninjajump_land'],
    };

    // Ensure motionPath is filled (use Motion URL) if blank.
    const motionUrl = String(st.motionUrl || '').trim();
    for (const k of Object.keys(aliases)) {
      const ent = ensure(k);
      if (!String(ent.motionPath || '').trim()) ent.motionPath = motionUrl;
    }

    // Try to pick a source clip for each locomotion slot.
    let n = 0;
    for (const [k, a] of Object.entries(aliases)) {
      const ent = ensure(k);
      const picked = pickClipByAliases(clips, a, { preferNvidia: !!preferNvidia });
      if (picked) {
        ent.motionClip = picked;
        n++;
      }
    }

    // ---- Fallbacks for sparse libraries (e.g. UAL2 Standard has only one walk) ----
    const get = (k) => String(ensure(k)?.motionClip || '').trim();
    const setIfEmpty = (k, v) => {
      const vv = String(v || '').trim();
      if (!vv) return false;
      const ent = ensure(k);
      if (String(ent.motionClip || '').trim()) return false;
      ent.motionClip = vv;
      return true;
    };

    const idlePicked = get('idle') || pickClipByAliases(clips, ['Idle_No_Loop', 'Idle_Rail_Loop', 'Idle_FoldArms_Loop', 'Zombie_Idle_Loop'], { preferNvidia: false }) || '';
    const walkPicked = get('walk_fwd') || pickClipByAliases(clips, ['Walk_Carry_Loop', 'Zombie_Walk_Fwd_Loop', 'walk'], { preferNvidia: false }) || '';
    const jumpStartPicked = get('jump_start') || pickClipByAliases(clips, ['NinjaJump_Start', 'jump_start', 'jump'], { preferNvidia: false }) || '';
    const jumpAirPicked = get('jump_air') || pickClipByAliases(clips, ['NinjaJump_Idle_Loop', 'jump_air', 'air'], { preferNvidia: false }) || '';
    const jumpLandPicked = get('jump_land') || pickClipByAliases(clips, ['NinjaJump_Land', 'jump_land', 'land'], { preferNvidia: false }) || '';

    // Directional walk/run: reuse best available.
    for (const k of ['walk_back', 'walk_left', 'walk_right']) if (setIfEmpty(k, walkPicked)) n++;
    for (const k of ['run_fwd', 'run_back', 'run_left', 'run_right']) if (setIfEmpty(k, walkPicked)) n++;

    // Jump fallbacks: prefer real jump clips; else use idle/walk so pack can still build.
    if (setIfEmpty('jump_start', jumpStartPicked || walkPicked || idlePicked)) n++;
    if (setIfEmpty('jump_air', jumpAirPicked || idlePicked || walkPicked)) n++;
    if (setIfEmpty('jump_land', jumpLandPicked || walkPicked || idlePicked)) n++;

    // If we picked NVIDIA-looking clips, auto-switch mapping if user is still on the default.
    try {
      const defaultMap = 'tools/rigging/mappings/example_map.json';
      const nvdMap = 'tools/rigging/mappings/nvidia_biped_demo_to_zimage.json';
      const anyNvd = Object.values(loco.clips || {}).some((ent) => isNvidiaAnimName(String(ent?.motionClip || '')));
      if (anyNvd && String(st.mapUrl || '').trim() === defaultMap) {
        st.mapUrl = nvdMap;
        try { localStorage.setItem('devtools.lastAnimMapUrl', st.mapUrl); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    return { ok: true, filled: n };
  }

  async _autoFillLocomotionPackFromMotionUrl({ preferNvidia = true } = {}) {
    await this._loadMotionClipsForCurrentMotionUrl();
    const out = this._autoFillLocomotionPackFromLoadedClips({ preferNvidia });
    this._syncClipLibrary();
    this._buildUi();
    return out;
  }

  _buildUi() {
    const root = this._root;
    if (!root) return;
    clear(root);
    const ctx = this._ctx;
    const st = this._state;

    const detailsCard = (title, { open = true, hint = '' } = {}, children = []) => el('details', { class: 'card', open: !!open }, [
      el('summary', {}, [
        el('div', { class: 'dockTitle' }, [String(title || 'Section')]),
        hint ? el('div', { class: 'muted', style: { marginLeft: 'auto', textAlign: 'right' } }, [String(hint)]) : el('div', {}),
      ]),
      el('div', { class: 'cardBody' }, children),
    ]);

    const copyBtn = (v) => el('button', {
      onclick: async () => { try { await navigator.clipboard.writeText(String(v || '')); } catch { /* ignore */ } },
      title: 'Copy to clipboard',
    }, ['Copy']);

    const openInViewerBtn = (p) => el('button', {
      class: 'primary',
      onclick: () => {
        const path = String(p || '').trim();
        if (!path) return;
        try { localStorage.setItem('devtools.lastGeneratedModelUrl', path); } catch { /* ignore */ }
        try { globalThis.__devtools?.setActiveTool?.('model_viewer'); } catch { /* ignore */ }
        ctx?.log?.(`Anim: open in viewer → ${path}`);
      },
    }, ['Open in viewer']);

    const rigUrl = el('input', {
      value: st.rigUrl,
      placeholder: 'rig/model path (GLB) (defaults to last output)',
      oninput: (e) => { st.rigUrl = String(e.target.value || '').trim(); },
    });
    const useLastRigBtn = el('button', {
      title: 'Use devtools.lastGeneratedModelUrl as rig input',
      onclick: () => {
        try {
          const saved = String(localStorage.getItem('devtools.lastGeneratedModelUrl') || '').trim();
          if (saved) {
            st.rigUrl = saved;
            rigUrl.value = saved;
          }
        } catch { /* ignore */ }
      },
    }, ['Use last output']);
    const useGameplayAvatarBtn = el('button', {
      title: 'Use gameplay.avatarUrl as rig input (from the main app)',
      onclick: () => {
        try {
          const saved = String(localStorage.getItem('gameplay.avatarUrl') || '').trim();
          if (saved) {
            st.rigUrl = saved;
            rigUrl.value = saved;
          }
        } catch { /* ignore */ }
      },
    }, ['Use gameplay avatar']);

    const motionUrl = el('input', {
      value: st.motionUrl,
      placeholder: 'motion file path (e.g. outputs/walk.bvh, assets/animations/foo.glb)',
      oninput: (e) => {
        st.motionUrl = String(e.target.value || '').trim();
        try { localStorage.setItem('devtools.lastMotionUrl', st.motionUrl); } catch { /* ignore */ }
      },
    });

    const useUal2MotionBtn = el('button', {
      title: 'Sets motionPath to Universal Animation Library 2. Keeps your rigPath unchanged.',
      onclick: () => {
        const motion = 'assets/external/ual2/UAL2_Standard.glb';
        st.motionUrl = motion;
        try { localStorage.setItem('devtools.lastMotionUrl', motion); } catch { /* ignore */ }
        try { motionUrl.value = motion; } catch { /* ignore */ }
        // Clear stale clip selection; user should Load clips again.
        st.motionClip = '';
        this._motionClips = [];
        this._buildUi();
      },
    }, ['UAL2 motion']);

    const useUal2MannequinRigBtn = el('button', {
      title: 'Sets rigPath to the UAL2 mannequin + identity map (for testing on the mannequin itself).',
      onclick: () => {
        const rig = 'assets/external/ual2/Mannequin_F.glb';
        const map = 'tools/rigging/mappings/unreal_mannequin_identity.json';
        st.rigUrl = rig;
        st.mapUrl = map;
        try { localStorage.setItem('devtools.lastAnimMapUrl', map); } catch { /* ignore */ }
        try { rigUrl.value = rig; } catch { /* ignore */ }
        try { mapUrl.value = map; } catch { /* ignore */ }
        this._buildUi();
      },
    }, ['UAL2 rig']);

    const useTestMotionBtn = el('button', {
      title: 'Set motionPath to outputs/mixamo_idle.bvh',
      onclick: () => {
        const p = 'outputs/mixamo_idle.bvh';
        st.motionUrl = p;
        motionUrl.value = p;
        try { localStorage.setItem('devtools.lastMotionUrl', p); } catch { /* ignore */ }
        ctx?.log?.(`Anim: motionPath set → ${p}`);
      },
    }, ['Use test BVH']);

    const mapUrl = el('input', {
      value: st.mapUrl,
      placeholder: 'tools/rigging/mappings/...json',
      oninput: (e) => {
        st.mapUrl = String(e.target.value || '').trim();
        try { localStorage.setItem('devtools.lastAnimMapUrl', st.mapUrl); } catch { /* ignore */ }
      },
    });

    const runner = el('select', {
      value: st.runner,
      onchange: (e) => { st.runner = String(e.target.value || 'conda_trellis'); },
    }, [
      el('option', { value: 'conda_trellis' }, ['conda_trellis']),
      el('option', { value: 'python3' }, ['python3']),
    ]);

    const blenderPath = el('input', {
      value: st.blenderPath,
      placeholder: 'blender executable path (optional, e.g. /usr/bin/blender)',
      oninput: (e) => {
        st.blenderPath = String(e.target.value || '').trim();
        try { localStorage.setItem('devtools.lastAnimBlenderPath', st.blenderPath); } catch { /* ignore */ }
      },
    });

    // Inspect
    const inspectStatus = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    const inspectLog = el('div', { class: 'scrollArea', style: { height: '120px', marginTop: '8px', whiteSpace: 'pre' } }, ['(no inspect output yet)']);
    const runInspect = async (mode) => {
      try {
        const motion = String(st.motionUrl || '').trim();
        if (!motion) throw new Error('Missing motionPath');
        inspectStatus.textContent = `Inspect: running (${mode})...`;
        inspectLog.textContent = '(running...)';
        const resp = await fetch('/__devtools_anim_inspect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            runner: String(st.runner || 'conda_trellis'),
            blenderPath: String(st.blenderPath || ''),
            inputPath: motion,
            mode: String(mode || 'list-clips'),
          }),
        });
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'inspect failed'));
        const out = String(j.stdout || '');
        const err = String(j.stderr || '');
        const code = (j.exitCode == null) ? null : Number(j.exitCode);
        inspectStatus.textContent = `Inspect: ${(code === 0) ? 'done' : 'error'}${(typeof code === 'number') ? ` (exit ${code})` : ''}`;
        inspectLog.textContent = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output)';
        try { inspectLog.scrollTop = inspectLog.scrollHeight; } catch { /* ignore */ }
      } catch (e) {
        inspectStatus.textContent = `Inspect failed: ${e?.message || e}`;
        inspectLog.textContent = String(e?.stack || e?.message || e || '(unknown error)');
      }
    };
    const listClipsBtn = el('button', {
      title: 'List action/clip names found in the motion file (use for motionClip)',
      onclick: () => runInspect('list-clips'),
    }, ['List clips']);
    const printBonesBtn = el('button', {
      title: 'Print bone names for the motion file (use for mapping)',
      onclick: () => runInspect('print-bones'),
    }, ['Print bones']);
    const validateMapBtn = el('button', {
      title: 'Validate that the selected mapping references bones that exist in both source + target rigs',
      onclick: async () => {
        try {
          const rigPath = String(st.rigUrl || '').trim();
          const motionPath = String(st.motionUrl || '').trim();
          const mapPath = String(st.mapUrl || '').trim();
          if (!rigPath) throw new Error('Set rigPath first');
          if (!motionPath) throw new Error('Set motionPath first');
          if (!mapPath) throw new Error('Set mapPath first');

          inspectStatus.textContent = 'Validate map: running...';
          inspectLog.textContent = '(running...)';
          const resp = await fetch('/__devtools_anim_validate_map', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              runner: st.runner,
              blenderPath: st.blenderPath,
              rigPath,
              motionPath,
              mapPath,
            }),
          });
          const j = await resp.json();
          if (!j?.ok) throw new Error(String(j?.error || 'validate map failed'));
          const out = String(j.stdout || '');
          const err = String(j.stderr || '');
          const code = (j.exitCode == null) ? null : Number(j.exitCode);
          inspectStatus.textContent = `Validate map: ${(code === 0) ? 'OK' : 'error'}${(typeof code === 'number') ? ` (exit ${code})` : ''}`;
          inspectLog.textContent = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output)';
          try { inspectLog.scrollTop = inspectLog.scrollHeight; } catch { /* ignore */ }
        } catch (e) {
          inspectStatus.textContent = `Validate map failed: ${e?.message || e}`;
          inspectLog.textContent = String(e?.stack || e?.message || e || '(unknown error)');
        }
      },
    }, ['Validate map']);

    // Clip selection
    const motionClip = el('input', {
      value: st.motionClip,
      placeholder: 'source action (motionClip) (e.g. AnimGraph_NVD_10010)',
      oninput: (e) => {
        this._setMotionClip(String(e.target.value || ''));
        mapUrl.value = st.mapUrl;
        outName.value = st.outName;
        clipName.value = st.clipName;
      },
    });

    const motionClipStatus = el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-wrap' } }, ['']);
    const motionClipSel = el('select', {
      value: '',
      onchange: (e) => {
        const v = String(e.target.value || '').trim();
        if (!v) return;
        this._setMotionClip(v);
        motionClip.value = st.motionClip;
        mapUrl.value = st.mapUrl;
        outName.value = st.outName;
        clipName.value = st.clipName;
      },
    }, [
      el('option', { value: '' }, ['(load clips from motion asset)']),
    ]);
    const loadMotionClipsBtn = el('button', {
      title: 'Read action/clip names from the motion asset and populate a dropdown',
      onclick: async () => {
        try {
          const motionPath = String(st.motionUrl || '').trim();
          if (!motionPath) throw new Error('Set motionPath first');

          motionClipStatus.textContent = 'Loading clips...';
          clear(motionClipSel);
          motionClipSel.appendChild(el('option', { value: '' }, ['(loading...)']));

          const resp = await fetch('/__devtools_anim_list_clips', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              runner: st.runner,
              blenderPath: st.blenderPath,
              motionPath,
            }),
          });
          const j = await resp.json();
          if (!j?.ok) throw new Error(String(j?.error || 'list clips failed'));

          const clips = Array.isArray(j?.clips) ? j.clips : [];
          this._motionClips = clips;
          clear(motionClipSel);
          motionClipSel.appendChild(el('option', { value: '' }, ['(select a clip)']));
          for (const c of clips) {
            const name = String(c?.name || '').trim();
            if (!name) continue;
            const s = (c?.start != null) ? Number(c.start) : null;
            const e = (c?.end != null) ? Number(c.end) : null;
            const label = (Number.isFinite(s) && Number.isFinite(e)) ? `${name}  [${s}..${e}]` : name;
            motionClipSel.appendChild(el('option', { value: name }, [label]));
          }
          motionClipStatus.textContent = `Found ${clips.length} clip(s)`;
          this._syncClipLibrary();

          const cur = String(st.motionClip || '').trim();
          if (!cur && clips.length) {
            const first = String(clips[0]?.name || '').trim();
            if (first) {
              this._setMotionClip(first);
              motionClip.value = st.motionClip;
              motionClipSel.value = st.motionClip;
              mapUrl.value = st.mapUrl;
              outName.value = st.outName;
              clipName.value = st.clipName;
            }
          } else {
            motionClipSel.value = cur;
          }
        } catch (e) {
          motionClipStatus.textContent = `Load clips failed: ${e?.message || e}`;
          clear(motionClipSel);
          motionClipSel.appendChild(el('option', { value: '' }, ['(load clips from motion asset)']));
          this._motionClips = [];
          this._syncClipLibrary();
        }
      },
    }, ['Load clips']);

    const clipLibFilter = el('input', {
      placeholder: 'filter motion clips (e.g. 10010, walk, idle)',
      value: '',
      oninput: () => {
        st.clipLibMax = 200;
        this._syncClipLibrary();
      },
    });
    this._uiClipLibFilterEl = clipLibFilter;

    const clipLibVendor = el('select', {
      value: String(st.clipLibVendor || 'all'),
      onchange: (e) => {
        st.clipLibVendor = String(e.target.value || 'all');
        st.clipLibMax = 200;
        this._syncClipLibrary();
      },
      title: 'Filter clip list by NVIDIA naming convention (heuristic)',
    }, [
      el('option', { value: 'all' }, ['All clips']),
      el('option', { value: 'nvidia' }, ['NVIDIA (AnimGraph_NVD_*, @nvidia)']),
      el('option', { value: 'other' }, ['Non-NVIDIA']),
    ]);
    this._uiClipLibVendorEl = clipLibVendor;

    const clipLibList = el('div', { class: 'scrollArea', style: { height: '220px', marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['(load clips to populate)']);
    this._uiClipLibListEl = clipLibList;

    const clipName = el('input', {
      value: st.clipName,
      placeholder: 'output clip name (optional; defaults to source action)',
      oninput: (e) => { st.clipName = String(e.target.value || '').trim(); },
    });

    const rootMotion = el('input', {
      type: 'checkbox',
      checked: !!st.rootMotion,
      onchange: (e) => { st.rootMotion = e.target.checked ? 1 : 0; },
    });

    const includeMesh = el('input', {
      type: 'checkbox',
      checked: !!st.includeMesh,
      onchange: (e) => { st.includeMesh = e.target.checked ? 1 : 0; },
    });

    const exportFormat = el('select', {
      value: st.exportFormat,
      onchange: (e) => { st.exportFormat = String(e.target.value || 'GLB'); },
    }, [
      el('option', { value: 'GLB' }, ['GLB']),
      el('option', { value: 'GLTF_SEPARATE' }, ['GLTF_SEPARATE']),
    ]);

    const outName = el('input', {
      value: st.outName,
      placeholder: 'output name (e.g. walk, idle, run_left)',
      oninput: (e) => { st.outName = String(e.target.value || '').trim(); },
    });

    const autoLoad = el('input', {
      type: 'checkbox',
      checked: !!st.jobAutoLoad,
      onchange: (e) => { st.jobAutoLoad = e.target.checked ? 1 : 0; },
    });

    const animStatus = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    const animLog = el('div', { class: 'scrollArea', style: { height: '160px', marginTop: '8px', whiteSpace: 'pre' } }, ['(no job yet)']);

    const animStartBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { animStartBtn.disabled = true; } catch { /* ignore */ }
        try {
          await this._startAnimJob({
            rigPath: st.rigUrl,
            motionPath: st.motionUrl,
            mapPath: st.mapUrl,
            runner: st.runner,
            blenderPath: st.blenderPath,
            motionClip: st.motionClip,
            clipName: st.clipName,
            exportFormat: st.exportFormat,
            rootMotion: !!st.rootMotion,
            includeMesh: !!st.includeMesh,
            outName: st.outName,
            statusEl: animStatus,
            logEl: animLog,
            autoLoad: !!st.jobAutoLoad,
          });
        } catch (e) {
          ctx?.log?.(`Anim: retarget start failed: ${e?.message || e}`);
          animStatus.textContent = `Anim start failed: ${e?.message || e}`;
        }
        try { animStartBtn.disabled = false; } catch { /* ignore */ }
      },
    }, ['Retarget']);

    const previewBtn = el('button', {
      class: 'primary',
      title: 'Retarget with Include mesh + Auto-open viewer (fast preview loop)',
      onclick: async () => {
        try { previewBtn.disabled = true; } catch { /* ignore */ }
        try {
          const clip = String(st.motionClip || '').trim();
          if (!clip) throw new Error('Pick a motionClip first (load clips, then click one)');
          const base = String(st.outName || '').trim() || slugifyName(clip, { maxLen: 48 }) || 'preview';
          const stamp = String(Date.now()).slice(-6);
          const out = `${base}_preview_${stamp}`;
          await this._startAnimJob({
            rigPath: st.rigUrl,
            motionPath: st.motionUrl,
            mapPath: st.mapUrl,
            runner: st.runner,
            blenderPath: st.blenderPath,
            motionClip: st.motionClip,
            clipName: st.clipName || slugifyName(clip, { maxLen: 48 }) || '',
            exportFormat: st.exportFormat,
            rootMotion: !!st.rootMotion,
            includeMesh: true,
            outName: out,
            statusEl: animStatus,
            logEl: animLog,
            autoLoad: true,
          });
        } catch (e) {
          ctx?.log?.(`Anim: preview failed: ${e?.message || e}`);
          animStatus.textContent = `Preview failed: ${e?.message || e}`;
        }
        try { previewBtn.disabled = false; } catch { /* ignore */ }
      },
    }, ['Preview on rig']);

    const animKillBtn = el('button', {
      class: 'danger',
      onclick: async () => {
        const id = String(this._animJob?.id || '');
        if (!id) return;
        try {
          await fetch('/__devtools_anim_kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
        } catch { /* ignore */ }
        this._pollingAnim = false;
      },
    }, ['Kill job']);

    const animCopyBtn = el('button', {
      onclick: async () => {
        const p = String(this._animJob?.outGlb || '');
        if (!p) return;
        try { await navigator.clipboard.writeText(p); ctx?.log?.('Anim: copied output path'); } catch { /* ignore */ }
      },
    }, ['Copy output']);

    // ---- Locomotion pack (idle/walk/run/jump) ----
    const loco = st.loco || (st.loco = { outName: 'locomotion_pack', includeMesh: 1, exportFormat: 'GLB', clips: {} });
    const locoOutName = el('input', {
      value: String(loco.outName || ''),
      placeholder: 'output name (e.g. hero_locomotion)',
      oninput: (e) => { loco.outName = String(e.target.value || '').trim(); },
    });
    const locoIncludeMesh = el('input', {
      type: 'checkbox',
      checked: !!loco.includeMesh,
      onchange: (e) => { loco.includeMesh = e.target.checked ? 1 : 0; },
    });
    const locoExportFormat = el('select', {
      value: String(loco.exportFormat || 'GLB'),
      onchange: (e) => { loco.exportFormat = String(e.target.value || 'GLB'); },
    }, [
      el('option', { value: 'GLB' }, ['GLB']),
      el('option', { value: 'GLTF_SEPARATE' }, ['GLTF_SEPARATE']),
    ]);

    const locoFillMotionPathsBtn = el('button', {
      title: 'Fill all locomotion pack motion paths from Motion URL',
      onclick: () => {
        const m = String(st.motionUrl || '').trim();
        const clips = loco?.clips || {};
        if (!m) return;
        for (const k of Object.keys(clips)) {
          if (!clips[k]) clips[k] = { motionPath: '', motionClip: '' };
          if (!String(clips[k].motionPath || '').trim()) clips[k].motionPath = m;
        }
        this._buildUi();
      },
    }, ['Use Motion URL for all']);

    const locoAutoFillBtn = el('button', {
      class: 'primary',
      title: 'Loads clips from the motion asset and auto-fills locomotion motionClip fields (tries NVIDIA names first).',
      onclick: async () => {
        try {
          const out = await this._autoFillLocomotionPackFromMotionUrl({ preferNvidia: true });
          ctx?.toast?.(`Auto-filled locomotion clips (${out?.filled || 0})`, 'success', { title: 'Animation' });
        } catch (e) {
          ctx?.toast?.(`Auto-fill failed: ${e?.message || e}`, 'error', { title: 'Animation' });
        }
      },
    }, ['Auto-fill locomotion clips']);

    const locoClipRows = (() => {
      const keys = [
        'idle',
        'walk_fwd', 'walk_back', 'walk_left', 'walk_right',
        'run_fwd', 'run_back', 'run_left', 'run_right',
        'jump_start', 'jump_air', 'jump_land',
      ];
      const host = el('div', { class: 'card', style: { marginTop: '10px' } }, []);
      host.appendChild(el('div', { class: 'muted', style: { whiteSpace: 'pre-wrap' } }, [
        'Per-clip mapping. If motionPath is blank, Motion URL will be used.',
      ]));
      for (const k of keys) {
        const ent = (loco.clips?.[k]) || (loco.clips[k] = { motionPath: '', motionClip: '' });
        const motionPathEl = el('input', {
          value: String(ent.motionPath || ''),
          placeholder: 'motionPath (optional)',
          oninput: (e) => { ent.motionPath = String(e.target.value || '').trim(); },
        });
        const motionClipEl = el('input', {
          value: String(ent.motionClip || ''),
          placeholder: 'motionClip (action name)',
          oninput: (e) => { ent.motionClip = String(e.target.value || '').trim(); },
        });
        host.appendChild(el('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } }, [
          el('div', { class: 'muted', style: { flex: '0 0 92px' } }, [k]),
          motionPathEl,
          motionClipEl,
        ]));
      }
      return host;
    })();

    const locoStartBtn = el('button', {
      class: 'primary',
      title: 'Generate a single GLB containing all locomotion actions',
      onclick: async () => {
        try { locoStartBtn.disabled = true; } catch { /* ignore */ }
        try {
          const rigPath = String(st.rigUrl || '').trim();
          const mapPath = String(st.mapUrl || '').trim();
          if (!rigPath) throw new Error('Set rigPath first');
          if (!mapPath) throw new Error('Set mapPath first');

          const motionDefault = String(st.motionUrl || '').trim();
          const clipsObj = loco?.clips || {};
          const clips = [];
          for (const [clipName, ent] of Object.entries(clipsObj)) {
            const motionPath = String(ent?.motionPath || '').trim() || motionDefault;
            const motionClip = String(ent?.motionClip || '').trim();
            if (!motionPath) throw new Error(`Locomotion pack: missing motionPath for ${clipName} (set Motion URL or per-clip path)`);
            if (!motionClip) throw new Error(`Locomotion pack: missing motionClip for ${clipName}`);
            clips.push({ clipName, motionPath, motionClip });
          }

          this._animJob = { id: '', status: 'running', stdout: '', stderr: '', outGlb: '', setGameplayAvatarOnDone: true };
          this._pollingAnim = false;
          animStatus.textContent = 'Starting locomotion pack job...';
          animLog.textContent = '(starting...)';

          const payload = {
            runner: String(st.runner || 'conda_trellis'),
            blenderPath: String(st.blenderPath || ''),
            rigPath,
            mapPath,
            clips,
            exportFormat: String(loco.exportFormat || 'GLB'),
            includeMesh: (loco.includeMesh ? 1 : 0),
            outName: String(loco.outName || '').trim(),
          };
          const resp = await fetch('/__devtools_anim_locomotion_pack_start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const j = await resp.json();
          if (!j?.ok) throw new Error(String(j?.error || 'locomotion pack start failed'));

          this._animJob.id = String(j.id || '');
          this._animJob.outGlb = String(j.outGlb || '');
          this._pollingAnim = true;
          void this._pollAnimLoop({ id: this._animJob.id, statusEl: animStatus, logEl: animLog, autoLoad: true });
          ctx?.log?.('Anim: locomotion pack started');
        } catch (e) {
          ctx?.log?.(`Anim: locomotion pack start failed: ${e?.message || e}`);
          animStatus.textContent = `Locomotion pack start failed: ${e?.message || e}`;
        }
        try { locoStartBtn.disabled = false; } catch { /* ignore */ }
      },
    }, ['Build locomotion pack']);

    const locoSetGameplayBtn = el('button', {
      title: 'Set the last output GLB as the gameplay avatar',
      onclick: () => {
        const p = String(this._animJob?.outGlb || '').trim();
        if (!p) return;
        try { localStorage.setItem('gameplay.avatarUrl', p); } catch { /* ignore */ }
        ctx?.toast?.('Set gameplay avatar to locomotion pack output', 'success', { title: 'Animation' });
      },
    }, ['Set gameplay avatar']);

    const assetPickRig = this._buildAssetPicker({
      title: 'Asset Picker (rig/model)',
      ext: '.glb,.gltf',
      onPick: (p) => { st.rigUrl = p; rigUrl.value = p; },
      allowEmptyQuery: true,
    });
    const assetPickMotion = this._buildAssetPicker({
      title: 'Asset Picker (motion)',
      ext: '.bvh,.fbx,.glb,.gltf,.usd,.usda,.usdc,.usdz',
      onPick: (p) => {
        st.motionUrl = p;
        motionUrl.value = p;
        try { localStorage.setItem('devtools.lastMotionUrl', p); } catch { /* ignore */ }
      },
      allowEmptyQuery: true,
    });
    const assetPickAnimMap = this._buildAssetPicker({
      title: 'Asset Picker (retarget map)',
      ext: '.json',
      onPick: (p) => {
        st.mapUrl = p;
        mapUrl.value = p;
        try { localStorage.setItem('devtools.lastAnimMapUrl', p); } catch { /* ignore */ }
      },
      allowEmptyQuery: true,
    });

    root.appendChild(detailsCard('Inputs', { open: true, hint: 'target + source' }, [
      el('div', { class: 'muted' }, ['Pick a rig (target) + motion (source), then retarget.']),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['rigPath (target)']),
      el('div', { class: 'row', style: { gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, [rigUrl, useLastRigBtn, useGameplayAvatarBtn]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } }, [copyBtn(st.rigUrl)]),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['motionPath (source)']),
      el('div', { class: 'row', style: { gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, [
        motionUrl,
        useTestMotionBtn,
        useUal2MotionBtn,
        useUal2MannequinRigBtn,
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [listClipsBtn, printBonesBtn, validateMapBtn]),
      inspectStatus,
      inspectLog,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['mapPath']),
      mapUrl,
    ]));

    root.appendChild(assetPickRig);
    root.appendChild(assetPickMotion);
    root.appendChild(assetPickAnimMap);

    root.appendChild(detailsCard('Retarget', { open: true, hint: 'AnimGraph' }, [
      el('div', { class: 'muted' }, ['Pick a motion file + choose the clip (action) to bake onto your rig. Outputs go to `assets/animations/`.']),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['motionClip (source)']), motionClip]),
        el('div', {}, [el('div', { class: 'muted' }, ['motion asset clips']), el('div', { class: 'row', style: { gap: '8px' } }, [loadMotionClipsBtn, motionClipSel])]),
      ]),
      motionClipStatus,
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
        el('div', { class: 'muted' }, ['Locomotion helper:']),
        locoAutoFillBtn,
      ]),
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Motion clip library']),
      el('div', { class: 'row', style: { marginTop: '6px', gap: '8px' } }, [clipLibFilter, clipLibVendor]),
      clipLibList,
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['outName']), outName]),
        el('div', {}, [el('div', { class: 'muted' }, ['clipName (optional)']), clipName]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } }, [
        animStartBtn,
        previewBtn,
        animKillBtn,
        animCopyBtn,
        openInViewerBtn(this._animJob?.outGlb || ''),
      ]),
      animStatus,
      animLog,
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Advanced']),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['runner']),
      runner,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['blenderPath (optional)']),
      blenderPath,
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['exportFormat']), exportFormat]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', alignItems: 'center' } }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          rootMotion,
          el('div', { class: 'muted' }, ['Root motion']),
        ]),
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          includeMesh,
          el('div', { class: 'muted' }, ['Include mesh (preview)']),
        ]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', alignItems: 'center' } }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          autoLoad,
          el('div', { class: 'muted' }, ['Auto-open output in viewer']),
        ]),
      ]),
    ]));

    root.appendChild(detailsCard('Locomotion pack (idle / walk / run / jump)', { open: false, hint: 'one GLB, many actions' }, [
      el('div', { class: 'muted', style: { whiteSpace: 'pre-wrap' } }, [
        'Generates a single GLB containing actions named:\n' +
        'idle, walk_fwd/back/left/right, run_fwd/back/left/right, jump_start/air/land.\n' +
        'Use it directly as your gameplay avatar.',
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['outName']), locoOutName]),
        el('div', {}, [el('div', { class: 'muted' }, ['exportFormat']), locoExportFormat]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '12px', alignItems: 'center', flexWrap: 'wrap' } }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          locoIncludeMesh,
          el('div', { class: 'muted' }, ['Include mesh']),
        ]),
        locoFillMotionPathsBtn,
        locoAutoFillBtn,
      ]),
      locoClipRows,
      el('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } }, [
        locoStartBtn,
        locoSetGameplayBtn,
      ]),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Tip: click "Load clips" above, then copy/paste clip names into the slots.']),
    ]));

    // Populate clip library if we already loaded clips.
    this._syncClipLibrary();
  }

  _buildAssetPicker({ title, ext, onPick, allowEmptyQuery = false }) {
    const ctx = this._ctx;
    const queryInput = el('input', { placeholder: allowEmptyQuery ? 'search assets (optional; empty to list)' : 'search assets (e.g. walk)' });
    const list = el('div', { class: 'scrollArea', style: { height: '160px' } }, ['(search to populate)']);

    const refresh = async () => {
      const q = String(queryInput.value || '').trim();
      if (!q && !allowEmptyQuery) {
        list.textContent = '(search to populate)';
        return;
      }
      try {
        list.textContent = 'Loading...';
        const items = await ctx.assetIndex({ query: q, ext });
        if (!items.length) {
          list.textContent = '(no matches)';
          return;
        }
        clear(list);
        for (const it of items.slice(0, 250)) {
          const p = String(it?.path || '');
          const btn = el('button', {
            class: 'toolBtn',
            style: { marginTop: '6px' },
            onclick: () => onPick(p),
          }, [p]);
          list.appendChild(btn);
        }
      } catch (e) {
        list.textContent = `(error) ${e?.message || e}`;
      }
    };
    queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') refresh(); });

    return el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, [String(title || 'Assets')]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        queryInput,
        el('button', { onclick: refresh }, ['Search']),
      ]),
      el('div', { class: 'muted', style: { marginTop: '6px' } }, ['Uses local Vite dev endpoint `/__editor_assets_index`.']),
      el('div', { style: { marginTop: '8px' } }, [list]),
    ]);
  }

  async _startAnimJob({ rigPath, motionPath, mapPath, runner, blenderPath, motionClip, clipName, exportFormat, rootMotion, includeMesh, outName, statusEl, logEl, autoLoad }) {
    const ctx = this._ctx;
    const rig = String(rigPath || '').trim();
    const motion = String(motionPath || '').trim();
    const map = String(mapPath || '').trim();
    if (!rig) throw new Error('Missing rigPath (target)');
    if (!motion) throw new Error('Missing motionPath (source)');
    if (!map) throw new Error('Missing mapPath');

    this._animJob = { id: '', status: 'running', stdout: '', stderr: '', outGlb: '' };
    this._pollingAnim = false;
    if (statusEl) statusEl.textContent = 'Starting retarget job...';
    if (logEl) logEl.textContent = '(starting...)';

    const payload = {
      rigPath: rig,
      motionPath: motion,
      mapPath: map,
      runner: String(runner || 'conda_trellis'),
      blenderPath: String(blenderPath || ''),
      motionClip: String(motionClip || '').trim().replace(/^@+/, ''),
      clipName: String(clipName || '').trim().replace(/^@+/, ''),
      exportFormat: String(exportFormat || ''),
      rootMotion: rootMotion ? 1 : 0,
      includeMesh: includeMesh ? 1 : 0,
      outName: String(outName || ''),
    };

    const resp = await fetch('/__devtools_anim_retarget_start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'anim start failed'));

    this._animJob.id = String(j.id || '');
    this._animJob.outGlb = String(j.outGlb || '');
    this._pollingAnim = true;
    void this._pollAnimLoop({ id: this._animJob.id, statusEl, logEl, autoLoad: !!autoLoad });
    ctx?.log?.('Anim: retarget started');
  }

  async _pollAnimLoop({ id, statusEl, logEl, autoLoad }) {
    const ctx = this._ctx;
    if (!id) return;
    let backoff = 400;
    while (this._pollingAnim && this._animJob?.id === id) {
      try {
        const resp = await fetch(`/__devtools_anim_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));
        this._animJob.status = String(j.status || '');
        this._animJob.stdout = String(j.stdout || '');
        this._animJob.stderr = String(j.stderr || '');
        this._animJob.outGlb = String(j.outGlb || this._animJob.outGlb || '');

        if (statusEl) statusEl.textContent = `Retarget job: ${this._animJob.status}${this._animJob.outGlb ? `\nOutput: ${this._animJob.outGlb}` : ''}`;
        if (logEl) {
          const out = this._animJob.stdout || '';
          const err = this._animJob.stderr || '';
          logEl.textContent = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output yet)';
          try { logEl.scrollTop = logEl.scrollHeight; } catch { /* ignore */ }
        }

        if (this._animJob.status === 'done' || this._animJob.status === 'error' || this._animJob.status === 'killed') {
          this._pollingAnim = false;
          if (this._animJob.status === 'done') {
            const outGlb = String(this._animJob.outGlb || '').trim();
            if (outGlb) {
              try { localStorage.setItem('devtools.lastGeneratedModelUrl', outGlb); } catch { /* ignore */ }
              if (this._animJob?.setGameplayAvatarOnDone) {
                try { localStorage.setItem('gameplay.avatarUrl', outGlb); } catch { /* ignore */ }
              }
              ctx?.log?.(`Anim: done → ${outGlb}`);
              if (autoLoad) {
                try { globalThis.__devtools?.setActiveTool?.('model_viewer'); } catch { /* ignore */ }
              }
            }
          }
          return;
        }

        backoff = 500;
      } catch (e) {
        if (statusEl) statusEl.textContent = `Anim polling failed: ${e?.message || e}`;
        backoff = Math.min(2000, Math.floor(backoff * 1.4));
      }
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

