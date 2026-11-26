// Revisions (patch sets): every head a PR has had, from its timeline, and a
// picker in the tab bar (js/tree/fileTabs.js) that opens GitHub's two-dot
// compare between any two of them, i.e. exactly what changed from one
// revision to the other. A force push starts a new revision at the pushed
// commit; a run of added commits is one revision at its last commit (the
// timeline does not say where one normal push ends and the next begins).

(function () {
    'use strict';

    var CACHE_MS = 5 * 60 * 1000;
    var revisions = new Map();   // PR key -> {revs: [{sha, how, date}], base} or {error}
    var loading = new Map();
    var selection = new Map();   // PR key -> {from, to} (from null: one revision) while its panel is open

    function el(tag, attrs, text) {
        var node = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (k) {
            if (k === 'class') node.className = attrs[k];
            else node.setAttribute(k, attrs[k]);
        });
        if (text != null) node.textContent = text;
        return node;
    }

    function fromTimeline(events) {
        var revs = [];
        var run = null;   // commits added since the last revision boundary
        events.forEach(function (e) {
            if (e.event === 'committed') {
                run = { sha: e.sha, how: run ? run.how + 1 : 1, date: (e.committer || e.author || {}).date };
            } else if (e.event === 'head_ref_force_pushed' && e.commit_id) {
                if (run) revs.push({ sha: run.sha, how: run.how + (run.how > 1 ? ' commits' : ' commit'), date: run.date });
                run = null;
                revs.push({ sha: e.commit_id, how: 'force push', date: e.created_at });
            }
        });
        if (run) revs.push({ sha: run.sha, how: run.how + (run.how > 1 ? ' commits' : ' commit'), date: run.date });
        return revs;
    }

    async function loadRevisions(s) {
        var cacheKey = 'lgg-revs:v2:' + s.key;
        try {
            var v = JSON.parse(sessionStorage.getItem(cacheKey));
            if (v && Date.now() - v.at < CACHE_MS) return v.data;
        } catch (e) { /* ignore */ }
        var events = [];
        for (var page = 1; page <= 5; page++) {
            var batch = await lggApiGet('/repos/' + s.owner + '/' + s.repo + '/issues/' + s.pr +
                '/timeline?per_page=100&page=' + page);
            events = events.concat(batch);
            if (batch.length < 100) break;
        }
        var pr = await lggApiGet('/repos/' + s.owner + '/' + s.repo + '/pulls/' + s.pr);
        var data = { revs: fromTimeline(events), base: pr.base.sha };
        try { sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), data: data })); } catch (e) { /* quota */ }
        return data;
    }

    function describe(revs, i) {
        var r = revs[i];
        var same = revs.findIndex(function (o) { return o.sha === r.sha; });
        var day = r.date ? new Date(r.date).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
        return r.sha.slice(0, 7) + ' · ' + r.how + (day ? ' · ' + day : '') + (same !== i ? ' (same as ' + (same + 1) + ')' : '');
    }

    // ------------------------------------------------ rebase-aware panel

    function rangeDiffPanel(s, revs, data, a, b) {
        var old = document.getElementById('lgg-remerge');
        if (old) old.remove();
        var panel = el('section', { id: 'lgg-remerge', 'data-pr': s.key, 'data-kind': 'rev', 'aria-label': 'Revision diff' });
        var head = el('div', { class: 'lgg-remerge-head' });
        var titles = el('div', { class: 'lgg-remerge-titles' });
        titles.appendChild(el('div', { class: 'lgg-remerge-title' }, 'Revision ' + (a + 1) + ' → ' + (b + 1) + ', ignoring rebases'));
        titles.appendChild(el('div', { class: 'lgg-remerge-sub' },
            'Each revision\'s commits against its own base, matched up by git range-diff: = unchanged, ! changed, < dropped, > added'));
        head.appendChild(titles);
        var close = el('button', { type: 'button', class: 'lgg-remerge-btn' }, 'Close');
        close.addEventListener('click', function () { panel.remove(); selection.delete(s.key); refresh(); });
        head.appendChild(close);
        panel.appendChild(head);
        var body = el('div', { class: 'lgg-remerge-body' }, 'Running git range-diff…');
        panel.appendChild(body);
        var bar = document.getElementById('lgg-tabs');
        if (bar) bar.insertAdjacentElement('afterend', panel);
        else (document.querySelector('main') || document.body).prepend(panel);

        chrome.runtime.sendMessage({ action: 'lggRemerge', payload: {
            action: 'rangediff', owner: s.owner, repo: s.repo, pr: s.pr,
            from: revs[a].sha, to: revs[b].sha, base: data.base,
        } }, function (reply) {
            if (!document.body.contains(body)) return;
            body.textContent = '';
            if (chrome.runtime.lastError || !reply || !reply.ok) {
                var msg = (chrome.runtime.lastError && chrome.runtime.lastError.message) || (reply && reply.error) || 'no reply';
                body.appendChild(el('div', { class: 'lgg-remerge-error' }, msg));
                if (!reply || reply.hostMissing || /not mapped|repos\.json/.test(msg)) {
                    body.appendChild(el('pre', { class: 'lgg-remerge-help' },
                        'Needs the local git helper: <extension folder>/native/install.sh,\n' +
                        'then map the repo in ~/.remerge/repos.json and restart the browser.'));
                }
                return;
            }
            var lines = reply.diff.replace(/\n$/, '').split('\n');
            var unchanged = lines.filter(function (l) { return /^\s*\d+:\s+\S+ = /.test(l); }).length;
            if (lines.every(function (l) { return !l || /^\s*\d+:\s+\S+ = /.test(l); })) {
                body.appendChild(el('div', { class: 'lgg-remerge-empty' },
                    'No changes besides rebasing: all ' + unchanged + ' commits are the same.'));
                return;
            }
            var pre = el('div', { class: 'lgg-rd' });
            var hidden = 0;
            lines.forEach(function (l) {
                var m = l.match(/^\s*(\d+|-):\s+\S+ ([=!<>]) /);
                if (m && m[2] === '=') { hidden++; return; }
                var cls = m ? 'lgg-rd-pair lgg-rd-' + { '!': 'changed', '<': 'dropped', '>': 'added' }[m[2]]
                    : l.charAt(4) === '+' ? 'lgg-rd-add' : l.charAt(4) === '-' ? 'lgg-rd-del'
                    : /^\s{4}@@/.test(l) ? 'lgg-rd-hunk' : '';
                pre.appendChild(el('div', { class: cls }, l || ' '));
            });
            if (hidden) body.appendChild(el('div', { class: 'lgg-remerge-sub' }, hidden + ' unchanged commit' + (hidden > 1 ? 's' : '') + ' not shown'));
            body.appendChild(pre);
        });
    }

    // A git diff in the page, drawn like Manual resolution (js/pr/remerge.js).
    function diffPanel(s, title, sub, payload) {
        var old = document.getElementById('lgg-remerge');
        if (old) old.remove();
        var panel = el('section', { id: 'lgg-remerge', 'data-pr': s.key, 'data-kind': 'rev', 'aria-label': title });
        var head = el('div', { class: 'lgg-remerge-head' });
        var titles = el('div', { class: 'lgg-remerge-titles' });
        titles.appendChild(el('div', { class: 'lgg-remerge-title' }, title));
        titles.appendChild(el('div', { class: 'lgg-remerge-sub' }, sub));
        head.appendChild(titles);
        var wsLabel = el('label', { class: 'lgg-remerge-ws' });
        var ws = el('input', { type: 'checkbox' });
        ws.checked = !!payload.ignoreWhitespace;
        ws.addEventListener('change', function () {
            diffPanel(s, title, sub, Object.assign({}, payload, { ignoreWhitespace: ws.checked }));
        });
        wsLabel.appendChild(ws);
        wsLabel.appendChild(document.createTextNode(' Ignore whitespace'));
        head.appendChild(wsLabel);
        var close = el('button', { type: 'button', class: 'lgg-remerge-btn' }, 'Close');
        close.addEventListener('click', function () { panel.remove(); selection.delete(s.key); refresh(); });
        head.appendChild(close);
        panel.appendChild(head);
        var body = el('div', { class: 'lgg-remerge-body' }, 'Running git diff…');
        panel.appendChild(body);
        var bar = document.getElementById('lgg-tabs');
        if (bar) bar.insertAdjacentElement('afterend', panel);
        else (document.querySelector('main') || document.body).prepend(panel);
        panel.scrollIntoView({ block: 'start' });

        chrome.runtime.sendMessage({ action: 'lggRemerge', payload: Object.assign({ action: 'diff' }, payload) }, function (reply) {
            if (!document.body.contains(body)) return;
            body.textContent = '';
            var view = window.lggDiffView;
            if (chrome.runtime.lastError || !reply || !reply.ok) {
                var msg = (chrome.runtime.lastError && chrome.runtime.lastError.message) || (reply && reply.error) || 'no reply';
                if (!reply || reply.hostMissing || /not mapped|repos\.json/.test(msg)) view.setupHelp(body, msg);
                else body.appendChild(el('div', { class: 'lgg-remerge-error' }, msg));
                return;
            }
            var files = view.parseDiff(reply.diff);
            if (!files.length) {
                body.appendChild(el('div', { class: 'lgg-remerge-empty' }, 'No differences.'));
                return;
            }
            if (reply.truncated) body.appendChild(el('div', { class: 'lgg-remerge-note' }, 'Output cut at 900 KB; run ' + reply.command + ' for all of it.'));
            view.renderFiles(body, files);
        });
    }

    function refresh() { if (window.lggTabs) window.lggTabs.rerender(); }

    // Remember what the open panel shows, so the button and menu say so.
    function select(s, from, to) {
        selection.set(s.key, { from: from, to: to });
        refresh();
    }

    // ------------------------------------------------------ revision menu

    function hook(bar, s) {
        if (!s || !s.pr) return;
        var data = revisions.get(s.key);
        if (!data) {
            if (!loading.has(s.key)) {
                loading.set(s.key, loadRevisions(s).then(function (d) { revisions.set(s.key, d); })
                    .catch(function (e) { revisions.set(s.key, { error: String(e.message || e) }); })
                    .then(function () { if (window.lggTabs) window.lggTabs.rerender(); }));
            }
            return;
        }
        if (data.error) {
            var retry = el('button', { type: 'button', class: 'lgg-revs-btn lgg-revs-failed',
                title: 'Could not read the PR timeline: ' + data.error + ' (click to retry)' }, 'Revisions ⚠');
            retry.addEventListener('click', function () {
                revisions.delete(s.key);
                loading.delete(s.key);
                if (window.lggTabs) window.lggTabs.rerender();
            });
            bar.appendChild(retry);
            return;
        }
        var revs = data.revs;
        var n = revs.length;
        if (!n) return;
        // The selection lasts while its panel is open (Close, or another panel, ends it).
        var panelOpen = document.getElementById('lgg-remerge');
        if (!panelOpen || panelOpen.getAttribute('data-kind') !== 'rev' || panelOpen.getAttribute('data-pr') !== s.key) selection.delete(s.key);
        var sel = selection.get(s.key);
        var base = '/' + s.owner + '/' + s.repo + '/compare/';
        var wrap = el('div', { class: 'lgg-revs' });
        var button = el('button', { type: 'button', class: 'lgg-revs-btn', 'aria-haspopup': 'true', 'aria-expanded': 'false' },
            (!sel ? 'Revision ' + n + ' of ' + n
                : sel.from == null ? 'Revision ' + (sel.to + 1) + ' of ' + n
                : 'Revision ' + (sel.from + 1) + '–' + (sel.to + 1) + (sel.rebase ? ' (rebase-aware)' : '')) + ' ▾');
        if (sel) button.classList.add('lgg-revs-selected');
        var menu = el('div', { class: 'lgg-revs-menu', role: 'menu', hidden: '' });
        var ignoreLabel = el('label', { class: 'lgg-revs-ignore' });
        var ignore = el('input', { type: 'checkbox' });
        ignore.checked = localStorage.getItem('lgg-revs-ignore-rebase') === '1';
        ignore.addEventListener('change', function () { localStorage.setItem('lgg-revs-ignore-rebase', ignore.checked ? '1' : '0'); });
        ignoreLabel.appendChild(ignore);
        ignoreLabel.appendChild(document.createTextNode(' Ignore rebases (local git)'));

        function closeMenu() { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); }
        revs.forEach(function (r, i) {
            var row = el('div', { class: 'lgg-revs-row' });
            // Left: the PR as of revision i (its diff against the PR base).
            var one = el('a', { class: 'lgg-revs-cell', role: 'menuitem', href: base + data.base + '...' + r.sha,
                title: 'Revision ' + (i + 1) + ': ' + describe(revs, i) }, String(i + 1));
            one.addEventListener('click', function (ev) {
                ev.preventDefault();
                closeMenu();
                diffPanel(s, 'Revision ' + (i + 1) + ' of ' + n, describe(revs, i) + ' · the PR as of this revision, against its base',
                    { owner: s.owner, repo: s.repo, pr: s.pr, to: r.sha, base: data.base });
                select(s, null, i);
            });
            if (sel && sel.from == null && sel.to === i) one.classList.add('lgg-revs-current');
            row.appendChild(one);
            // Right: what changed from revision i to the latest.
            if (i < n - 1) {
                var range = el('a', { class: 'lgg-revs-cell', role: 'menuitem', href: base + r.sha + '..' + revs[n - 1].sha,
                    title: 'Changes from revision ' + (i + 1) + ' to ' + n }, (i + 1) + '–' + n);
                range.addEventListener('click', function (ev) {
                    ev.preventDefault();
                    closeMenu();
                    if (ignore.checked) {
                        rangeDiffPanel(s, revs, data, i, n - 1);
                        selection.set(s.key, { from: i, to: n - 1, rebase: true });
                        refresh();
                        return;
                    }
                    diffPanel(s, 'Revision ' + (i + 1) + ' → ' + n, 'What changed from ' + revs[i].sha.slice(0, 7) + ' to ' +
                        revs[n - 1].sha.slice(0, 7) + ' (includes base-branch changes if a revision was rebased)',
                        { owner: s.owner, repo: s.repo, pr: s.pr, from: r.sha, to: revs[n - 1].sha });
                    select(s, i, n - 1);
                });
                if (sel && sel.from === i) range.classList.add('lgg-revs-current');
                row.appendChild(range);
            } else {
                row.appendChild(el('span', { class: 'lgg-revs-cell lgg-revs-empty' }));
            }
                menu.appendChild(row);
        });
        menu.appendChild(ignoreLabel);
        button.addEventListener('click', function (ev) {
            ev.stopPropagation();
            menu.hidden = !menu.hidden;
            button.setAttribute('aria-expanded', String(!menu.hidden));
        });
        wrap.appendChild(button);
        wrap.appendChild(menu);
        bar.appendChild(wrap);
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { fromTimeline: fromTimeline };
        return;
    }
    // One listener for all redraws of the bar: a click outside closes the menu.
    document.addEventListener('click', function (ev) {
        document.querySelectorAll('#lgg-tabs .lgg-revs').forEach(function (w) {
            if (w.contains(ev.target)) return;
            var m = w.querySelector('.lgg-revs-menu');
            if (m) m.hidden = true;
        });
    });
    window.lggTabBarHooks = (window.lggTabBarHooks || []).concat([hook]);
    if (window.lggTabs) window.lggTabs.rerender();
})();
