// Shared GitHub REST helper for the PR graph and the file tree.
// Sends le-git-graph's stored token (getLocalToken, js/getLocalToken.js) when
// there is one; otherwise anonymous (60 requests/hour, public repos only).

// A token not authorized for an org with SAML SSO
// gets 403 even on that org's public repos. Such owners are remembered and
// served anonymously; every other owner keeps using the token.
var lggAnonymousOwners = new Set();

function lggOwnerOf(path) {
    var m = path.match(/^\/repos\/([^/]+)\//);
    return m ? m[1].toLowerCase() : null;
}

// True when requests for this owner carry a token (so paging is affordable).
function lggHasToken(owner) {
    var token = typeof getLocalToken === 'function' ? getLocalToken() : null;
    return !!token && !lggAnonymousOwners.has(String(owner).toLowerCase());
}

async function lggApiGet(path) {
    var owner = lggOwnerOf(path);
    var headers = { Accept: 'application/vnd.github+json' };
    var token = typeof getLocalToken === 'function' ? getLocalToken() : null;
    if (token && !(owner && lggAnonymousOwners.has(owner))) headers.Authorization = 'Bearer ' + token;
    var res = await fetch('https://api.github.com' + path, { headers: headers });
    if (res.ok) return res.json();
    var body = await res.text();
    if (res.status === 403 && headers.Authorization && owner && /SAML/i.test(body)) {
        lggAnonymousOwners.add(owner);
        return lggApiGet(path);
    }
    var msg;
    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
        var reset = new Date(Number(res.headers.get('x-ratelimit-reset')) * 1000);
        msg = 'GitHub API rate limit used up (' + (headers.Authorization ? 'token' : 'anonymous, 60/hour per IP') +
            '); resets at ' + reset.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
            (headers.Authorization ? '.' : '. Add a token: Commits tab → "Custom Personal Access Token".');
    } else if (res.status === 404) {
        msg = 'GitHub API 404 for ' + path + ' (private repo? add a token through the Commits tab)';
    } else {
        msg = 'GitHub API ' + res.status + ' for ' + path + ': ' + body.slice(0, 160);
    }
    var err = new Error(msg);
    err.status = res.status;
    throw err;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { lggApiGet: lggApiGet, lggHasToken: lggHasToken };
}
