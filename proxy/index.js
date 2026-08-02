// Minimal Omni Flash proxy for Cloud Run.
//
// The browser app cannot call the Vertex Interactions API directly because
// that endpoint rejects API keys and requires an OAuth2 access token. This
// proxy runs on Cloud Run as a service account, mints a token automatically
// via Application Default Credentials, and forwards the request to Vertex —
// so Omni bills against the project's (free) credits.
//
// Auth to the proxy itself is a shared secret (PROXY_SECRET) that the app
// sends in the X-Proxy-Secret header, so a stray URL can't burn credits.

const http = require('http');
const { GoogleAuth } = require('google-auth-library');

const PROJECT = process.env.VERTEX_PROJECT || 'fhnw-gemini';
const SHARED_SECRET = process.env.PROXY_SECRET || '';
const PORT = process.env.PORT || 8080;

const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Proxy-Secret',
    'Access-Control-Max-Age': '3600'
};

// The Interactions API only serves the global endpoint and the us/eu
// multi-region endpoints — ordinary regions (us-central1, …) are rejected.
// Multi-region traffic goes to its own host; only "global" uses the plain one.
const OMNI_LOCATIONS = ['global', 'us', 'eu'];
const DEFAULT_LOCATION = 'us';

function normalizeLocation(loc) {
    return OMNI_LOCATIONS.includes(loc) ? loc : DEFAULT_LOCATION;
}

function interactionsBase(location) {
    const host = location === 'global'
        ? 'aiplatform.googleapis.com'
        : `aiplatform.${location}.rep.googleapis.com`;
    return `https://${host}/v1beta1/projects/${PROJECT}/locations/${location}/interactions`;
}

function send(res, status, obj) {
    res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
    res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (req.method !== 'POST') return send(res, 405, { error: { message: 'POST only' } });

    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 60 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
        try {
            if (SHARED_SECRET && req.headers['x-proxy-secret'] !== SHARED_SECRET) {
                return send(res, 403, { error: { message: 'Invalid proxy secret' } });
            }

            const payload = JSON.parse(body || '{}');
            const location = normalizeLocation(payload.__region);
            delete payload.__region;
            const getId = payload.__get;

            const base = interactionsBase(location);

            const client = await auth.getClient();
            const { token } = await client.getAccessToken();

            // {__get: id} → retrieve an interaction (poll/recover); else create.
            const upstream = getId
                ? await fetch(`${base}/${encodeURIComponent(getId)}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                })
                : await fetch(base, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify(payload)
                });

            const text = await upstream.text();
            send(res, upstream.status, text);
        } catch (e) {
            send(res, 500, { error: { message: String((e && e.message) || e) } });
        }
    });
});

server.listen(PORT, () => console.log(`omni-proxy listening on ${PORT} (project ${PROJECT})`));
