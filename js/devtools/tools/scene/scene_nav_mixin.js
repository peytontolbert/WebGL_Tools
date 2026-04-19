export const sceneNavMixin = {
  _buildNavGrid() {
    const g = this._game;
    if (!g?.enabled) return;
    const nav = g.nav;
    // Expand nav bounds to match the current arena size.
    // (We keep a generous padding so enemies can path around perimeter walls.)
    try {
      nav.minX = -36; nav.maxX = 36;
      nav.minZ = -36; nav.maxZ = 36;
    } catch { /* ignore */ }
    const cell = Math.max(0.25, Number(nav.cell) || 1.0);
    const w = Math.max(1, Math.floor((nav.maxX - nav.minX) / cell));
    const h = Math.max(1, Math.floor((nav.maxZ - nav.minZ) / cell));
    const occ = new Uint8Array(w * h);
    const boxes = Array.isArray(this._obstacleBoxes) ? this._obstacleBoxes : [];

    // Mark blocked cells if their center falls within any obstacle footprint.
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const x = nav.minX + (i + 0.5) * cell;
        const z = nav.minZ + (j + 0.5) * cell;
        let blocked = false;
        for (const b of boxes) {
          if (!b) continue;
          // Ignore very low boxes (none in arena, but safe)
          if ((b.max.y - b.min.y) < 0.4) continue;
          if (x >= b.min.x - 0.4 && x <= b.max.x + 0.4 && z >= b.min.z - 0.4 && z <= b.max.z + 0.4) {
            blocked = true;
            break;
          }
        }
        occ[j * w + i] = blocked ? 1 : 0;
      }
    }

    nav.cell = cell;
    nav.w = w;
    nav.h = h;
    nav.occ = occ;
    nav.built = true;
  },

  _navFindPath(sx, sz, tx, tz) {
    const nav = this._game?.nav;
    if (!nav?.built || !nav.occ) return null;
    const { minX, minZ, cell, w, h, occ } = nav;
    const si = Math.floor((sx - minX) / cell);
    const sj = Math.floor((sz - minZ) / cell);
    const ti = Math.floor((tx - minX) / cell);
    const tj = Math.floor((tz - minZ) / cell);
    const inb = (i, j) => i >= 0 && j >= 0 && i < w && j < h;
    if (!inb(si, sj) || !inb(ti, tj)) return null;
    const start = sj * w + si;
    const goal = tj * w + ti;
    if (occ[start] || occ[goal]) return null;

    // A* with arrays (small grid)
    const came = new Int32Array(w * h);
    const gScore = new Float32Array(w * h);
    const fScore = new Float32Array(w * h);
    const open = [];
    const inOpen = new Uint8Array(w * h);
    const closed = new Uint8Array(w * h);
    for (let k = 0; k < came.length; k++) { came[k] = -1; gScore[k] = 1e9; fScore[k] = 1e9; }
    const hfn = (a, b) => {
      const ai = a % w; const aj = (a / w) | 0;
      const bi = b % w; const bj = (b / w) | 0;
      return Math.abs(ai - bi) + Math.abs(aj - bj);
    };

    gScore[start] = 0;
    fScore[start] = hfn(start, goal);
    open.push(start);
    inOpen[start] = 1;

    const neighbors = (n) => {
      const i = n % w; const j = (n / w) | 0;
      return [
        (j > 0) ? (n - w) : -1,
        (j < h - 1) ? (n + w) : -1,
        (i > 0) ? (n - 1) : -1,
        (i < w - 1) ? (n + 1) : -1,
      ].filter((x) => x >= 0);
    };

    let iters = 0;
    const maxIters = 6000;
    while (open.length && iters++ < maxIters) {
      // pick lowest f
      let bestIdx = 0;
      let bestF = fScore[open[0]];
      for (let i = 1; i < open.length; i++) {
        const n = open[i];
        const f = fScore[n];
        if (f < bestF) { bestF = f; bestIdx = i; }
      }
      const cur = open.splice(bestIdx, 1)[0];
      inOpen[cur] = 0;
      if (cur === goal) break;
      closed[cur] = 1;
      for (const nb of neighbors(cur)) {
        if (closed[nb]) continue;
        if (occ[nb]) continue;
        const tentative = gScore[cur] + 1;
        if (tentative < gScore[nb]) {
          came[nb] = cur;
          gScore[nb] = tentative;
          fScore[nb] = tentative + hfn(nb, goal);
          if (!inOpen[nb]) { open.push(nb); inOpen[nb] = 1; }
        }
      }
    }

    if (came[goal] < 0) return null;
    const nodes = [];
    let cur = goal;
    while (cur >= 0 && cur !== start) {
      nodes.push(cur);
      cur = came[cur];
    }
    nodes.reverse();
    // Convert to world points
    const pts = nodes.map((n) => {
      const i = n % w; const j = (n / w) | 0;
      return { x: minX + (i + 0.5) * cell, z: minZ + (j + 0.5) * cell };
    });
    return pts.slice(0, 64);
  },
};

