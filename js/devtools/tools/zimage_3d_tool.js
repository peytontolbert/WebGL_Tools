import { el, clear } from '../../ui/dom.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeTrim(s) {
  return String(s ?? '').trim();
}

export class ZImage3DTool {
  constructor() {
    this.id = 'zimage3d';
    this.label = 'Text → 3D';

    this._ctx = null;
    this._root = null;

    this._state = {
      runner: 'conda_hunyuan3d', // python3 | conda_hunyuan3d | conda_trellis
      meshBackend: 'hunyuan', // hunyuan | trellis

      // Z-Image-Turbo
      prompt: '',
      editPrompt: '',
      outName: 'zimage_asset',
      device: 'cuda',
      zimageModel: 'Tongyi-MAI/Z-Image-Turbo',
      dtype: 'bf16',
      height: 1024,
      width: 1024,
      steps: 9,
      guidanceScale: 0.0,
      editStrength: 0.65,
      lowCpuMemUsage: 0,
      cpuOffload: 0,
      attentionBackend: '',
      compileTransformer: 0,
      seed: 42,

      // Hunyuan export
      trellisModel: 'tencent/Hunyuan3D-2',
      simplify: 16777216,
      aabb: '-0.5,-0.5,-0.5,0.5,0.5,0.5',
      decimationTarget: 1000000,
      textureSize: 4096,
      remesh: 1,
      remeshBand: 1,
      remeshProject: 0,
      extensionWebp: 1,
      // Optional preview render
      renderMp4: 0,
      envmap: '',
      fps: 15,
      rigBackend: '',
      rigArgs: '',
    };

    // Step jobs:
    // 1) Z-Image text->image
    // 1.5) Z-Image img2img edit (optional)
    // 2) optional background removal
    // 3) Hunyuan image->GLB
    this._imgJob = { id: '', status: '', stdout: '', stderr: '', outImage: '' };
    this._editJob = { id: '', status: '', stdout: '', stderr: '', outImage: '' };
    this._bgJob = { id: '', status: '', stdout: '', stderr: '', outImage: '' };
    this._envmaps = [];
    this._meshJob = { id: '', status: '', stdout: '', stderr: '', outGlb: '', outMp4: '', outRig: '' };
    this._pollingImg = false;
    this._pollingEdit = false;
    this._pollingBg = false;
    this._pollingMesh = false;

    this._selectedImage = '';
    this._imgPreviewEl = null;
    this._logEl = null;
    this._statusEl = null;
    this._outEl = null;

    // Large center preview (mounted into canvasHost)
    this._previewHost = null;
    this._previewImg = null;
    this._previewLabel = null;
    this._previewPlaceholder = null;
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;
    try {
      const resp = await fetch('/__devtools_envmaps');
      const j = await resp.json();
      this._envmaps = Array.isArray(j?.items) ? j.items.map((x) => String(x || '')).filter(Boolean) : [];
    } catch { /* ignore */ }
    this._buildPreviewHost();
    this._buildUi();
  }

  async unmount() {
    this._pollingImg = false;
    this._pollingEdit = false;
    this._pollingBg = false;
    this._pollingMesh = false;
    try {
      if (this._previewImg) this._previewImg.src = '';
    } catch { /* ignore */ }
    if (this._previewHost?.parentNode) this._previewHost.parentNode.removeChild(this._previewHost);
    this._previewHost = null;
    this._previewImg = null;
    this._previewLabel = null;
    this._previewPlaceholder = null;
    this._ctx = null;
    this._root = null;
  }

  tick() {}

  getStats() {
    return {
      img: this._imgJob?.status || '',
      edit: this._editJob?.status || '',
      bg: this._bgJob?.status || '',
      mesh: this._meshJob?.status || '',
      outGlb: this._meshJob?.outGlb || '',
      outMp4: this._meshJob?.outMp4 || '',
      outImg: this._selectedImage || this._imgJob?.outImage || '',
    };
  }

  _buildUi() {
    if (!this._root) return;
    clear(this._root);
    const st = this._state;

    const runner = el('select', {
      value: st.runner,
      onchange: (e) => { st.runner = String(e.target.value || 'conda_hunyuan3d'); },
    }, [
      el('option', { value: 'conda_hunyuan3d' }, ['conda run -n hunyuan3d python3 (recommended)']),
      el('option', { value: 'conda_trellis' }, ['conda run -n trellis python3 (recommended)']),
      el('option', { value: 'python3' }, ['python3 (uses current env)']),
    ]);

    const meshBackend = el('select', {
      value: st.meshBackend || 'hunyuan',
      onchange: (e) => { st.meshBackend = String(e.target.value || 'hunyuan') === 'trellis' ? 'trellis' : 'hunyuan'; },
    }, [
      el('option', { value: 'hunyuan' }, ['Hunyuan (default)']),
      el('option', { value: 'trellis' }, ['Trellis']),
    ]);

    const prompt = el('textarea', {
      value: st.prompt,
      placeholder: 'Describe your object. Be specific: materials, view, background, lighting…',
      oninput: (e) => { st.prompt = String(e.target.value || ''); },
      style: { width: '100%', minHeight: '96px', resize: 'vertical' },
    });

    const editPrompt = el('textarea', {
      value: st.editPrompt,
      placeholder: '(optional) edit prompt; if empty uses Prompt above',
      oninput: (e) => { st.editPrompt = String(e.target.value || ''); },
      style: { width: '100%', minHeight: '56px', resize: 'vertical' },
    });

    const outName = el('input', {
      value: st.outName,
      placeholder: 'name hint',
      oninput: (e) => { st.outName = safeTrim(e.target.value); },
    });

    const device = el('input', {
      value: st.device,
      placeholder: 'cuda | cuda:0 | cpu',
      oninput: (e) => { st.device = safeTrim(e.target.value); },
    });

    const zimageModel = el('input', {
      value: st.zimageModel,
      oninput: (e) => { st.zimageModel = safeTrim(e.target.value); },
    });

    const dtype = el('select', {
      value: st.dtype,
      onchange: (e) => { st.dtype = String(e.target.value || 'bf16'); },
    }, [
      el('option', { value: 'bf16' }, ['bf16']),
      el('option', { value: 'fp16' }, ['fp16']),
      el('option', { value: 'fp32' }, ['fp32']),
    ]);

    const height = el('input', { value: String(st.height), oninput: (e) => { st.height = Math.max(64, Number(e.target.value) || 1024); } });
    const width = el('input', { value: String(st.width), oninput: (e) => { st.width = Math.max(64, Number(e.target.value) || 1024); } });
    const steps = el('input', { value: String(st.steps), oninput: (e) => { st.steps = Math.max(1, Number(e.target.value) || 9); } });
    const guidance = el('input', { value: String(st.guidanceScale), oninput: (e) => { st.guidanceScale = Number(e.target.value) || 0.0; } });
    const editStrength = el('input', { value: String(st.editStrength), oninput: (e) => { st.editStrength = Math.max(0.0, Math.min(1.0, Number(e.target.value) || 0)); } });
    const seed = el('input', { value: String(st.seed), oninput: (e) => { st.seed = Number(e.target.value) || 0; } });

    const lowCpuMemUsage = el('select', {
      value: String(st.lowCpuMemUsage),
      onchange: (e) => { st.lowCpuMemUsage = Number(e.target.value) ? 1 : 0; },
    }, [el('option', { value: '0' }, ['0']), el('option', { value: '1' }, ['1'])]);

    const cpuOffload = el('select', {
      value: String(st.cpuOffload),
      onchange: (e) => { st.cpuOffload = Number(e.target.value) ? 1 : 0; },
    }, [el('option', { value: '0' }, ['0']), el('option', { value: '1' }, ['1'])]);

    const attentionBackend = el('select', {
      value: st.attentionBackend,
      onchange: (e) => { st.attentionBackend = String(e.target.value || ''); },
    }, [
      el('option', { value: '' }, ['(default)']),
      el('option', { value: 'flash' }, ['flash']),
      el('option', { value: '_flash_3' }, ['_flash_3']),
    ]);

    const compileTransformer = el('select', {
      value: String(st.compileTransformer),
      onchange: (e) => { st.compileTransformer = Number(e.target.value) ? 1 : 0; },
    }, [el('option', { value: '0' }, ['0']), el('option', { value: '1' }, ['1'])]);

    const trellisModel = el('input', {
      value: st.trellisModel,
      oninput: (e) => { st.trellisModel = safeTrim(e.target.value); },
    });

    const simplify = el('input', { value: String(st.simplify), oninput: (e) => { st.simplify = Math.max(0, Number(e.target.value) || 0); } });
    const aabb = el('input', { value: st.aabb, oninput: (e) => { st.aabb = safeTrim(e.target.value); } });
    const decimationTarget = el('input', { value: String(st.decimationTarget), oninput: (e) => { st.decimationTarget = Math.max(0, Number(e.target.value) || 0); } });
    const textureSize = el('input', { value: String(st.textureSize), oninput: (e) => { st.textureSize = Math.max(64, Number(e.target.value) || 4096); } });
    const remesh = el('select', { value: String(st.remesh), onchange: (e) => { st.remesh = Number(e.target.value) ? 1 : 0; } }, [el('option', { value: '1' }, ['1']), el('option', { value: '0' }, ['0'])]);
    const extensionWebp = el('select', { value: String(st.extensionWebp), onchange: (e) => { st.extensionWebp = Number(e.target.value) ? 1 : 0; } }, [el('option', { value: '1' }, ['1']), el('option', { value: '0' }, ['0'])]);

    const renderMp4 = el('select', {
      value: String(st.renderMp4),
      onchange: (e) => { st.renderMp4 = Number(e.target.value) ? 1 : 0; },
    }, [el('option', { value: '0' }, ['0']), el('option', { value: '1' }, ['1'])]);

    const envmapInput = el('input', {
      value: st.envmap,
      placeholder: '(auto default) repos/TRELLIS.2/assets/hdri/studio.exr',
      oninput: (e) => { st.envmap = safeTrim(e.target.value); },
    });

    const envmapSelect = el('select', {
      value: st.envmap,
      onchange: (e) => {
        const v = String(e.target.value || '');
        st.envmap = v;
        envmapInput.value = v;
      },
    }, [
      el('option', { value: '' }, ['(auto default)']),
      ...(this._envmaps || []).map((p) => el('option', { value: p }, [p])),
    ]);

    const fps = el('input', { value: String(st.fps), oninput: (e) => { st.fps = Math.max(1, Number(e.target.value) || 15); } });

    const rigBackend = el('select', {
      value: st.rigBackend,
      onchange: (e) => { st.rigBackend = String(e.target.value || ''); },
    }, [
      el('option', { value: '' }, ['(no rig)']),
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

    this._statusEl = el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Idle.']);
    this._outEl = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    this._logEl = el('div', { class: 'scrollArea', style: { height: '240px' } }, ['(logs will appear here)']);

    const previewImg = el('img', {
      alt: 'zimage preview',
      style: {
        width: '100%',
        maxHeight: '260px',
        objectFit: 'contain',
        borderRadius: '10px',
        border: '1px solid rgba(255,255,255,0.14)',
        background: 'rgba(0,0,0,0.25)',
        display: 'none',
      },
    });
    this._imgPreviewEl = previewImg;

    const genImgBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { await this._startImageJob(); } catch (e) { this._ctx?.log?.(`ZImage3D: image start failed: ${e?.message || e}`); }
      },
    }, ['1) Generate image']);

    const rembgBtn = el('button', {
      onclick: async () => {
        try { await this._startBgJob(); } catch (e) { this._ctx?.log?.(`ZImage3D: rembg start failed: ${e?.message || e}`); }
      },
    }, ['2) Remove BG (optional)']);

    const editBtn = el('button', {
      onclick: async () => {
        try { await this._startEditJob(); } catch (e) { this._ctx?.log?.(`ZImage3D: edit start failed: ${e?.message || e}`); }
      },
    }, ['1.5) Edit image (img2img)']);

    const gen3dBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { await this._startMeshJob(); } catch (e) { this._ctx?.log?.(`ZImage3D: mesh start failed: ${e?.message || e}`); }
      },
    }, ['3) Generate GLB']);

    const killImgBtn = el('button', {
      class: 'danger',
      onclick: async () => {
        const id = this._imgJob?.id;
        if (!id) return;
        try {
          await fetch('/__devtools_zimage_t2i_kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
        } catch { /* ignore */ }
      },
    }, ['Kill image']);

    const killBgBtn = el('button', {
      class: 'danger',
      onclick: async () => {
        const id = this._bgJob?.id;
        if (!id) return;
        try {
          await fetch('/__devtools_zimage_rembg_kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
        } catch { /* ignore */ }
      },
    }, ['Kill rembg']);

    const killEditBtn = el('button', {
      class: 'danger',
      onclick: async () => {
        const id = this._editJob?.id;
        if (!id) return;
        try {
          await fetch('/__devtools_zimage_img2img_kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
        } catch { /* ignore */ }
      },
    }, ['Kill edit']);

    const killMeshBtn = el('button', {
      class: 'danger',
      onclick: async () => {
        const id = this._meshJob?.id;
        if (!id) return;
        try {
          await fetch('/__devtools_zimage_mesh_kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
        } catch { /* ignore */ }
      },
    }, ['Kill mesh']);

    const copyOutBtn = el('button', {
      onclick: async () => {
        const p = this._meshJob?.outGlb || '';
        if (!p) return;
        try { await navigator.clipboard.writeText(p); this._ctx?.log?.('ZImage3D: copied GLB path'); } catch { /* ignore */ }
      },
    }, ['Copy GLB path']);

    const openModelBtn = el('button', {
      onclick: () => {
        const p = this._meshJob?.outRig || this._meshJob?.outGlb || '';
        if (!p) return;
        try { localStorage.setItem('devtools.lastGeneratedModelUrl', p); } catch { /* ignore */ }
        // If DevToolsApp global hook exists, switch immediately.
        try { globalThis.__devtools?.setActiveTool?.('model_viewer'); } catch { /* ignore */ }
        this._ctx?.log?.('ZImage3D: sent model to viewer');
      },
    }, ['Send to Model Viewer']);

    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Text → 3D generator']),
      el('div', { class: 'muted' }, ['Step 1 generates an image. Step 1.5 can optionally edit that image (img2img). Step 2 can optionally remove background. Step 3 generates the GLB using the currently selected image. Outputs go to `assets/generated/zimage/`.']),
      el('div', { class: 'muted', style: { marginTop: '6px' } }, ['Runner']),
      runner,
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Mesh backend (step 3)']),
      meshBackend,
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Prompt']),
      prompt,
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Edit prompt (img2img)']),
      editPrompt,
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['outName']), outName]),
        el('div', {}, [el('div', { class: 'muted' }, ['seed']), seed]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['device']), device]),
        el('div', {}, [el('div', { class: 'muted' }, ['dtype']), dtype]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['zimageModel']), zimageModel]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['width']), width]),
        el('div', {}, [el('div', { class: 'muted' }, ['height']), height]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['steps']), steps]),
        el('div', {}, [el('div', { class: 'muted' }, ['guidanceScale']), guidance]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['editStrength (0..1)']), editStrength]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['low_cpu_mem_usage']), lowCpuMemUsage]),
        el('div', {}, [el('div', { class: 'muted' }, ['cpu_offload']), cpuOffload]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['attentionBackend']), attentionBackend]),
        el('div', {}, [el('div', { class: 'muted' }, ['compileTransformer']), compileTransformer]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '12px' } }, ['Mesh export settings']),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['trellisModel']), trellisModel]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['simplify']), simplify]),
        el('div', {}, [el('div', { class: 'muted' }, ['textureSize']), textureSize]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['decimationTarget']), decimationTarget]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['aabb']), aabb]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['remesh']), remesh]),
        el('div', {}, [el('div', { class: 'muted' }, ['extensionWebp']), extensionWebp]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Optional rigging chain']),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['rigBackend']), rigBackend]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [rigArgs]),
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Optional preview MP4 (Trellis backend only)']),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['renderMp4']), renderMp4]),
        el('div', {}, [el('div', { class: 'muted' }, ['fps']), fps]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['envmap']), envmapSelect]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [envmapInput]),
      el('div', { class: 'muted', style: { marginTop: '12px' } }, ['Intermediate image preview']),
      previewImg,
      el('div', { class: 'row', style: { marginTop: '12px', flexWrap: 'wrap' } }, [genImgBtn, editBtn, rembgBtn, gen3dBtn]),
      el('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, [killImgBtn, killEditBtn, killBgBtn, killMeshBtn, copyOutBtn, openModelBtn]),
      this._statusEl,
      this._outEl,
    ]));

    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Logs']),
      this._logEl,
    ]));

    this._syncPreview();
    this._syncStatusAndOut();
  }

  _buildPreviewHost() {
    const ctx = this._ctx;
    if (!ctx?.canvasHost) return;

    // A "safe area" that avoids the left/right/bottom docks so the preview
    // visually fills the center blank space.
    const host = document.createElement('div');
    host.style.position = 'absolute';
    host.style.inset = '0';
    host.style.paddingLeft = '252px';   // 16 + 220 + ~16
    host.style.paddingRight = '452px';  // 16 + 420 + ~16
    host.style.paddingTop = '16px';
    host.style.paddingBottom = '206px'; // 16 + 170 + ~20
    host.style.boxSizing = 'border-box';
    host.style.display = 'flex';
    host.style.alignItems = 'center';
    host.style.justifyContent = 'center';
    host.style.pointerEvents = 'none';
    host.style.overflow = 'hidden';
    this._previewHost = host;
    ctx.canvasHost.appendChild(host);

    const frame = document.createElement('div');
    frame.style.position = 'relative';
    frame.style.width = '100%';
    frame.style.height = '100%';
    frame.style.borderRadius = '16px';
    frame.style.border = '1px solid rgba(255,255,255,0.14)';
    frame.style.background = 'rgba(0,0,0,0.25)';
    frame.style.overflow = 'hidden';
    frame.style.display = 'flex';
    frame.style.alignItems = 'center';
    frame.style.justifyContent = 'center';
    host.appendChild(frame);

    const placeholder = document.createElement('div');
    placeholder.style.position = 'absolute';
    placeholder.style.inset = '0';
    placeholder.style.display = 'flex';
    placeholder.style.alignItems = 'center';
    placeholder.style.justifyContent = 'center';
    placeholder.style.color = 'rgba(234,240,255,0.70)';
    placeholder.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    placeholder.style.fontSize = '12px';
    placeholder.style.whiteSpace = 'pre';
    placeholder.textContent = 'Image preview\nGenerate an image (step 1) to populate';
    this._previewPlaceholder = placeholder;
    frame.appendChild(placeholder);

    const label = document.createElement('div');
    label.style.position = 'absolute';
    label.style.left = '12px';
    label.style.top = '12px';
    label.style.zIndex = '2';
    label.style.padding = '6px 8px';
    label.style.borderRadius = '10px';
    label.style.border = '1px solid rgba(255,255,255,0.14)';
    label.style.background = 'rgba(0,0,0,0.45)';
    label.style.color = 'rgba(234,240,255,0.92)';
    label.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    label.style.fontSize = '11px';
    label.style.pointerEvents = 'none';
    label.textContent = 'preview: (none)';
    this._previewLabel = label;
    frame.appendChild(label);

    const img = document.createElement('img');
    img.alt = 'zimage preview (large)';
    img.decoding = 'async';
    img.loading = 'eager';
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'contain';
    img.style.display = 'none';
    img.style.userSelect = 'none';
    img.draggable = false;
    this._previewImg = img;
    frame.appendChild(img);

    // Checkerboard to make alpha obvious after BG removal.
    frame.style.backgroundImage =
      'linear-gradient(45deg, rgba(255,255,255,0.08) 25%, transparent 25%),' +
      'linear-gradient(-45deg, rgba(255,255,255,0.08) 25%, transparent 25%),' +
      'linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.08) 75%),' +
      'linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.08) 75%)';
    frame.style.backgroundSize = '32px 32px';
    frame.style.backgroundPosition = '0 0, 0 16px, 16px -16px, -16px 0px';

    this._syncPreview();
  }

  _syncPreview() {
    const imgEl = this._imgPreviewEl;
    if (!imgEl) return;
    const p = String(this._selectedImage || this._imgJob?.outImage || '');
    const bigImg = this._previewImg;
    const bigLabel = this._previewLabel;
    const bigPh = this._previewPlaceholder;

    const show = (path) => {
      const url = `${path}?t=${Date.now()}`;
      if (imgEl) {
        imgEl.style.display = 'block';
        imgEl.src = url;
      }
      if (bigImg) {
        bigImg.style.display = 'block';
        bigImg.src = url;
      }
      if (bigPh) bigPh.style.display = 'none';
      if (bigLabel) bigLabel.textContent = `preview: ${path}`;
    };

    const hide = () => {
      if (imgEl) {
        imgEl.style.display = 'none';
        imgEl.src = '';
      }
      if (bigImg) {
        bigImg.style.display = 'none';
        bigImg.src = '';
      }
      if (bigPh) bigPh.style.display = 'flex';
      if (bigLabel) bigLabel.textContent = 'preview: (none)';
    };

    if (!p) return hide();
    return show(p);
  }

  _syncStatusAndOut() {
    if (this._statusEl) {
      const a = this._imgJob?.status ? `img=${this._imgJob.status}` : '';
      const b = this._editJob?.status ? `edit=${this._editJob.status}` : '';
      const c = this._bgJob?.status ? `bg=${this._bgJob.status}` : '';
      const d = this._meshJob?.status ? `mesh=${this._meshJob.status}` : '';
      const parts = [a, b, c, d].filter(Boolean);
      this._statusEl.textContent = parts.length ? parts.join('   ') : 'Idle.';
    }
    if (this._outEl) {
      const parts = [];
      const img = this._selectedImage || this._imgJob?.outImage || '';
      if (img) parts.push(`IMG: ${img}`);
      if (this._meshJob?.outGlb) parts.push(`GLB: ${this._meshJob.outGlb}`);
      if (this._meshJob?.outMp4) parts.push(`MP4: ${this._meshJob.outMp4}`);
      if (this._meshJob?.outRig) parts.push(`RIG: ${this._meshJob.outRig}`);
      this._outEl.textContent = parts.join('\n');
    }
  }

  async _startImageJob() {
    const st = this._state;
    const ctx = this._ctx;
    const payload = {
      runner: st.runner,
      prompt: st.prompt,
      outName: st.outName,
      device: st.device,
      zimageModel: st.zimageModel,
      dtype: st.dtype,
      height: st.height,
      width: st.width,
      steps: st.steps,
      guidanceScale: st.guidanceScale,
      lowCpuMemUsage: st.lowCpuMemUsage,
      cpuOffload: st.cpuOffload,
      attentionBackend: st.attentionBackend,
      compileTransformer: st.compileTransformer,
      seed: st.seed,
    };

    this._selectedImage = '';
    this._imgJob = { id: '', status: 'running', stdout: '', stderr: '', outImage: '' };
    this._editJob = { id: '', status: '', stdout: '', stderr: '', outImage: '' };
    this._bgJob = { id: '', status: '', stdout: '', stderr: '', outImage: '' };
    this._meshJob = { id: '', status: '', stdout: '', stderr: '', outGlb: '', outMp4: '', outRig: '' };
    this._syncPreview();
    this._syncStatusAndOut();
    if (this._logEl) this._logEl.textContent = '(starting image...)';

    const resp = await fetch('/__devtools_zimage_t2i_start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'start failed'));

    this._imgJob.id = String(j.id || '');
    this._imgJob.outImage = String(j.outImage || '');
    ctx?.log?.(`ZImage3D: image job started (${this._imgJob.id})`);

    this._pollingImg = true;
    void this._pollImgLoop();
  }

  async _pollImgLoop() {
    const id = this._imgJob?.id;
    if (!id) return;
    let backoff = 400;
    while (this._pollingImg && this._imgJob?.id === id) {
      try {
        const resp = await fetch(`/__devtools_zimage_t2i_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));
        this._imgJob.status = String(j.status || '');
        this._imgJob.stdout = String(j.stdout || '');
        this._imgJob.stderr = String(j.stderr || '');
        this._imgJob.outImage = String(j.outImage || '');
        this._syncStatusAndOut();
        if (this._logEl) {
          const out = this._imgJob.stdout || '';
          const err = this._imgJob.stderr || '';
          this._logEl.textContent = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output yet)';
          try { this._logEl.scrollTop = this._logEl.scrollHeight; } catch { /* ignore */ }
        }

        if (this._imgJob.status === 'done' || this._imgJob.status === 'error' || this._imgJob.status === 'killed') {
          this._pollingImg = false;
          if (this._imgJob.status === 'done') {
            this._selectedImage = this._imgJob.outImage || '';
            this._syncPreview();
            this._syncStatusAndOut();
            this._ctx?.log?.(`ZImage3D: image ready → ${this._selectedImage}`);
          }
          return;
        }

        backoff = 500;
      } catch (e) {
        if (this._statusEl) this._statusEl.textContent = `Image polling failed: ${e?.message || e}`;
        backoff = Math.min(2000, Math.floor(backoff * 1.4));
      }
      await sleep(backoff);
    }
  }

  async _startEditJob() {
    const st = this._state;
    const ctx = this._ctx;
    const inImg = String(this._selectedImage || this._bgJob?.outImage || this._imgJob?.outImage || '');
    if (!inImg) throw new Error('No image available to edit yet');

    const editPrompt = safeTrim(st.editPrompt) || String(st.prompt || '').trim();
    if (!editPrompt) throw new Error('Missing edit prompt');

    this._editJob = { id: '', status: 'running', stdout: '', stderr: '', outImage: '' };
    this._syncStatusAndOut();
    if (this._logEl) this._logEl.textContent = '(starting img2img edit...)';

    const payload = {
      runner: st.runner,
      outName: st.outName,
      inImageAssetPath: inImg,
      prompt: editPrompt,
      model: st.zimageModel,
      device: st.device,
      dtype: st.dtype,
      seed: st.seed,
      steps: st.steps,
      guidanceScale: st.guidanceScale,
      strength: st.editStrength,
      lowCpuMemUsage: st.lowCpuMemUsage,
      cpuOffload: st.cpuOffload,
      attentionBackend: st.attentionBackend,
      compileTransformer: st.compileTransformer,
    };

    const resp = await fetch('/__devtools_zimage_img2img_start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'start failed'));

    this._editJob.id = String(j.id || '');
    this._editJob.outImage = String(j.outImage || '');
    ctx?.log?.(`ZImage3D: edit job started (${this._editJob.id})`);

    this._pollingEdit = true;
    void this._pollEditLoop();
  }

  async _pollEditLoop() {
    const id = this._editJob?.id;
    if (!id) return;
    let backoff = 400;
    while (this._pollingEdit && this._editJob?.id === id) {
      try {
        const resp = await fetch(`/__devtools_zimage_img2img_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));
        this._editJob.status = String(j.status || '');
        this._editJob.stdout = String(j.stdout || '');
        this._editJob.stderr = String(j.stderr || '');
        this._editJob.outImage = String(j.outImage || '');
        this._syncStatusAndOut();
        if (this._logEl) {
          const out = this._editJob.stdout || '';
          const err = this._editJob.stderr || '';
          this._logEl.textContent = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output yet)';
          try { this._logEl.scrollTop = this._logEl.scrollHeight; } catch { /* ignore */ }
        }

        if (this._editJob.status === 'done' || this._editJob.status === 'error' || this._editJob.status === 'killed') {
          this._pollingEdit = false;
          if (this._editJob.status === 'done') {
            this._selectedImage = this._editJob.outImage || this._selectedImage;
            this._syncPreview();
            this._syncStatusAndOut();
            this._ctx?.log?.(`ZImage3D: edited image ready → ${this._selectedImage}`);
          }
          return;
        }
        backoff = 500;
      } catch (e) {
        if (this._statusEl) this._statusEl.textContent = `Edit polling failed: ${e?.message || e}`;
        backoff = Math.min(2000, Math.floor(backoff * 1.4));
      }
      await sleep(backoff);
    }
  }

  async _startBgJob() {
    const st = this._state;
    const inImg = String(this._selectedImage || this._imgJob?.outImage || '');
    if (!inImg) throw new Error('No image generated yet');

    this._bgJob = { id: '', status: 'running', stdout: '', stderr: '', outImage: '' };
    this._syncStatusAndOut();
    if (this._logEl) this._logEl.textContent = '(starting background removal...)';

    const payload = {
      runner: st.runner,
      outName: st.outName,
      device: st.device,
      inImageAssetPath: inImg,
      rembgModel: 'ZhengPeng7/BiRefNet',
    };

    const resp = await fetch('/__devtools_zimage_rembg_start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'rembg start failed'));

    this._bgJob.id = String(j.id || '');
    this._bgJob.outImage = String(j.outImage || '');
    this._pollingBg = true;
    void this._pollBgLoop();
  }

  async _pollBgLoop() {
    const id = this._bgJob?.id;
    if (!id) return;
    let backoff = 400;
    while (this._pollingBg && this._bgJob?.id === id) {
      try {
        const resp = await fetch(`/__devtools_zimage_rembg_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));
        this._bgJob.status = String(j.status || '');
        this._bgJob.stdout = String(j.stdout || '');
        this._bgJob.stderr = String(j.stderr || '');
        this._bgJob.outImage = String(j.outImage || '');
        this._syncStatusAndOut();
        if (this._logEl) {
          const out = this._bgJob.stdout || '';
          const err = this._bgJob.stderr || '';
          this._logEl.textContent = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output yet)';
          try { this._logEl.scrollTop = this._logEl.scrollHeight; } catch { /* ignore */ }
        }

        if (this._bgJob.status === 'done' || this._bgJob.status === 'error' || this._bgJob.status === 'killed') {
          this._pollingBg = false;
          if (this._bgJob.status === 'done') {
            this._selectedImage = this._bgJob.outImage || this._selectedImage;
            this._syncPreview();
            this._syncStatusAndOut();
            this._ctx?.log?.(`ZImage3D: background removed → ${this._selectedImage}`);
          }
          return;
        }

        backoff = 500;
      } catch (e) {
        if (this._statusEl) this._statusEl.textContent = `Rembg polling failed: ${e?.message || e}`;
        backoff = Math.min(2000, Math.floor(backoff * 1.4));
      }
      await sleep(backoff);
    }
  }

  async _startMeshJob() {
    const st = this._state;
    const img = String(this._selectedImage || this._imgJob?.outImage || '');
    if (!img) throw new Error('No image generated yet');

    this._meshJob = { id: '', status: 'running', stdout: '', stderr: '', outGlb: '', outMp4: '', outRig: '' };
    this._syncStatusAndOut();
    if (this._logEl) this._logEl.textContent = `(starting ${st.meshBackend === 'trellis' ? 'Trellis' : 'Hunyuan'}...)`;

    const payload = {
      runner: st.runner,
      meshBackend: st.meshBackend || 'hunyuan',
      outName: st.outName,
      device: st.device,
      imageAssetPath: img,
      trellisModel: st.trellisModel,
      simplify: st.simplify,
      aabb: st.aabb,
      decimationTarget: st.decimationTarget,
      textureSize: st.textureSize,
      remesh: st.remesh,
      remeshBand: st.remeshBand,
      remeshProject: st.remeshProject,
      extensionWebp: st.extensionWebp,
      renderMp4: st.renderMp4,
      envmap: st.envmap,
      fps: st.fps,
      rigBackend: st.rigBackend,
      rigArgs: st.rigArgs,
    };

    const resp = await fetch('/__devtools_zimage_mesh_start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'mesh start failed'));

    this._meshJob.id = String(j.id || '');
    this._meshJob.outGlb = String(j.outGlb || '');
    this._meshJob.outMp4 = String(j.outMp4 || '');
    this._meshJob.outRig = String(j.outRig || '');
    this._pollingMesh = true;
    void this._pollMeshLoop();
  }

  async _pollMeshLoop() {
    const id = this._meshJob?.id;
    if (!id) return;
    let backoff = 400;
    while (this._pollingMesh && this._meshJob?.id === id) {
      try {
        const resp = await fetch(`/__devtools_zimage_mesh_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));
        this._meshJob.status = String(j.status || '');
        this._meshJob.stdout = String(j.stdout || '');
        this._meshJob.stderr = String(j.stderr || '');
        this._meshJob.outGlb = String(j.outGlb || '');
        this._meshJob.outMp4 = String(j.outMp4 || '');
        this._meshJob.outRig = String(j.outRig || '');
        this._syncStatusAndOut();
        if (this._logEl) {
          const out = this._meshJob.stdout || '';
          const err = this._meshJob.stderr || '';
          this._logEl.textContent = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output yet)';
          try { this._logEl.scrollTop = this._logEl.scrollHeight; } catch { /* ignore */ }
        }

        if (this._meshJob.status === 'done' || this._meshJob.status === 'error' || this._meshJob.status === 'killed') {
          this._pollingMesh = false;
          if (this._meshJob.status === 'done') {
            try { localStorage.setItem('devtools.lastGeneratedModelUrl', this._meshJob.outRig || this._meshJob.outGlb || ''); } catch { /* ignore */ }
            this._ctx?.log?.(`ZImage3D: GLB ready → ${this._meshJob.outGlb}`);
          }
          return;
        }

        backoff = 500;
      } catch (e) {
        if (this._statusEl) this._statusEl.textContent = `Mesh polling failed: ${e?.message || e}`;
        backoff = Math.min(2000, Math.floor(backoff * 1.4));
      }
      await sleep(backoff);
    }
  }
}

