import { el, clear } from './dom.js';

export function createStartScreen({ root, store, onLoadMap, onCreateNew }) {
  const panel = el('div', { class: 'panel' });
  root.appendChild(panel);

  const state = { visible: true };

  function render() {
    clear(panel);
    panel.appendChild(el('div', { class: 'title' }, ['Select a map']));
    panel.appendChild(el('div', { class: 'muted' }, [
      'Create up to 5 local maps. Press ',
      el('span', { class: 'kbd' }, ['Esc']),
      ' any time to return here.',
    ]));

    const maps = store.listMaps();
    const limit = store.maxMaps;
    const canCreate = maps.length < limit;

    panel.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'mapLine' }, [
        el('div', {}, [
          el('div', { class: 'mapName' }, ['New map']),
            el('div', { class: 'muted' }, ['Templates: AI City (procedural), AI City (WFC from example), Room Sim (penthouse), Richmond (real-world OSM), Hampton Roads (OSM), or Hampton Roads (OSM roads + Overture buildings)']),
        ]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('button', {
          class: 'primary',
          disabled: !canCreate,
          onclick: async () => onCreateNew('ai_city'),
          title: canCreate ? '' : 'Map limit reached (5)',
        }, ['Create AI City']),
        el('button', {
          disabled: !canCreate,
          onclick: async () => onCreateNew('room_sim'),
          title: canCreate ? '' : 'Map limit reached (5)',
        }, ['Create Room Sim']),
          el('button', {
            disabled: !canCreate,
            onclick: async () => onCreateNew('ai_city_wfc'),
            title: canCreate ? '' : 'Map limit reached (5)',
          }, ['Create AI City (WFC)']),
        el('button', {
          disabled: !canCreate,
          onclick: async () => onCreateNew('richmond_osm'),
          title: canCreate ? '' : 'Map limit reached (5)',
        }, ['Create Richmond (OSM)']),
        el('button', {
          disabled: !canCreate,
          onclick: async () => onCreateNew('hampton_roads_osm'),
          title: canCreate ? '' : 'Map limit reached (5)',
        }, ['Create Hampton Roads (OSM, full)']),
        el('button', {
          disabled: !canCreate,
          onclick: async () => onCreateNew('hampton_roads_osm_overture'),
          title: canCreate ? '' : 'Map limit reached (5)',
        }, ['Create Hampton Roads (OSM roads + Overture buildings)']),
      ]),
    ]));

    const header = el('div', { class: 'card' }, [
      el('div', { class: 'mapLine' }, [
        el('div', {}, [
          el('div', { class: 'mapName' }, [`Your maps (${maps.length}/${limit})`]),
          el('div', { class: 'muted' }, ['Stored in this browser (localStorage).']),
        ]),
      ]),
    ]);
    panel.appendChild(header);

    if (!maps.length) {
      panel.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'muted' }, ['No maps yet. Create an example to get started.']),
      ]));
    }

    for (const m of maps) {
      const chips = [];
      if (m.templateId) {
        const label = (m.templateId === 'ai_city') ? 'AI City'
          : (m.templateId === 'ai_city_wfc') ? 'AI City (WFC)'
          : (m.templateId === 'room_sim') ? 'Room Sim (penthouse)'
          : (m.templateId === 'richmond_osm') ? 'Richmond (real-world)'
            : (m.templateId === 'hampton_roads_osm') ? 'Hampton Roads (real-world)'
              : (m.templateId === 'hampton_roads_osm_overture') ? 'Hampton Roads (OSM+Overture)'
            : String(m.templateId);
        chips.push(el('span', { class: 'chip' }, [label]));
      }
      if (m.dataset?.enabled && m.dataset?.datasetId) chips.push(el('span', { class: 'chip' }, [`dataset:${m.dataset.datasetId}`]));
      if (m.legacy?.kind) chips.push(el('span', { class: 'chip' }, [`legacy:${m.legacy.kind}`]));

      panel.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'mapLine' }, [
          el('div', {}, [
            el('div', { class: 'mapName' }, [m.name || m.id]),
            el('div', { class: 'muted' }, [
              `Updated ${new Date(m.updatedAt || m.createdAt || Date.now()).toLocaleString()}`,
            ]),
            chips.length ? el('div', { style: { marginTop: '6px', display: 'flex', gap: '6px', flexWrap: 'wrap' } }, chips) : el('div', {}),
          ]),
          el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [
            el('button', { class: 'primary', onclick: async () => onLoadMap(m.id) }, ['Load']),
            el('button', {
              class: 'danger',
              onclick: () => {
                if (!confirm(`Delete map "${m.name || m.id}"?`)) return;
                store.deleteMap(m.id);
                render();
              },
            }, ['Delete']),
          ]),
        ]),
      ]));
    }

    const legacyDetected = store.detectLegacyGtaAssets();
    panel.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'mapName' }, ['Legacy GTA5 map (placeholder)']),
      el('div', { class: 'muted', style: { marginTop: '6px' } }, [
        legacyDetected
          ? 'GTA-style assets detected under assets/. This editor keeps a placeholder entry so we can reconnect the full legacy viewer/streaming later.'
          : 'No GTA-style assets detected under assets/. If you drop them back in later, this entry will become available.',
      ]),
    ]));

    panel.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'mapName' }, ['DevTools Viewer']),
      el('div', { class: 'muted', style: { marginTop: '6px' } }, [
        'Open the dedicated viewer for models (rig/anim), terrain previews, and other rendering tools.',
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('button', {
          class: 'primary',
          onclick: () => window.open('./devtools.html', '_blank', 'noopener,noreferrer'),
        }, ['Open DevTools Viewer']),
        el('button', {
          onclick: () => {
            try { localStorage.setItem('devtools.activeToolId', 'scene'); } catch { /* ignore */ }
            try { localStorage.setItem('devtools.scene.sourceUrl', 'proc:resume_showcase'); } catch { /* ignore */ }
            try { localStorage.setItem('devtools.scene.autoPlayAfterLoad', '1'); } catch { /* ignore */ }
            window.location.href = './devtools.html';
          },
          title: 'Open DevTools Scene directly into the playable repository showcase world.',
        }, ['Open Resume Showcase']),
      ]),
    ]));
  }

  function show() {
    state.visible = true;
    panel.style.display = 'block';
    render();
  }
  function hide() {
    state.visible = false;
    panel.style.display = 'none';
  }
  function refresh() {
    if (state.visible) render();
  }

  return { show, hide, refresh };
}


