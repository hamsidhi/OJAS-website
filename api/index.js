// Vercel entry point: every request is handled by the Express app.
// If the app cannot start (bad/missing settings), show the reason instead of a blank crash page.
let app, startError;
try { app = require('../server'); } catch (e) { startError = e; console.error('[startup failed]', e); }

module.exports = (req, res) => {
  if (startError) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end(`The store could not start: ${startError.message}\n\nCheck the Environment Variables in Vercel and redeploy.`);
  }
  return app(req, res);
};
