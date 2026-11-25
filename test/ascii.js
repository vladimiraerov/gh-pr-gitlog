// Fetches a real PR and prints the layout as ASCII, to eyeball against `git log --graph`.
// usage: node test/ascii.js owner repo number   (set GITHUB_TOKEN to avoid rate limits)
global.getLocalToken = () => process.env.GITHUB_TOKEN || null;
Object.assign(global, require('../js/common/api.js'));
const { topoOrder, layout, loadPrGraph } = require('../js/pr/prGraph.js');
const [owner, repo, num] = process.argv.slice(2);
loadPrGraph(owner, repo, num).then((d) => {
  const by = new Map(d.commits.map((c) => [c.sha, c]));
  const g = layout(topoOrder(by, d.tips, d.mergeBase));
  const refs = new Map(d.refs);
  console.log(`${d.baseLabel} ... ${d.headLabel}: ${d.aheadBy} ahead, ${d.behindBy} behind`);
  g.rows.forEach((row) => {
    let s = '';
    for (let i = 0; i < Math.max(row.lanes.length, 1); i++) s += i === row.col ? (row.commit.parents.length > 1 ? 'M ' : '* ') : '| ';
    const r = refs.get(row.commit.sha);
    console.log(s.padEnd(2 * g.width + 1), row.commit.sha.slice(0, 7), r ? '(' + r.map((x) => x.name).join(', ') + ') ' : '', row.commit.subject.slice(0, 70));
  });
}).catch((e) => { console.error(e); process.exit(1); });
