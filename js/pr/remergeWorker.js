// Background half of the "Manual resolution" view: relays a content-script
// request to the native host com.local.remerge (native/remerge_host.py) and
// returns its reply. Loaded by serviceWorker.js with importScripts.
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (!request || request.action !== 'lggRemerge') return;
    chrome.runtime.sendNativeMessage('com.local.remerge', request.payload, function (reply) {
        if (chrome.runtime.lastError) {
            var error = chrome.runtime.lastError.message || String(chrome.runtime.lastError);
            sendResponse({ ok: false, error: error, hostMissing: /not found|forbidden|exited/i.test(error) });
        } else {
            sendResponse(reply || { ok: false, error: 'the native host sent no reply' });
        }
    });
    return true;   // reply asynchronously
});
