import { el, clear } from '../../ui/dom.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeTrim(v) {
  return String(v ?? '').trim();
}

function parseResultJsonFromText(text) {
  const s = String(text || '');
  const m = s.match(/OVOXEL_LAB_RESULT_JSON:({[\s\S]*})/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

export class OVoxelLabTool {
  constructor() {
    this.id = 'ovoxel_lab';
    this.label = 'O-Voxel Lab';
    this._ctx = null;
    this._root = null;

    this._state = {
      runner: 'conda_trellis',
      tab: 'convert',

      convertMeshPath: '',
      convertOutName: 'ovoxel_model',
      convertGridSize: '512',
      convertAabb: '-0.5,-0.5,-0.5,0.5,0.5,0.5',
      convertFaceWeight: '1.0',
      convertBoundaryWeight: '0.2',
      convertRegularizationWeight: '0.01',
      convertTiming: '0',

      reconInputPath: '',
      reconOutName: 'ovoxel_recon',
      reconOutExt: '.glb',
      reconGridSize: '',
      reconAabb: '-0.5,-0.5,-0.5,0.5,0.5,0.5',
      reconSplitWeight: '',
      reconDecimationTarget: '100000',
      reconTextureSize: '2048',
      reconRemesh: '0',
      reconRemeshBand: '1.0',
      reconRemeshProject: '0.9',
      reconExtensionWebp: '1',
      reconVerbose: '0',

      renderInputPath: '',
      renderOutName: 'ovoxel_preview',
      renderGridSize: '',
      renderResolution: '512',
      renderSsaa: '2',
      renderNear: '0.1',
      renderFar: '10.0',
      renderYawDeg: '45',
      renderPitchDeg: '20',
      renderRadius: '1.8',
      renderFovDeg: '40',
      renderNumFrames: '90',
      renderFps: '15',
      renderMp4: '1',

      inspectInputPath: '',
      inspectAction: 'inspect',
      ioInPath: '',
      ioOutName: 'ovoxel_transcoded',
      ioOutExt: '.npz',
      ioChunkSize: '256',
      ioCompression: 'lzma',
      ioFilterMode: 'none',
      ioAttrInterleave: 'as_is',
    };

    this._job = { id: '', status: '', stdout: '', stderr: '', cmd: '', exitCode: null };
    this._polling = false;
    this._statusEl = null;
    this._logEl = null;
    this._cmdEl = null;
    this._resultEl = null;
    this._outEl = null;
    this._envEl = null;
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;
    this._buildUi();
  }

  async unmount() {
    this._polling = false;
    this._ctx = null;
    this._root = null;
  }

  tick() {}

  getStats() {
    return {
      tab: this._state.tab,
      job: this._job?.status || '',
      out: this._outEl?.textContent || '',
    };
  }

  _buildUi() {
    if (!this._root) return;
    clear(this._root);
    const st = this._state;

    const runnerSel = el('select', {
      value: st.runner,
      onchange: (e) => { st.runner = safeTrim(e.target.value) || 'conda_trellis'; },
    }, [
      el('option', { value: 'conda_trellis' }, ['conda run -n trellis python3 (recommended)']),
      el('option', { value: 'python3' }, ['python3 (current env)']),
    ]);

    const tabSel = el('select', {
      value: st.tab,
      onchange: (e) => {
        st.tab = safeTrim(e.target.value) || 'convert';
        this._buildUi();
      },
    }, [
      el('option', { value: 'convert' }, ['Convert (mesh -> vxz)']),
      el('option', { value: 'reconstruct' }, ['Reconstruct (vxz -> mesh/glb)']),
      el('option', { value: 'render' }, ['Render (vxz preview)']),
      el('option', { value: 'inspect' }, ['Inspect / I/O']),
    ]);

    const runBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { await this._startJob(); } catch (e) { this._setStatus(`Start failed: ${e?.message || e}`); }
      },
    }, ['Run']);

    const killBtn = el('button', {
      class: 'danger',
      onclick: async () => {
        const id = safeTrim(this._job?.id || '');
        if (!id) return;
        try {
          await fetch('/__devtools_ovoxel_lab_kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
        } catch { /* ignore */ }
      },
    }, ['Kill']);

    const envCheckBtn = el('button', {
      onclick: async () => {
        if (this._envEl) this._envEl.textContent = 'Checking environment...';
        try {
          const resp = await fetch('/__devtools_trellis_env_check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runner: st.runner }),
          });
          const j = await resp.json();
          if (!j?.ok) throw new Error(String(j?.error || 'env check failed'));
          const checks = j?.probe?.checks || {};
          const lines = [
            `runner=${j.runner} exit=${j.exitCode}`,
            `torch=${checks.torch ? 'ok' : 'missing'} cuda=${j?.probe?.cuda?.available ? 'yes' : 'no'}`,
            `o_voxel=${checks.o_voxel ? 'ok' : 'missing'} cumesh=${checks.cumesh ? 'ok' : 'missing'} flex_gemm=${checks.flex_gemm ? 'ok' : 'missing'}`,
          ];
          if (Array.isArray(j.missing) && j.missing.length) lines.push(`missing: ${j.missing.join(', ')}`);
          if (j.setupCmd) lines.push(`suggested setup: ${j.setupCmd}`);
          if (this._envEl) this._envEl.textContent = lines.join('\n');
        } catch (e) {
          if (this._envEl) this._envEl.textContent = `Env check failed: ${e?.message || e}`;
        }
      },
    }, ['Check env']);

    this._statusEl = el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Idle']);
    this._cmdEl = el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-wrap' } }, ['']);
    this._outEl = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    this._resultEl = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    this._envEl = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['No env check run yet.']);
    this._logEl = el('div', { class: 'scrollArea', style: { height: '240px', marginTop: '8px' } }, ['(logs appear here)']);

    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['O-Voxel Lab']),
      el('div', { class: 'muted' }, [
        'Mesh <-> O-Voxel conversion, reconstruction, voxel preview rendering, inspection, and format conversion.',
      ]),
      el('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, [
        el('div', { style: { flex: '1' } }, [el('div', { class: 'muted' }, ['Runner']), runnerSel]),
        el('div', { style: { flex: '1' } }, [el('div', { class: 'muted' }, ['Tab']), tabSel]),
      ]),
      this._buildTabUi(st.tab),
      el('div', { class: 'row', style: { marginTop: '12px', flexWrap: 'wrap' } }, [runBtn, killBtn, envCheckBtn]),
      this._statusEl,
      this._cmdEl,
      this._outEl,
      this._resultEl,
      this._envEl,
      this._logEl,
    ]));

    this._root.appendChild(this._buildAssetPicker({
      title: 'Asset Picker (meshes / voxels)',
      ext: '.glb,.gltf,.obj,.ply,.vxz,.npz',
      onPick: (p) => {
        st.convertMeshPath = p;
        st.reconInputPath = p;
        st.renderInputPath = p;
        st.inspectInputPath = p;
        st.ioInPath = p;
        this._buildUi();
      },
      allowEmptyQuery: true,
    }));
  }

  _buildTabUi(tabId) {
    const st = this._state;
    if (tabId === 'convert') {
      const meshPath = el('input', {
        value: st.convertMeshPath,
        placeholder: 'assets/.../mesh.glb | outputs/.../mesh.obj',
        oninput: (e) => { st.convertMeshPath = safeTrim(e.target.value); },
      });
      const outName = el('input', {
        value: st.convertOutName,
        oninput: (e) => { st.convertOutName = safeTrim(e.target.value); },
      });
      const gridSize = el('input', {
        value: st.convertGridSize,
        oninput: (e) => { st.convertGridSize = safeTrim(e.target.value); },
      });
      const aabb = el('input', {
        value: st.convertAabb,
        oninput: (e) => { st.convertAabb = safeTrim(e.target.value); },
      });
      const faceWeight = el('input', {
        value: st.convertFaceWeight,
        oninput: (e) => { st.convertFaceWeight = safeTrim(e.target.value); },
      });
      const boundaryWeight = el('input', {
        value: st.convertBoundaryWeight,
        oninput: (e) => { st.convertBoundaryWeight = safeTrim(e.target.value); },
      });
      const regularizationWeight = el('input', {
        value: st.convertRegularizationWeight,
        oninput: (e) => { st.convertRegularizationWeight = safeTrim(e.target.value); },
      });
      const timing = el('select', {
        value: st.convertTiming,
        onchange: (e) => { st.convertTiming = safeTrim(e.target.value) || '0'; },
      }, [el('option', { value: '0' }, ['0']), el('option', { value: '1' }, ['1'])]);

      return el('div', {}, [
        el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Input mesh']),
        meshPath,
        el('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, [
          el('div', {}, [el('div', { class: 'muted' }, ['outName']), outName]),
          el('div', {}, [el('div', { class: 'muted' }, ['gridSize']), gridSize]),
          el('div', {}, [el('div', { class: 'muted' }, ['timing']), timing]),
        ]),
        el('div', { class: 'muted', style: { marginTop: '10px' } }, ['aabb']),
        aabb,
        el('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, [
          el('div', {}, [el('div', { class: 'muted' }, ['faceWeight']), faceWeight]),
          el('div', {}, [el('div', { class: 'muted' }, ['boundaryWeight']), boundaryWeight]),
          el('div', {}, [el('div', { class: 'muted' }, ['regularizationWeight']), regularizationWeight]),
        ]),
      ]);
    }

    if (tabId === 'reconstruct') {
      const inputPath = el('input', {
        value: st.reconInputPath,
        placeholder: 'assets/.../*.vxz | *.npz | *.ply',
        oninput: (e) => { st.reconInputPath = safeTrim(e.target.value); },
      });
      const outName = el('input', {
        value: st.reconOutName,
        oninput: (e) => { st.reconOutName = safeTrim(e.target.value); },
      });
      const outExt = el('select', {
        value: st.reconOutExt,
        onchange: (e) => { st.reconOutExt = safeTrim(e.target.value) || '.glb'; },
      }, [el('option', { value: '.glb' }, ['.glb']), el('option', { value: '.ply' }, ['.ply'])]);
      const gridSize = el('input', {
        value: st.reconGridSize,
        placeholder: '(blank = infer from coords)',
        oninput: (e) => { st.reconGridSize = safeTrim(e.target.value); },
      });
      const aabb = el('input', {
        value: st.reconAabb,
        oninput: (e) => { st.reconAabb = safeTrim(e.target.value); },
      });
      const splitWeight = el('input', {
        value: st.reconSplitWeight,
        placeholder: '(blank = auto split)',
        oninput: (e) => { st.reconSplitWeight = safeTrim(e.target.value); },
      });
      const decimationTarget = el('input', {
        value: st.reconDecimationTarget,
        oninput: (e) => { st.reconDecimationTarget = safeTrim(e.target.value); },
      });
      const textureSize = el('input', {
        value: st.reconTextureSize,
        oninput: (e) => { st.reconTextureSize = safeTrim(e.target.value); },
      });
      const remesh = el('select', {
        value: st.reconRemesh,
        onchange: (e) => { st.reconRemesh = safeTrim(e.target.value) || '0'; },
      }, [el('option', { value: '0' }, ['0']), el('option', { value: '1' }, ['1'])]);
      const remeshBand = el('input', {
        value: st.reconRemeshBand,
        oninput: (e) => { st.reconRemeshBand = safeTrim(e.target.value); },
      });
      const remeshProject = el('input', {
        value: st.reconRemeshProject,
        oninput: (e) => { st.reconRemeshProject = safeTrim(e.target.value); },
      });
      const extensionWebp = el('select', {
        value: st.reconExtensionWebp,
        onchange: (e) => { st.reconExtensionWebp = safeTrim(e.target.value) || '1'; },
      }, [el('option', { value: '1' }, ['1']), el('option', { value: '0' }, ['0'])]);
      const verbose = el('select', {
        value: st.reconVerbose,
        onchange: (e) => { st.reconVerbose = safeTrim(e.target.value) || '0'; },
      }, [el('option', { value: '0' }, ['0']), el('option', { value: '1' }, ['1'])]);

      return el('div', {}, [
        el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Input voxel']),
        inputPath,
        el('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, [
          el('div', {}, [el('div', { class: 'muted' }, ['outName']), outName]),
          el('div', {}, [el('div', { class: 'muted' }, ['outExt']), outExt]),
          el('div', {}, [el('div', { class: 'muted' }, ['gridSize']), gridSize]),
        ]),
        el('div', { class: 'muted', style: { marginTop: '10px' } }, ['aabb']),
        aabb,
        el('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, [
          el('div', {}, [el('div', { class: 'muted' }, ['splitWeight']), splitWeight]),
          el('div', {}, [el('div', { class: 'muted' }, ['decimationTarget']), decimationTarget]),
          el('div', {}, [el('div', { class: 'muted' }, ['textureSize']), textureSize]),
        ]),
        el('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, [
          el('div', {}, [el('div', { class: 'muted' }, ['remesh']), remesh]),
          el('div', {}, [el('div', { class: 'muted' }, ['remeshBand']), remeshBand]),
          el('div', {}, [el('div', { class: 'muted' }, ['remeshProject']), remeshProject]),
        ]),
        el('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, [
          el('div', {}, [el('div', { class: 'muted' }, ['extensionWebp']), extensionWebp]),
          el('div', {}, [el('div', { class: 'muted' }, ['verbose']), verbose]),
        ]),
      ]);
    }

    if (tabId === 'render') {
      const inputPath = el('input', {
        value: st.renderInputPath,
        placeholder: 'assets/.../*.vxz | *.npz | *.ply',
        oninput: (e) => { st.renderInputPath = safeTrim(e.target.value); },
      });
      const outName = el('input', {
        value: st.renderOutName,
        oninput: (e) => { st.renderOutName = safeTrim(e.target.value); },
      });
      const gridSize = el('input', {
        value: st.renderGridSize,
        placeholder: '(blank = infer)',
        oninput: (e) => { st.renderGridSize = safeTrim(e.target.value); },
      });
      const resolution = el('input', {
        value: st.renderResolution,
        oninput: (e) => { st.renderResolution = safeTrim(e.target.value); },
      });
      const ssaa = el('input', {
        value: st.renderSsaa,
        oninput: (e) => { st.renderSsaa = safeTrim(e.target.value); },
      });
      const near = el('input', {
        value: st.renderNear,
        oninput: (e) => { st.renderNear = safeTrim(e.target.value); },
      });
      const far = el('input', {
        value: st.renderFar,
        oninput: (e) => { st.renderFar = safeTrim(e.target.value); },
      });
      const yawDeg = el('input', {
        value: st.renderYawDeg,
        oninput: (e) => { st.renderYawDeg = safeTrim(e.target.value); },
      });
      const pitchDeg = el('input', {
        value: st.renderPitchDeg,
        oninput: (e) => { st.renderPitchDeg = safeTrim(e.target.value); },
      });
      const radius = el('input', {
        value: st.renderRadius,
        oninput: (e) => { st.renderRadius = safeTrim(e.target.value); },
      });
      const fovDeg = el('input', {
        value: st.renderFovDeg,
        oninput: (e) => { st.renderFovDeg = safeTrim(e.target.value); },
      });
      const numFrames = el('input', {
        value: st.renderNumFrames,
        oninput: (e) => { st.renderNumFrames = safeTrim(e.target.value); },
      });
      const fps = el('input', {
        value: st.renderFps,
        oninput: (e) => { st.renderFps = safeTrim(e.target.value); },
      });
      const renderMp4 = el('select', {
        value: st.renderMp4,
        onchange: (e) => { st.renderMp4 = safeTrim(e.target.value) || '1'; },
      }, [el('option', { value: '1' }, ['1']), el('option', { value: '0' }, ['0'])]);

      return el('div', {}, [
        el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Input voxel']),
        inputPath,
        el('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, [
          el('div', {}, [el('div', { class: 'muted' }, ['outName']), outName]),
          el('div', {}, [el('div', { class: 'muted' }, ['gridSize']), gridSize]),
          el('div', {}, [el('div', { class: 'muted' }, ['renderMp4']), renderMp4]),
        ]),
        el('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, [
          el('div', {}, [el('div', { class: 'muted' }, ['resolution']), resolution]),
          el('div', {}, [el('div', { class: 'muted' }, ['ssaa']), ssaa]),
          el('div', {}, [el('div', { class: 'muted' }, ['near']), near]),
          el('div', {}, [el('div', { class: 'muted' }, ['far']), far]),
        ]),
        el('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, [
          el('div', {}, [el('div', { class: 'muted' }, ['yawDeg']), yawDeg]),
          el('div', {}, [el('div', { class: 'muted' }, ['pitchDeg']), pitchDeg]),
          el('div', {}, [el('div', { class: 'muted' }, ['radius']), radius]),
          el('div', {}, [el('div', { class: 'muted' }, ['fovDeg']), fovDeg]),
        ]),
        el('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, [
          el('div', {}, [el('div', { class: 'muted' }, ['numFrames']), numFrames]),
          el('div', {}, [el('div', { class: 'muted' }, ['fps']), fps]),
        ]),
      ]);
    }

    const inspectAction = el('select', {
      value: st.inspectAction,
      onchange: (e) => { st.inspectAction = safeTrim(e.target.value) || 'inspect'; },
    }, [
      el('option', { value: 'inspect' }, ['inspect']),
      el('option', { value: 'io_convert' }, ['io-convert']),
    ]);
    const inspectInputPath = el('input', {
      value: st.inspectInputPath,
      placeholder: 'assets/.../*.vxz | *.npz | *.ply',
      oninput: (e) => { st.inspectInputPath = safeTrim(e.target.value); },
    });
    const ioInPath = el('input', {
      value: st.ioInPath,
      placeholder: 'assets/.../*.vxz | *.npz | *.ply',
      oninput: (e) => { st.ioInPath = safeTrim(e.target.value); },
    });
    const ioOutName = el('input', {
      value: st.ioOutName,
      oninput: (e) => { st.ioOutName = safeTrim(e.target.value); },
    });
    const ioOutExt = el('select', {
      value: st.ioOutExt,
      onchange: (e) => { st.ioOutExt = safeTrim(e.target.value) || '.npz'; },
    }, [
      el('option', { value: '.vxz' }, ['.vxz']),
      el('option', { value: '.npz' }, ['.npz']),
      el('option', { value: '.ply' }, ['.ply']),
    ]);
    const ioChunkSize = el('input', {
      value: st.ioChunkSize,
      oninput: (e) => { st.ioChunkSize = safeTrim(e.target.value); },
    });
    const ioCompression = el('select', {
      value: st.ioCompression,
      onchange: (e) => { st.ioCompression = safeTrim(e.target.value) || 'lzma'; },
    }, [
      el('option', { value: 'lzma' }, ['lzma']),
      el('option', { value: 'zstd' }, ['zstd']),
      el('option', { value: 'deflate' }, ['deflate']),
      el('option', { value: 'none' }, ['none']),
    ]);
    const ioFilterMode = el('select', {
      value: st.ioFilterMode,
      onchange: (e) => { st.ioFilterMode = safeTrim(e.target.value) || 'none'; },
    }, [
      el('option', { value: 'none' }, ['none']),
      el('option', { value: 'parent' }, ['parent']),
      el('option', { value: 'neighbor' }, ['neighbor']),
    ]);
    const ioAttrInterleave = el('select', {
      value: st.ioAttrInterleave,
      onchange: (e) => { st.ioAttrInterleave = safeTrim(e.target.value) || 'as_is'; },
    }, [
      el('option', { value: 'as_is' }, ['as_is']),
      el('option', { value: 'all' }, ['all']),
      el('option', { value: 'none' }, ['none']),
    ]);

    return el('div', {}, [
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['Action']), inspectAction]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Inspect input']),
      inspectInputPath,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Run to inspect voxel count, attr channels, coord bounds, and vxz header info.']),
      el('div', { class: 'muted', style: { marginTop: '12px' } }, ['I/O convert input']),
      ioInPath,
      el('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['ioOutName']), ioOutName]),
        el('div', {}, [el('div', { class: 'muted' }, ['ioOutExt']), ioOutExt]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['ioChunkSize']), ioChunkSize]),
        el('div', {}, [el('div', { class: 'muted' }, ['ioCompression']), ioCompression]),
        el('div', {}, [el('div', { class: 'muted' }, ['ioFilterMode']), ioFilterMode]),
        el('div', {}, [el('div', { class: 'muted' }, ['ioAttrInterleave']), ioAttrInterleave]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '6px' } }, ['Set Action=inspect for stats, Action=io-convert for voxel file conversion.']),
    ]);
  }

  _buildAssetPicker({ title, ext, onPick, allowEmptyQuery = false }) {
    const ctx = this._ctx;
    const queryInput = el('input', { placeholder: allowEmptyQuery ? 'search assets (optional; empty lists assets/)' : 'search assets' });
    const list = el('div', { class: 'scrollArea', style: { height: '160px' } }, ['(search to populate)']);

    const refresh = async () => {
      if (!ctx?.assetIndex) {
        list.textContent = '(error) asset index not available';
        return;
      }
      const qRaw = String(queryInput.value || '').trim();
      const q = qRaw || (allowEmptyQuery ? 'assets/' : '');
      if (!q) { list.textContent = '(search to populate)'; return; }
      try {
        list.textContent = 'Loading...';
        const items = await ctx.assetIndex({ query: q, ext });
        if (!items.length) { list.textContent = '(no matches)'; return; }
        clear(list);
        for (const it of items.slice(0, 250)) {
          const p = String(it?.path || '');
          list.appendChild(el('button', { class: 'toolBtn', style: { marginTop: '6px' }, onclick: () => onPick(p) }, [p]));
        }
      } catch (e) {
        list.textContent = `(error) ${e?.message || e}`;
      }
    };
    queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') refresh(); });

    return el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, [String(title || 'Assets')]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [queryInput, el('button', { onclick: refresh }, ['Search'])]),
      el('div', { class: 'muted', style: { marginTop: '6px' } }, ['Uses local Vite endpoint `/__editor_assets_index`.']),
      el('div', { style: { marginTop: '8px' } }, [list]),
    ]);
  }

  _setStatus(text) {
    if (this._statusEl) this._statusEl.textContent = String(text || '');
  }

  _buildPayload() {
    const st = this._state;
    if (st.tab === 'convert') {
      return {
        runner: st.runner,
        mode: 'convert',
        meshPath: st.convertMeshPath,
        outName: st.convertOutName,
        gridSize: st.convertGridSize,
        aabb: st.convertAabb,
        faceWeight: st.convertFaceWeight,
        boundaryWeight: st.convertBoundaryWeight,
        regularizationWeight: st.convertRegularizationWeight,
        timing: st.convertTiming,
      };
    }
    if (st.tab === 'reconstruct') {
      return {
        runner: st.runner,
        mode: 'reconstruct',
        inputPath: st.reconInputPath,
        outName: st.reconOutName,
        outExt: st.reconOutExt,
        gridSize: st.reconGridSize,
        aabb: st.reconAabb,
        splitWeight: st.reconSplitWeight,
        decimationTarget: st.reconDecimationTarget,
        textureSize: st.reconTextureSize,
        remesh: st.reconRemesh,
        remeshBand: st.reconRemeshBand,
        remeshProject: st.reconRemeshProject,
        extensionWebp: st.reconExtensionWebp,
        verbose: st.reconVerbose,
      };
    }
    if (st.tab === 'render') {
      return {
        runner: st.runner,
        mode: 'render',
        inputPath: st.renderInputPath,
        outName: st.renderOutName,
        gridSize: st.renderGridSize,
        resolution: st.renderResolution,
        ssaa: st.renderSsaa,
        near: st.renderNear,
        far: st.renderFar,
        yawDeg: st.renderYawDeg,
        pitchDeg: st.renderPitchDeg,
        radius: st.renderRadius,
        fovDeg: st.renderFovDeg,
        numFrames: st.renderNumFrames,
        fps: st.renderFps,
        renderMp4: st.renderMp4,
      };
    }
    if (st.inspectAction === 'io_convert') {
      return {
        runner: st.runner,
        mode: 'io_convert',
        inputPath: st.ioInPath || st.inspectInputPath,
        outName: st.ioOutName,
        outExt: st.ioOutExt,
        chunkSize: st.ioChunkSize,
        compression: st.ioCompression,
        filterMode: st.ioFilterMode,
        attrInterleave: st.ioAttrInterleave,
      };
    }
    return {
      runner: st.runner,
      mode: 'inspect',
      inputPath: st.inspectInputPath,
    };
  }

  async _startJob() {
    const payload = this._buildPayload();
    if (payload.mode === 'convert' && !safeTrim(payload.meshPath)) throw new Error('Missing mesh path');
    if (payload.mode === 'reconstruct' && !safeTrim(payload.inputPath)) throw new Error('Missing input voxel path');
    if (payload.mode === 'render' && !safeTrim(payload.inputPath)) throw new Error('Missing input voxel path');
    if (payload.mode === 'inspect' && !safeTrim(payload.inputPath)) throw new Error('Missing inspect input path');
    if (payload.mode === 'io_convert' && !safeTrim(payload.inputPath)) throw new Error('Missing io convert input path');

    if (this._resultEl) this._resultEl.textContent = '';
    if (this._outEl) this._outEl.textContent = '';
    if (this._logEl) this._logEl.textContent = '(starting...)';
    this._setStatus('Starting job...');

    const resp = await fetch('/__devtools_ovoxel_lab_start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'start failed'));

    this._job = {
      id: String(j.id || ''),
      status: 'running',
      stdout: '',
      stderr: '',
      cmd: String(j.cmd || ''),
      exitCode: null,
      outImage: String(j.outImage || ''),
      outMp4: String(j.outMp4 || ''),
      outGlb: String(j.outGlb || ''),
      outVxz: String(j.outVxz || ''),
      outPath: String(j.outPath || ''),
    };
    this._polling = true;
    void this._pollJobLoop();
  }

  async _pollJobLoop() {
    const id = this._job?.id;
    if (!id) return;
    let backoff = 450;
    while (this._polling && this._job?.id === id) {
      try {
        const resp = await fetch(`/__devtools_ovoxel_lab_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));
        this._job.status = String(j.status || '');
        this._job.stdout = String(j.stdout || '');
        this._job.stderr = String(j.stderr || '');
        this._job.cmd = String(j.cmd || this._job.cmd || '');
        this._job.exitCode = (j.exitCode == null) ? null : Number(j.exitCode);
        this._job.outImage = String(j.outImage || this._job.outImage || '');
        this._job.outMp4 = String(j.outMp4 || this._job.outMp4 || '');
        this._job.outGlb = String(j.outGlb || this._job.outGlb || '');
        this._job.outVxz = String(j.outVxz || this._job.outVxz || '');
        this._job.outPath = String(j.outPath || this._job.outPath || '');

        const code = (j.exitCode == null) ? '' : ` (exit=${j.exitCode})`;
        this._setStatus(`Job ${id}: ${this._job.status}${code}`);
        if (this._cmdEl) this._cmdEl.textContent = this._job.cmd ? `Command: ${this._job.cmd}` : '';

        if (this._logEl) {
          const out = this._job.stdout || '';
          const err = this._job.stderr || '';
          this._logEl.textContent = (err ? `${out}\n--- stderr ---\n${err}` : out) || '(no output yet)';
          try { this._logEl.scrollTop = this._logEl.scrollHeight; } catch { /* ignore */ }
        }

        if (this._outEl) {
          const bits = [];
          if (this._job.outPath) bits.push(`Out: ${this._job.outPath}`);
          if (this._job.outVxz) bits.push(`VXZ: ${this._job.outVxz}`);
          if (this._job.outGlb) bits.push(`GLB: ${this._job.outGlb}`);
          if (this._job.outImage) bits.push(`Image: ${this._job.outImage}`);
          if (this._job.outMp4) bits.push(`MP4: ${this._job.outMp4}`);
          this._outEl.textContent = bits.join('\n');
        }

        const parsed = parseResultJsonFromText(this._job.stdout || '');
        if (parsed && this._resultEl) {
          this._resultEl.textContent = JSON.stringify(parsed, null, 2);
        }

        if (this._job.status === 'done' || this._job.status === 'error' || this._job.status === 'killed') {
          this._polling = false;
          if (this._job.status === 'done' && this._job.outGlb) {
            try { localStorage.setItem('devtools.lastGeneratedModelUrl', this._job.outGlb); } catch { /* ignore */ }
          }
          return;
        }
        backoff = 500;
      } catch (e) {
        this._setStatus(`Polling failed: ${e?.message || e}`);
        backoff = Math.min(2200, Math.floor(backoff * 1.4));
      }
      await sleep(backoff);
    }
  }
}

