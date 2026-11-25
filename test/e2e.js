// Loads the unpacked extension in Chromium, opens pages, screenshots them and
// asserts the panels rendered. Needs playwright-core (not a repo dependency):
//   NODE_PATH=/path/with/node_modules LGG_TOKEN=... node test/e2e.js
// LGG_TOKEN is optional; it is put in a throwaway profile's localStorage the
// way le-git-graph stores its token, and the profile is deleted at the end.
const { chromium } = require('playwright-core');
const fs = require('fs'), os = require('os'), path = require('path');

const EXT = path.resolve(__dirname, '..');
const OUT = process.env.LGG_OUT || path.join(os.tmpdir(), 'lgg-shots');
const CHROME = process.env.LGG_CHROME;
const PAGES = (process.env.LGG_PAGES || '').split(' ').filter(Boolean);
if (!PAGES.length) { console.error('set LGG_PAGES to the GitHub pages to check, space-separated'); process.exit(2); }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lgg-profile-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: CHROME, headless: false, viewport: { width: 1500, height: 1000 },
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let failed = 0;
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') console.log('  console.error:', m.text().slice(0, 200)); });
    await page.goto('https://github.com/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => {
      if (t) localStorage.setItem('GithubOAuthToken', t);
      localStorage.setItem('lgg-tree-open', '1');
    }, process.env.LGG_TOKEN || '');
    for (const [i, url] of PAGES.entries()) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      const isPr = /\/pull\/\d+/.test(url);
      const res = { url };
      try {
        await page.waitForSelector('#lgg-tree .lgg-tree-row, #lgg-tree .lgg-tree-error', { timeout: 20000 });
        res.tree = await page.$$eval('#lgg-tree .lgg-tree-row', (r) => r.length);
        res.treeTitle = await page.$eval('#lgg-tree .lgg-tree-title', (e) => e.textContent);
        res.treeError = await page.$eval('#lgg-tree', (e) => e.querySelector('.lgg-tree-error')?.textContent || null);
        if (isPr) {
          await page.waitForSelector('#lgg-pr-graph .lgg-pr-row, #lgg-pr-graph .lgg-pr-error', { timeout: 20000 });
          res.prRows = await page.$$eval('#lgg-pr-graph .lgg-pr-row', (r) => r.length);
          res.prStats = await page.$eval('#lgg-pr-graph .lgg-pr-stats', (e) => e.textContent);
          res.prError = await page.$eval('#lgg-pr-graph', (e) => e.querySelector('.lgg-pr-error')?.textContent || null);
          res.svgPaths = await page.$$eval('#lgg-pr-graph svg path', (r) => r.length);
          res.inHeader = await page.$eval('#lgg-pr-graph', (e) => (e.previousElementSibling?.id || e.parentElement?.tagName));
        }
      } catch (e) { res.exception = e.message.split('\n')[0]; }
      const m = url.match(/\/tree\/(chore\/[^/]+)/);
      const refOk = !m || res.treeTitle.endsWith('@ ' + m[1]);
      const ok = refOk && !res.exception && !res.treeError && res.tree > 0 && (!isPr || (!res.prError && res.prRows > 0));
      if (!ok) failed++;
      console.log(ok ? 'PASS' : 'FAIL', JSON.stringify(res));
      await page.screenshot({ path: path.join(OUT, `shot-${i}.png`) });
      if (isPr) {
        const panel = await page.$('#lgg-pr-graph');
        if (panel) await panel.screenshot({ path: path.join(OUT, `panel-${i}.png`) });
      }
    }
  } finally {
    await ctx.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(`screenshots in ${OUT}`);
  process.exit(failed ? 1 : 0);
})();
