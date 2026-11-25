// PR graph: on a pull request page, draw the `git log --graph --oneline`
// view between the base branch and the PR head, the way a terminal shows
// `git log --graph base head`: the PR commits, the base commits made since
// the two diverged, and the merge base where the two lines join.
//
// Kept in its own files so upstream le-git-graph merges stay clean.
// Uses the GitHub REST API; sends le-git-graph's stored token when one exists
// (getLocalToken), otherwise goes anonymous (60 requests/hour, public repos).

(function () {
    'use strict';

    var PER_PAGE = 100;
    var MAX_HEAD = 250;          // PR commits shown (GitHub caps compare at 250 per page set anyway)
    var MAX_BASE = 100;          // base-side commits shown, newest first
    var CACHE_MS = 5 * 60 * 1000;   // cache key carries a format version (lgg-pr:v2:); bump it when the data changes
    var ROW_H = 22, LANE_W = 14, PAD = 8, DOT_R = 4;
    var COLORS = ['#e5534b', '#57ab5a', '#c69026', '#539bf5', '#b083f0', '#39c5cf', '#e0823d', '#d16d9e'];
    var PANEL_ID = 'lgg-pr-graph';

    // ---------------------------------------------------------------- layout

    // Order commits like `git log --topo-order`: no parent before all of its
    // children, and a line of history is followed down before switching.
    // commits: Map sha -> {sha, parents: [sha], date: ms}
    // `last` (the merge base) goes at the bottom like git's boundary commit; it
    // has no parents in the set, so that never breaks the topological order.
    function topoOrder(commits, tips, last) {
        var pending = new Map();
        commits.forEach(function (c) { pending.set(c.sha, 0); });
        commits.forEach(function (c) {
            c.parents.forEach(function (p) {
                if (pending.has(p)) pending.set(p, pending.get(p) + 1);
            });
        });
        // Tips first, newest on top of the stack.
        var stack = [];
        commits.forEach(function (c) { if (pending.get(c.sha) === 0) stack.push(c); });
        stack.sort(function (a, b) {
            var ta = tips.indexOf(a.sha), tb = tips.indexOf(b.sha);
            if (ta !== tb) return (tb === -1 ? -1 : tb) - (ta === -1 ? -1 : ta) || a.date - b.date;
            return a.date - b.date;
        });
        var out = [];
        while (stack.length) {
            var c = stack.pop();
            out.push(c);
            // Push in parent order, as git does: the side a merge brings in is
            // listed right after the merge, the first-parent line after it.
            for (var i = 0; i < c.parents.length; i++) {
                var p = c.parents[i];
                if (!pending.has(p)) continue;
                pending.set(p, pending.get(p) - 1);
                if (pending.get(p) === 0) stack.push(commits.get(p));
            }
        }
        if (last) {
            var i = out.findIndex(function (c) { return c.sha === last; });
            var hasShownParent = i !== -1 && out[i].parents.some(function (p) { return commits.has(p); });
            if (i !== -1 && !hasShownParent) out.push(out.splice(i, 1)[0]);
        }
        return out;
    }

    // Assign lanes. rows[r].lanes is the lane array at the top of row r with
    // the row's commit placed at rows[r].col. Lanes hold the sha each lane is
    // waiting for and are unique, so an edge child->parent passes through
    // column rows[k].lanes.indexOf(parent) at every row k in between.
    function layout(order) {
        var inSet = new Set(order.map(function (c) { return c.sha; }));
        var colorOf = new Map();
        var nextColor = 0;
        var lanes = [];
        var rows = [];
        var width = 1;
        order.forEach(function (c) {
            var col = lanes.indexOf(c.sha);
            if (col === -1) { col = lanes.length; lanes.push(c.sha); }
            if (!colorOf.has(c.sha)) colorOf.set(c.sha, nextColor++);
            rows.push({ commit: c, col: col, lanes: lanes.slice() });
            var ps = c.parents.filter(function (p) { return inSet.has(p); });
            var insert = [];
            ps.forEach(function (p, i) {
                if (lanes.indexOf(p) !== -1 || insert.indexOf(p) !== -1) return;
                insert.push(p);
                colorOf.set(p, i === 0 ? colorOf.get(c.sha) : nextColor++);
            });
            var next = lanes.slice();
            next.splice.apply(next, [col, 1].concat(insert));
            lanes = next;
            width = Math.max(width, rows[rows.length - 1].lanes.length, lanes.length);
        });

        var rowOf = new Map();
        rows.forEach(function (row, r) { rowOf.set(row.commit.sha, r); });
        var edges = [];
        rows.forEach(function (row, r) {
            row.commit.parents.forEach(function (p, i) {
                if (!rowOf.has(p)) {
                    edges.push({ points: [[row.col, r]], stub: true, color: colorOf.get(row.commit.sha) });
                    return;
                }
                var pts = [[row.col, r]];
                for (var k = r + 1; k <= rowOf.get(p); k++) pts.push([rows[k].lanes.indexOf(p), k]);
                edges.push({ points: pts, color: i === 0 ? colorOf.get(row.commit.sha) : colorOf.get(p) });
            });
        });
        rows.forEach(function (row) { row.color = colorOf.get(row.commit.sha); });
        return { rows: rows, edges: edges, width: width };
    }

    // ------------------------------------------------------------------ data

    var apiGet = lggApiGet;   // js/common/api.js

    // Commits of `base...head` (reachable from head, not base), newest `max`.
    // compare lists commits oldest first and paginates, so fetch from the end.
    // `head` must be a sha; `base` may be a branch name.
    async function compareCommits(owner, repo, base, head, max) {
        var ref = function (r) { return encodeURIComponent(r).replace(/%2F/g, '/'); };
        var pathFor = function (b) {
            return '/repos/' + owner + '/' + repo + '/compare/' + ref(b) + '...' + ref(head) + '?per_page=' + PER_PAGE;
        };
        var first = await apiGet(pathFor(base) + '&page=1');
        // Later pages are pinned to the base sha page 1 saw, so a base branch
        // that moves between requests cannot mix two comparisons.
        var pinned = pathFor(first.base_commit.sha);
        var total = first.total_commits;
        var lastPage = Math.max(1, Math.ceil(total / PER_PAGE));
        // The newest `max` commits can straddle a page boundary: take one page more.
        var firstNeeded = Math.max(1, lastPage - Math.ceil(max / PER_PAGE));
        var pages = [];
        for (var p = firstNeeded; p <= lastPage; p++) {
            pages.push(p === 1 ? Promise.resolve(first) : apiGet(pinned + '&page=' + p));
        }
        var commits = [];
        (await Promise.all(pages)).forEach(function (r) { commits = commits.concat(r.commits); });
        return { meta: first, commits: commits.slice(-max), total: total };
    }

    // Branch tips for decorations. Paging costs a request per 100 branches,
    // so without a token (60 requests/hour) only the first page is read.
    async function branchesOf(owner, repo) {
        var maxPages = lggHasToken(owner) ? 5 : 1;
        var all = [];
        try {
            for (var page = 1; page <= maxPages; page++) {
                var batch = await apiGet('/repos/' + owner + '/' + repo + '/branches?per_page=100&page=' + page);
                all = all.concat(batch);
                if (batch.length < 100) break;
            }
        } catch (e) { /* decorations are optional */ }
        return all;
    }

    // Parents of shown commits that are not shown are all reachable from the
    // merge base. Walk its history (newest first, as `git log` lists it) and
    // add commits until every such parent is in; the last one found becomes
    // the bottom row. Stops after MAX_BELOW commits and reports incomplete.
    var MAX_BELOW = 300;

    async function extendBelow(owner, repo, mergeBaseSha, commits) {
        var missing = new Set();
        commits.forEach(function (c) {
            if (c.sha === mergeBaseSha) return;
            c.parents.forEach(function (p) { if (!commits.has(p)) missing.add(p); });
        });
        if (!missing.size) return { complete: true };
        var walked = [];
        for (var page = 1; missing.size && walked.length < MAX_BELOW; page++) {
            var batch = await apiGet('/repos/' + owner + '/' + repo + '/commits?sha=' + mergeBaseSha +
                '&per_page=100&page=' + page);
            for (var i = 0; i < batch.length && missing.size; i++) {
                var c = batch[i];
                if (c.sha === mergeBaseSha) continue;
                walked.push(c);
                missing.delete(c.sha);
            }
            if (batch.length < 100) break;
        }
        if (missing.size) return { complete: false };
        var bottom = walked[walked.length - 1].sha;
        walked.forEach(function (c) { if (!commits.has(c.sha)) commits.set(c.sha, toNode(c)); });
        return { complete: true, bottom: bottom };
    }

    function toNode(c) {
        return {
            sha: c.sha,
            parents: c.parents.map(function (p) { return p.sha; }),
            date: Date.parse(c.commit.committer ? c.commit.committer.date : c.commit.author.date),
            subject: c.commit.message.split('\n')[0],
            author: c.author ? c.author.login : c.commit.author.name,
        };
    }

    async function loadPrGraph(owner, repo, number) {
        var pr = await apiGet('/repos/' + owner + '/' + repo + '/pulls/' + number);
        var baseRef = pr.base.ref;
        var headSha = pr.head.sha;
        var ahead;
        try {
            ahead = await compareCommits(owner, repo, baseRef, headSha, MAX_HEAD);
        } catch (e) {
            // Base branch deleted (old closed PRs): compare against the base
            // sha GitHub recorded for the PR instead.
            if (e.status !== 404) throw e;
            ahead = await compareCommits(owner, repo, pr.base.sha, headSha, MAX_HEAD);
        }
        var baseTip = ahead.meta.base_commit;
        var mergeBase = ahead.meta.merge_base_commit;
        var behind = ahead.meta.behind_by > 0
            ? await compareCommits(owner, repo, headSha, baseTip.sha, MAX_BASE)
            : { commits: [], total: 0 };

        var commits = new Map();
        [mergeBase].concat(behind.commits, ahead.commits).forEach(function (c) {
            commits.set(c.sha, toNode(c));
        });
        var prSet = new Set(ahead.commits.map(function (c) { return c.sha; }));

        // Like `git log --graph base head`, keep going below the merge base
        // until every line joins: a PR commit forked from an older base commit
        // (e.g. a branch merged into a newer main) has its parent there.
        var below = { complete: true };
        var hiddenHead = Math.max(0, ahead.total - ahead.commits.length);
        var hiddenBase = Math.max(0, behind.total - behind.commits.length);
        if (!hiddenHead && !hiddenBase) {
            below = await extendBelow(owner, repo, mergeBase.sha, commits);
        }
        var bottom = below.bottom || mergeBase.sha;

        // Decorations, like `git log --decorate`.
        var refs = new Map();
        function addRef(sha, name, kind) {
            if (!commits.has(sha)) return;
            if (!refs.has(sha)) refs.set(sha, []);
            var list = refs.get(sha);
            if (!list.some(function (r) { return r.name === name; })) list.push({ name: name, kind: kind });
        }
        addRef(headSha, 'pr/' + number, 'head');
        addRef(headSha, pr.head.label, 'branch');
        addRef(baseTip.sha, pr.base.label, 'base');
        var headRepo = pr.head.repo;
        var lists = [branchesOf(owner, repo)];
        var fork = headRepo && headRepo.full_name !== pr.base.repo.full_name;
        if (fork) lists.push(branchesOf(headRepo.owner.login, headRepo.name));
        var got = await Promise.all(lists);
        got[0].forEach(function (b) { addRef(b.commit.sha, pr.base.repo.owner.login + ':' + b.name, 'branch'); });
        if (fork) got[1].forEach(function (b) { addRef(b.commit.sha, headRepo.owner.login + ':' + b.name, 'branch'); });
        addRef(mergeBase.sha, 'merge-base', 'mergebase');

        return {
            owner: owner, repo: repo, number: number,
            baseLabel: pr.base.label, headLabel: pr.head.label,
            aheadBy: ahead.meta.ahead_by, behindBy: ahead.meta.behind_by,
            hiddenHead: hiddenHead,
            hiddenBase: hiddenBase,
            belowIncomplete: !below.complete,
            commits: Array.from(commits.values()),
            tips: [headSha, baseTip.sha],
            mergeBase: bottom,
            refs: Array.from(refs.entries()),
            prShas: Array.from(prSet),
            loadedAt: Date.now(),
        };
    }

    // -------------------------------------------------------------------- UI

    function el(tag, attrs) {
        var node = document.createElement(tag);
        if (attrs) Object.keys(attrs).forEach(function (k) {
            if (k === 'text') node.textContent = attrs[k];
            else if (k === 'class') node.className = attrs[k];
            else node.setAttribute(k, attrs[k]);
        });
        for (var i = 2; i < arguments.length; i++) {
            var child = arguments[i];
            if (child == null) continue;
            node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
        }
        return node;
    }

    function svgEl(tag, attrs) {
        var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
        Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
        return node;
    }

    function relTime(ms) {
        var s = (Date.now() - ms) / 1000;
        var units = [[31536000, 'year'], [2592000, 'month'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
        for (var i = 0; i < units.length; i++) {
            var n = Math.floor(s / units[i][0]);
            if (n >= 1) return n + ' ' + units[i][1] + (n > 1 ? 's' : '') + ' ago';
        }
        return 'just now';
    }

    function renderGraph(data) {
        var bySha = new Map(data.commits.map(function (c) { return [c.sha, c]; }));
        var g = layout(topoOrder(bySha, data.tips, data.mergeBase));
        var refs = new Map(data.refs);
        var prShas = new Set(data.prShas);
        var gw = PAD * 2 + g.width * LANE_W;
        var x = function (col) { return PAD + col * LANE_W + LANE_W / 2; };
        var y = function (row) { return row * ROW_H + ROW_H / 2; };

        var svg = svgEl('svg', { width: gw, height: g.rows.length * ROW_H, class: 'lgg-pr-svg' });
        g.edges.forEach(function (e) {
            var color = COLORS[e.color % COLORS.length];
            var p0 = e.points[0];
            if (e.stub) {
                svg.appendChild(svgEl('line', {
                    x1: x(p0[0]), y1: y(p0[1]), x2: x(p0[0]), y2: y(p0[1]) + ROW_H * 0.6,
                    stroke: color, 'stroke-width': 2, 'stroke-dasharray': '2 3',
                }));
                return;
            }
            var d = 'M' + x(p0[0]) + ' ' + y(p0[1]);
            for (var i = 1; i < e.points.length; i++) {
                var a = e.points[i - 1], b = e.points[i];
                if (a[0] === b[0]) d += ' L' + x(b[0]) + ' ' + y(b[1]);
                else d += ' C' + x(a[0]) + ' ' + (y(a[1]) + ROW_H * 0.6) + ' ' + x(b[0]) + ' ' +
                    (y(b[1]) - ROW_H * 0.6) + ' ' + x(b[0]) + ' ' + y(b[1]);
            }
            svg.appendChild(svgEl('path', { d: d, stroke: color, 'stroke-width': 2, fill: 'none' }));
        });
        g.rows.forEach(function (row, r) {
            var color = COLORS[row.color % COLORS.length];
            var merge = row.commit.parents.length > 1;
            svg.appendChild(svgEl('circle', {
                cx: x(row.col), cy: y(r), r: DOT_R, stroke: color, 'stroke-width': 2,
                style: 'fill:' + (merge ? 'var(--bgColor-default, #fff)' : color),
            }));
        });

        var list = el('div', { class: 'lgg-pr-rows', style: 'padding-left:' + gw + 'px' });
        g.rows.forEach(function (row) {
            var c = row.commit;
            var href = prShas.has(c.sha)
                ? '/' + data.owner + '/' + data.repo + '/pull/' + data.number + '/commits/' + c.sha
                : '/' + data.owner + '/' + data.repo + '/commit/' + c.sha;
            var line = el('div', { class: 'lgg-pr-row' + (prShas.has(c.sha) ? '' : ' lgg-pr-base') },
                el('a', { class: 'lgg-pr-sha', href: href, title: c.sha, text: c.sha.slice(0, 7) }));
            var rs = refs.get(c.sha);
            if (rs && rs.length) {
                var deco = el('span', { class: 'lgg-pr-refs' });
                rs.forEach(function (ref) {
                    deco.appendChild(el('span', { class: 'lgg-pr-ref lgg-pr-ref-' + ref.kind, title: ref.name, text: ref.name }));
                });
                line.appendChild(deco);
            }
            line.appendChild(el('span', { class: 'lgg-pr-subject', title: c.subject, text: c.subject }));
            line.appendChild(el('span', { class: 'lgg-pr-meta', text: c.author + ', ' + relTime(c.date) }));
            list.appendChild(line);
        });

        var body = el('div', { class: 'lgg-pr-body' }, svg, list);
        var notes = [];
        if (data.hiddenHead) notes.push(data.hiddenHead + ' older PR commits not shown');
        if (data.hiddenBase) notes.push(data.hiddenBase + ' older base commits not shown');
        if (data.belowIncomplete) notes.push('some lines fork more than ' + MAX_BELOW + ' commits below the merge base and end early');
        return el('div', null, body, notes.length ? el('div', { class: 'lgg-pr-note', text: notes.join(' · ') }) : null);
    }

    // ------------------------------------------------------------ page glue

    function currentPr() {
        var m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
        return m ? { owner: m[1], repo: m[2], number: m[3], key: m[1] + '/' + m[2] + '#' + m[3] } : null;
    }

    function cacheGet(key) {
        try {
            var v = JSON.parse(sessionStorage.getItem('lgg-pr:v2:' + key));
            return v && Date.now() - v.loadedAt < CACHE_MS ? v : null;
        } catch (e) { return null; }
    }

    function cachePut(key, data) {
        try { sessionStorage.setItem('lgg-pr:v2:' + key, JSON.stringify(data)); } catch (e) { /* quota */ }
    }

    // Where to put the panel: in the conversation column like the merge box
    // card (above it on the React layout, at the top of the timeline on the
    // classic one); on tabs without either, under the PR title.
    function anchor() {
        // Overview layout (logged in, 2026-11): the "Recommended action" card
        // ("Review requested", "Ready to merge", ...) is one of a column of
        // cards; go right above it, or at the top of that column without it.
        var action = document.querySelector('section[aria-label="Recommended action"]');
        for (var n = action; n && n.parentElement; n = n.parentElement) {
            if (n.parentElement.matches('.d-flex.flex-column')) return { node: n, where: 'beforebegin', stack: true };
            if (/PageLayout-Content-/.test(n.parentElement.className)) break;
        }
        var stack = /\/pull\/\d+\/?$/.test(location.pathname) &&
            document.querySelector('[class*="PageLayout-Content-"] > .d-flex.flex-column');
        if (stack) return { node: stack, where: 'afterbegin', stack: true };
        var mergeBox = document.querySelector('[data-testid="mergebox-partial"], [class*="MergeBox-module"], [data-testid*="merge-box"]');
        if (mergeBox) return { node: mergeBox, where: 'beforebegin' };
        var timeline = document.querySelector('#discussion_bucket .js-discussion');
        if (timeline) return { node: timeline, where: 'afterbegin' };
        var header = document.querySelector('#partial-discussion-header') ||
            document.querySelector('.gh-header-show') ||
            // React PR layout (seen on merged PRs, 2026-11): the page header.
            document.querySelector('header[class*="PageLayout-Header"]');
        if (header) return { node: header, where: 'afterend' };
        var main = document.querySelector('main') || document.querySelector('#js-repo-pjax-container');
        return main ? { node: main, where: 'afterbegin' } : null;
    }

    var mounting = null;

    function mount(pr, force) {
        var at = anchor();
        if (!at) return;
        var old = document.getElementById(PANEL_ID);
        if (old) old.remove();

        var collapsed = localStorage.getItem('lgg-pr-collapsed') === '1';
        var details = el('details', { id: PANEL_ID, 'data-pr': pr.key });
        if (!collapsed) details.open = true;
        details.addEventListener('toggle', function () {
            localStorage.setItem('lgg-pr-collapsed', details.open ? '0' : '1');
        });
        var icon = el('span', { class: 'lgg-pr-icon' });
        var iconSvg = svgEl('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true' });
        // octicon git-commit
        iconSvg.appendChild(svgEl('path', { 'fill-rule': 'evenodd', fill: 'currentColor',
            d: 'M10.5 7.75a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zm1.43.75a4.002 4.002 0 01-7.86 0H.75a.75.75 0 110-1.5h3.32a4.001 4.001 0 017.86 0h3.32a.75.75 0 110 1.5h-3.32z' }));
        icon.appendChild(iconSvg);
        var title = el('span', { class: 'lgg-pr-title', text: 'Commit graph' });
        var stats = el('span', { class: 'lgg-pr-stats', text: 'Loading…' });
        var refresh = el('button', { class: 'lgg-pr-refresh', type: 'button', title: 'Reload from GitHub', text: 'Reload' });
        refresh.addEventListener('click', function (ev) {
            ev.preventDefault();
            sessionStorage.removeItem('lgg-pr:v2:' + pr.key);
            mount(pr, true);
        });
        var content = el('div', { class: 'lgg-pr-content' });
        details.appendChild(el('summary', null, icon, el('span', { class: 'lgg-pr-heading' }, title, stats), refresh));
        details.appendChild(content);
        details.classList.toggle('lgg-pr-in-stack', !!at.stack);
        at.node.insertAdjacentElement(at.where, details);

        var cached = force ? null : cacheGet(pr.key);
        var job = cached ? Promise.resolve(cached) : loadPrGraph(pr.owner, pr.repo, pr.number);
        mounting = job;
        job.then(function (data) {
            // A superseded load (refresh, or navigating away and back) must not
            // overwrite the cache entry of the load that replaced it.
            if (mounting !== job) return;
            if (!cached) cachePut(pr.key, data);
            stats.textContent = data.baseLabel + ' … ' + data.headLabel +
                ' · ' + data.aheadBy + ' ahead, ' + data.behindBy + ' behind';
            content.appendChild(renderGraph(data));
        }).catch(function (err) {
            if (mounting !== job) return;
            stats.textContent = '';
            content.appendChild(el('div', { class: 'lgg-pr-error', text: String(err.message || err) }));
        });
    }

    function isPlaced(panel, at) {
        if (at.where === 'beforebegin') return panel.nextElementSibling === at.node;
        if (at.where === 'afterbegin') return at.node.firstElementChild === panel;
        return panel.previousElementSibling === at.node;
    }

    // GitHub navigates without page loads and re-renders parts of the page,
    // so re-check on every DOM change (cheap: a regex and a lookup).
    function check() {
        var pr = currentPr();
        var panel = document.getElementById(PANEL_ID);
        if (!pr) { if (panel) panel.remove(); return; }
        if (panel && panel.getAttribute('data-pr') === pr.key) {
            // Mounted before GitHub rendered the PR header: move it under the header.
            var at = anchor();
            if (at && !isPlaced(panel, at)) {
                panel.classList.toggle('lgg-pr-in-stack', !!at.stack);
                at.node.insertAdjacentElement(at.where, panel);
            }
            return;
        }
        mount(pr, false);
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { topoOrder: topoOrder, layout: layout, loadPrGraph: loadPrGraph };
        return;
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
