// "Manual resolution": for each merge commit of a PR, a button in the tab bar
// (js/tree/fileTabs.js) opens `git show --remerge-diff --format= <sha>`: the
// merge result against git's own automatic re-merge of the two parents, so
// only the hand-made part of the conflict resolution shows. The diff comes
// from a local clone through the native host (native/remerge_host.py).

(function () {
    'use strict';

    var PANEL_ID = 'lgg-remerge';
    var CACHE_MS = 5 * 60 * 1000;
    var merges = new Map();      // PR key -> [{sha, subject}] once loaded
    var loading = new Map();     // PR key -> Promise

    function el(tag, attrs, text) {
        var node = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (k) {
            if (k === 'class') node.className = attrs[k];
            else node.setAttribute(k, attrs[k]);
        });
        if (text != null) node.textContent = text;
        return node;
    }

    // Merge commits (two parents) among the PR's commits.
    async function loadMerges(s) {
        var cacheKey = 'lgg-remerge:v1:' + s.key;
        try {
            var v = JSON.parse(sessionStorage.getItem(cacheKey));
            if (v && Date.now() - v.at < CACHE_MS) return v.list;
        } catch (e) { /* ignore */ }
        var commits = [];
        for (var page = 1; page <= 3; page++) {   // the endpoint lists at most 250 commits
            var batch = await lggApiGet('/repos/' + s.owner + '/' + s.repo + '/pulls/' + s.pr +
                '/commits?per_page=100&page=' + page);
            commits = commits.concat(batch);
            if (batch.length < 100) break;
        }
        var list = commits.filter(function (c) { return c.parents.length === 2; }).map(function (c) {
            return { sha: c.sha, subject: c.commit.message.split('\n')[0] };
        }).reverse();   // newest first
        try { sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), list: list })); } catch (e) { /* quota */ }
        return list;
    }

    // ------------------------------------------------------------ diff view

    function parseDiff(text) {
        var files = [];
        var file = null, hunk = null, oldNo = 0, newNo = 0;
        text.split('\n').forEach(function (line) {
            if (line.indexOf('diff --git ') === 0) {
                var m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
                file = { name: m ? m[2] : line.slice(11), notes: [], hunks: [], add: 0, del: 0 };
                files.push(file);
                hunk = null;
                return;
            }
            if (!file) return;
            if (line.indexOf('@@') === 0) {
                var h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
                oldNo = h ? +h[1] : 0;
                newNo = h ? +h[2] : 0;
                hunk = { header: line, lines: [] };
                file.hunks.push(hunk);
                return;
            }
            if (!hunk) {
                // Header lines: keep git's conflict notes, drop index/mode/---/+++.
                if (/^remerge CONFLICT|^Binary files/.test(line)) file.notes.push(line);
                return;
            }
            var t = line.charAt(0);
            if (t === '+') { hunk.lines.push({ type: 'add', text: line.slice(1), n: newNo++ }); file.add++; }
            else if (t === '-') { hunk.lines.push({ type: 'del', text: line.slice(1), o: oldNo++ }); file.del++; }
            else if (t === ' ') hunk.lines.push({ type: 'ctx', text: line.slice(1), o: oldNo++, n: newNo++ });
            else if (t === '\\') hunk.lines.push({ type: 'meta', text: line });
        });
        return files;
    }

    function fileId(i) { return 'lgg-remerge-file-' + i; }

    function renderFiles(body, files) {
        var list = el('ul', { class: 'lgg-remerge-files' });
        files.forEach(function (f, i) {
            var li = el('li');
            var a = el('a', { href: '#' + fileId(i) }, f.name);
            a.addEventListener('click', function (ev) {
                ev.preventDefault();
                document.getElementById(fileId(i)).scrollIntoView({ block: 'start' });
            });
            li.appendChild(a);
            li.appendChild(el('span', { class: 'lgg-remerge-add' }, '+' + f.add));
            li.appendChild(el('span', { class: 'lgg-remerge-del' }, '−' + f.del));
            list.appendChild(li);
        });
        body.appendChild(list);

        files.forEach(function (f, i) {
            var box = el('div', { class: 'lgg-remerge-file', id: fileId(i) });
            var head = el('div', { class: 'lgg-remerge-filehead' });
            head.appendChild(el('span', { class: 'lgg-remerge-filename' }, f.name));
            head.appendChild(el('span', { class: 'lgg-remerge-add' }, '+' + f.add));
            head.appendChild(el('span', { class: 'lgg-remerge-del' }, '−' + f.del));
            box.appendChild(head);
            f.notes.forEach(function (n) { box.appendChild(el('div', { class: 'lgg-remerge-note' }, n)); });
            var table = el('table', { class: 'lgg-remerge-table' });
            f.hunks.forEach(function (h) {
                var tr = el('tr', { class: 'lgg-remerge-hunk' });
                tr.appendChild(el('td', { colspan: '3' }, h.header));
                table.appendChild(tr);
                h.lines.forEach(function (l) {
                    var row = el('tr', { class: 'lgg-remerge-' + l.type });
                    row.appendChild(el('td', { class: 'lgg-remerge-no' }, l.o != null ? String(l.o) : ''));
                    row.appendChild(el('td', { class: 'lgg-remerge-no' }, l.n != null ? String(l.n) : ''));
                    var sign = l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' ';
                    row.appendChild(el('td', { class: 'lgg-remerge-code' }, l.type === 'meta' ? l.text : sign + ' ' + l.text));
                    table.appendChild(row);
                });
            });
            if (f.hunks.length) box.appendChild(table);
            body.appendChild(box);
        });
    }

    function setupHelp(body, error) {
        body.appendChild(el('div', { class: 'lgg-remerge-error' }, error));
        var help = el('div', { class: 'lgg-remerge-help' });
        help.appendChild(el('div', null, 'One-time setup, in a terminal:'));
        help.appendChild(el('pre', null,
            '<extension folder>/native/install.sh\n' +
            '# then map the repo to a local clone in ~/.remerge/repos.json, e.g.\n' +
            '# {"owner/repo": "/path/to/clone"}\n' +
            '# and restart the browser'));
        body.appendChild(help);
    }

    // -------------------------------------------------------------- panel

    function open(s, sha, ignoreWhitespace) {
        var bar = document.getElementById('lgg-tabs');
        var old = document.getElementById(PANEL_ID);
        if (old) old.remove();
        var panel = el('section', { id: PANEL_ID, 'data-pr': s.key, 'aria-label': 'Manual resolution' });
        var head = el('div', { class: 'lgg-remerge-head' });
        var titles = el('div', { class: 'lgg-remerge-titles' });
        var title = el('div', { class: 'lgg-remerge-title' }, 'Manual resolution of ');
        title.appendChild(el('a', { href: '/' + s.owner + '/' + s.repo + '/pull/' + s.pr + '/commits/' + sha, class: 'lgg-remerge-sha' }, sha.slice(0, 7)));
        titles.appendChild(title);
        titles.appendChild(el('div', { class: 'lgg-remerge-sub' },
            'What the merge changed beyond git\'s automatic merge of its two parents (git show --remerge-diff)'));
        head.appendChild(titles);

        var wsLabel = el('label', { class: 'lgg-remerge-ws' });
        var ws = el('input', { type: 'checkbox' });
        ws.checked = !!ignoreWhitespace;
        ws.addEventListener('change', function () { open(s, sha, ws.checked); });
        wsLabel.appendChild(ws);
        wsLabel.appendChild(document.createTextNode(' Ignore whitespace'));
        head.appendChild(wsLabel);

        var command = 'git show --remerge-diff --format=' + (ignoreWhitespace ? ' -w' : '') + ' ' + sha;
        var copy = el('button', { type: 'button', class: 'lgg-remerge-btn', title: command }, 'Copy command');
        copy.addEventListener('click', function () {
            navigator.clipboard.writeText(command).then(function () { copy.textContent = 'Copied'; },
                function () { copy.textContent = 'Copy failed'; });
            setTimeout(function () { copy.textContent = 'Copy command'; }, 1500);
        });
        head.appendChild(copy);
        var close = el('button', { type: 'button', class: 'lgg-remerge-btn', 'aria-label': 'Close' }, 'Close');
        close.addEventListener('click', function () { panel.remove(); });
        head.appendChild(close);
        panel.appendChild(head);

        var body = el('div', { class: 'lgg-remerge-body' }, 'Running git show --remerge-diff…');
        panel.appendChild(body);
        if (bar) bar.insertAdjacentElement('afterend', panel);
        else (document.querySelector('main') || document.body).prepend(panel);

        chrome.runtime.sendMessage({
            action: 'lggRemerge',
            payload: { owner: s.owner, repo: s.repo, pr: s.pr, sha: sha, ignoreWhitespace: !!ignoreWhitespace },
        }, function (reply) {
            if (!document.body.contains(body)) return;
            body.textContent = '';
            if (chrome.runtime.lastError || !reply) {
                setupHelp(body, (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'no reply from the extension');
                return;
            }
            if (!reply.ok) {
                if (reply.hostMissing || /not mapped|no .*repos\.json/.test(reply.error)) setupHelp(body, reply.error);
                else body.appendChild(el('div', { class: 'lgg-remerge-error' }, reply.error));
                return;
            }
            var files = parseDiff(reply.diff);
            if (!files.length) {
                body.appendChild(el('div', { class: 'lgg-remerge-empty' },
                    'No manual changes: the merge result is exactly what git merges automatically.'));
                return;
            }
            if (reply.truncated) body.appendChild(el('div', { class: 'lgg-remerge-note' }, 'Output cut at 900 KB; run the command for all of it.'));
            renderFiles(body, files);
        });
    }

    // ------------------------------------------------------- tab bar hook

    function hook(bar, s) {
        var panel = document.getElementById(PANEL_ID);
        if (panel && panel.getAttribute('data-pr') !== (s && s.key)) panel.remove();
        if (!s || !s.pr) return;
        var list = merges.get(s.key);
        if (!list) {
            if (!loading.has(s.key)) {
                loading.set(s.key, loadMerges(s).then(function (l) {
                    merges.set(s.key, l);
                    if (window.lggTabs) window.lggTabs.rerender();
                }).catch(function (e) {
                    merges.set(s.key, { error: String(e.message || e) });
                    if (window.lggTabs) window.lggTabs.rerender();
                }));
            }
            return;
        }
        if (list.error) {
            // Say why instead of hiding the feature; a click retries.
            var retry = el('button', { type: 'button', class: 'lgg-remerge-open lgg-remerge-failed',
                title: 'Could not list the merge commits: ' + list.error + ' (click to retry)' }, 'Manual resolution ⚠');
            retry.addEventListener('click', function () {
                merges.delete(s.key);
                loading.delete(s.key);
                if (window.lggTabs) window.lggTabs.rerender();
            });
            bar.appendChild(retry);
            return;
        }
        if (!list.length) return;
        var group = el('div', { class: 'lgg-remerge-group' });
        var pick = null;
        if (list.length > 1) {
            pick = el('select', { class: 'lgg-remerge-pick', 'aria-label': 'Merge commit' });
            list.forEach(function (m) { pick.appendChild(el('option', { value: m.sha }, m.sha.slice(0, 7) + ' ' + m.subject)); });
            group.appendChild(pick);
        }
        var btn = el('button', { type: 'button', class: 'lgg-remerge-open',
            title: 'Show only the hand-made part of ' + (list.length > 1 ? 'the chosen merge' : list[0].sha.slice(0, 7)) },
            'Manual resolution');
        btn.addEventListener('click', function () { open(s, pick ? pick.value : list[0].sha, false); });
        group.appendChild(btn);
        bar.appendChild(group);
    }

    window.lggTabBarHooks = (window.lggTabBarHooks || []).concat([hook]);
    if (window.lggTabs) window.lggTabs.rerender();
})();
