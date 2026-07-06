const RESULT_CACHE = 'nb-results-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

async function broadcast(msg) {
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const c of clients) c.postMessage(msg);
}

async function storeResult(id, result) {
    const cache = await caches.open(RESULT_CACHE);
    await cache.put(
        new Request(`/__nb_result/${id}`),
        new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
    );
}

async function readResult(id) {
    const cache = await caches.open(RESULT_CACHE);
    const res = await cache.match(`/__nb_result/${id}`);
    return res ? res.json() : null;
}

async function deleteResult(id) {
    const cache = await caches.open(RESULT_CACHE);
    await cache.delete(`/__nb_result/${id}`);
}

async function runGenerate({ id, url, headers, body, meta }) {
    let result;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(headers || {}) },
            body: JSON.stringify(body)
        });
        let data = null;
        try { data = await response.json(); } catch (_) {}
        if (!response.ok) {
            const errMsg = (data && data.error && data.error.message) || `HTTP ${response.status}`;
            result = { id, ok: false, error: errMsg, meta };
        } else if (data && data.error) {
            result = { id, ok: false, error: data.error.message || 'API Error', meta };
        } else {
            result = { id, ok: true, data, meta };
        }
    } catch (err) {
        result = { id, ok: false, error: (err && err.message) || 'Network error', meta };
    }
    await storeResult(id, result);
    await broadcast({ type: 'result', ...result });
}

self.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;
    if (msg.type === 'generate') {
        event.waitUntil(runGenerate(msg));
    } else if (msg.type === 'check') {
        event.waitUntil((async () => {
            const result = await readResult(msg.id);
            if (result && event.source) event.source.postMessage({ type: 'result', ...result });
        })());
    } else if (msg.type === 'ack') {
        event.waitUntil(deleteResult(msg.id));
    }
});
