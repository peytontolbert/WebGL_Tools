import { safeTrim, normalizeWebUrl, escapeHtml } from './core/scene_utils.js';

export const sceneResumeShowcasePanelMixin = {
  _openExternalUrl(rawUrl) {
    const u = normalizeWebUrl(rawUrl);
    if (!u) return false;
    try {
      window.open(u, '_blank', 'noopener,noreferrer');
      return true;
    } catch {
      return false;
    }
  },

  async _deriveGithubZipUrl(repoUrl) {
    const u = normalizeWebUrl(repoUrl);
    if (!u) return '';
    try {
      const parsed = new URL(u);
      const parts = String(parsed.pathname || '').split('/').filter(Boolean);
      if (parts.length < 2) return '';
      const owner = safeTrim(parts[0]);
      const repo = safeTrim(parts[1]).replace(/\.git$/i, '');
      if (!owner || !repo) return '';
      const key = `${owner}/${repo}`.toLowerCase();
      const cache = this._resumeShowcase?.repoBranchCache;
      let branch = safeTrim(cache?.get?.(key) || '');
      if (!branch) {
        try {
          const resp = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
            headers: { Accept: 'application/vnd.github+json' },
            cache: 'no-store',
          });
          if (resp.ok) {
            const j = await resp.json().catch(() => null);
            branch = safeTrim(j?.default_branch || '');
          }
        } catch { /* ignore */ }
      }
      if (!branch) branch = 'main';
      try { cache?.set?.(key, branch); } catch { /* ignore */ }
      return `https://github.com/${owner}/${repo}/archive/refs/heads/${encodeURIComponent(branch)}.zip`;
    } catch {
      return '';
    }
  },

  async _downloadRepoZip(repoUrl) {
    const zipUrl = await this._deriveGithubZipUrl(repoUrl);
    if (!zipUrl) return false;
    try {
      const a = document.createElement('a');
      a.href = zipUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.download = '';
      document.body.appendChild(a);
      a.click();
      try { a.remove(); } catch { /* ignore */ }
      return true;
    } catch {
      return false;
    }
  },

  _inlineMarkdownToHtml(raw) {
    let s = escapeHtml(raw);
    // Inline code first to avoid formatting inside code spans.
    s = s.replace(/`([^`]+)`/g, (_m, code) => `<code style="background:rgba(136,173,233,0.12);padding:1px 5px;border-radius:4px;color:#d5e8ff">${code}</code>`);
    // Links
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, txt, href) => {
      const u = normalizeWebUrl(href);
      if (!u) return escapeHtml(txt);
      return `<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer" style="color:#8fc8ff;text-decoration:underline">${escapeHtml(txt)}</a>`;
    });
    // Bold / italic
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return s;
  },

  _markdownToHtml(md) {
    const src = String(md || '').replace(/\r\n/g, '\n');
    const lines = src.split('\n');
    const out = [];
    let inCode = false;
    let codeLines = [];
    let listType = ''; // ul | ol

    const closeList = () => {
      if (!listType) return;
      out.push(listType === 'ol' ? '</ol>' : '</ul>');
      listType = '';
    };
    const flushCode = () => {
      if (!inCode) return;
      out.push(`<pre style="margin:8px 0;padding:10px;border-radius:8px;background:rgba(8,16,30,0.9);border:1px solid rgba(127,167,220,0.25);overflow:auto"><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      inCode = false;
      codeLines = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const t = ln.trim();
      if (t.startsWith('```')) {
        closeList();
        if (!inCode) {
          inCode = true;
          codeLines = [];
        } else {
          flushCode();
        }
        continue;
      }
      if (inCode) {
        codeLines.push(ln);
        continue;
      }
      if (!t) {
        closeList();
        out.push('<div style="height:6px"></div>');
        continue;
      }
      const h = t.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        closeList();
        const lvl = Math.max(1, Math.min(6, h[1].length));
        const size = ({ 1: 24, 2: 21, 3: 18, 4: 16, 5: 14, 6: 13 })[lvl] || 16;
        out.push(`<h${lvl} style="margin:8px 0 6px 0;font-size:${size}px;color:#e2efff">${this._inlineMarkdownToHtml(h[2])}</h${lvl}>`);
        continue;
      }
      if (/^---+$/.test(t) || /^\*\*\*+$/.test(t)) {
        closeList();
        out.push('<hr style="border:0;border-top:1px solid rgba(127,167,220,0.35);margin:10px 0" />');
        continue;
      }
      const quote = t.match(/^>\s?(.*)$/);
      if (quote) {
        closeList();
        out.push(`<blockquote style="margin:8px 0;padding:6px 10px;border-left:3px solid rgba(127,167,220,0.55);background:rgba(127,167,220,0.08);color:#cfe4ff">${this._inlineMarkdownToHtml(quote[1])}</blockquote>`);
        continue;
      }
      const ul = t.match(/^[-*+]\s+(.*)$/);
      if (ul) {
        if (listType !== 'ul') { closeList(); out.push('<ul style="margin:6px 0 6px 20px;padding:0">'); listType = 'ul'; }
        out.push(`<li style="margin:3px 0">${this._inlineMarkdownToHtml(ul[1])}</li>`);
        continue;
      }
      const ol = t.match(/^\d+\.\s+(.*)$/);
      if (ol) {
        if (listType !== 'ol') { closeList(); out.push('<ol style="margin:6px 0 6px 20px;padding:0">'); listType = 'ol'; }
        out.push(`<li style="margin:3px 0">${this._inlineMarkdownToHtml(ol[1])}</li>`);
        continue;
      }
      closeList();
      out.push(`<p style="margin:6px 0;color:#d2e6ff">${this._inlineMarkdownToHtml(t)}</p>`);
    }
    flushCode();
    closeList();
    return out.join('\n');
  },

  _ensureResumeProjectPanel() {
    if (this._resumeShowcase?.panelRoot) return;
    const mk = (tag, style = {}, text = '') => {
      const n = document.createElement(tag);
      Object.assign(n.style, style || {});
      if (text) n.textContent = String(text);
      return n;
    };
    const bindButtonFx = (btn) => {
      if (!btn) return;
      btn.addEventListener('mouseenter', () => {
        btn.style.transform = 'translateY(-1px) scale(1.01)';
        btn.style.background = 'linear-gradient(180deg, rgba(40,62,95,0.96), rgba(18,29,49,0.98))';
        btn.style.borderColor = 'rgba(157,237,255,0.72)';
        btn.style.boxShadow = '0 0 0 1px rgba(145,214,255,0.24), 0 0 18px rgba(104,215,255,0.24), 0 0 30px rgba(228,92,255,0.14)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.transform = 'translateY(0px)';
        btn.style.background = 'linear-gradient(180deg, rgba(24,38,59,0.92), rgba(15,24,39,0.95))';
        btn.style.borderColor = 'rgba(186,213,255,0.45)';
        btn.style.boxShadow = '0 0 0 1px rgba(145,214,255,0.14), inset 0 0 16px rgba(112,219,255,0.06)';
      });
    };
    const root = mk('div', {
      position: 'absolute',
      inset: '0',
      background: 'radial-gradient(circle at 50% 22%, rgba(85,177,255,0.2), rgba(30,16,57,0.4) 34%, rgba(7,12,22,0.9) 48%, rgba(3,6,12,0.96) 100%)',
      zIndex: '40',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '14px',
      boxSizing: 'border-box',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity 260ms ease',
      backdropFilter: 'blur(3px) saturate(1.1)',
    });
    const rootPulse = mk('div', {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      opacity: '0',
      background: [
        'radial-gradient(circle at 50% 30%, rgba(113, 223, 255, 0.34), rgba(113, 223, 255, 0.0) 56%)',
        'radial-gradient(circle at 52% 64%, rgba(233, 104, 255, 0.2), rgba(233, 104, 255, 0.0) 62%)',
      ].join(','),
      mixBlendMode: 'screen',
      transform: 'scale(1.1)',
      transition: 'opacity 640ms ease, transform 1300ms cubic-bezier(0.14, 0.86, 0.2, 1)',
    });
    root.appendChild(rootPulse);
    const panel = mk('div', {
      width: 'min(1100px, 100%)',
      height: 'min(82vh, 760px)',
      position: 'relative',
      background: 'linear-gradient(180deg, rgba(9,16,30,0.95), rgba(8,13,24,0.98))',
      border: '1px solid rgba(128,204,255,0.38)',
      borderRadius: '12px',
      display: 'flex',
      flexDirection: 'column',
      boxShadow: '0 30px 80px rgba(2,7,16,0.8), 0 0 0 1px rgba(122,191,255,0.14), 0 0 42px rgba(105,214,255,0.1), inset 0 1px 0 rgba(196,238,255,0.09)',
      overflow: 'hidden',
      opacity: '0',
      transform: 'translateY(30px) scale(0.965) rotateX(6deg)',
      transformOrigin: '50% 85%',
      filter: 'blur(8px) saturate(0.88)',
      transition: 'transform 1300ms cubic-bezier(0.14, 0.86, 0.2, 1), opacity 760ms ease, filter 1200ms ease, box-shadow 1450ms ease',
    });
    const top = mk('div', {
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '10px 12px',
      borderBottom: '1px solid rgba(127,195,255,0.24)',
      background: 'linear-gradient(90deg, rgba(12,24,42,0.96), rgba(31,16,50,0.92) 52%, rgba(12,24,42,0.96) 100%)',
      color: '#d7e8ff',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      opacity: '0',
      transform: 'translateY(-8px)',
      transition: 'opacity 520ms ease, transform 720ms cubic-bezier(0.18, 0.84, 0.22, 1)',
    });
    const badge = mk('div', {
      fontSize: '10px',
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: '#9de6ff',
      padding: '4px 7px',
      borderRadius: '999px',
      border: '1px solid rgba(152,223,255,0.45)',
      background: 'linear-gradient(180deg, rgba(21,40,67,0.92), rgba(17,32,54,0.88))',
      boxShadow: 'inset 0 0 8px rgba(110,214,255,0.16), 0 0 16px rgba(101,208,255,0.16)',
    }, 'Portfolio Console');
    const title = mk('div', {
      fontWeight: '700',
      fontSize: '14px',
      flex: '1',
      letterSpacing: '0.05em',
      textTransform: 'uppercase',
      color: '#dff2ff',
      textShadow: '0 0 10px rgba(104,217,255,0.3)',
    }, 'Project');
    const closeBtn = mk('button', {
      border: '1px solid rgba(186,213,255,0.45)',
      borderRadius: '6px',
      background: 'linear-gradient(180deg, rgba(24,38,59,0.92), rgba(15,24,39,0.95))',
      color: '#d9e9ff',
      padding: '6px 10px',
      cursor: 'pointer',
      transition: 'background 140ms ease, transform 140ms ease, box-shadow 140ms ease',
      boxShadow: '0 0 0 1px rgba(145,214,255,0.14), inset 0 0 16px rgba(112,219,255,0.06)',
    }, 'Close');
    closeBtn.onclick = () => this._hideResumeProjectPanel();
    bindButtonFx(closeBtn);
    top.appendChild(badge);
    top.appendChild(title);
    top.appendChild(closeBtn);
    const rail = mk('div', {
      height: '2px',
      width: '100%',
      background: 'linear-gradient(90deg, rgba(76,213,255,0.0), rgba(88,224,255,0.9) 26%, rgba(236,96,255,0.84) 72%, rgba(236,96,255,0.0))',
      boxShadow: '0 0 14px rgba(88,224,255,0.42), 0 0 20px rgba(236,96,255,0.26)',
      opacity: '0',
      transform: 'scaleX(0.72) translateY(-1px)',
      transformOrigin: '50% 50%',
      transition: 'opacity 440ms ease, transform 900ms cubic-bezier(0.16, 0.86, 0.2, 1)',
      flexShrink: '0',
    });

    const meta = mk('div', {
      color: '#95c8ff',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: '12px',
      padding: '8px 12px 0 12px',
      whiteSpace: 'pre-wrap',
      opacity: '0',
      transform: 'translateY(10px)',
      transition: 'opacity 180ms ease, transform 220ms ease',
    });
    const desc = mk('div', {
      color: '#c6dcff',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '12px',
      padding: '6px 12px 10px 12px',
      borderBottom: '1px solid rgba(127,189,255,0.2)',
      whiteSpace: 'pre-wrap',
      opacity: '0',
      transform: 'translateY(10px)',
      transition: 'opacity 200ms ease, transform 240ms ease',
    });
    const actions = mk('div', {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '8px 12px',
      borderBottom: '1px solid rgba(127,189,255,0.2)',
      background: 'linear-gradient(180deg, rgba(13,20,33,0.78), rgba(10,16,28,0.86))',
      opacity: '0',
      transform: 'translateY(10px)',
      transition: 'opacity 220ms ease, transform 260ms ease',
    });
    const openRepoBtn = mk('button', {
      border: '1px solid rgba(186,213,255,0.45)',
      borderRadius: '6px',
      background: 'linear-gradient(180deg, rgba(24,38,59,0.92), rgba(15,24,39,0.95))',
      color: '#d9e9ff',
      padding: '6px 10px',
      cursor: 'pointer',
      transition: 'background 140ms ease, transform 140ms ease, box-shadow 140ms ease',
      boxShadow: '0 0 0 1px rgba(145,214,255,0.14), inset 0 0 16px rgba(112,219,255,0.06)',
    }, 'Open GitHub');
    const openDemoBtn = mk('button', {
      border: '1px solid rgba(186,213,255,0.45)',
      borderRadius: '6px',
      background: 'linear-gradient(180deg, rgba(24,38,59,0.92), rgba(15,24,39,0.95))',
      color: '#d9e9ff',
      padding: '6px 10px',
      cursor: 'pointer',
      transition: 'background 140ms ease, transform 140ms ease, box-shadow 140ms ease',
      boxShadow: '0 0 0 1px rgba(145,214,255,0.14), inset 0 0 16px rgba(112,219,255,0.06)',
    }, 'Download ZIP');
    bindButtonFx(openRepoBtn);
    bindButtonFx(openDemoBtn);
    const hint = mk('div', { marginLeft: 'auto', color: '#9ec7ed', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '11px', letterSpacing: '0.03em' },
      'Local README preview from cloned repository files.',
    );
    actions.appendChild(openRepoBtn);
    actions.appendChild(openDemoBtn);
    actions.appendChild(hint);

    const readme = mk('div', {
      flex: '1',
      margin: '0',
      padding: '12px',
      overflow: 'auto',
      background: 'linear-gradient(180deg, rgba(10,18,31,0.96), rgba(7,12,22,0.98))',
      color: '#d2e6ff',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: '12px',
      lineHeight: '1.45',
      borderTop: '1px solid rgba(132,202,255,0.14)',
      opacity: '0',
      transform: 'translateY(14px)',
      transition: 'opacity 240ms ease, transform 280ms ease',
    });
    readme.textContent = 'Loading repository details...';

    const readmeFx = mk('div', {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      mixBlendMode: 'screen',
      opacity: '0.28',
      background: [
        'repeating-linear-gradient(0deg, rgba(99,210,255,0.045) 0px, rgba(99,210,255,0.045) 1px, rgba(0,0,0,0) 1px, rgba(0,0,0,0) 3px)',
        'linear-gradient(135deg, rgba(85,212,255,0.06), rgba(226,98,255,0.045))',
      ].join(','),
      backgroundSize: 'auto, 100% 100%',
      animation: 'resumePanelScan 5.2s linear infinite',
    });
    panel.appendChild(readmeFx);

    panel.style.pointerEvents = 'auto';
    panel.appendChild(top);
    panel.appendChild(rail);
    panel.appendChild(meta);
    panel.appendChild(desc);
    panel.appendChild(actions);
    panel.appendChild(readme);
    root.appendChild(panel);
    root.addEventListener('click', (ev) => {
      if (ev.target === root) this._hideResumeProjectPanel();
    });
    const host = this._ctx?.canvasHost || this._hudOverlay || document.body;
    host.appendChild(root);
    if (!document.getElementById('resume-panel-neon-style')) {
      const styleEl = document.createElement('style');
      styleEl.id = 'resume-panel-neon-style';
      styleEl.textContent = `
        @keyframes resumePanelScan {
          0% { transform: translateY(-8%); }
          100% { transform: translateY(8%); }
        }
      `;
      document.head.appendChild(styleEl);
    }

    this._resumeShowcase.panelRoot = root;
    this._resumeShowcase.panelCard = panel;
    this._resumeShowcase.panelTitle = title;
    this._resumeShowcase.panelMeta = meta;
    this._resumeShowcase.panelDesc = desc;
    this._resumeShowcase.panelReadme = readme;
    this._resumeShowcase.panelOpenRepoBtn = openRepoBtn;
    this._resumeShowcase.panelOpenDemoBtn = openDemoBtn;
    this._resumeShowcase.panelSections = [meta, desc, actions, readme];
    this._resumeShowcase.panelChrome = [top, rail];
    this._resumeShowcase.panelPulse = rootPulse;
  },

  _repoNameFromUrl(repoUrl, fallbackName = '') {
    const fb = safeTrim(fallbackName);
    const url = normalizeWebUrl(repoUrl);
    if (!url) return fb;
    try {
      const u = new URL(url);
      const parts = String(u.pathname || '').split('/').filter(Boolean);
      if (!parts.length) return fb;
      const last = safeTrim(parts[parts.length - 1]).replace(/\.git$/i, '');
      return last || fb;
    } catch {
      return fb;
    }
  },

  _repoUserFromUrl(repoUrl, fallbackUser = '') {
    const fb = safeTrim(fallbackUser);
    const url = normalizeWebUrl(repoUrl);
    if (!url) return fb;
    try {
      const u = new URL(url);
      const parts = String(u.pathname || '').split('/').filter(Boolean);
      if (parts.length < 2) return fb;
      return safeTrim(parts[0]) || fb;
    } catch {
      return fb;
    }
  },

  async _loadLocalRepoReadme({ repoName, repoUrl, user } = {}) {
    const repo = safeTrim(repoName) || this._repoNameFromUrl(repoUrl, '');
    const who = safeTrim(user) || this._repoUserFromUrl(repoUrl, '') || safeTrim(this._resumeShowcase?.githubUser) || 'peytontolbert';
    if (!repo || !who) return '';
    const key = `${who}/${repo}`.toLowerCase();
    const cache = this._resumeShowcase?.readmeCache;
    if (cache && cache.has(key)) return String(cache.get(key) || '');

    const base = `/repos/github-${encodeURIComponent(who)}/${encodeURIComponent(repo)}`;
    const candidates = [
      `${base}/README.md`,
      `${base}/readme.md`,
      `${base}/README.MD`,
      `${base}/README.txt`,
      `${base}/readme.txt`,
      `${base}/docs/README.md`,
      `${base}/docs/readme.md`,
    ];
    for (const p of candidates) {
      try {
        const resp = await fetch(p, { cache: 'no-store' });
        if (!resp.ok) continue;
        const txt = await resp.text();
        const out = safeTrim(txt);
        if (out) {
          try { cache?.set?.(key, out); } catch { /* ignore */ }
          return out;
        }
      } catch { /* ignore */ }
    }
    const miss = 'README not found in local clone.';
    try { cache?.set?.(key, miss); } catch { /* ignore */ }
    return miss;
  },

  async _showResumeProjectPanel({ title, meta, description, repoUrl, demoUrl, embedUrl, repoName, repoUser } = {}) {
    this._ensureResumeProjectPanel();
    const st = this._resumeShowcase;
    if (!st?.panelRoot) return;
    try {
      if (st.panelHideTimer) {
        clearTimeout(st.panelHideTimer);
        st.panelHideTimer = null;
      }
    } catch { /* ignore */ }
    try {
      for (const t of (Array.isArray(st.panelTimers) ? st.panelTimers : [])) clearTimeout(t);
      st.panelTimers = [];
    } catch { /* ignore */ }
    try { this._plock?.unlock?.(); } catch { /* ignore */ }

    const t = safeTrim(title) || 'Project';
    const m = safeTrim(meta);
    const d = safeTrim(description) || 'Interactive project info.';
    const repo = normalizeWebUrl(repoUrl);
    const demo = normalizeWebUrl(demoUrl);
    let isGithubRepo = false;
    try {
      if (repo) {
        const pu = new URL(repo);
        const parts = String(pu.pathname || '').split('/').filter(Boolean);
        isGithubRepo = /(^|\.)github\.com$/i.test(String(pu.hostname || '')) && parts.length >= 2;
      }
    } catch { /* ignore */ }
    const embed = normalizeWebUrl(embedUrl);
    const primaryUrl = repo || demo || embed || '';
    const secondaryUrl = (demo && demo !== primaryUrl) ? demo : '';
    const showWebsiteEmbed = !!primaryUrl && !isGithubRepo;
    const rr = safeTrim(repoName) || this._repoNameFromUrl(repo, safeTrim(title));
    const ru = safeTrim(repoUser) || this._repoUserFromUrl(repo, safeTrim(this._resumeShowcase?.githubUser) || 'peytontolbert');
    const summary = safeTrim(description) || safeTrim(meta) || 'No description provided.';

    if (st.panelTitle) st.panelTitle.textContent = t;
    if (st.panelMeta) st.panelMeta.textContent = m;
    if (st.panelDesc) st.panelDesc.textContent = d;
    if (st.panelReadme) {
      if (showWebsiteEmbed) {
        st.panelReadme.innerHTML = '';
        st.panelReadme.style.padding = '0';
        st.panelReadme.style.overflow = 'hidden';
        st.panelReadme.style.fontFamily = 'system-ui, sans-serif';
        st.panelReadme.style.fontSize = '12px';
        st.panelReadme.style.lineHeight = '1.45';

        const wrap = document.createElement('div');
        Object.assign(wrap.style, {
          position: 'relative',
          width: '100%',
          height: '100%',
          background: 'linear-gradient(180deg, rgba(10,18,31,0.96), rgba(7,12,22,0.98))',
        });

        const frame = document.createElement('iframe');
        frame.src = primaryUrl;
        frame.title = `${t} website preview`;
        frame.referrerPolicy = 'no-referrer';
        frame.loading = 'eager';
        Object.assign(frame.style, {
          width: '100%',
          height: '100%',
          border: '0',
          background: '#0a121f',
        });

        const note = document.createElement('div');
        Object.assign(note.style, {
          position: 'absolute',
          left: '12px',
          right: '12px',
          top: '12px',
          zIndex: '3',
          pointerEvents: 'none',
          padding: '8px 10px',
          borderRadius: '8px',
          border: '1px solid rgba(139,204,255,0.38)',
          background: 'rgba(8,16,28,0.62)',
          color: '#b9dcff',
          fontSize: '11px',
          letterSpacing: '0.02em',
          backdropFilter: 'blur(2px)',
        });
        note.textContent = 'Live website preview (if blocked by site policy, use "Open Website").';

        wrap.appendChild(frame);
        wrap.appendChild(note);
        st.panelReadme.appendChild(wrap);
      } else {
        st.panelReadme.style.padding = '12px';
        st.panelReadme.style.overflow = 'auto';
        st.panelReadme.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        st.panelReadme.style.fontSize = '12px';
        st.panelReadme.style.lineHeight = '1.45';
        const mdDoc = [
          `# ${rr || t}`,
          '',
          `Owner: ${ru || '-'}`,
          `Repo: ${safeTrim(repo) || '-'}`,
          `Demo: ${safeTrim(demo) || '-'}`,
          '',
          '## Description',
          summary,
          '',
          '## README',
          (isGithubRepo ? '_Loading README…_' : '_README unavailable._'),
        ].join('\n');
        st.panelReadme.innerHTML = this._markdownToHtml(mdDoc);
      }
    }
    if (st.panelOpenRepoBtn) {
      st.panelOpenRepoBtn.textContent = isGithubRepo ? 'Open GitHub' : 'Open Website';
      st.panelOpenRepoBtn.disabled = !primaryUrl;
      st.panelOpenRepoBtn.onclick = () => {
        if (!this._openExternalUrl(primaryUrl)) this._ctx?.toast?.('Missing project URL', 'warning', { title: 'Project' });
      };
    }
    if (st.panelOpenDemoBtn) {
      if (isGithubRepo) {
        st.panelOpenDemoBtn.textContent = 'Download ZIP';
        st.panelOpenDemoBtn.style.display = '';
        st.panelOpenDemoBtn.disabled = !repo;
        st.panelOpenDemoBtn.onclick = async () => {
          const ok = await this._downloadRepoZip(repo);
          if (!ok) this._ctx?.toast?.('Could not build ZIP download link for this repository', 'warning', { title: 'Project' });
        };
      } else if (secondaryUrl) {
        st.panelOpenDemoBtn.textContent = 'Open Demo';
        st.panelOpenDemoBtn.style.display = '';
        st.panelOpenDemoBtn.disabled = false;
        st.panelOpenDemoBtn.onclick = () => {
          if (!this._openExternalUrl(secondaryUrl)) this._ctx?.toast?.('Missing demo URL', 'warning', { title: 'Project' });
        };
      } else {
        st.panelOpenDemoBtn.style.display = 'none';
        st.panelOpenDemoBtn.disabled = true;
        st.panelOpenDemoBtn.onclick = null;
      }
    }
    st.panelRoot.style.display = 'flex';
    st.panelRoot.style.pointerEvents = 'auto';
    st.panelRoot.style.opacity = '0';
    if (st.panelPulse) {
      st.panelPulse.style.opacity = '0';
      st.panelPulse.style.transform = 'scale(1.1)';
    }
    if (st.panelCard) {
      st.panelCard.style.opacity = '0';
      st.panelCard.style.transform = 'translateY(30px) scale(0.965) rotateX(6deg)';
      st.panelCard.style.filter = 'blur(8px) saturate(0.88)';
      st.panelCard.style.boxShadow = '0 22px 58px rgba(2,7,16,0.66), 0 0 0 1px rgba(122,191,255,0.08), 0 0 10px rgba(105,214,255,0.06), inset 0 1px 0 rgba(196,238,255,0.04)';
    }
    const chrome = Array.isArray(st.panelChrome) ? st.panelChrome : [];
    for (const c of chrome) {
      if (!c) continue;
      c.style.opacity = '0';
      c.style.transform = (c === chrome[0]) ? 'translateY(-8px)' : 'scaleX(0.72) translateY(-1px)';
    }
    for (const sec of (Array.isArray(st.panelSections) ? st.panelSections : [])) {
      if (!sec) continue;
      sec.style.opacity = '0';
      sec.style.transform = 'translateY(14px)';
    }
    requestAnimationFrame(() => {
      st.panelRoot.style.opacity = '1';
      if (st.panelPulse) {
        st.panelPulse.style.opacity = '0.92';
        st.panelPulse.style.transform = 'scale(1.0)';
      }
      if (st.panelCard) {
        st.panelCard.style.opacity = '1';
        st.panelCard.style.transform = 'translateY(0px) scale(1) rotateX(0deg)';
        st.panelCard.style.filter = 'blur(0px) saturate(1)';
        st.panelCard.style.boxShadow = '0 30px 80px rgba(2,7,16,0.8), 0 0 0 1px rgba(122,191,255,0.14), 0 0 42px rgba(105,214,255,0.1), inset 0 1px 0 rgba(196,238,255,0.09)';
      }
      if (chrome[0]) {
        const t = setTimeout(() => {
          chrome[0].style.opacity = '1';
          chrome[0].style.transform = 'translateY(0px)';
        }, 150);
        st.panelTimers.push(t);
      }
      if (chrome[1]) {
        const t = setTimeout(() => {
          chrome[1].style.opacity = '0.96';
          chrome[1].style.transform = 'scaleX(1) translateY(0px)';
        }, 260);
        st.panelTimers.push(t);
      }
      const sections = Array.isArray(st.panelSections) ? st.panelSections : [];
      for (let i = 0; i < sections.length; i += 1) {
        const sec = sections[i];
        if (!sec) continue;
        // Stage content reveal to complete in a little over 2 seconds.
        const delay = 520 + (i * 280);
        const t = setTimeout(() => {
          sec.style.opacity = '1';
          sec.style.transform = 'translateY(0px)';
        }, delay);
        st.panelTimers.push(t);
      }
      const pulseT = setTimeout(() => {
        if (st.panelPulse) st.panelPulse.style.opacity = '0.22';
      }, 1560);
      st.panelTimers.push(pulseT);
    });

    // Load README after the panel becomes visible so "E interact" feels immediate.
    if (!showWebsiteEmbed && isGithubRepo && st.panelReadme) {
      try {
        const readme = await this._loadLocalRepoReadme({ repoName: rr, repoUrl: repo, user: ru });
        const mdDoc = [
          `# ${rr || t}`,
          '',
          `Owner: ${ru || '-'}`,
          `Repo: ${safeTrim(repo) || '-'}`,
          `Demo: ${safeTrim(demo) || '-'}`,
          '',
          '## Description',
          summary,
          '',
          '## README',
          safeTrim(readme) || 'README unavailable.',
        ].join('\n');
        st.panelReadme.innerHTML = this._markdownToHtml(mdDoc);
      } catch { /* ignore */ }
    }
  },

  _hideResumeProjectPanel() {
    const st = this._resumeShowcase;
    if (!st?.panelRoot) return;
    try {
      if (st.panelHideTimer) {
        clearTimeout(st.panelHideTimer);
        st.panelHideTimer = null;
      }
    } catch { /* ignore */ }
    try {
      for (const t of (Array.isArray(st.panelTimers) ? st.panelTimers : [])) clearTimeout(t);
      st.panelTimers = [];
    } catch { /* ignore */ }
    st.panelRoot.style.pointerEvents = 'none';
    st.panelRoot.style.opacity = '0';
    if (st.panelPulse) {
      st.panelPulse.style.opacity = '0';
      st.panelPulse.style.transform = 'scale(1.08)';
    }
    if (st.panelCard) {
      st.panelCard.style.opacity = '0';
      st.panelCard.style.transform = 'translateY(30px) scale(0.965) rotateX(6deg)';
      st.panelCard.style.filter = 'blur(8px) saturate(0.88)';
    }
    const chrome = Array.isArray(st.panelChrome) ? st.panelChrome : [];
    for (const c of chrome) {
      if (!c) continue;
      c.style.opacity = '0';
      c.style.transform = (c === chrome[0]) ? 'translateY(-8px)' : 'scaleX(0.72) translateY(-1px)';
    }
    for (const sec of (Array.isArray(st.panelSections) ? st.panelSections : [])) {
      if (!sec) continue;
      sec.style.opacity = '0';
      sec.style.transform = 'translateY(10px)';
    }
    st.panelHideTimer = setTimeout(() => {
      if (!st?.panelRoot) return;
      st.panelRoot.style.display = 'none';
      try { if (st.panelReadme) st.panelReadme.textContent = ''; } catch { /* ignore */ }
      st.panelHideTimer = null;
    }, 320);
  },

  async _fetchResumeGithubRepos(user) {
    const who = safeTrim(user) || 'peytontolbert';
    const cache = this._resumeShowcase?.repoCache;
    const now = Date.now();
    if (cache && cache.user === who && Array.isArray(cache.repos) && cache.repos.length && (now - Number(cache.atMs || 0) < 4 * 60 * 1000)) {
      return cache.repos.slice();
    }
    const fallback = [
      { name: 'webgl-game', description: 'Playable WebGL resume world.', repoUrl: `https://github.com/${who}/webgl-game`, demoUrl: '', language: 'JavaScript', stars: 0, updatedAt: '' },
      { name: 'project-portfolio', description: 'Portfolio and project collection.', repoUrl: `https://github.com/${who}?tab=repositories`, demoUrl: '', language: '', stars: 0, updatedAt: '' },
    ];
    // Prefer a local curated dataset when available. This avoids API rate limits and
    // lets the showcase stay aligned with the repos currently cloned in this workspace.
    if (who.toLowerCase() === 'peytontolbert') {
      try {
        // Use a relative URL so static hosting under a subpath (e.g. GitHub Pages) still works.
        const localUrl = new URL('data/peytontolbert_repos.json', String(document?.baseURI || window.location.href || '')).toString();
        const localResp = await fetch(localUrl, { cache: 'no-store' });
        if (localResp.ok) {
          const localJson = await localResp.json();
          const rows = Array.isArray(localJson?.repos) ? localJson.repos : [];
          const repos = rows
            .map((r) => {
              const repoName = safeTrim(r?.name);
              const repoUrl = normalizeWebUrl(r?.repoUrl) || `https://github.com/${who}/${repoName}`;
              const demoUrl = normalizeWebUrl(r?.demoUrl);
              return {
                name: repoName,
                description: safeTrim(r?.description),
                repoUrl,
                demoUrl,
                language: safeTrim(r?.language),
                stars: Number(r?.stars || 0),
                updatedAt: safeTrim(r?.updatedAt || ''),
              };
            })
            .filter((r) => !!r.name && !!r.repoUrl);
          if (repos.length) {
            this._resumeShowcase.repoCache = { user: who, atMs: now, repos: repos.slice() };
            return repos;
          }
        }
      } catch { /* ignore */ }
    }
    try {
      const url = `https://api.github.com/users/${encodeURIComponent(who)}/repos?sort=updated&per_page=24&type=owner`;
      const resp = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
      if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);
      const rows = await resp.json();
      if (!Array.isArray(rows)) throw new Error('Unexpected GitHub payload');
      const repos = rows
        .filter((r) => !r?.fork && !r?.archived)
        .map((r) => {
          const owner = safeTrim(r?.owner?.login) || who;
          const repoName = safeTrim(r?.name);
          const homepage = normalizeWebUrl(r?.homepage);
          const pagesGuess = repoName ? `https://${owner}.github.io/${repoName}/` : '';
          return {
            name: repoName,
            description: safeTrim(r?.description),
            repoUrl: normalizeWebUrl(r?.html_url) || `https://github.com/${owner}/${repoName}`,
            demoUrl: homepage || normalizeWebUrl(pagesGuess),
            language: safeTrim(r?.language),
            stars: Number(r?.stargazers_count || 0),
            updatedAt: safeTrim(r?.pushed_at || r?.updated_at || ''),
          };
        })
        .filter((r) => !!r.name && !!r.repoUrl)
        .sort((a, b) => {
          const sa = Number(a.stars || 0);
          const sb = Number(b.stars || 0);
          if (sb !== sa) return sb - sa;
          return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
        });
      const out = repos.length ? repos : fallback;
      this._resumeShowcase.repoCache = { user: who, atMs: now, repos: out.slice() };
      return out;
    } catch {
      this._resumeShowcase.repoCache = { user: who, atMs: now, repos: fallback.slice() };
      return fallback;
    }
  },

  _refreshResumeShowcaseSelection({ showMsg = true, openPanel = false } = {}) {
    const st = this._resumeShowcase;
    const rt = st?.runtime;
    if (!rt || !Array.isArray(rt.repos) || !rt.repos.length) return;
    const idx = Math.max(0, Math.min(rt.repos.length - 1, Number(rt.activeIndex) || 0));
    rt.activeIndex = idx;
    const repo = rt.repos[idx] || {};
    const title = safeTrim(repo?.name) || 'Repository';
    const lang = safeTrim(repo?.language);
    const stars = Number(repo?.stars || 0);
    const desc = safeTrim(repo?.description) || 'Repository preview on the lab platform.';
    const subtitle = [lang, `stars ${stars}`].filter(Boolean).join(' • ');

    try {
      const canvas = rt.screenCanvas;
      const cx = rt.screenCtx;
      const tex = rt.screenTex;
      if (canvas && cx && tex) {
        cx.clearRect(0, 0, canvas.width, canvas.height);
        const grad = cx.createLinearGradient(0, 0, canvas.width, canvas.height);
        grad.addColorStop(0, 'rgba(8,18,34,0.95)');
        grad.addColorStop(1, 'rgba(16,28,50,0.95)');
        cx.fillStyle = grad;
        cx.fillRect(0, 0, canvas.width, canvas.height);
        cx.strokeStyle = 'rgba(110,224,255,0.95)';
        cx.lineWidth = 7;
        cx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);
        cx.fillStyle = '#7be8ff';
        cx.font = '700 58px system-ui, sans-serif';
        cx.textAlign = 'center';
        cx.textBaseline = 'middle';
        cx.fillText(title.length > 28 ? `${title.slice(0, 25)}...` : title, canvas.width * 0.5, canvas.height * 0.42);
        cx.fillStyle = '#c7d9ff';
        cx.font = '500 24px system-ui, sans-serif';
        cx.fillText(subtitle || 'repository profile', canvas.width * 0.5, canvas.height * 0.64);
        cx.fillStyle = '#9fc7ff';
        cx.font = '500 21px system-ui, sans-serif';
        cx.fillText(`Repo ${idx + 1} / ${rt.repos.length}`, canvas.width * 0.5, canvas.height * 0.80);
        tex.needsUpdate = true;
      }
    } catch { /* ignore */ }

    try {
      const pulse = 1.05 + ((idx % 4) * 0.18);
      for (const m of (Array.isArray(rt.platformGlowMats) ? rt.platformGlowMats : [])) {
        if (!m) continue;
        if (typeof m.emissiveIntensity === 'number') m.emissiveIntensity = pulse;
      }
      for (const l of (Array.isArray(rt.platformLights) ? rt.platformLights : [])) {
        if (!l) continue;
        if (l.userData?.repoReactive === false) continue;
        l.intensity = 0.7 + (idx % 5) * 0.16;
        l.color.setHex((idx % 2 === 0) ? 0x27c1e3 : 0xe12e52);
      }
      if (rt.ringFlowMat?.uniforms?.uGlow) {
        rt.ringFlowMat.uniforms.uGlow.value = 0.95 + ((idx % 6) * 0.08);
      }
      rt.fxKick = Math.max(0.25, Number(rt.fxKick || 0), 1.0);
      rt.fxFocusIndex = idx;
      for (const card of (Array.isArray(rt.galleryCards) ? rt.galleryCards : [])) {
        if (!card) continue;
        const cardIdx = Number(card.userData?.repoIndex);
        const active = cardIdx === idx;
        card.visible = !active;
        const near = (!active && Number.isFinite(cardIdx) && Math.abs(cardIdx - idx) <= 2);
        const s = near ? 1.2 : 1.0;
        card.scale.set(s, s, s);
        try {
          if (card.material) card.material.opacity = near ? 0.92 : 0.58;
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    if (showMsg) this._showMsg(`[ / ] ${idx + 1}/${rt.repos.length}: ${title}`, 1.35);

    if (openPanel) {
      const meta = [lang, `stars ${stars}`].filter(Boolean).join(' • ');
      this._showResumeProjectPanel({
        title,
        meta,
        description: desc,
        repoUrl: safeTrim(repo?.repoUrl),
        demoUrl: safeTrim(repo?.demoUrl),
        embedUrl: safeTrim(repo?.demoUrl) || safeTrim(repo?.repoUrl),
      });
    }
  },

  _cycleResumeShowcaseSelection(dir = 1) {
    const rt = this._resumeShowcase?.runtime;
    if (!rt || !Array.isArray(rt.repos) || !rt.repos.length) return;
    const n = rt.repos.length;
    const step = (Number(dir) || 0) >= 0 ? 1 : -1;
    const cur = Number(rt.activeIndex) || 0;
    rt.activeIndex = (cur + step + n) % n;
    rt.fxKick = 1.0;
    rt.fxFocusIndex = Number(rt.activeIndex) || 0;
    this._refreshResumeShowcaseSelection({ showMsg: true, openPanel: false });
  },

  _showCurrentResumeShowcaseRepo() {
    this._refreshResumeShowcaseSelection({ showMsg: false, openPanel: true });
  },

  async _seedResumeShowcaseContent({ scenario = null } = {}) {
    const user = safeTrim(scenario?.proc?.githubUser) || safeTrim(this._resumeShowcase?.githubUser) || 'peytontolbert';
    const scTrig = Array.isArray(scenario?.content?.triggers) ? scenario.content.triggers : [];
    const scWp = Array.isArray(scenario?.content?.waypoints) ? scenario.content.waypoints : [];
    const curTrig = Array.isArray(this._scenarioContent?.triggers) ? this._scenarioContent.triggers : [];
    const curWp = Array.isArray(this._scenarioContent?.waypoints) ? this._scenarioContent.waypoints : [];
    const existingTriggers = (scTrig.length ? scTrig : curTrig).slice();
    const existingWaypoints = (scWp.length ? scWp : curWp).slice();
    const waypoints = [
      { name: 'Lab Entry', x: 0, y: 0, z: 20 },
      { name: 'Presentation Platform', x: 0, y: 0, z: 0 },
      { name: 'Server Wall', x: 0, y: 0, z: -20 },
      { name: 'Control Monitors', x: -21, y: 0, z: -4 },
      { name: 'Security Door', x: 22, y: 0, z: -3 },
    ];
    const mkResumeTrigger = ({ name, prompt, x, z, sx, sz, action }) => ({
      id: this._makeId(),
      name,
      type: 'message',
      once: false,
      requireInteract: true,
      prompt,
      center: { x, y: 1.1, z },
      size: { x: sx, y: 2.0, z: sz },
      message: '[ ] cycle • Enter/O open',
      action,
      panelTitle: `Repository Lab: @${user}`,
      panelMeta: 'Presentation Controls',
      panelBody: 'Use [ and ] to cycle repositories. Press Enter or O to open the currently selected repository.',
      repoUrl: `https://github.com/${user}`,
      demoUrl: `https://github.com/${user}?tab=repositories`,
      embedUrl: `https://github.com/${user}`,
    });
    const hasResumeAction = (list, action) => list.some((t) => safeTrim(t?.action).toLowerCase() === action);
    const ensureResumeTrigger = (list, cfg) => {
      if (hasResumeAction(list, cfg.action)) return;
      list.push(mkResumeTrigger(cfg));
    };
    const websiteCards = [
      {
        name: 'Trained LLM',
        prompt: 'Open Trained LLM',
        x: -13.0,
        z: 27.8,
        sx: 3.8,
        sz: 2.4,
        url: 'https://huggingface.co/AgoraX/Lumixion-e1-70k-fncall-qlora',
        description: 'Function-calling VLM fine-tuned with QLoRA.',
      },
      {
        name: 'Calisthenics App',
        prompt: 'Open Calisthenics App',
        x: -7.8,
        z: 27.8,
        sx: 3.8,
        sz: 2.4,
        url: 'https://calicombos.com/',
        description: 'Combo generator for calisthenics routines.',
      },
      {
        name: 'Agentic DEX',
        prompt: 'Open Agentic DEX',
        x: -2.6,
        z: 27.8,
        sx: 3.8,
        sz: 2.4,
        url: 'https://dex.swarms.world/',
        description: 'Autonomous agent-powered decentralized exchange project.',
      },
      {
        name: 'MCP Search Tool',
        prompt: 'Open MCP Search Tool',
        x: 2.6,
        z: 27.8,
        sx: 3.8,
        sz: 2.4,
        url: 'https://mcpsearchtool.com/',
        description: 'Secure MCP tool discovery and loading platform.',
      },
      {
        name: 'CreateNow',
        prompt: 'Open CreateNow',
        x: 7.8,
        z: 27.8,
        sx: 3.8,
        sz: 2.4,
        url: 'https://createnow.xyz/',
        description: 'Creative AI web project showcase.',
      },
      {
        name: 'Bddy',
        prompt: 'Open Bddy',
        x: 13.0,
        z: 27.8,
        sx: 3.8,
        sz: 2.4,
        url: 'https://bddy.io/',
        description: 'Private AI copilot focused on interview support.',
      },
    ];
    const triggers = [
      mkResumeTrigger({ name: 'Lab Console Prev', prompt: 'Previous repository', x: -4.8, z: 9.4, sx: 3.4, sz: 2.8, action: 'resume_repo_prev' }),
      mkResumeTrigger({ name: 'Lab Console Open', prompt: 'Open current repository', x: 0.0, z: 9.4, sx: 3.4, sz: 2.8, action: 'resume_repo_open' }),
      mkResumeTrigger({ name: 'Lab Console Next', prompt: 'Next repository', x: 4.8, z: 9.4, sx: 3.4, sz: 2.8, action: 'resume_repo_next' }),
      // Fallback interaction zone near the central display.
      mkResumeTrigger({ name: 'Lab Platform Open', prompt: 'Open current repository', x: 0, z: 0, sx: 5.0, sz: 5.0, action: 'resume_repo_open' }),
      ...websiteCards.map((card) => ({
        id: this._makeId(),
        name: `Website Card: ${card.name}`,
        type: 'message',
        once: false,
        requireInteract: true,
        prompt: card.prompt,
        center: { x: card.x, y: 1.2, z: card.z },
        size: { x: card.sx, y: 2.2, z: card.sz },
        message: `Opening ${card.name}`,
        action: 'project_panel',
        panelTitle: card.name,
        panelMeta: 'External Website',
        panelBody: card.description,
        repoUrl: card.url,
        demoUrl: '',
        embedUrl: card.url,
      })),
    ];
    if (existingTriggers.length || existingWaypoints.length) {
      const mergedTriggers = existingTriggers.slice();
      ensureResumeTrigger(mergedTriggers, { name: 'Lab Console Prev', prompt: 'Previous repository', x: -4.8, z: 9.4, sx: 3.4, sz: 2.8, action: 'resume_repo_prev' });
      ensureResumeTrigger(mergedTriggers, { name: 'Lab Console Open', prompt: 'Open current repository', x: 0.0, z: 9.4, sx: 3.4, sz: 2.8, action: 'resume_repo_open' });
      ensureResumeTrigger(mergedTriggers, { name: 'Lab Console Next', prompt: 'Next repository', x: 4.8, z: 9.4, sx: 3.4, sz: 2.8, action: 'resume_repo_next' });
      const hasWebsiteTrigger = (list, url) => list.some((t) => normalizeWebUrl(t?.repoUrl) === normalizeWebUrl(url));
      for (const card of websiteCards) {
        if (hasWebsiteTrigger(mergedTriggers, card.url)) continue;
        mergedTriggers.push({
          id: this._makeId(),
          name: `Website Card: ${card.name}`,
          type: 'message',
          once: false,
          requireInteract: true,
          prompt: card.prompt,
          center: { x: card.x, y: 1.2, z: card.z },
          size: { x: card.sx, y: 2.2, z: card.sz },
          message: `Opening ${card.name}`,
          action: 'project_panel',
          panelTitle: card.name,
          panelMeta: 'External Website',
          panelBody: card.description,
          repoUrl: card.url,
          demoUrl: '',
          embedUrl: card.url,
        });
      }
      const mergedWaypoints = existingWaypoints.length ? existingWaypoints : waypoints.slice();
      this._scenarioContent = { waypoints: mergedWaypoints, triggers: mergedTriggers };
      return;
    }
    this._scenarioContent = { waypoints, triggers };
  },
};

