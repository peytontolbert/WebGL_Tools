import { SCENE_ASSET_LOCATIONS } from './scene_presets.js';

import { safeTrim } from './core/scene_utils.js';

export const sceneBuildingsMixin = {
  _scanTaggedBuildings() {
    const root = this._worldRoot;
    const out = [];
    if (root?.traverse) {
      root.traverse((n) => {
        if (!n) return;
        const isTagged = this._hasProjectTag(n, 'buildings');
        const nm = safeTrim(n?.name).toLowerCase();
        // Common authoring convention: building roots named "blg_*" (e.g. blg_alpha, blg_bravo).
        const isNameHint = nm.startsWith('blg_') || nm.startsWith('bldg_');
        if (isTagged || isNameHint) out.push(n);
      });
    }
    // Stable-ish ordering for UI.
    out.sort((a, b) => {
      const an = safeTrim(a?.name) || '';
      const bn = safeTrim(b?.name) || '';
      if (an && bn) return an.localeCompare(bn);
      if (an) return -1;
      if (bn) return 1;
      return String(a?.uuid || '').localeCompare(String(b?.uuid || ''));
    });
    this._taggedBuildings = out;
  },

  _exportAllBuildingsPayload() {
    this._scanTaggedBuildings();
    const items = Array.isArray(this._taggedBuildings) ? this._taggedBuildings : [];
    return items.map((o) => this._exportBuildingRecord(o));
  },

  _exportBuildingRecord(o) {
    const obj = o || null;
    const ud = (obj?.userData && typeof obj.userData === 'object') ? obj.userData : {};
    return {
      uuid: obj?.uuid || '',
      name: safeTrim(obj?.name),
      assetPath: safeTrim(ud?.buildingAssetPath || ''),
      tags: this._getProjectTags(obj),
      transform: {
        pos: [Number(obj?.position?.x) || 0, Number(obj?.position?.y) || 0, Number(obj?.position?.z) || 0],
        yawDeg: (Number(obj?.rotation?.y) || 0) * 180 / Math.PI,
        scale: Number(obj?.scale?.x) || 1,
      },
      building: ud?.building || {},
      ai: ud?.ai || {},
    };
  },

  async _saveBuildingAssetToAssets({ obj = null, overwrite = true } = {}) {
    const o = obj || null;
    if (!o) throw new Error('Missing building object');
    const ud = (o.userData && typeof o.userData === 'object') ? o.userData : (o.userData = {});
    const existingRel = safeTrim(ud?.buildingAssetPath || '');
    const relPath = (overwrite && existingRel.startsWith('assets/')) ? existingRel : '';

    const rec = this._exportBuildingRecord(o);
    const data = {
      schema: 1,
      kind: 'building',
      source: safeTrim(this._state?.sourceUrl || ''),
      ...rec,
    };
    const nameHint = safeTrim(rec?.name) || 'building';
    const payload = { relPath, relDir: SCENE_ASSET_LOCATIONS.buildings, nameHint, data };

    const resp = await fetch('/__devtools_write_json_asset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await resp.json().catch(() => null);
    if (!j?.ok) throw new Error(String(j?.error || 'write_json_asset failed'));

    // Track source asset on the building itself for easy overwrite.
    try { ud.buildingAssetPath = String(j?.relPath || relPath || ''); } catch { /* ignore */ }
    return j;
  },

  async _saveAllBuildingsAsAssets({ overwriteExisting = true } = {}) {
    this._scanTaggedBuildings();
    const items = Array.isArray(this._taggedBuildings) ? this._taggedBuildings : [];
    let count = 0;
    for (const o of items) {
      try {
        await this._saveBuildingAssetToAssets({ obj: o, overwrite: !!overwriteExisting });
        count++;
      } catch (e) {
        // Keep going; report the first failure in status.
        if (!this._ui?.statusEl?.textContent) this._setStatus(`Save failed for ${safeTrim(o?.name) || o?.uuid || '(unnamed)'}: ${e?.message || e}`);
      }
    }
    return { ok: true, count };
  },
};

