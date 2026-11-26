// Revisions (patch sets): every head a PR has had, from its timeline, and a
// picker in the tab bar (js/tree/fileTabs.js) that opens GitHub's two-dot
// compare between any two of them, i.e. exactly what changed from one
// revision to the other. A force push starts a new revision at the pushed
// commit; a run of added commits is one revision at its last commit (the
// timeline does not say where one normal push ends and the next begins).

(function () {
    'use strict';

    var CACHE_MS = 5 * 60 * 1000;
    var revisions = new Map();   // PR key -> [{sha, how, date}] or {error}
    var loading = new Map();

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
        var cacheKey = 'lgg-revs:v1:' + s.key;
        try {
            var v = JSON.parse(sessionStorage.getItem(cacheKey));
            if (v && Date.now() - v.at < CACHE_MS) return v.revs;
        } catch (e) { /* ignore */ }
        var events = [];
        for (var page = 1; page <= 5; page++) {
            var batch = await lggApiGet('/repos/' + s.owner + '/' + s.repo + '/issues/' + s.pr +
                '/timeline?per_page=100&page=' + page);
            events = events.concat(batch);
            if (batch.length < 100) break;
        }
        var revs = fromTimeline(events);
        try { sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), revs: revs })); } catch (e) { /* quota */ }
        return revs;
    }

    function label(revs, i) {
        var r = revs[i];
        var same = revs.findIndex(function (o) { return o.sha === r.sha; });
        var day = r.date ? new Date(r.date).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
        return 'rev ' + (i + 1) + ' · ' + r.sha.slice(0, 7) + ' · ' + r.how + (day ? ', ' + day : '') +
            (same !== i ? ' (= rev ' + (same + 1) + ')' : '');
    }

    function hook(bar, s) {
        if (!s || !s.pr) return;
        var revs = revisions.get(s.key);
        if (!revs) {
            if (!loading.has(s.key)) {
                loading.set(s.key, loadRevisions(s).then(function (r) { revisions.set(s.key, r); })
                    .catch(function (e) { revisions.set(s.key, { error: String(e.message || e) }); })
                    .then(function () { if (window.lggTabs) window.lggTabs.rerender(); }));
            }
            return;
        }
        if (revs.error) {
            var retry = el('button', { type: 'button', class: 'lgg-revs-btn lgg-revs-failed',
                title: 'Could not read the PR timeline: ' + revs.error + ' (click to retry)' }, 'Revisions ⚠');
            retry.addEventListener('click', function () {
                revisions.delete(s.key);
                loading.delete(s.key);
                if (window.lggTabs) window.lggTabs.rerender();
            });
            bar.appendChild(retry);
            return;
        }
        if (revs.length < 2) return;   // nothing to compare
        var group = el('div', { class: 'lgg-revs', role: 'group', 'aria-label': 'Compare revisions' });
        var from = el('select', { 'aria-label': 'From revision' });
        var to = el('select', { 'aria-label': 'To revision' });
        revs.forEach(function (r, i) {
            from.appendChild(el('option', { value: String(i) }, label(revs, i)));
            to.appendChild(el('option', { value: String(i) }, label(revs, i)));
        });
        from.value = String(revs.length - 2);
        to.value = String(revs.length - 1);
        var go = el('button', { type: 'button', class: 'lgg-revs-btn', title: 'Open GitHub\'s diff between the two revisions' }, 'Compare');
        go.addEventListener('click', function () {
            var a = revs[+from.value].sha, b = revs[+to.value].sha;
            if (a === b) { go.title = 'Those two revisions are the same commit'; return; }
            window.open('/' + s.owner + '/' + s.repo + '/compare/' + a + '..' + b, '_blank', 'noopener');
        });
        group.appendChild(el('span', { class: 'lgg-revs-label' }, revs.length + ' revisions'));
        group.appendChild(from);
        group.appendChild(el('span', { class: 'lgg-revs-arrow' }, '→'));
        group.appendChild(to);
        group.appendChild(go);
        bar.appendChild(group);
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { fromTimeline: fromTimeline };
        return;
    }
    window.lggTabBarHooks = (window.lggTabBarHooks || []).concat([hook]);
    if (window.lggTabs) window.lggTabs.rerender();
})();
