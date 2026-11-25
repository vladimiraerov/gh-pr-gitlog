// Compares our commit set and order for a PR against `git log --topo-order`
// in a local clone that has the PR head fetched as pr<N>.
// usage: GITHUB_TOKEN=... node test/vs-git.js owner repo number /path/to/clone baseBranch
global.getLocalToken = () => process.env.GITHUB_TOKEN || null;
Object.assign(global, require('../js/common/api.js'));
const { topoOrder, layout, loadPrGraph } = require('../js/pr/prGraph.js');
const { execSync } = require('child_process');
const [owner, repo, num, clone, base] = process.argv.slice(2);
loadPrGraph(owner, repo, num).then((d) => {
  const by = new Map(d.commits.map((c) => [c.sha, c]));
  const ours = layout(topoOrder(by, d.tips, d.mergeBase)).rows.map((r) => r.commit.sha);
  const git = execSync(`git -C ${clone} log --topo-order --format=%H origin/${base}...pr${num}`).toString().trim().split('\n').filter(Boolean);
  const mb = execSync(`git -C ${clone} merge-base origin/${base} pr${num}`).toString().trim();
  const want = new Set(git.concat(mb));
  const got = new Set(ours);
  const missing = [...want].filter((s) => !got.has(s)), extra = [...got].filter((s) => !want.has(s));
  // Topological validity: every parent in the set is shown after its child.
  const pos = new Map(ours.map((s, i) => [s, i]));
  const bad = ours.filter((s) => by.get(s).parents.some((p) => pos.has(p) && pos.get(p) < pos.get(s)));
  console.log(`#${num}: ours=${ours.length} git=${want.size} missing=${missing.length} extra=${extra.length} parent-before-child=${bad.length} bottom=${ours[ours.length - 1].slice(0, 7)} mb=${mb.slice(0, 7)} sameOrder=${JSON.stringify(ours.slice(0, -1)) === JSON.stringify(git)}`);
  // extra = history below the merge base down to where every line joins.
  if (missing.length || bad.length) process.exitCode = 1;
}).catch((e) => { console.error(e.message); process.exit(1); });
