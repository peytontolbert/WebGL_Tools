import { el, clear, clamp } from '../../ui/dom.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

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

function resizeCanvasToDisplaySize(canvasEl, maxDpr = 2.0) {
  const dpr = Math.min(maxDpr, window.devicePixelRatio || 1);
  const rect = canvasEl.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (canvasEl.width !== w || canvasEl.height !== h) {
    canvasEl.width = w;
    canvasEl.height = h;
    return { changed: true, dpr, w, h };
  }
  return { changed: false, dpr, w: canvasEl.width, h: canvasEl.height };
}

function disposeThreeObject(obj) {
  if (!obj) return;
  obj.traverse?.((n) => {
    if (n?.geometry) {
      try { n.geometry.dispose?.(); } catch { /* ignore */ }
    }
    const mat = n?.material;
    const mats = Array.isArray(mat) ? mat : (mat ? [mat] : []);
    for (const m of mats) {
      if (!m) continue;
      for (const k of ['map', 'normalMap', 'metalnessMap', 'roughnessMap', 'emissiveMap', 'aoMap']) {
        const t = m[k];
        if (t && t.isTexture) {
          try { t.dispose?.(); } catch { /* ignore */ }
        }
      }
      try { m.dispose?.(); } catch { /* ignore */ }
    }
  });
}

function isUsdExt(ext) {
  return ext === '.usd' || ext === '.usda' || ext === '.usdc' || ext === '.usdz';
}

function collectSkeletonBones(modelRoot) {
  /** @type {THREE.Bone[]} */
  const bones = [];
  if (!modelRoot) return bones;
  modelRoot.traverse?.((n) => {
    const sk = /** @type {any} */ (n);
    const s = sk?.skeleton;
    const b = s?.bones;
    if (Array.isArray(b)) {
      for (const bone of b) {
        if (bone && bone.isBone) bones.push(bone);
      }
    }
  });
  // De-dupe by UUID (multiple skinned meshes can share a skeleton).
  const seen = new Set();
  return bones.filter((b) => {
    const id = String(b.uuid || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function pickDefaultRootBone(bones) {
  if (!Array.isArray(bones) || bones.length === 0) return null;
  // Common conventions: root / hips / pelvis
  const prefer = ['root', 'hips', 'pelvis', 'armature', 'mixamorighips', 'mixamorig:hips'];
  const lower = (s) => String(s || '').trim().toLowerCase();
  for (const key of prefer) {
    const hit = bones.find((b) => lower(b.name) === key);
    if (hit) return hit;
  }
  // Else: pick the highest bone in hierarchy (closest to skeleton root).
  let best = bones[0];
  let bestDepth = Infinity;
  for (const b of bones) {
    let d = 0;
    let cur = b;
    while (cur?.parent && cur.parent.isBone && d < 256) { cur = cur.parent; d++; }
    if (d < bestDepth) { bestDepth = d; best = b; }
  }
  return best || bones[0] || null;
}

export class LocomotionTool {
  constructor() {
    this.id = 'locomotion';
    this.label = 'Locomotion';

    this._ctx = null;
    this._root = null;

    this._canvas = null;
    this._renderer = null;
    this._scene = null;
    this._camera = null;
    this._controls = null;
    this._clock = new THREE.Clock();

    this._gltf = null;
    this._modelRoot = null;
    this._mixer = null;
    this._activeAction = null;

    /** @type {THREE.Bone[]} */
    this._bones = [];
    /** @type {THREE.Bone|null} */
    this._rootBone = null;

    // Root-motion bookkeeping (we track the raw bone world pos after mixer update)
    this._rmPrevRawWorld = new THREE.Vector3();
    this._rmHasPrev = false;
    this._rmDistance = 0;
    this._rmSpeed = 0;

    // Debug path line
    this._pathPts = [];
    this._pathLine = null;

    this._state = {
      modelUrl: '',
      playing: true,
      speed: 1.0,
      animName: '',

      // Clip library UI (for large multi-clip assets like AnimGraph)
      clipLibVendor: 'all', // all | nvidia | other
      clipLibMax: 200,

      // Locomotion controls
      applyRootMotion: true,
      cancelBoneTranslation: true,
      rootBoneName: '',
      drawPath: true,
      pathMaxPoints: 600,
    };

    // UI refs
    this._uiModelUrlEl = null;
    this._uiAnimSelEl = null;
    this._uiRootBoneSelEl = null;
    this._uiStatsEl = null;

    // Motion-clip library UI
    this._uiClipLibFilterEl = null;
    this._uiClipLibVendorEl = null;
    this._uiClipLibListEl = null;
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;

    // Default from shared key (same as viewer/anim tools).
    try {
      const saved = String(localStorage.getItem('devtools.lastGeneratedModelUrl') || '').trim();
      if (saved && !String(this._state.modelUrl || '').trim()) this._state.modelUrl = saved;
    } catch { /* ignore */ }

    this._canvas = document.createElement('canvas');
    this._canvas.style.width = '100%';
    this._canvas.style.height = '100%';
    ctx.canvasHost.appendChild(this._canvas);

    const renderer = new THREE.WebGLRenderer({
      canvas: this._canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    renderer.setClearColor(new THREE.Color(0x07090d), 1.0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this._renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x07090d);
    this._scene = scene;

    const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 200000);
    camera.position.set(3.0, 2.2, 4.0);
    this._camera = camera;

    const controls = new OrbitControls(camera, this._canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.target.set(0, 1, 0);
    this._controls = controls;

    // Lights + grid
    scene.add(new THREE.HemisphereLight(0xdde8ff, 0x1a2230, 0.95));
    const dir = new THREE.DirectionalLight(0xffffff, 1.05);
    dir.position.set(6, 10, 4);
    scene.add(dir);
    const grid = new THREE.GridHelper(10, 10, 0x3a4a64, 0x223046);
    grid.material.opacity = 0.55;
    grid.material.transparent = true;
    scene.add(grid);
    scene.add(new THREE.AxesHelper(1.0));

    this._buildUi();

    // Auto-load on mount if we have a URL.
    try {
      const u = String(this._state.modelUrl || '').trim();
      if (u) await this._loadModel(u);
    } catch (e) {
      ctx?.log?.(`Locomotion: auto-load failed: ${e?.message || e}`);
    }
  }

  async unmount() {
    try { this._clearModel(); } catch { /* ignore */ }
    try { this._controls?.dispose?.(); } catch { /* ignore */ }
    try { this._renderer?.dispose?.(); } catch { /* ignore */ }

    this._controls = null;
    this._renderer = null;
    this._scene = null;
    this._camera = null;
    this._ctx = null;
    this._root = null;

    if (this._canvas?.parentNode) this._canvas.parentNode.removeChild(this._canvas);
    this._canvas = null;
  }

  tick(dt) {
    if (!this._renderer || !this._scene || !this._camera || !this._canvas) return;

    const { dpr, w, h } = resizeCanvasToDisplaySize(this._canvas, 2.0);
    this._renderer.setPixelRatio(dpr);
    this._renderer.setSize(w / dpr, h / dpr, false);
    this._camera.aspect = Math.max(1e-6, w / Math.max(1e-6, h));
    this._camera.updateProjectionMatrix();

    this._controls?.update?.();

    const delta = Math.max(0, Math.min(0.25, Number(dt) || 0));
    if (this._mixer && this._state.playing) {
      const s = clamp(this._state.speed, 0.0, 10.0);
      this._mixer.update(delta * s);
    }

    // Root motion extraction/apply (after mixer update).
    this._updateRootMotion(delta);

    this._renderer.render(this._scene, this._camera);
  }

  getStats() {
    return {
      model: this._state.modelUrl || '',
      anim: this._state.animName || '',
      rm: this._state.applyRootMotion ? `${this._rmSpeed.toFixed(2)} m/s` : '',
    };
  }

  _buildUi() {
    if (!this._root) return;
    clear(this._root);
    const ctx = this._ctx;
    const st = this._state;

    const detailsCard = (title, { open = true, hint = '' } = {}, children = []) => el('details', { class: 'card', open: !!open }, [
      el('summary', {}, [
        el('div', { class: 'dockTitle' }, [String(title || 'Section')]),
        hint ? el('div', { class: 'muted', style: { marginLeft: 'auto', textAlign: 'right' } }, [String(hint)]) : el('div', {}),
      ]),
      el('div', { class: 'cardBody' }, children),
    ]);

    const assetPicker = ({ title, ext, onPick, allowEmptyQuery = false }) => {
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
            if (!p) continue;
            list.appendChild(el('button', {
              class: 'toolBtn',
              style: { marginTop: '6px' },
              onclick: () => onPick(p),
              title: p,
            }, [p]));
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
    };

    const modelUrl = el('input', {
      value: st.modelUrl,
      placeholder: 'assets/.../model.glb (or .usd/.fbx)',
      oninput: (e) => { st.modelUrl = String(e.target.value || '').trim(); },
    });
    this._uiModelUrlEl = modelUrl;

    const loadBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { await this._loadModel(st.modelUrl); }
        catch (e) { ctx?.log?.(`Locomotion: load failed: ${e?.message || e}`); }
      },
    }, ['Load']);

    const useLastBtn = el('button', {
      onclick: async () => {
        try {
          const saved = String(localStorage.getItem('devtools.lastGeneratedModelUrl') || '').trim();
          if (!saved) return;
          st.modelUrl = saved;
          if (this._uiModelUrlEl) this._uiModelUrlEl.value = saved;
          await this._loadModel(saved);
        } catch (e) {
          ctx?.log?.(`Locomotion: load last failed: ${e?.message || e}`);
        }
      },
      title: 'Load devtools.lastGeneratedModelUrl',
    }, ['Use last output']);

    const playing = el('input', {
      type: 'checkbox',
      checked: !!st.playing,
      onchange: (e) => { st.playing = !!e.target.checked; },
    });

    const speed = el('input', {
      type: 'number',
      value: String(st.speed),
      min: '0',
      max: '10',
      step: '0.05',
      oninput: (e) => { st.speed = clamp(Number(e.target.value) || 1.0, 0.0, 10.0); },
    });

    const animSel = el('select', {
      value: st.animName,
      onchange: (e) => { this._setAnimation(String(e.target.value || '')); },
    }, [
      el('option', { value: '' }, ['(no animation)']),
    ]);
    this._uiAnimSelEl = animSel;

    const clipLibFilter = el('input', {
      placeholder: 'filter clips (e.g. walk, run, strafe, 10010)',
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

    const clipLibList = el('div', { class: 'scrollArea', style: { height: '200px', marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['(no model loaded)']);
    this._uiClipLibListEl = clipLibList;

    const applyRootMotion = el('input', {
      type: 'checkbox',
      checked: !!st.applyRootMotion,
      onchange: (e) => { st.applyRootMotion = !!e.target.checked; },
    });

    const cancelBone = el('input', {
      type: 'checkbox',
      checked: !!st.cancelBoneTranslation,
      onchange: (e) => { st.cancelBoneTranslation = !!e.target.checked; },
      title: 'Subtract root-bone translation so motion moves the character in world space (less “double transform”)',
    });

    const rootBoneSel = el('select', {
      value: st.rootBoneName || '',
      onchange: (e) => {
        st.rootBoneName = String(e.target.value || '');
        this._applyRootBoneFromState();
      },
    }, [
      el('option', { value: '' }, ['(auto)']),
    ]);
    this._uiRootBoneSelEl = rootBoneSel;

    const drawPath = el('input', {
      type: 'checkbox',
      checked: !!st.drawPath,
      onchange: (e) => { st.drawPath = !!e.target.checked; this._syncPathVisible(); },
    });

    const resetBtn = el('button', {
      onclick: () => {
        this._resetRootMotionState();
        ctx?.toast?.('Locomotion reset', 'info');
      },
    }, ['Reset']);

    const statsEl = el('div', { class: 'scrollArea', style: { height: '92px', marginTop: '8px', whiteSpace: 'pre' } }, ['(no model loaded)']);
    this._uiStatsEl = statsEl;

    this._root.appendChild(detailsCard('Inputs', { open: true, hint: 'viewer' }, [
      el('div', { class: 'muted', style: { whiteSpace: 'pre-wrap' } }, [
        'This tool previews a single animation clip and optionally extracts/applies root motion.\n' +
        'If your character is a T-pose rig with no clips, generate animations first via “Animation / Retarget”.',
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } }, [modelUrl, loadBtn]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } }, [useLastBtn]),
    ]));

    this._root.appendChild(assetPicker({
      title: 'Asset Picker (character / motion asset)',
      ext: '.glb,.gltf,.fbx,.usd,.usda,.usdc,.usdz',
      allowEmptyQuery: true,
      onPick: async (p) => {
        try {
          st.modelUrl = p;
          if (this._uiModelUrlEl) this._uiModelUrlEl.value = p;
          await this._loadModel(p);
        } catch (e) {
          ctx?.log?.(`Locomotion: load failed: ${e?.message || e}`);
        }
      },
    }));

    this._root.appendChild(detailsCard('Animation', { open: true, hint: 'preview' }, [
      el('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          playing,
          el('div', { class: 'muted' }, ['Playing']),
        ]),
        el('div', {}, [el('div', { class: 'muted' }, ['Speed']), speed]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Clip']),
      animSel,
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Clip library (loaded asset)']),
      el('div', { class: 'row', style: { marginTop: '6px', gap: '8px' } }, [clipLibFilter, clipLibVendor]),
      clipLibList,
    ]));

    this._root.appendChild(detailsCard('Locomotion', { open: true, hint: 'root motion' }, [
      el('div', { class: 'muted' }, [
        'This extracts the selected root bone’s translation per-frame and can apply it to the character in world space.',
      ]),
      el('div', { class: 'row', style: { marginTop: '10px', gap: '12px', alignItems: 'center', flexWrap: 'wrap' } }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center', flex: '0 0 auto' } }, [
          applyRootMotion,
          el('div', { class: 'muted' }, ['Apply root motion']),
        ]),
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center', flex: '0 0 auto' } }, [
          cancelBone,
          el('div', { class: 'muted' }, ['Cancel bone translation']),
        ]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Root bone']),
      rootBoneSel,
      el('div', { class: 'row', style: { marginTop: '10px', gap: '12px', alignItems: 'center' } }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          drawPath,
          el('div', { class: 'muted' }, ['Draw path']),
        ]),
        resetBtn,
      ]),
      statsEl,
    ]));

    // Populate selectors if we already have a model loaded.
    this._refreshAnimSelect();
    this._refreshRootBoneSelect();
    this._syncClipLibrary();
    this._syncStatsText();
  }

  _syncClipLibrary() {
    const host = this._uiClipLibListEl;
    if (!host) return;
    clear(host);

    const clips = Array.isArray(this._gltf?.animations) ? this._gltf.animations : [];
    if (!clips.length) {
      host.appendChild(el('div', { class: 'muted', style: { whiteSpace: 'pre-wrap' } }, [
        '(no animations in loaded asset)\n' +
        'To add idle/walk/run to a T-pose rig, open “Animation / Retarget” and build a locomotion pack.',
      ]));
      const btnRow = el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
        el('button', {
          class: 'primary',
          onclick: () => {
            try { localStorage.setItem('devtools.lastGeneratedModelUrl', String(this._state?.modelUrl || '').trim()); } catch { /* ignore */ }
            try { globalThis.__devtools?.setActiveTool?.('animation'); } catch { /* ignore */ }
            try { this._ctx?.toast?.('Opened Animation / Retarget (rig set from current model)', 'info', { title: 'Locomotion' }); } catch { /* ignore */ }
          },
          title: 'Open Animation / Retarget and use current model as rigPath',
        }, ['Open Animation / Retarget']),
        el('button', {
          onclick: () => {
            try { localStorage.setItem('devtools.lastGeneratedModelUrl', String(this._state?.modelUrl || '').trim()); } catch { /* ignore */ }
            try { localStorage.setItem('devtools.lastMotionUrl', 'outputs/mixamo_idle.bvh'); } catch { /* ignore */ }
            try { globalThis.__devtools?.setActiveTool?.('animation'); } catch { /* ignore */ }
            try { this._ctx?.toast?.('Set test motion BVH and opened Animation / Retarget', 'info', { title: 'Locomotion' }); } catch { /* ignore */ }
          },
          title: 'Sets motionPath to outputs/mixamo_idle.bvh (as a starting point)',
        }, ['Use test BVH']),
      ]);
      host.appendChild(btnRow);
      return;
    }

    const st = this._state;
    const q = String(this._uiClipLibFilterEl?.value || '').trim().toLowerCase();
    const vendor = String(st.clipLibVendor || 'all');
    const max = Math.max(20, Math.min(5000, Number(st.clipLibMax) || 200));
    const active = String(st.animName || '').trim();

    const all = clips.map((c) => {
      const name = String(c?.name || '').trim() || '(unnamed clip)';
      return { name, isNvidia: isNvidiaAnimName(name) };
    });
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
        onclick: () => this._setAnimation(name === '(unnamed clip)' ? '' : name),
        title: 'Click to play this clip',
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

  _syncStatsText() {
    const elStats = this._uiStatsEl;
    if (!elStats) return;
    if (!this._modelRoot) {
      elStats.textContent = '(no model loaded)';
      return;
    }
    const p = this._modelRoot.position;
    const bone = this._rootBone;
    const boneName = bone ? String(bone.name || '') : '(none)';
    elStats.textContent = [
      `rootBone: ${boneName}`,
      `worldPos: x=${p.x.toFixed(2)} y=${p.y.toFixed(2)} z=${p.z.toFixed(2)}`,
      `speed: ${this._rmSpeed.toFixed(2)} m/s`,
      `distance: ${this._rmDistance.toFixed(2)} m`,
    ].join('\n');
  }

  _resetRootMotionState() {
    this._rmHasPrev = false;
    this._rmDistance = 0;
    this._rmSpeed = 0;
    this._pathPts = [];
    if (this._pathLine && this._scene) {
      try { this._scene.remove(this._pathLine); } catch { /* ignore */ }
      try { this._pathLine.geometry?.dispose?.(); } catch { /* ignore */ }
      try { this._pathLine.material?.dispose?.(); } catch { /* ignore */ }
    }
    this._pathLine = null;
    if (this._modelRoot) {
      this._modelRoot.position.set(0, 0, 0);
      this._modelRoot.updateMatrixWorld(true);
    }
    this._syncStatsText();
  }

  _syncPathVisible() {
    if (!this._pathLine) return;
    this._pathLine.visible = !!this._state.drawPath;
  }

  _ensurePathLine() {
    if (!this._scene) return;
    if (this._pathLine) return;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x5b9aff, transparent: true, opacity: 0.85 });
    const line = new THREE.Line(geom, mat);
    line.frustumCulled = false;
    this._pathLine = line;
    this._scene.add(line);
    this._syncPathVisible();
  }

  _updatePathLine() {
    if (!this._pathLine) return;
    const pts = Array.isArray(this._pathPts) ? this._pathPts : [];
    const n = pts.length;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      arr[i * 3 + 0] = Number(p.x) || 0;
      arr[i * 3 + 1] = Number(p.y) || 0;
      arr[i * 3 + 2] = Number(p.z) || 0;
    }
    const geom = /** @type {THREE.BufferGeometry} */ (this._pathLine.geometry);
    geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    geom.computeBoundingSphere();
  }

  _applyRootBoneFromState() {
    const desired = String(this._state.rootBoneName || '').trim();
    if (!desired) {
      this._rootBone = pickDefaultRootBone(this._bones);
      return;
    }
    const hit = this._bones.find((b) => String(b?.name || '') === desired) || null;
    this._rootBone = hit || pickDefaultRootBone(this._bones);
  }

  _refreshRootBoneSelect() {
    const sel = this._uiRootBoneSelEl;
    if (!sel) return;
    clear(sel);
    sel.appendChild(el('option', { value: '' }, ['(auto)']));
    for (const b of this._bones) {
      const name = String(b?.name || '').trim();
      if (!name) continue;
      sel.appendChild(el('option', { value: name }, [name]));
    }
    sel.value = String(this._state.rootBoneName || '');
    this._applyRootBoneFromState();
  }

  _refreshAnimSelect() {
    const sel = this._uiAnimSelEl;
    if (!sel) return;
    clear(sel);
    sel.appendChild(el('option', { value: '' }, ['(no animation)']));
    const clips = this._gltf?.animations || [];
    for (const c of clips) {
      const name = String(c?.name || '').trim();
      sel.appendChild(el('option', { value: name }, [name || '(unnamed clip)']));
    }
    sel.value = String(this._state.animName || '');
  }

  _setAnimation(name) {
    const st = this._state;
    const n = String(name || '');
    st.animName = n;
    if (!this._mixer) return;

    if (this._activeAction) {
      try { this._activeAction.stop(); } catch { /* ignore */ }
      this._activeAction = null;
    }

    const clips = this._gltf?.animations || [];
    const clip = clips.find((c) => String(c?.name || '') === n) || null;
    if (!clip) return;

    const action = this._mixer.clipAction(clip);
    action.reset();
    action.play();
    this._activeAction = action;
    if (this._uiAnimSelEl) this._uiAnimSelEl.value = n;

    // New clip: reset RM state (avoids a huge delta on first frame).
    this._rmHasPrev = false;
    this._rmSpeed = 0;
    this._rmDistance = 0;
    this._pathPts = [];
    if (this._pathLine && this._scene) {
      try { this._scene.remove(this._pathLine); } catch { /* ignore */ }
      try { this._pathLine.geometry?.dispose?.(); } catch { /* ignore */ }
      try { this._pathLine.material?.dispose?.(); } catch { /* ignore */ }
    }
    this._pathLine = null;
    this._syncStatsText();
    this._syncClipLibrary();
  }

  _updateRootMotion(dt) {
    const st = this._state;
    const root = this._modelRoot;
    const bone = this._rootBone;
    if (!root || !bone) {
      this._rmSpeed = 0;
      this._syncStatsText();
      return;
    }

    const delta = Math.max(1e-6, Number(dt) || 1e-6);

    // Get raw world-space root-bone position *after* animation update.
    const rawW = new THREE.Vector3();
    bone.getWorldPosition(rawW);

    if (!this._rmHasPrev) {
      this._rmPrevRawWorld.copy(rawW);
      this._rmHasPrev = true;
      this._rmSpeed = 0;
      this._syncStatsText();
      return;
    }

    const dW = rawW.clone().sub(this._rmPrevRawWorld);
    // Project to XZ plane (ground plane in Three).
    dW.y = 0;

    const stepDist = Math.hypot(dW.x, dW.z);
    this._rmSpeed = stepDist / delta;
    if (st.applyRootMotion) this._rmDistance += stepDist;

    if (st.applyRootMotion) {
      root.position.x += dW.x;
      root.position.z += dW.z;

      if (st.cancelBoneTranslation && bone.parent) {
        // Convert world delta into parent-local delta via inverse parent rotation (best-effort).
        const qParent = new THREE.Quaternion();
        bone.parent.getWorldQuaternion(qParent);
        qParent.invert();
        const localDelta = dW.clone().applyQuaternion(qParent);
        bone.position.x -= localDelta.x;
        bone.position.y -= localDelta.y;
        bone.position.z -= localDelta.z;
      }

      root.updateMatrixWorld(true);
    }

    // Path sampling (use modelRoot world position).
    if (st.drawPath && st.applyRootMotion) {
      this._ensurePathLine();
      const wp = new THREE.Vector3();
      root.getWorldPosition(wp);
      this._pathPts.push(wp);
      const maxPts = Math.max(50, Math.min(5000, Number(st.pathMaxPoints) || 600));
      if (this._pathPts.length > maxPts) this._pathPts.splice(0, this._pathPts.length - maxPts);
      this._updatePathLine();
    }

    this._rmPrevRawWorld.copy(rawW);
    this._syncStatsText();
  }

  async _convertToGlb(inputPath) {
    const ctx = this._ctx;
    const p = String(inputPath || '').trim();
    if (!p) throw new Error('Missing input path');

    ctx?.log?.(`Locomotion: converting ${p} → GLB`);

    // Preflight: prevent converting meshless USDs (best-effort).
    const ext = p.lastIndexOf('.') >= 0 ? p.slice(p.lastIndexOf('.')).toLowerCase() : '';
    if (isUsdExt(ext)) {
      try {
        const ir = await fetch('/__devtools_usd_inspect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runner: 'blender_5', inputPath: p }),
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
              throw new Error(
                `USD has no Mesh prims (meshCount=0) and no SkelAnimation prims (skelAnim=0). (skelRoot=${skelRoot})`
              );
            }
            ctx?.log?.(`Locomotion: USD preflight: motion-only (meshCount=0, skelAnim=${skelAnim}, skelRoot=${skelRoot}) → allowing convert`);
          }
        }
      } catch (e) {
        const msg = String(e?.message || e || '');
        if (msg.toLowerCase().includes('no mesh') || msg.toLowerCase().includes('meshcount=0')) throw e;
      }
    }

    const resp = await fetch('/__devtools_convert_start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runner: 'conda_trellis',
        inPath: p,
        blenderPath: '',
        exportFormat: 'GLB',
        outName: '',
        splitMeshes: false,
      }),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'convert start failed'));

    const jobId = String(j.id || '');
    let outGlb = String(j.outGlb || '');

    let backoff = 400;
    while (true) {
      await new Promise((r) => setTimeout(r, backoff));
      const pr = await fetch(`/__devtools_convert_job?id=${encodeURIComponent(jobId)}`);
      const pj = await pr.json();
      if (!pj?.ok) throw new Error(String(pj?.error || 'job query failed'));
      const status = String(pj.status || '');
      outGlb = String(pj.outGlb || outGlb || '');
      if (status === 'done') {
        if (!outGlb) throw new Error('Convert finished but no output GLB');
        ctx?.log?.(`Locomotion: convert done → ${outGlb}`);
        return outGlb;
      }
      if (status === 'error' || status === 'killed') {
        const stderr = String(pj.stderr || '').trim();
        throw new Error(`Convert ${status}${stderr ? `: ${stderr.split('\n').pop()}` : ''}`);
      }
      backoff = 500;
    }
  }

  async _loadModel(url) {
    const ctx = this._ctx;
    let u = String(url || '').trim();
    if (!u) throw new Error('Missing model url');
    if (!this._scene) return;

    // Auto-convert USD/FBX → GLB first.
    const ext = u.lastIndexOf('.') >= 0 ? u.slice(u.lastIndexOf('.')).toLowerCase() : '';
    const needsConvert = isUsdExt(ext) || ext === '.fbx';
    if (needsConvert) {
      u = await this._convertToGlb(u);
      this._state.modelUrl = u;
      if (this._uiModelUrlEl) this._uiModelUrlEl.value = u;
    }

    ctx?.log?.(`Locomotion: loading ${u}`);
    this._clearModel();

    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(u);
    this._gltf = gltf;
    this._modelRoot = gltf.scene || null;
    if (!this._modelRoot) throw new Error('glTF missing scene');
    this._scene.add(this._modelRoot);

    // Fit camera to model bounds.
    const box = new THREE.Box3().setFromObject(this._modelRoot);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const radius = Math.max(0.25, size.length() * 0.5);
    this._controls.target.copy(center);
    this._camera.position.copy(center).add(new THREE.Vector3(radius * 1.2, radius * 0.65, radius * 1.2));
    this._camera.near = Math.max(0.01, radius * 0.01);
    this._camera.far = Math.max(50, radius * 50);
    this._camera.updateProjectionMatrix();
    this._controls.update();

    // Animations
    this._activeAction = null;
    this._mixer = null;
    if (Array.isArray(gltf.animations) && gltf.animations.length) {
      this._mixer = new THREE.AnimationMixer(this._modelRoot);
      const first = gltf.animations[0];
      this._setAnimation(first?.name || '');
    } else {
      this._state.animName = '';
    }

    // Bones
    this._bones = collectSkeletonBones(this._modelRoot);
    this._refreshAnimSelect();
    this._refreshRootBoneSelect();
    this._syncClipLibrary();

    // Reset RM/path state
    this._resetRootMotionState();

    ctx?.log?.(`Locomotion: loaded (${gltf.animations?.length || 0} clips, bones=${this._bones.length})`);
  }

  _clearModel() {
    if (!this._scene) return;

    if (this._activeAction) {
      try { this._activeAction.stop(); } catch { /* ignore */ }
    }
    this._activeAction = null;
    this._mixer = null;

    if (this._pathLine) {
      try { this._scene.remove(this._pathLine); } catch { /* ignore */ }
      try { this._pathLine.geometry?.dispose?.(); } catch { /* ignore */ }
      try { this._pathLine.material?.dispose?.(); } catch { /* ignore */ }
    }
    this._pathLine = null;
    this._pathPts = [];

    if (this._modelRoot) {
      try { this._scene.remove(this._modelRoot); } catch { /* ignore */ }
      try { disposeThreeObject(this._modelRoot); } catch { /* ignore */ }
    }
    this._modelRoot = null;
    this._gltf = null;
    this._bones = [];
    this._rootBone = null;

    this._rmHasPrev = false;
    this._rmDistance = 0;
    this._rmSpeed = 0;
    this._syncStatsText();
    this._syncClipLibrary();
  }
}

