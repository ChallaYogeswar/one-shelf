const { handleRequest } = require('../server');

module.exports = async function api(req, res) {
  try {
    await handleRequest(req, res);
  } catch (error) {
    console.error('Hosted API request failed:', error.message);
    if (!res.headersSent) {
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(JSON.stringify({ error: 'The request could not be completed.' }));
    } else {
      res.destroy();
    }
  }
};

module.exports.config = { api: { bodyParser: false } };
