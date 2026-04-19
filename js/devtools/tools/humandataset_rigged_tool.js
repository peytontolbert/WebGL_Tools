import { el, clear } from '../../ui/dom.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeTrim(v) {
  return String(v ?? '').trim();
}

export class HumanDatasetRiggedTool {
  constructor() {
    this.id = 'humandataset_rigged';
    this.label = 'HumanDataset Rigged';

    this._ctx = null;
    this._root = null;
    this._state = {
      rootPath: 'repos/TRELLIS.2/datasets/humandataset/rigged',
      query: '',
      limit: '2000',
      runner: 'conda_trellis',
      rigBackend: 'rigify',
      rigArgs: '--deform-only',
      blenderPath: '',
      outPrefix: 'humandataset',
    };
    this._items = [];
    this._selected = new Set();
    this._batch = {
      running: false,
      stopRequested: false,
      done: 0,
      failed: 0,
      skipped: 0,
      total: 0,
      current: '',
      logs: [],
    };
    this._statusEl = null;
    this._listEl = null;
    this._logEl = null;
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;
    this._buildUi();
  }

  async unmount() {
    this._batch.stopRequested = true;
    this._batch.running = false;
    this._ctx = null;
    this._root = null;
  }

  tick() {}

  getStats() {
    return {
      indexed: this._items.length,
      selected: this._selected.size,
      batch: this._batch.running ? 'running' : 'idle',
      progress: `${this._batch.done + this._batch.failed}/${this._batch.total || 0}`,
    };
  }

  _setStatus(text) {
    if (this._statusEl) this._statusEl.textContent = text;
  }

  _pushLog(line) {
    const msg = safeTrim(line);
    if (!msg) return;
    this._batch.logs.push(msg);
    if (this._batch.logs.length > 400) this._batch.logs.splice(0, this._batch.logs.length - 400);
    if (this._logEl) {
      this._logEl.textContent = this._batch.logs.join('\n');
      try { this._logEl.scrollTop = this._logEl.scrollHeight; } catch { /* ignore */ }
    }
  }

  _buildUi() {
    if (!this._root) return;
    clear(this._root);
    const st = this._state;

    const rootPath = el('input', {
      value: st.rootPath,
      placeholder: 'repos/TRELLIS.2/datasets/humandataset/rigged',
      oninput: (e) => { st.rootPath = safeTrim(e.target.value); },
    });
    const query = el('input', {
      value: st.query,
      placeholder: 'optional filename filter (e.g. carla, male, female)',
      oninput: (e) => { st.query = safeTrim(e.target.value); },
    });
    const limit = el('input', {
      value: st.limit,
      placeholder: '2000',
      oninput: (e) => { st.limit = safeTrim(e.target.value); },
    });
    const runner = el('select', {
      value: st.runner,
      onchange: (e) => { st.runner = safeTrim(e.target.value) || 'conda_trellis'; },
    }, [
      el('option', { value: 'conda_trellis' }, ['conda_trellis']),
      el('option', { value: 'python3' }, ['python3']),
    ]);
    const rigBackend = el('select', {
      value: st.rigBackend,
      onchange: (e) => { st.rigBackend = safeTrim(e.target.value) || 'rigify'; },
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
      placeholder: '--deform-only',
      oninput: (e) => { st.rigArgs = String(e.target.value || ''); },
    });
    const blenderPath = el('input', {
      value: st.blenderPath,
      placeholder: 'optional /path/to/blender',
      oninput: (e) => { st.blenderPath = safeTrim(e.target.value); },
    });
    const outPrefix = el('input', {
      value: st.outPrefix,
      placeholder: 'humandataset',
      oninput: (e) => { st.outPrefix = safeTrim(e.target.value); },
    });

    const refreshBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { await this._refreshIndex(); } catch (e) { this._setStatus(`Index failed: ${e?.message || e}`); }
      },
    }, ['Index rigged models']);

    const selectAllBtn = el('button', {
      onclick: () => {
        this._selected = new Set(this._items.map((it) => it.path));
        this._renderList();
      },
    }, ['Select all']);

    const clearSelBtn = el('button', {
      onclick: () => {
        this._selected.clear();
        this._renderList();
      },
    }, ['Clear selection']);

    const startBatchBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { await this._runBatchRig(); } catch (e) { this._setStatus(`Batch failed: ${e?.message || e}`); }
      },
    }, ['Batch auto-rig selected']);

    const stopBatchBtn = el('button', {
      class: 'danger',
      onclick: () => { this._batch.stopRequested = true; },
    }, ['Stop batch']);

    this._statusEl = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['Idle']);
    this._listEl = el('div', { class: 'scrollArea', style: { height: '220px', marginTop: '8px' } }, ['(index results appear here)']);
    this._logEl = el('div', { class: 'scrollArea', style: { height: '180px', marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['(batch logs appear here)']);

    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['HumanDataset Rigged Integration']),
      el('div', { class: 'muted' }, [
        'Index local rigged models (FBX/GLB/OBJ) and run batch auto-rig for DevTools character pipelines.',
      ]),
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Dataset root']),
      rootPath,
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } }, [
        el('div', { style: { flex: '1' } }, [el('div', { class: 'muted' }, ['Filter']), query]),
        el('div', { style: { width: '120px' } }, [el('div', { class: 'muted' }, ['Limit']), limit]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [refreshBtn, selectAllBtn, clearSelBtn]),

      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Batch rig settings']),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } }, [
        el('div', { style: { flex: '1' } }, [el('div', { class: 'muted' }, ['Runner']), runner]),
        el('div', { style: { flex: '1' } }, [el('div', { class: 'muted' }, ['Backend']), rigBackend]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Rig args']),
      rigArgs,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Blender path (optional)']),
      blenderPath,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Output prefix']),
      outPrefix,
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } }, [startBatchBtn, stopBatchBtn]),

      this._statusEl,
      this._listEl,
      this._logEl,
    ]));

    this._renderList();
  }

  _renderList() {
    if (!this._listEl) return;
    clear(this._listEl);
    if (!this._items.length) {
      this._listEl.textContent = '(no indexed models)';
      return;
    }
    const header = el('div', { class: 'muted', style: { marginBottom: '8px' } }, [
      `Indexed: ${this._items.length} | Selected: ${this._selected.size}`,
    ]);
    this._listEl.appendChild(header);

    for (const it of this._items) {
      const checked = this._selected.has(it.path);
      const cb = el('input', {
        type: 'checkbox',
        checked,
        onchange: (e) => {
          if (e.target.checked) this._selected.add(it.path);
          else this._selected.delete(it.path);
          this._renderList();
        },
      });
      this._listEl.appendChild(el('label', {
        class: 'row',
        style: { gap: '8px', alignItems: 'flex-start', marginBottom: '6px' },
      }, [
        cb,
        el('div', { style: { flex: '1', wordBreak: 'break-all' } }, [
          `${it.modelId || 'model'}  (${it.ext || ''})\n${it.path}`,
        ]),
      ]));
    }
  }

  async _refreshIndex() {
    const st = this._state;
    const q = encodeURIComponent(st.query || '');
    const rp = encodeURIComponent(st.rootPath || '');
    const lim = encodeURIComponent(st.limit || '2000');
    this._setStatus('Indexing local rigged models...');
    const resp = await fetch(`/__devtools_humandataset_index?rootPath=${rp}&query=${q}&limit=${lim}`);
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'index failed'));
    this._items = Array.isArray(j.items) ? j.items : [];
    this._selected = new Set(this._items.map((it) => it.path));
    this._setStatus(`Indexed ${this._items.length} model files from ${j.rootPath}`);
    this._renderList();
  }

  async _runBatchRig() {
    if (this._batch.running) throw new Error('Batch already running');
    const selected = this._items.filter((it) => this._selected.has(it.path));
    if (!selected.length) throw new Error('No selected models');

    this._batch.running = true;
    this._batch.stopRequested = false;
    this._batch.done = 0;
    this._batch.failed = 0;
    this._batch.skipped = 0;
    this._batch.total = selected.length;
    this._batch.current = '';
    this._batch.logs = [];

    this._pushLog(`Batch start: ${selected.length} selected models`);

    for (let i = 0; i < selected.length; i++) {
      if (this._batch.stopRequested) {
        this._pushLog('Batch stop requested.');
        break;
      }
      const item = selected[i];
      const itemPath = safeTrim(item.path);
      if (!itemPath) {
        this._batch.skipped += 1;
        continue;
      }

      this._batch.current = itemPath;
      this._setStatus(`Batch ${i + 1}/${selected.length}: ${itemPath}`);
      const outName = `${safeTrim(this._state.outPrefix) || 'humandataset'}_${safeTrim(item.modelId || `model_${i + 1}`)}`;
      this._pushLog(`[${i + 1}/${selected.length}] start ${itemPath}`);

      try {
        const startResp = await fetch('/__devtools_rig_start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            runner: this._state.runner,
            inModelPath: itemPath,
            rigBackend: this._state.rigBackend,
            rigArgs: this._state.rigArgs,
            blenderPath: this._state.blenderPath,
            outName,
          }),
        });
        const startJson = await startResp.json();
        if (!startJson?.ok) throw new Error(String(startJson?.error || 'start failed'));

        const jobId = String(startJson.id || '');
        const result = await this._waitRigJob(jobId);
        if (result.status !== 'done') {
          this._batch.failed += 1;
          this._pushLog(`[${i + 1}/${selected.length}] failed ${itemPath}: ${result.status}${result.exitCode == null ? '' : ` (exit=${result.exitCode})`}`);
        } else {
          this._batch.done += 1;
          this._pushLog(`[${i + 1}/${selected.length}] done ${itemPath} -> ${safeTrim(result.outRigRel || '')}`);
        }
      } catch (e) {
        this._batch.failed += 1;
        this._pushLog(`[${i + 1}/${selected.length}] error ${itemPath}: ${e?.message || e}`);
      }
    }

    this._batch.running = false;
    this._batch.current = '';
    this._setStatus(`Batch complete. done=${this._batch.done} failed=${this._batch.failed} skipped=${this._batch.skipped} total=${this._batch.total}`);
    this._ctx?.toast?.(`HumanDataset batch finished: ${this._batch.done}/${this._batch.total} succeeded`, this._batch.failed ? 'warning' : 'success', { title: 'Rigging' });
  }

  async _waitRigJob(id) {
    const jobId = safeTrim(id);
    if (!jobId) throw new Error('Missing rig job id');
    let backoff = 500;
    while (true) {
      if (this._batch.stopRequested) return { status: 'killed' };
      const resp = await fetch(`/__devtools_rig_job?id=${encodeURIComponent(jobId)}`);
      const j = await resp.json();
      if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));
      const status = safeTrim(j.status);
      if (status === 'done' || status === 'error' || status === 'killed') {
        return j;
      }
      await sleep(backoff);
      backoff = Math.min(1500, Math.floor(backoff * 1.2));
    }
  }
}

