const http = require('node:http');

function startHealthServer(port = process.env.PORT || 3000) {
    http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ZiGBoT is alive');
    }).listen(port, () => console.log(`Health server listening on :${port}`));
}

module.exports = { startHealthServer };
