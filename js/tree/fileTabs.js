// Editor-style tabs for files, above the page content. A repo file you open
// (from the tree or any GitHub link) gets a tab that navigates back to it; on
// a pull request, files opened from the tree get tabs that jump to their
// diff, and the bar has a Split | Unified switch for the diff view.
// Tabs are kept per repo and per PR in localStorage.

(function () {
    'use strict';

    var BAR_ID = 'lgg-tabs';
    var MAX_TABS = 15;
    // First path segments that are GitHub pages, not repository owners (as in fileTree.js).
    var RESERVED = ['settings', 'orgs', 'notifications', 'login', 'logout', 'join', 'explore',
        'marketplace', 'sponsors', 'topics', 'collections', 'trending', 'search', 'new',
        'organizations', 'pulls', 'issues', 'codespaces', 'features', 'about', 'pricing',
        'enterprise', 'apps', 'users', 'oauth', 'authorize', 'sessions', 'dashboard', 'copilot'];

    function el(tag, attrs, text) {
        var node = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (k) {
            if (k === 'class') node.className = attrs[k];
            else node.setAttribute(k, attrs[k]);
        });
        if (text != null) node.textContent = text;
        return node;
    }

    // Tab scope of the current URL: a PR, a repo, or null.
    function scope() {
        var parts = location.pathname.split('/').filter(Boolean);
        if (parts.length < 2 || RESERVED.indexOf(parts[0]) !== -1) return null;
        var s = { owner: parts[0], repo: parts[1] };
        if (parts[2] === 'pull' && /^\d+$/.test(parts[3] || '')) s.pr = parts[3];
        s.key = s.owner + '/' + s.repo + (s.pr ? '#' + s.pr : '');
        return s;
    }

    // Tabs: repo tabs are identified by their /blob/ URL path, PR tabs by file path.
    function load(key) {
        try {
            var st = JSON.parse(localStorage.getItem('lgg-tabs:' + key));
            if (st && Array.isArray(st.tabs)) return st;
        } catch (e) { /* ignore */ }
        return { tabs: [], active: null };
    }

    function save(key, st) {
        try { localStorage.setItem('lgg-tabs:' + key, JSON.stringify(st)); } catch (e) { /* quota */ }
    }

    function add(s, id, title) {
        var st = load(s.key);
        if (!st.tabs.some(function (t) { return t.id === id; })) {
            st.tabs.push({ id: id, title: title });
            if (st.tabs.length > MAX_TABS) st.tabs.shift();
        }
        st.active = id;
        save(s.key, st);
        render();
    }

    function close(s, id) {
        var st = load(s.key);
        var i = st.tabs.findIndex(function (t) { return t.id === id; });
        if (i === -1) return;
        st.tabs.splice(i, 1);
        if (st.active === id) st.active = null;
        save(s.key, st);
        render();
    }

    // GitHub anchors each file of a PR diff at #diff-<sha256 hex of the path>.
    var anchorIds = new Map();
    async function diffAnchor(path) {
        if (anchorIds.has(path)) return anchorIds.get(path);
        var id = await sha256Anchor(path);
        anchorIds.set(path, id);
        return id;
    }

    async function sha256Anchor(path) {
        var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path));
        return 'diff-' + Array.from(new Uint8Array(buf)).map(function (b) {
            return b.toString(16).padStart(2, '0');
        }).join('');
    }

    async function jumpToDiff(s, path) {
        var id = await diffAnchor(path);
        var target = document.getElementById(id) || document.querySelector('[data-anchor="' + id + '"]');
        if (target) target.scrollIntoView({ block: 'start' });
        else location.href = '/' + s.owner + '/' + s.repo + '/pull/' + s.pr + '/files#' + id;
    }

    // Called by the tree when a PR file is clicked: tab it and go to its diff.
    function openPrFile(owner, repo, pr, path) {
        var s = { owner: owner, repo: repo, pr: pr, key: owner + '/' + repo + '#' + pr };
        add(s, path, path);
        jumpToDiff(s, path);
    }

    // Split or unified, from the URL or the rendered diff; null when unknown.
    function diffMode() {
        var p = new URLSearchParams(location.search).get('diff');
        if (p === 'split' || p === 'unified') return p;
        if (document.querySelector('.file-diff-split')) return 'split';
        if (document.querySelector('.diff-table')) return 'unified';
        return null;
    }

    function setDiffMode(mode) {
        var url = new URL(location.href);
        url.searchParams.set('diff', mode);
        location.assign(url.toString());   // full load: GitHub reads ?diff= on load
    }

    function render() {
        var s = scope();
        var bar = document.getElementById(BAR_ID);
        var st = s ? load(s.key) : null;
        if (!s || (!st.tabs.length && !s.pr)) { if (bar) bar.remove(); return; }
        var host = document.querySelector('main');
        if (!host) return;
        if (!bar || bar.parentElement !== host) {
            if (bar) bar.remove();
            bar = el('div', { id: BAR_ID, role: 'tablist' });
            host.insertAdjacentElement('afterbegin', bar);
        }
        bar.textContent = '';
        var current = s.pr ? st.active : decodeURIComponent(location.pathname);
        var list = el('div', { class: 'lgg-tabs-list' });
        st.tabs.forEach(function (t) {
            var name = t.title.split('/').pop();
            var tab = el('a', { class: 'lgg-tab' + (t.id === current ? ' lgg-tab-active' : ''), role: 'tab', title: t.title });
            if (s.pr) tab.href = '#';
            else tab.href = t.id;
            tab.appendChild(el('span', { class: 'lgg-tab-name' }, name));
            var x = el('button', { class: 'lgg-tab-close', type: 'button', title: 'Close tab', 'aria-label': 'Close ' + name }, '×');
            x.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); close(s, t.id); });
            tab.appendChild(x);
            tab.addEventListener('auxclick', function (ev) {
                if (ev.button === 1) { ev.preventDefault(); close(s, t.id); }
            });
            if (s.pr) {
                tab.addEventListener('click', function (ev) { ev.preventDefault(); add(s, t.id, t.title); jumpToDiff(s, t.id); });
            }
            list.appendChild(tab);
        });
        if (!st.tabs.length) list.appendChild(el('span', { class: 'lgg-tabs-hint' }, 'Files you open from the tree appear here'));
        bar.appendChild(list);
        if (s.pr) {
            var mode = diffMode();
            var seg = el('div', { class: 'lgg-tabs-diffmode', role: 'group', 'aria-label': 'Diff view' });
            ['split', 'unified'].forEach(function (m) {
                var b = el('button', { type: 'button', class: m === mode ? 'lgg-on' : '', 'aria-pressed': String(m === mode) },
                    m === 'split' ? 'Split' : 'Unified');
                b.addEventListener('click', function () { if (m !== mode) setDiffMode(m); });
                seg.appendChild(b);
            });
            bar.appendChild(seg);
            var expand = el('button', { type: 'button', class: 'lgg-tabs-expand', title: 'Show every changed file in full' }, 'Expand all');
            expand.addEventListener('click', function () { expandAll(expand); });
            bar.appendChild(expand);
        }
        // Other features add their own controls (js/pr/remerge.js).
        (window.lggTabBarHooks || []).forEach(function (hook) { hook(bar, s); });
    }

    // Expand every diff on the page in full: GitHub's per-file "Expand all"
    // and "Load diff" buttons first, then any remaining hunk expanders. Each
    // control is clicked once; rounds repeat while new ones appear (expanding
    // loads more of the page), and stop when none are left.
    // Labels: classic files page ("Expand all", "Expand Up"), and the newer
    // changes view ("Expand all lines: <path>", "Load Diff",
    // "Expand file up from line 17", "Expand file from line 656 to line 677").
    var WHOLE_FILE = /^(expand all( lines)?(: .+)?|load diff)$/i;
    var ANY_EXPAND = /^(expand all( lines)?(: .+)?|load diff|expand (up|down|all)( lines)?|expand file (up |down )?from line .+)$/i;

    function controlLabel(e) {
        return (e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent || '').trim();
    }

    async function expandAll(button) {
        button.disabled = true;
        button.textContent = 'Expanding…';
        var clicked = new WeakSet();
        // A per-file button re-rendered under the same label is the same
        // control: clicking it again could collapse the file.
        var clickedFiles = new Set();
        var total = 0;
        for (var round = 0; round < 60; round++) {
            var controls = Array.prototype.filter.call(document.querySelectorAll('button, a.js-expand, [role="button"]'), function (e) {
                var label = controlLabel(e);
                return !clicked.has(e) && !clickedFiles.has(label) && e.offsetParent !== null && !e.closest('#' + BAR_ID + ', #lgg-tree, #lgg-pr-graph') &&
                    ANY_EXPAND.test(controlLabel(e));
            });
            var whole = controls.filter(function (e) { return WHOLE_FILE.test(controlLabel(e)); });
            var batch = whole.length ? whole : controls;
            if (!batch.length) break;
            batch.forEach(function (e) {
                clicked.add(e);
                var label = controlLabel(e);
                if (/: .+$/.test(label)) clickedFiles.add(label);
                e.click();
            });
            total += batch.length;
            await new Promise(function (r) { setTimeout(r, 600); });
        }
        button.disabled = false;
        button.textContent = 'Expand all';
        button.title = total ? 'Expanded (' + total + ' clicks). Click again for anything loaded since.' : 'Nothing left to expand';
    }

    // A /blob/ page opened by any link gets a tab.
    var lastPath = null;
    function check() {
        var s = scope();
        if (s && !s.pr && location.pathname.split('/')[3] === 'blob' && location.pathname !== lastPath) {
            lastPath = location.pathname;
            var path = decodeURIComponent(location.pathname);
            add(s, path, path.split('/').slice(5).join('/'));   // /owner/repo/blob/<ref>/<path>
            return;
        }
        lastPath = location.pathname;
        var bar = document.getElementById(BAR_ID);
        var host = document.querySelector('main');
        var key = s ? s.key + location.pathname + diffMode() : '';
        if (!bar || bar.parentElement !== host || bar.getAttribute('data-key') !== key) {
            render();
            bar = document.getElementById(BAR_ID);
            if (bar) bar.setAttribute('data-key', key);
        }
    }

    // GitHub's own Viewed control for a file in the rendered diff, or null when
    // that file is not on the page. Classic: the "Viewed" checkbox; changes
    // view: a button labelled "Viewed" / "Not Viewed" with aria-pressed. Walk
    // up from the file's anchor to the nearest ancestor holding exactly one
    // such control, so another file's control is never picked.
    var VIEWED_SEL = 'input.js-reviewed-checkbox, button[aria-label="Viewed" i], button[aria-label="Not Viewed" i]';

    async function viewedControl(path) {
        var id = await diffAnchor(path);
        var anchor = document.getElementById(id) || document.querySelector('[data-anchor="' + id + '"]');
        for (var n = anchor, i = 0; n && i < 8; n = n.parentElement, i++) {
            var found = n.querySelectorAll(VIEWED_SEL);
            if (found.length === 1) return found[0];
            if (found.length > 1) return null;
        }
        return null;
    }

    function isViewed(ctrl) {
        if (ctrl.tagName === 'INPUT') return ctrl.checked;
        var pressed = ctrl.getAttribute('aria-pressed');
        if (pressed === 'true' || pressed === 'false') return pressed === 'true';
        return /^viewed$/i.test(ctrl.getAttribute('aria-label') || '');
    }

    window.lggTabs = {
        openPrFile: openPrFile, jumpToDiff: jumpToDiff, rerender: render,
        viewedControl: viewedControl, isViewed: isViewed,
    };

    var scheduled = false;
    new MutationObserver(function () {
        if (scheduled) return;
        scheduled = true;
        setTimeout(function () { scheduled = false; check(); }, 300);
    }).observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('turbo:load', check);
    window.addEventListener('popstate', check);
    check();
})();
