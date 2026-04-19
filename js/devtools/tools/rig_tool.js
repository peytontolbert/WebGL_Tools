import { el, clear } from '../../ui/dom.js';

export class RigTool {
  constructor() {
    this.id = 'rig';
    this.label = 'Rigging';

    this._ctx = null;
    this._root = null;

    this._state = {
      modelUrl: '',

      // Bring-to-life (auto pipeline: optional rig -> locomotion pack -> preview)
      bringToLife: {
        autoRig: 1,
        rigBackend: 'rigify',
        mapUrl: 'tools/rigging/mappings/example_map.json',
        runner: 'conda_trellis', // python3 | conda_trellis
        blenderPath: '',
        // Optional shared motion source convenience (used by UI helpers).
        motionUrl: '',
        outName: 'locomotion_pack',
        includeMesh: 1,
        exportFormat: 'GLB',
        // clipKey -> { motionPath, motionClip }
        clips: {
          idle: { motionPath: 'outputs/mixamo_idle.bvh', motionClip: '' },
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

      // Rigging
      rigRunner: 'conda_trellis', // python3 | conda_trellis
      rigBackend: 'rigify',
      blenderPath: '',
      rigArgs: '--deform-only',
      rigOutName: '',
      rigJobAutoLoad: 1,

      // Outfit / clothing (attach meshes to an existing rigged base)
      outfitRunner: 'conda_trellis', // python3 | conda_trellis
      outfitBaseRigUrl: '',
      outfitClothesText: '',
      outfitBlenderPath: '',
      outfitArgs: '--weight-method transfer',
      outfitOutName: '',
      outfitJobAutoLoad: 1,
    };

    this._rigJob = { id: '', status: '', stdout: '', stderr: '', outRig: '' };
    this._animJob = { id: '', status: '', stdout: '', stderr: '', outGlb: '' };
    this._outfitJob = { id: '', status: '', stdout: '', stderr: '', outGlb: '' };
    this._pollingRig = false;
    this._pollingAnim = false;
    this._pollingOutfit = false;

    this._modelUrlInputEl = null;

    // Tracks the last shared model URL we synced from localStorage.
    // Tool instances persist across unmount/mount, so without this we can get "stuck"
    // on a stale modelUrl and never pick up the one loaded in the model viewer.
    this._lastStorageModelUrlSeen = '';

    // Bring-to-life motion clip library cache + UX state.
    this._btlMotionClips = [];
    this._btlActiveClipKey = '';

    // UI refs (so other tools can auto-run and still show progress).
    this._uiBtlStatusEl = null;
    this._uiBtlLogEl = null;
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;

    // Default model from shared "active/last opened model" key.
    // Prefer the storage value if it changed since we last saw it.
    try {
      const saved = String(localStorage.getItem('devtools.lastGeneratedModelUrl') || '').trim();
      if (saved && saved !== this._lastStorageModelUrlSeen) {
        this._state.modelUrl = saved;
        this._lastStorageModelUrlSeen = saved;
      }
      if (saved && !String(this._state.outfitBaseRigUrl || '').trim()) this._state.outfitBaseRigUrl = saved;
    } catch { /* ignore */ }

    // Restore last-used Blender paths.
    try {
      const p = String(localStorage.getItem('devtools.lastRigBlenderPath') || '').trim();
      if (p && !this._state.blenderPath) this._state.blenderPath = p;
    } catch { /* ignore */ }
    try {
      const p = String(localStorage.getItem('devtools.lastOutfitBlenderPath') || '').trim();
      if (p && !this._state.outfitBlenderPath) this._state.outfitBlenderPath = p;
    } catch { /* ignore */ }

    // Bring-to-life defaults from shared keys (Animation tool compatible).
    try {
      const st = this._state.bringToLife;
      const savedMap = String(localStorage.getItem('devtools.lastAnimMapUrl') || '').trim();
      if (savedMap && String(st.mapUrl || '').trim() === 'tools/rigging/mappings/example_map.json') st.mapUrl = savedMap;
    } catch { /* ignore */ }
    try {
      const st = this._state.bringToLife;
      const savedMotion = String(localStorage.getItem('devtools.lastMotionUrl') || '').trim();
      if (savedMotion && !String(st.motionUrl || '').trim()) st.motionUrl = savedMotion;
      if (savedMotion && !String(st.clips?.idle?.motionPath || '').trim()) st.clips.idle.motionPath = savedMotion;
    } catch { /* ignore */ }
    try {
      const st = this._state.bringToLife;
      const p = String(localStorage.getItem('devtools.lastAnimBlenderPath') || '').trim();
      if (p && !String(st.blenderPath || '').trim()) st.blenderPath = p;
    } catch { /* ignore */ }

    this._buildUi();

    // Optional: allow other tools (Model Viewer) to one-click start bring-to-life.
    // Pattern: write JSON to localStorage, switch to Rigging tool, and we auto-run once.
    try {
      const raw = String(localStorage.getItem('devtools.rig.autoBringToLife') || '').trim();
      if (raw) {
        localStorage.removeItem('devtools.rig.autoBringToLife');
        let cfg = null;
        try { cfg = JSON.parse(raw); } catch { cfg = null; }
        const inModelPath = String(cfg?.modelUrl || this._state.modelUrl || '').trim();
        const btl = cfg?.bringToLife || {};
        const runner = String(btl?.runner || this._state?.bringToLife?.runner || 'conda_trellis');
        const blenderPath = String(btl?.blenderPath || this._state?.bringToLife?.blenderPath || '');
        const mapPath = String(btl?.mapUrl || this._state?.bringToLife?.mapUrl || '').trim();
        const outName = String(btl?.outName || this._state?.bringToLife?.outName || 'locomotion_pack').trim();
        const includeMesh = Number(btl?.includeMesh ?? this._state?.bringToLife?.includeMesh ?? 1) ? 1 : 0;
        const exportFormat = String(btl?.exportFormat || this._state?.bringToLife?.exportFormat || 'GLB');
        const autoRig = !!Number(btl?.autoRig ?? this._state?.bringToLife?.autoRig ?? 1);
        const rigBackend = String(btl?.rigBackend || this._state?.bringToLife?.rigBackend || 'rigify');
        const clipsObj = (btl?.clips && typeof btl.clips === 'object') ? btl.clips : (this._state?.bringToLife?.clips || {});

        // Best-effort: sync UI state (so the user sees what is running).
        this._state.modelUrl = inModelPath;
        try { if (this._modelUrlInputEl) this._modelUrlInputEl.value = inModelPath; } catch { /* ignore */ }
        try {
          const st = this._state.bringToLife;
          st.runner = runner;
          st.blenderPath = blenderPath;
          if (mapPath) st.mapUrl = mapPath;
          st.outName = outName;
          st.includeMesh = includeMesh ? 1 : 0;
          st.exportFormat = exportFormat;
          st.autoRig = autoRig ? 1 : 0;
          st.rigBackend = rigBackend;
          if (clipsObj && typeof clipsObj === 'object') st.clips = clipsObj;
        } catch { /* ignore */ }
        this._buildUi();

        // Kick off the pipeline.
        void this._bringToLife({
          inModelPath,
          autoRig,
          rigBackend,
          runner,
          blenderPath,
          mapPath: mapPath || this._state?.bringToLife?.mapUrl || '',
          outName,
          includeMesh,
          exportFormat,
          clipsObj,
          statusEl: this._uiBtlStatusEl,
          logEl: this._uiBtlLogEl,
        }).catch((e) => {
          try { this._ctx?.toast?.(`Bring-to-life failed: ${e?.message || e}`, 'error', { title: 'Rigging' }); } catch { /* ignore */ }
        });
      }
    } catch { /* ignore */ }
  }

  async unmount() {
    this._pollingRig = false;
    this._pollingAnim = false;
    this._pollingOutfit = false;
    this._ctx = null;
    this._root = null;
  }

  tick() {}

  getStats() {
    return {
      model: this._state.modelUrl || '',
      rigJob: this._rigJob?.status || '',
      animJob: this._animJob?.status || '',
      outfitJob: this._outfitJob?.status || '',
    };
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
        ctx?.log?.(`Rigging: open in viewer → ${path}`);
      },
    }, ['Open in viewer']);

    const modelUrl = el('input', {
      value: st.modelUrl,
      placeholder: 'assets/.../model.glb (input mesh/model)',
      oninput: (e) => { st.modelUrl = String(e.target.value || '').trim(); },
    });
    this._modelUrlInputEl = modelUrl;

    const useLastBtn = el('button', {
      title: 'Use devtools.lastGeneratedModelUrl as input',
      onclick: () => {
        try {
          const saved = String(localStorage.getItem('devtools.lastGeneratedModelUrl') || '').trim();
          if (saved) {
            st.modelUrl = saved;
            modelUrl.value = saved;
            if (!String(st.outfitBaseRigUrl || '').trim()) st.outfitBaseRigUrl = saved;
          }
        } catch { /* ignore */ }
      },
    }, ['Use last output']);

    // ───────────────── Bring to life ─────────────────
    const btl = st.bringToLife || (st.bringToLife = {});
    const btlAutoRig = el('input', {
      type: 'checkbox',
      checked: !!btl.autoRig,
      onchange: (e) => { btl.autoRig = e.target.checked ? 1 : 0; this._buildUi(); },
    });
    const btlRigBackend = el('select', {
      value: String(btl.rigBackend || 'rigify'),
      onchange: (e) => { btl.rigBackend = String(e.target.value || 'rigify'); },
    }, [
      el('option', { value: 'rigify' }, ['rigify (recommended)']),
      el('option', { value: 'blenrig' }, ['blenrig']),
      el('option', { value: 'unirig' }, ['unirig']),
      el('option', { value: 'riganything' }, ['riganything']),
    ]);
    const btlMapUrl = el('input', {
      value: String(btl.mapUrl || 'tools/rigging/mappings/example_map.json'),
      placeholder: 'tools/rigging/mappings/...json',
      oninput: (e) => { btl.mapUrl = String(e.target.value || '').trim(); try { localStorage.setItem('devtools.lastAnimMapUrl', btl.mapUrl); } catch { /* ignore */ } },
    });
    const btlRunner = el('select', {
      value: String(btl.runner || 'conda_trellis'),
      onchange: (e) => { btl.runner = String(e.target.value || 'conda_trellis'); },
    }, [
      el('option', { value: 'conda_trellis' }, ['conda_trellis']),
      el('option', { value: 'python3' }, ['python3']),
    ]);
    const btlBlenderPath = el('input', {
      value: String(btl.blenderPath || ''),
      placeholder: 'blender executable path (optional)',
      oninput: (e) => {
        btl.blenderPath = String(e.target.value || '').trim();
        try { localStorage.setItem('devtools.lastAnimBlenderPath', btl.blenderPath); } catch { /* ignore */ }
      },
    });
    const btlOutName = el('input', {
      value: String(btl.outName || 'locomotion_pack'),
      placeholder: 'output name hint (e.g. hero_locomotion)',
      oninput: (e) => { btl.outName = String(e.target.value || '').trim(); },
    });
    const btlIncludeMesh = el('input', {
      type: 'checkbox',
      checked: !!btl.includeMesh,
      onchange: (e) => { btl.includeMesh = e.target.checked ? 1 : 0; },
    });
    const btlExportFormat = el('select', {
      value: String(btl.exportFormat || 'GLB'),
      onchange: (e) => { btl.exportFormat = String(e.target.value || 'GLB'); },
    }, [
      el('option', { value: 'GLB' }, ['GLB']),
      el('option', { value: 'GLTF_SEPARATE' }, ['GLTF_SEPARATE']),
    ]);

    const btlStatus = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    const btlLog = el('div', { class: 'scrollArea', style: { height: '160px', marginTop: '8px', whiteSpace: 'pre' } }, ['(no job yet)']);
    this._uiBtlStatusEl = btlStatus;
    this._uiBtlLogEl = btlLog;

    const btlMotionUrl = el('input', {
      value: String(btl.motionUrl || ''),
      placeholder: 'motion URL (optional helper; e.g. outputs/walk.bvh, assets/external/ual2/UAL2_Standard.glb)',
      oninput: (e) => {
        btl.motionUrl = String(e.target.value || '').trim();
        try { localStorage.setItem('devtools.lastMotionUrl', btl.motionUrl); } catch { /* ignore */ }
      },
    });

    const btlUseUal2MotionBtn = el('button', {
      title: 'Use Universal Animation Library 2 motion source (Unreal mannequin skeleton).',
      onclick: () => {
        const p = 'assets/external/ual2/UAL2_Standard.glb';
        btl.motionUrl = p;
        btlMotionUrl.value = p;
        try { localStorage.setItem('devtools.lastMotionUrl', p); } catch { /* ignore */ }
        this._btlMotionClips = [];
        this._buildUi();
      },
    }, ['UAL2 motion']);

    const btlUseMotionUrlForAllBtn = el('button', {
      title: 'Fill empty motionPath fields from Motion URL.',
      onclick: () => {
        const m = String(btl.motionUrl || '').trim();
        if (!m) return;
        for (const ent of Object.values(btl.clips || {})) {
          if (!ent || typeof ent !== 'object') continue;
          if (!String(ent.motionPath || '').trim()) ent.motionPath = m;
        }
        this._buildUi();
      },
    }, ['Use Motion URL for all']);

    // Clip library for motion assets (glb/fbx with multiple actions).
    const btlClipLibFilter = el('input', {
      placeholder: 'filter motion clips (e.g. walk, idle, jump, zombie)',
      value: '',
      oninput: () => this._buildUi(),
    });

    const btlClipLibList = (() => {
      const host = el('div', { class: 'scrollArea', style: { height: '180px', marginTop: '8px', whiteSpace: 'pre-wrap' } }, []);
      const clips = Array.isArray(this._btlMotionClips) ? this._btlMotionClips : [];
      if (!clips.length) {
        host.textContent = '(load clips to populate)';
        return host;
      }
      const q = String(btlClipLibFilter.value || '').trim().toLowerCase();
      const shown = clips
        .map((c) => String(c?.name || '').trim())
        .filter(Boolean)
        .filter((name) => !q || name.toLowerCase().includes(q))
        .slice(0, 500);
      if (!shown.length) {
        host.textContent = '(no matches)';
        return host;
      }
      host.appendChild(el('div', { class: 'muted', style: { marginBottom: '6px', whiteSpace: 'pre-wrap' } }, [
        `active slot: ${String(this._btlActiveClipKey || '(none)')}`,
        `showing: ${shown.length}`,
      ].join('\n')));
      for (const name of shown) {
        host.appendChild(el('button', {
          class: 'toolBtn',
          style: { marginTop: '6px' },
          title: this._btlActiveClipKey ? `Set ${this._btlActiveClipKey}.motionClip = ${name}` : 'Click a motionClip field first, then click a clip name',
          onclick: () => {
            const k = String(this._btlActiveClipKey || '').trim();
            if (!k) return;
            const ent = ensureBtlClip(k);
            ent.motionClip = name;
            this._buildUi();
          },
        }, [name]));
      }
      return host;
    })();

    const btlLoadClipsBtn = el('button', {
      class: 'primary',
      title: 'Reads action/clip names from Motion URL and populates the clip library.',
      onclick: async () => {
        try {
          const motionPath = String(btl.motionUrl || '').trim();
          if (!motionPath) throw new Error('Set Motion URL first');
          btlStatus.textContent = 'Loading motion clips...';
          const resp = await fetch('/__devtools_anim_list_clips', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              runner: String(btl.runner || 'conda_trellis'),
              blenderPath: String(btl.blenderPath || ''),
              motionPath,
            }),
          });
          const j = await resp.json();
          if (!j?.ok) throw new Error(String(j?.error || 'list clips failed'));
          this._btlMotionClips = Array.isArray(j?.clips) ? j.clips : [];
          btlStatus.textContent = `Loaded ${this._btlMotionClips.length} motion clip(s)`;
          this._buildUi();
        } catch (e) {
          this._btlMotionClips = [];
          btlStatus.textContent = `Load clips failed: ${e?.message || e}`;
          this._buildUi();
        }
      },
    }, ['Load clips']);

    const ensureBtlClip = (k) => {
      btl.clips = btl.clips && typeof btl.clips === 'object' ? btl.clips : {};
      btl.clips[k] = btl.clips[k] && typeof btl.clips[k] === 'object' ? btl.clips[k] : { motionPath: '', motionClip: '' };
      return btl.clips[k];
    };

    const normClipName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '').replace(/[-_.:]/g, '');
    const pickClipByAliases = (clips, aliases) => {
      const arr = Array.isArray(clips) ? clips : [];
      if (!arr.length) return '';
      const byNorm = new Map();
      for (const c of arr) {
        const name = String(c?.name || '').trim();
        if (!name) continue;
        byNorm.set(normClipName(name), name);
      }
      const want = Array.isArray(aliases) ? aliases : [];
      for (const a of want) {
        const hit = byNorm.get(normClipName(a));
        if (hit) return hit;
      }
      // substring fallback
      for (const a of want) {
        const key = normClipName(a);
        for (const name of byNorm.values()) {
          if (normClipName(name).includes(key)) return name;
        }
      }
      return '';
    };

    const btlAutoFillClipsBtn = el('button', {
      class: 'primary',
      title: 'Uses the loaded motion clip list to fill idle/walk/run/jump slots (best-effort).',
      onclick: () => {
        const clips = Array.isArray(this._btlMotionClips) ? this._btlMotionClips : [];
        if (!clips.length) {
          btlStatus.textContent = 'Auto-fill: load clips first.';
          return;
        }
        const aliases = {
          idle: ['idle', 'idle_no_loop', 'idle_foldarms_loop', 'zombie_idle_loop', 'stand', 'rest'],
          walk_fwd: ['walk_fwd', 'walkforward', 'walk_forward', 'walk', 'walk_carry_loop', 'zombie_walk_fwd_loop'],
          walk_back: ['walk_back', 'walkback', 'walkbackward', 'walk_backward'],
          walk_left: ['walk_left', 'walkleft', 'strafeleft', 'strafe_left'],
          walk_right: ['walk_right', 'walkright', 'straferight', 'strafe_right'],
          run_fwd: ['run_fwd', 'runforward', 'run_forward', 'run', 'jog', 'sprint'],
          run_back: ['run_back', 'runback', 'runbackward', 'run_backward'],
          run_left: ['run_left', 'runleft', 'run_strafeleft', 'strafeleft_run'],
          run_right: ['run_right', 'runright', 'run_straferight', 'straferight_run'],
          jump_start: ['jump_start', 'jumpstart', 'jump_takeoff', 'takeoff', 'ninjajump_start', 'jump'],
          jump_air: ['jump_air', 'jumpair', 'inair', 'air', 'fall', 'ninjajump_idle_loop'],
          jump_land: ['jump_land', 'jumpland', 'land', 'landing', 'ninjajump_land'],
        };
        let filled = 0;
        for (const [k, a] of Object.entries(aliases)) {
          const ent = ensureBtlClip(k);
          if (String(ent.motionClip || '').trim()) continue;
          const picked = pickClipByAliases(clips, a);
          if (picked) { ent.motionClip = picked; filled++; }
        }
        btlStatus.textContent = `Auto-fill: filled ${filled} slot(s)`;
        this._buildUi();
      },
    }, ['Auto-fill locomotion clips']);

    const btlClipRows = (() => {
      const keys = [
        'idle',
        'walk_fwd', 'walk_back', 'walk_left', 'walk_right',
        'run_fwd', 'run_back', 'run_left', 'run_right',
        'jump_start', 'jump_air', 'jump_land',
      ];
      const host = el('div', { class: 'card', style: { marginTop: '10px' } }, []);
      host.appendChild(el('div', { class: 'muted', style: { whiteSpace: 'pre-wrap' } }, [
        'Clips: motionPath is BVH/FBX/GLB. motionClip is optional (blank = first action).',
      ]));
      for (const k of keys) {
        const ent = ensureBtlClip(k);
        const motionPathEl = el('input', {
          value: String(ent.motionPath || ''),
          placeholder: 'motionPath (optional; leave blank to skip this clip)',
          oninput: (e) => { ent.motionPath = String(e.target.value || '').trim(); try { localStorage.setItem('devtools.lastMotionUrl', ent.motionPath); } catch { /* ignore */ } },
        });
        const motionClipEl = el('input', {
          value: String(ent.motionClip || ''),
          placeholder: 'motionClip (optional)',
          onfocus: () => { this._btlActiveClipKey = k; },
          onclick: () => { this._btlActiveClipKey = k; },
          oninput: (e) => { ent.motionClip = String(e.target.value || '').trim(); },
        });
        host.appendChild(el('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } }, [
          el('div', { class: 'muted', style: { flex: '0 0 90px' } }, [k]),
          motionPathEl,
          motionClipEl,
        ]));
      }
      return host;
    })();

    const btlUseMixamoIdleBtn = el('button', {
      title: 'Set idle clip to outputs/mixamo_idle.bvh',
      onclick: () => {
        const ent = ensureBtlClip('idle');
        ent.motionPath = 'outputs/mixamo_idle.bvh';
        ent.motionClip = '';
        try { localStorage.setItem('devtools.lastMotionUrl', ent.motionPath); } catch { /* ignore */ }
        this._buildUi();
      },
    }, ['Use Mixamo idle']);

    const btlStartBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { btlStartBtn.disabled = true; } catch { /* ignore */ }
        try {
          await this._bringToLife({
            inModelPath: st.modelUrl,
            autoRig: !!btl.autoRig,
            rigBackend: String(btl.rigBackend || 'rigify'),
            runner: String(btl.runner || 'conda_trellis'),
            blenderPath: String(btl.blenderPath || ''),
            mapPath: String(btl.mapUrl || ''),
            outName: String(btl.outName || '').trim(),
            includeMesh: Number(btl.includeMesh ?? 1) ? 1 : 0,
            exportFormat: String(btl.exportFormat || 'GLB'),
            clipsObj: btl.clips || {},
            statusEl: btlStatus,
            logEl: btlLog,
          });
        } catch (e) {
          btlStatus.textContent = `Bring-to-life failed: ${e?.message || e}`;
        }
        try { btlStartBtn.disabled = false; } catch { /* ignore */ }
      },
    }, ['Bring to life (rig + locomotion)']);

    const btlOpenLocomotionBtn = el('button', {
      onclick: () => {
        const p = String(this._animJob?.outGlb || '').trim();
        if (!p) return;
        try { localStorage.setItem('devtools.lastGeneratedModelUrl', p); } catch { /* ignore */ }
        try { globalThis.__devtools?.setActiveTool?.('locomotion'); } catch { /* ignore */ }
      },
      title: 'Open the locomotion preview tool with the last output',
    }, ['Open in Locomotion tool']);

    const btlSendToMesh2MotionBtn = el('button', {
      title: 'Open Mesh2Motion tool with this model prefilled',
      onclick: () => {
        const p = String(st.modelUrl || this._rigJob?.outRig || '').trim();
        try {
          const payload = JSON.stringify({ modelUrl: p });
          localStorage.setItem('devtools.mesh2motion.prefill', payload);
        } catch { /* ignore */ }
        try { globalThis.__devtools?.setActiveTool?.('mesh2motion'); } catch { /* ignore */ }
      },
    }, ['Send to Mesh2Motion']);

    const btlKillBtn = el('button', {
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

    const assetPickMap = this._buildAssetPicker({
      title: 'Asset Picker (retarget map)',
      ext: '.json',
      onPick: (p) => { btl.mapUrl = p; btlMapUrl.value = p; try { localStorage.setItem('devtools.lastAnimMapUrl', p); } catch { /* ignore */ } },
      allowEmptyQuery: true,
    });

    // Rigging
    const rigRunner = el('select', {
      value: st.rigRunner,
      onchange: (e) => { st.rigRunner = String(e.target.value || 'conda_trellis'); },
    }, [
      el('option', { value: 'conda_trellis' }, ['conda_trellis']),
      el('option', { value: 'python3' }, ['python3']),
    ]);

    const rigBackend = el('select', {
      value: st.rigBackend,
      onchange: (e) => { st.rigBackend = String(e.target.value || ''); },
    }, [
      el('option', { value: 'rigify' }, ['rigify']),
      el('option', { value: 'blenrig' }, ['blenrig']),
      el('option', { value: 'rigacar' }, ['rigacar']),
      el('option', { value: 'unirig' }, ['unirig']),
      el('option', { value: 'riganything' }, ['riganything']),
      el('option', { value: 'rignet' }, ['rignet']),
    ]);

    const rigArgs = el('input', {
      value: st.rigArgs,
      placeholder: 'extra args for tools/rig_asset.py (optional)',
      oninput: (e) => { st.rigArgs = String(e.target.value || ''); },
    });

    const blenderPath = el('input', {
      value: st.blenderPath,
      placeholder: 'blender executable path (optional, e.g. /usr/bin/blender)',
      oninput: (e) => {
        st.blenderPath = String(e.target.value || '').trim();
        try { localStorage.setItem('devtools.lastRigBlenderPath', st.blenderPath); } catch { /* ignore */ }
      },
    });

    const rigOutName = el('input', {
      value: st.rigOutName,
      placeholder: 'optional output name hint (e.g. hero)',
      oninput: (e) => { st.rigOutName = String(e.target.value || '').trim(); },
    });

    const rigAutoLoad = el('input', {
      type: 'checkbox',
      checked: !!st.rigJobAutoLoad,
      onchange: (e) => { st.rigJobAutoLoad = e.target.checked ? 1 : 0; },
    });

    const rigStatus = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    const rigLog = el('div', { class: 'scrollArea', style: { height: '160px', marginTop: '8px', whiteSpace: 'pre' } }, ['(no job yet)']);

    const rigStartBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { rigStartBtn.disabled = true; } catch { /* ignore */ }
        try {
          await this._startRigJob({
            inModelPath: st.modelUrl,
            runner: st.rigRunner,
            rigBackend: st.rigBackend,
            rigArgs: st.rigArgs,
            blenderPath: st.blenderPath,
            outName: st.rigOutName,
            statusEl: rigStatus,
            logEl: rigLog,
            autoLoad: !!st.rigJobAutoLoad,
          });
        } catch (e) {
          ctx?.log?.(`Rig: start failed: ${e?.message || e}`);
          rigStatus.textContent = `Rig start failed: ${e?.message || e}`;
        }
        try { rigStartBtn.disabled = false; } catch { /* ignore */ }
      },
    }, ['Auto-rig']);

    const rigKillBtn = el('button', {
      class: 'danger',
      onclick: async () => {
        const id = String(this._rigJob?.id || '');
        if (!id) return;
        try {
          await fetch('/__devtools_rig_kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
        } catch { /* ignore */ }
        this._pollingRig = false;
      },
    }, ['Kill job']);

    const rigCopyBtn = el('button', {
      onclick: async () => {
        const p = String(this._rigJob?.outRig || '');
        if (!p) return;
        try { await navigator.clipboard.writeText(p); ctx?.log?.('Rig: copied output path'); } catch { /* ignore */ }
      },
    }, ['Copy output']);

    const rigOpenViewerBtn = el('button', {
      class: 'primary',
      title: 'Open the rig output in the Model Viewer',
      onclick: () => {
        const p = String(this._rigJob?.outRig || '').trim();
        if (!p) return;
        try { localStorage.setItem('devtools.lastGeneratedModelUrl', p); } catch { /* ignore */ }
        try { globalThis.__devtools?.setActiveTool?.('model_viewer'); } catch { /* ignore */ }
      },
    }, ['Open in viewer']);

    const rigSetGameplayAvatarBtn = el('button', {
      title: 'Set this rig as the gameplay avatar (writes gameplay.avatarUrl)',
      onclick: () => {
        const p = String(this._rigJob?.outRig || '').trim();
        if (!p) return;
        try { localStorage.setItem('gameplay.avatarUrl', p); } catch { /* ignore */ }
        ctx?.toast?.('Set gameplay avatar to rig output', 'success', { title: 'Rigging' });
      },
    }, ['Set gameplay avatar']);

    const assetPickModel = this._buildAssetPicker({
      title: 'Asset Picker (model)',
      ext: '.glb,.gltf',
      onPick: (p) => { st.modelUrl = p; modelUrl.value = p; },
    });

    // Outfit
    const outfitRunner = el('select', {
      value: st.outfitRunner,
      onchange: (e) => { st.outfitRunner = String(e.target.value || 'conda_trellis'); },
    }, [
      el('option', { value: 'conda_trellis' }, ['conda_trellis']),
      el('option', { value: 'python3' }, ['python3']),
    ]);

    const outfitBaseRig = el('input', {
      value: st.outfitBaseRigUrl,
      placeholder: 'base rig path (e.g. assets/generated/rig/hero_...glb)',
      oninput: (e) => { st.outfitBaseRigUrl = String(e.target.value || '').trim(); },
    });

    const outfitClothes = el('textarea', {
      value: st.outfitClothesText,
      placeholder: 'clothing asset paths (one per line)\nassets/generated/trellis/shirt.glb\nassets/generated/trellis/pants.glb',
      oninput: (e) => { st.outfitClothesText = String(e.target.value || ''); },
      style: { height: '92px', resize: 'vertical' },
    });

    const outfitArgs = el('input', {
      value: st.outfitArgs,
      placeholder: 'extra args for tools/outfit_asset.py (optional)',
      oninput: (e) => { st.outfitArgs = String(e.target.value || ''); },
    });

    const outfitBlenderPath = el('input', {
      value: st.outfitBlenderPath,
      placeholder: 'blender executable path (optional, e.g. /usr/bin/blender)',
      oninput: (e) => {
        st.outfitBlenderPath = String(e.target.value || '').trim();
        try { localStorage.setItem('devtools.lastOutfitBlenderPath', st.outfitBlenderPath); } catch { /* ignore */ }
      },
    });

    const outfitOutName = el('input', {
      value: st.outfitOutName,
      placeholder: 'optional output name hint (e.g. hero_outfit1)',
      oninput: (e) => { st.outfitOutName = String(e.target.value || '').trim(); },
    });

    const outfitAutoLoad = el('input', {
      type: 'checkbox',
      checked: !!st.outfitJobAutoLoad,
      onchange: (e) => { st.outfitJobAutoLoad = e.target.checked ? 1 : 0; },
    });

    const outfitStatus = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    const outfitLog = el('div', { class: 'scrollArea', style: { height: '160px', marginTop: '8px', whiteSpace: 'pre' } }, ['(no job yet)']);

    const outfitStartBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { outfitStartBtn.disabled = true; } catch { /* ignore */ }
        try {
          await this._startOutfitJob({
            runner: st.outfitRunner,
            baseRigPath: st.outfitBaseRigUrl || st.modelUrl,
            clothesText: st.outfitClothesText,
            outfitArgs: st.outfitArgs,
            blenderPath: st.outfitBlenderPath,
            outName: st.outfitOutName,
            statusEl: outfitStatus,
            logEl: outfitLog,
            autoLoad: !!st.outfitJobAutoLoad,
          });
        } catch (e) {
          ctx?.log?.(`Outfit: start failed: ${e?.message || e}`);
          outfitStatus.textContent = `Outfit start failed: ${e?.message || e}`;
        }
        try { outfitStartBtn.disabled = false; } catch { /* ignore */ }
      },
    }, ['Build outfit']);

    const outfitKillBtn = el('button', {
      class: 'danger',
      onclick: async () => {
        const id = String(this._outfitJob?.id || '');
        if (!id) return;
        try {
          await fetch('/__devtools_outfit_kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
        } catch { /* ignore */ }
        this._pollingOutfit = false;
      },
    }, ['Kill job']);

    const outfitCopyBtn = el('button', {
      onclick: async () => {
        const p = String(this._outfitJob?.outGlb || '');
        if (!p) return;
        try { await navigator.clipboard.writeText(p); ctx?.log?.('Outfit: copied output path'); } catch { /* ignore */ }
      },
    }, ['Copy output']);

    const assetPickOutfitClothes = this._buildAssetPicker({
      title: 'Asset Picker (clothes)',
      ext: '.glb,.gltf',
      onPick: (p) => {
        const cur = String(st.outfitClothesText || '');
        const next = (cur.trim() ? (cur.replace(/\s+$/g, '') + '\n') : '') + p + '\n';
        st.outfitClothesText = next;
        outfitClothes.value = next;
      },
    });

    const btlAdvanced = detailsCard('Advanced', { open: false, hint: 'optional' }, [
      el('div', { class: 'row', style: { marginTop: '8px', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [btlAutoRig, el('span', { class: 'muted' }, ['Auto-rig (if needed)'])]),
        btl.autoRig ? el('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          el('span', { class: 'muted' }, ['backend']),
          btlRigBackend,
        ]) : null,
      ].filter(Boolean)),
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['retarget map']),
      btlMapUrl,
      assetPickMap,
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['motion URL (source helper)']),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, [
        btlMotionUrl,
        btlUseUal2MotionBtn,
        btlUseMotionUrlForAllBtn,
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, [
        btlLoadClipsBtn,
        btlAutoFillClipsBtn,
      ]),
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['motion clip library']),
      btlClipLibFilter,
      btlClipLibList,
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['outName']), btlOutName]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [btlIncludeMesh, el('span', { class: 'muted' }, ['include mesh'])]),
        el('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [el('span', { class: 'muted' }, ['export']), btlExportFormat]),
      ]),
      btlClipRows,
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['runner']),
      btlRunner,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['blenderPath (optional)']),
      btlBlenderPath,
    ]);

    root.appendChild(detailsCard('Bring to life', { open: true, hint: 'character → locomotion' }, [
      el('div', { class: 'muted', style: { whiteSpace: 'pre-wrap' } }, [
        'Goal: take a character model and produce a single GLB with locomotion clips, then preview it in the Locomotion tool.',
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
        modelUrl,
        useLastBtn,
      ]),
      el('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } }, [
        btlStartBtn,
        btlKillBtn,
        btlOpenLocomotionBtn,
        btlSendToMesh2MotionBtn,
        btlUseMixamoIdleBtn,
      ]),
      btlStatus,
      btlLog,
      btlAdvanced,
    ]));

    root.appendChild(detailsCard('Input', { open: false, hint: 'context' }, [
      el('div', { class: 'muted' }, ['Pick the mesh/model you want to rig (or use the last output).']),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } }, [modelUrl, useLastBtn]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } }, [copyBtn(st.modelUrl)]),
    ]));

    root.appendChild(assetPickModel);

    root.appendChild(detailsCard('Rigging (advanced)', { open: false, hint: 'pipeline' }, [
      el('div', { class: 'muted' }, ['Auto-rig a mesh and export a runtime-friendly GLB.']),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['backend']),
      rigBackend,
      el('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } }, [
        rigStartBtn,
        rigKillBtn,
        rigCopyBtn,
        rigOpenViewerBtn,
        rigSetGameplayAvatarBtn,
      ]),
      rigStatus,
      rigLog,
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Advanced']),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['runner']),
      rigRunner,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['blenderPath (optional)']),
      blenderPath,
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['outName']), rigOutName]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [rigArgs]),
      el('div', { class: 'row', style: { marginTop: '8px', alignItems: 'center' } }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          rigAutoLoad,
          el('div', { class: 'muted' }, ['Auto-open output in viewer']),
        ]),
      ]),
    ]));

    root.appendChild(detailsCard('Outfit / Clothing (advanced)', { open: false, hint: 'attach' }, [
      el('div', { class: 'muted' }, ['Attach one or more clothing meshes onto a rigged base GLB.']),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [outfitStartBtn, outfitKillBtn, outfitCopyBtn, openInViewerBtn(this._outfitJob?.outGlb || '')]),
      outfitStatus,
      outfitLog,
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Inputs']),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['baseRigPath']),
      outfitBaseRig,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['clothesPaths']),
      outfitClothes,
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Advanced']),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['runner']),
      outfitRunner,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['blenderPath (optional)']),
      outfitBlenderPath,
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['outName']), outfitOutName]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [outfitArgs]),
      el('div', { class: 'row', style: { marginTop: '8px', alignItems: 'center' } }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          outfitAutoLoad,
          el('div', { class: 'muted' }, ['Auto-open output in viewer']),
        ]),
      ]),
    ]));

    root.appendChild(assetPickOutfitClothes);
  }

  _buildAssetPicker({ title, ext, onPick, allowEmptyQuery = false }) {
    const ctx = this._ctx;
    const queryInput = el('input', { placeholder: allowEmptyQuery ? 'search assets (optional; empty to list)' : 'search assets (e.g. character)' });
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

  async _startRigJob({ inModelPath, runner, rigBackend, rigArgs, blenderPath, outName, statusEl, logEl, autoLoad }) {
    const ctx = this._ctx;
    const u = String(inModelPath || '').trim();
    if (!u) throw new Error('Load or enter a model path first');
    const backend = String(rigBackend || '').trim();
    if (!backend) throw new Error('Missing rig backend');

    // UX preflight: we intentionally route USD → Convert → GLB first.
    const low = u.toLowerCase();
    const isUsd = low.endsWith('.usd') || low.endsWith('.usda') || low.endsWith('.usdc') || low.endsWith('.usdz');
    if (isUsd) {
      throw new Error('Rigging expects a GLB/GLTF (or FBX/OBJ/BLEND). Convert USD → GLB first, then auto-rig the GLB.');
    }

    const outHint = String(outName || '').trim() || (String(u).split('/').pop() || '').replace(/\.[^.]+$/g, '');

    this._rigJob = { id: '', status: 'running', stdout: '', stderr: '', outRig: '' };
    this._pollingRig = false;
    if (statusEl) statusEl.textContent = 'Starting rig job...';
    if (logEl) logEl.textContent = '(starting...)';

    const payload = {
      runner: String(runner || 'conda_trellis'),
      inModelPath: u,
      rigBackend: backend,
      rigArgs: String(rigArgs || ''),
      blenderPath: String(blenderPath || ''),
      outName: outHint,
    };
    const resp = await fetch('/__devtools_rig_start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'rig start failed'));

    this._rigJob.id = String(j.id || '');
    this._rigJob.outRig = String(j.outRig || '');
    this._pollingRig = true;
    void this._pollRigLoop({ id: this._rigJob.id, statusEl, logEl, autoLoad: !!autoLoad });
    ctx?.log?.(`Rig: started (${backend})`);
  }

  async _pollRigLoop({ id, statusEl, logEl, autoLoad }) {
    const ctx = this._ctx;
    if (!id) return;
    let backoff = 400;
    while (this._pollingRig && this._rigJob?.id === id) {
      try {
        const resp = await fetch(`/__devtools_rig_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));
        this._rigJob.status = String(j.status || '');
        this._rigJob.stdout = String(j.stdout || '');
        this._rigJob.stderr = String(j.stderr || '');
        this._rigJob.outRig = String(j.outRig || this._rigJob.outRig || '');

        if (statusEl) statusEl.textContent = `Rig job: ${this._rigJob.status}${this._rigJob.outRig ? `\nOutput: ${this._rigJob.outRig}` : ''}`;
        if (logEl) {
          const out = this._rigJob.stdout || '';
          const err = this._rigJob.stderr || '';
          logEl.textContent = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output yet)';
          try { logEl.scrollTop = logEl.scrollHeight; } catch { /* ignore */ }
        }

        if (this._rigJob.status === 'done' || this._rigJob.status === 'error' || this._rigJob.status === 'killed') {
          this._pollingRig = false;
          if (this._rigJob.status === 'done') {
            const outRig = String(this._rigJob.outRig || '').trim();
            if (outRig) {
              try { localStorage.setItem('devtools.lastGeneratedModelUrl', outRig); } catch { /* ignore */ }
              ctx?.log?.(`Rig: done → ${outRig}`);
              if (autoLoad) {
                try { globalThis.__devtools?.setActiveTool?.('model_viewer'); } catch { /* ignore */ }
              }
            }
          }
          return;
        }

        backoff = 500;
      } catch (e) {
        if (statusEl) statusEl.textContent = `Rig polling failed: ${e?.message || e}`;
        backoff = Math.min(2000, Math.floor(backoff * 1.4));
      }
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  async _startOutfitJob({ runner, baseRigPath, clothesText, outfitArgs, blenderPath, outName, statusEl, logEl, autoLoad }) {
    const ctx = this._ctx;
    const baseRig = String(baseRigPath || '').trim();
    const clothesPathsText = String(clothesText || '').trim();
    if (!baseRig) throw new Error('Missing base rig path');
    if (!clothesPathsText) throw new Error('Missing clothes paths');

    this._outfitJob = { id: '', status: 'running', stdout: '', stderr: '', outGlb: '' };
    this._pollingOutfit = false;
    if (statusEl) statusEl.textContent = 'Starting outfit job...';
    if (logEl) logEl.textContent = '(starting...)';

    const payload = {
      runner: String(runner || 'conda_trellis'),
      baseRigPath: baseRig,
      clothesPathsText,
      outfitArgs: String(outfitArgs || ''),
      blenderPath: String(blenderPath || ''),
      outName: String(outName || ''),
    };

    const resp = await fetch('/__devtools_outfit_start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'outfit start failed'));

    this._outfitJob.id = String(j.id || '');
    this._outfitJob.outGlb = String(j.outGlb || '');
    this._pollingOutfit = true;
    void this._pollOutfitLoop({ id: this._outfitJob.id, statusEl, logEl, autoLoad: !!autoLoad });
    ctx?.log?.('Outfit: started');
  }

  async _pollOutfitLoop({ id, statusEl, logEl, autoLoad }) {
    const ctx = this._ctx;
    if (!id) return;
    let backoff = 400;
    while (this._pollingOutfit && this._outfitJob?.id === id) {
      try {
        const resp = await fetch(`/__devtools_outfit_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));
        this._outfitJob.status = String(j.status || '');
        this._outfitJob.stdout = String(j.stdout || '');
        this._outfitJob.stderr = String(j.stderr || '');
        this._outfitJob.outGlb = String(j.outGlb || this._outfitJob.outGlb || '');

        if (statusEl) statusEl.textContent = `Outfit job: ${this._outfitJob.status}${this._outfitJob.outGlb ? `\nOutput: ${this._outfitJob.outGlb}` : ''}`;
        if (logEl) {
          const out = this._outfitJob.stdout || '';
          const err = this._outfitJob.stderr || '';
          logEl.textContent = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output yet)';
          try { logEl.scrollTop = logEl.scrollHeight; } catch { /* ignore */ }
        }

        if (this._outfitJob.status === 'done' || this._outfitJob.status === 'error' || this._outfitJob.status === 'killed') {
          this._pollingOutfit = false;
          if (this._outfitJob.status === 'done') {
            const outGlb = String(this._outfitJob.outGlb || '').trim();
            if (outGlb) {
              try { localStorage.setItem('devtools.lastGeneratedModelUrl', outGlb); } catch { /* ignore */ }
              ctx?.log?.(`Outfit: done → ${outGlb}`);
              if (autoLoad) {
                try { globalThis.__devtools?.setActiveTool?.('model_viewer'); } catch { /* ignore */ }
              }
            }
          }
          return;
        }

        backoff = 500;
      } catch (e) {
        if (statusEl) statusEl.textContent = `Outfit polling failed: ${e?.message || e}`;
        backoff = Math.min(2000, Math.floor(backoff * 1.4));
      }
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  async _bringToLife({ inModelPath, autoRig, rigBackend, runner, blenderPath, mapPath, outName, includeMesh, exportFormat, clipsObj, statusEl, logEl }) {
    const ctx = this._ctx;
    const u = String(inModelPath || '').trim();
    if (!u) throw new Error('Missing modelUrl');
    const mapUrl = String(mapPath || '').trim();
    if (!mapUrl) throw new Error('Missing mapUrl');

    // 1) Ensure we have a rigPath (either use the input model, or auto-rig it).
    let rigPath = u;
    if (autoRig) {
      if (statusEl) statusEl.textContent = 'Step 1/2: auto-rigging...';
      // Start rig job (no auto-load; we chain into locomotion pack).
      await this._startRigJob({
        inModelPath: u,
        runner,
        rigBackend,
        rigArgs: '--deform-only',
        blenderPath,
        outName: String(outName || '').trim() || '',
        statusEl,
        logEl,
        autoLoad: false,
      });
      rigPath = await this._waitForRigDone({ id: String(this._rigJob?.id || ''), statusEl, logEl });
    }

    // 2) Build locomotion pack (batch retarget).
    const clips = [];
    for (const [clipName, ent] of Object.entries(clipsObj || {})) {
      const motionPath = String(ent?.motionPath || '').trim();
      if (!motionPath) continue; // allow skipping clips for UX
      const motionClip = String(ent?.motionClip || '').trim();
      clips.push({ clipName, motionPath, motionClip });
    }
    if (!clips.length) throw new Error('No clips configured (set at least idle.motionPath)');

    this._animJob = { id: '', status: 'running', stdout: '', stderr: '', outGlb: '' };
    this._pollingAnim = false;
    if (statusEl) statusEl.textContent = 'Step 2/2: building locomotion pack...';
    if (logEl) logEl.textContent = '(starting...)';

    const payload = {
      runner: String(runner || 'conda_trellis'),
      blenderPath: String(blenderPath || ''),
      rigPath,
      mapPath: mapUrl,
      clips,
      exportFormat: String(exportFormat || 'GLB'),
      includeMesh: Number(includeMesh ?? 1) ? 1 : 0,
      outName: String(outName || '').trim(),
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
    void this._pollAnimLoop({ id: this._animJob.id, statusEl, logEl, autoLoad: true });
    ctx?.log?.('Rigging: bring-to-life started');
  }

  async _waitForRigDone({ id, statusEl, logEl }) {
    const ctx = this._ctx;
    const jobId = String(id || '').trim();
    if (!jobId) throw new Error('Missing rig job id');
    let backoff = 500;
    while (true) {
      const resp = await fetch(`/__devtools_rig_job?id=${encodeURIComponent(jobId)}`);
      const j = await resp.json();
      if (!j?.ok) throw new Error(String(j?.error || 'rig job query failed'));
      const status = String(j.status || '');
      const outRig = String(j.outRig || '').trim();
      if (statusEl) statusEl.textContent = `Rig job: ${status}${outRig ? `\nRig: ${outRig}` : ''}`;
      if (logEl) {
        const out = String(j.stdout || '');
        const err = String(j.stderr || '');
        logEl.textContent = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output yet)';
        try { logEl.scrollTop = logEl.scrollHeight; } catch { /* ignore */ }
      }
      if (status === 'done') {
        if (!outRig) throw new Error('Rig job finished but produced no output');
        try { localStorage.setItem('devtools.lastGeneratedModelUrl', outRig); } catch { /* ignore */ }
        ctx?.log?.(`Rigging: rig done → ${outRig}`);
        return outRig;
      }
      if (status === 'error' || status === 'killed') throw new Error(`Rig job ${status}`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(1500, Math.floor(backoff * 1.2));
    }
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

        if (statusEl) statusEl.textContent = `Locomotion pack: ${this._animJob.status}${this._animJob.outGlb ? `\nOutput: ${this._animJob.outGlb}` : ''}`;
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
              try { localStorage.setItem('gameplay.avatarUrl', outGlb); } catch { /* ignore */ }
              ctx?.toast?.('Character brought to life (locomotion pack built + set as gameplay avatar)', 'success', { title: 'Rigging' });
              if (autoLoad) {
                try { globalThis.__devtools?.setActiveTool?.('locomotion'); } catch { /* ignore */ }
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

