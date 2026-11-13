const http = require('node:http');

/**
 * Liveness on every path (unchanged: "ZiGBoT is alive", 200), plus
 * GET /healthz: a readiness report from getStatus() as JSON, 200 when the
 * Discord connection is ready, 503 otherwise. Booleans, counts and
 * provider names only; never ids, tokens or configuration values.
 */
function startHealthServer(port = process.env.PORT || 3000, { getStatus = null } = {}) {
    const server = http.createServer((req, res) => {
        if (getStatus && req.method === 'GET' && String(req.url || '').split('?')[0] === '/healthz') {
            let status;
            try {
                status = getStatus();
            } catch (error) {
                status = { ok: false, error: 'status unavailable' };
            }
            const ok = Boolean(status?.ok);
            res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ...status, ok }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ZiGBoT is alive');
    });
    server.listen(port, () => console.log(`Health server listening on :${server.address()?.port ?? port}`));
    return server;
}

module.exports = { startHealthServer };
