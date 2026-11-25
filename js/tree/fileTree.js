// File tree sidebar, in the spirit of Octotree (written from scratch; no
// Octotree code). On a repo page it lists the repository tree at the ref being
// viewed; on a pull request page it lists the changed files with their status
// and line counts, and a click jumps to that file's diff.

(function () {
    'use strict';

    var SIDEBAR_ID = 'lgg-tree';
    var TOGGLE_ID = 'lgg-tree-toggle';
    var CACHE_MS = 5 * 60 * 1000;
    var MAX_PR_FILES = 3000;     // GitHub's own cap for the PR files endpoint
    var MAX_EXPANDED = 2000;     // most rows built at once when a list is shown expanded
    // First path segments that are GitHub pages, not repository owners.
    var RESERVED = ['settings', 'orgs', 'notifications', 'login', 'logout', 'join', 'explore',
        'marketplace', 'sponsors', 'topics', 'collections', 'trending', 'search', 'new',
        'organizations', 'pulls', 'issues', 'codespaces', 'features', 'about', 'pricing',
        'enterprise', 'apps', 'users', 'oauth', 'authorize', 'sessions', 'dashboard', 'copilot'];

    // ----------------------------------------------------------- location

    // Repo context of the current URL, or null on non-repo pages.
    function context() {
        var parts = location.pathname.split('/').filter(Boolean);
        if (parts.length < 2 || RESERVED.indexOf(parts[0]) !== -1) return null;
        var c = { owner: parts[0], repo: parts[1] };
        if (parts[2] === 'pull' && /^\d+$/.test(parts[3] || '')) {
            c.pr = parts[3];
            c.key = c.owner + '/' + c.repo + '#' + c.pr;
        } else {
            c.ref = (parts[2] === 'tree' || parts[2] === 'blob') && parts[3]
                ? refOf(parts.slice(3).map(decodeURIComponent).join('/'))
                : null;
            c.key = c.owner + '/' + c.repo + '@' + (c.ref || '');
        }
        return c;
    }

    // In /tree/<ref>/<path> the ref may itself contain slashes (feature/foo),
    // so the URL alone is ambiguous. GitHub embeds the resolved ref in the page
    // (refInfo.name); use it when it is a prefix of this URL's rest, which also
    // rejects data left over from the previous page after in-app navigation.
    // Otherwise take the first segment.
    var refMemo = { path: null, ref: null };

    function refOf(rest) {
        if (refMemo.path === location.pathname) return refMemo.ref;
        var scripts = document.querySelectorAll('script[data-target="react-app.embeddedData"]');
        for (var i = 0; i < scripts.length; i++) {
            var m = scripts[i].textContent.match(/"refInfo":(\{[^{}]*\})/);
            if (!m) continue;
            var name = null;
            try { name = JSON.parse(m[1]).name; } catch (e) { continue; }
            if (name && (rest === name || rest.indexOf(name + '/') === 0)) {
                refMemo = { path: location.pathname, ref: name };
                return name;
            }
        }
        return rest.split('/')[0];
    }

    function refPath(ref) { return encodeURIComponent(ref).replace(/%2F/g, '/'); }

    // ---------------------------------------------------------------- data

    async function loadRepoTree(c) {
        var ref = c.ref;
        if (!ref) ref = (await lggApiGet('/repos/' + c.owner + '/' + c.repo)).default_branch;
        var t = await lggApiGet('/repos/' + c.owner + '/' + c.repo + '/git/trees/' +
            refPath(ref) + '?recursive=1');
        return {
            ref: ref,
            truncated: !!t.truncated,
            entries: t.tree.filter(function (e) { return e.type === 'blob' || e.type === 'commit'; })
                .map(function (e) { return { path: e.path, submodule: e.type === 'commit' }; }),
        };
    }

    async function loadPrFiles(c) {
        var files = [];
        for (var page = 1; files.length < MAX_PR_FILES; page++) {
            var batch = await lggApiGet('/repos/' + c.owner + '/' + c.repo + '/pulls/' + c.pr +
                '/files?per_page=100&page=' + page);
            files = files.concat(batch);
            if (batch.length < 100) break;
        }
        return {
            entries: files.map(function (f) {
                return { path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions };
            }),
        };
    }

    function cacheGet(key) {
        try {
            var v = JSON.parse(sessionStorage.getItem('lgg-tree:v2:' + key));
            if (v && Date.now() - v.at < CACHE_MS) return v.data;
        } catch (e) { /* ignore */ }
        return null;
    }

    function cachePut(key, data) {
        try { sessionStorage.setItem('lgg-tree:v2:' + key, JSON.stringify({ at: Date.now(), data: data })); }
        catch (e) { /* quota: large trees are not cached */ }
    }

    // Nested {dirs: Map, files: []} from flat paths.
    function buildTree(entries) {
        var root = { name: '', dirs: new Map(), files: [] };
        entries.forEach(function (e) {
            var parts = e.path.split('/');
            var node = root;
            for (var i = 0; i < parts.length - 1; i++) {
                if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], dirs: new Map(), files: [] });
                node = node.dirs.get(parts[i]);
            }
            node.files.push(Object.assign({ name: parts[parts.length - 1] }, e));
        });
        return root;
    }

    // GitHub anchors each file of a PR diff at #diff-<sha256 hex of the path>.
    async function diffAnchor(path) {
        var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path));
        return 'diff-' + Array.from(new Uint8Array(buf)).map(function (b) {
            return b.toString(16).padStart(2, '0');
        }).join('');
    }

    // ------------------------------------------------------------------ UI

    function el(tag, attrs) {
        var node = document.createElement(tag);
        if (attrs) Object.keys(attrs).forEach(function (k) {
            if (k === 'text') node.textContent = attrs[k];
            else if (k === 'class') node.className = attrs[k];
            else node.setAttribute(k, attrs[k]);
        });
        for (var i = 2; i < arguments.length; i++) {
            if (arguments[i] != null) node.appendChild(arguments[i]);
        }
        return node;
    }

    function isOpen() { return localStorage.getItem('lgg-tree-open') === '1'; }

    function setOpen(open) {
        localStorage.setItem('lgg-tree-open', open ? '1' : '0');
        document.documentElement.classList.toggle('lgg-tree-shown', open);
        var sb = document.getElementById(SIDEBAR_ID);
        if (sb) sb.hidden = !open;
    }

    function fileHref(c, data, path) {
        return '/' + c.owner + '/' + c.repo + '/blob/' + refPath(data.ref) + '/' +
            path.split('/').map(encodeURIComponent).join('/');
    }

    // Directories are rendered when first expanded, so huge repos stay cheap.
    function renderDir(c, data, node, container, depth, expandAll) {
        var dirs = Array.from(node.dirs.values()).sort(function (a, b) { return a.name.localeCompare(b.name); });
        var files = node.files.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
        dirs.forEach(function (d) {
            // Collapse single-child chains like Octotree: a/b/c
            var label = d.name;
            while (d.files.length === 0 && d.dirs.size === 1) {
                d = d.dirs.values().next().value;
                label += '/' + d.name;
            }
            var row = el('div', { class: 'lgg-tree-row lgg-tree-dir', style: 'padding-left:' + (8 + depth * 14) + 'px' },
                el('span', { class: 'lgg-tree-caret', text: '▸' }), el('span', { text: label }));
            var kids = el('div', { class: 'lgg-tree-kids', hidden: '' });
            var rendered = false;
            var target = d;
            function toggle(force) {
                var open = force !== undefined ? force : kids.hidden;
                if (open && !rendered) { renderDir(c, data, target, kids, depth + 1, expandAll); rendered = true; }
                kids.hidden = !open;
                row.firstChild.textContent = open ? '▾' : '▸';
            }
            row.addEventListener('click', function () { toggle(); });
            container.appendChild(row);
            container.appendChild(kids);
            if (expandAll) toggle(true);
        });
        files.forEach(function (f) {
            var row = el('a', { class: 'lgg-tree-row lgg-tree-file' + (f.status ? ' lgg-tree-' + f.status : ''),
                style: 'padding-left:' + (22 + depth * 14) + 'px', title: f.path, text: f.name });
            if (c.pr) {
                row.href = '#';
                row.appendChild(el('span', { class: 'lgg-tree-stat' },
                    el('span', { class: 'lgg-tree-add', text: '+' + f.additions }),
                    el('span', { class: 'lgg-tree-del', text: ' −' + f.deletions })));
                row.addEventListener('click', function (ev) {
                    ev.preventDefault();
                    diffAnchor(f.path).then(function (id) {
                        var target = document.getElementById(id) || document.querySelector('[id="' + id + '"], [data-anchor="' + id + '"]');
                        if (target) target.scrollIntoView({ block: 'start' });
                        else location.href = '/' + c.owner + '/' + c.repo + '/pull/' + c.pr + '/files#' + id;
                    });
                });
            } else if (f.submodule) {
                row.classList.add('lgg-tree-submodule');
            } else {
                row.href = fileHref(c, data, f.path);
            }
            container.appendChild(row);
        });
    }

    function renderInto(body, c, data, filter) {
        body.textContent = '';
        var entries = data.entries;
        var matched = entries.length;
        if (filter) {
            var q = filter.toLowerCase();
            entries = entries.filter(function (e) { return e.path.toLowerCase().indexOf(q) !== -1; });
            matched = entries.length;
            // Filter results are shown expanded; cap them so a broad filter on a
            // huge repo does not build every row at once.
            entries = entries.slice(0, MAX_EXPANDED);
        }
        // PR file lists are the point of the PR view: expand them, unless huge.
        var expand = !!filter || (!!c.pr && entries.length <= MAX_EXPANDED);
        renderDir(c, data, buildTree(entries), body, 0, expand);
        if (matched > entries.length) body.appendChild(el('div', { class: 'lgg-tree-note', text: 'Showing the first ' + entries.length + ' of ' + matched + ' matches; narrow the filter.' }));
        if (data.truncated) body.appendChild(el('div', { class: 'lgg-tree-note', text: 'GitHub truncated this tree (very large repo); some files are missing.' }));
        if (!matched) body.appendChild(el('div', { class: 'lgg-tree-note', text: 'No files.' }));
    }

    var shownKey = null;
    var loading = null;

    function mount(c) {
        var sb = document.getElementById(SIDEBAR_ID);
        if (!sb) {
            sb = el('aside', { id: SIDEBAR_ID });
            document.body.appendChild(sb);
        }
        sb.textContent = '';
        shownKey = c.key;
        var title = el('div', { class: 'lgg-tree-title', text: c.owner + ' / ' + c.repo + (c.pr ? '  #' + c.pr : '') });
        var close = el('button', { class: 'lgg-tree-close', type: 'button', title: 'Hide (also: toggle button)', text: '×' });
        close.addEventListener('click', function () { setOpen(false); });
        var filter = el('input', { class: 'lgg-tree-filter', type: 'search', placeholder: 'Filter files…' });
        var body = el('div', { class: 'lgg-tree-body', text: 'Loading…' });
        sb.appendChild(el('div', { class: 'lgg-tree-head' }, title, close));
        sb.appendChild(filter);
        sb.appendChild(body);
        sb.hidden = !isOpen();

        var hit = cacheGet(c.key);
        var job = hit ? Promise.resolve(hit) : (c.pr ? loadPrFiles(c) : loadRepoTree(c));
        loading = job;
        job.then(function (data) {
            // A superseded load (navigating away and back while it ran) must
            // not overwrite the cache entry of the load that replaced it.
            if (loading !== job) return;
            if (!hit) cachePut(c.key, data);
            if (data.ref) title.textContent = c.owner + ' / ' + c.repo + ' @ ' + data.ref;
            var timer = null;
            filter.addEventListener('input', function () {
                clearTimeout(timer);
                timer = setTimeout(function () { renderInto(body, c, data, filter.value.trim()); }, 150);
            });
            renderInto(body, c, data, '');
        }).catch(function (err) {
            if (loading !== job) return;
            body.textContent = '';
            body.appendChild(el('div', { class: 'lgg-tree-error', text: String(err.message || err) }));
        });
    }

    function ensureToggle() {
        if (document.getElementById(TOGGLE_ID)) return;
        var btn = el('button', { id: TOGGLE_ID, type: 'button', title: 'File tree (le-git-graph)', text: '☰' });
        btn.addEventListener('click', function () {
            var open = !isOpen();
            setOpen(open);
            var c = context();
            if (open && c && shownKey !== c.key) mount(c);
        });
        document.body.appendChild(btn);
    }

    // Load lazily: nothing is fetched until the sidebar is opened once.
    function check() {
        var c = context();
        var toggle = document.getElementById(TOGGLE_ID);
        var sb = document.getElementById(SIDEBAR_ID);
        if (!c) {
            if (toggle) toggle.remove();
            if (sb) sb.remove();
            document.documentElement.classList.remove('lgg-tree-shown');
            shownKey = null;
            return;
        }
        ensureToggle();
        document.documentElement.classList.toggle('lgg-tree-shown', isOpen());
        if (isOpen() && (shownKey !== c.key || !sb)) mount(c);
    }

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
