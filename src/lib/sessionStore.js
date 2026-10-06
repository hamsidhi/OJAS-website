// SQL-backed express-session store (works with local SQLite and hosted Turso).
const session = require('express-session');
const { db } = require('../db');

class SqlStore extends session.Store {
  constructor() { super(); this.lastClean = 0; }
  get(sid, cb) {
    db.get('SELECT data FROM sessions WHERE sid = ? AND expires > ?', sid, Date.now())
      .then((r) => cb(null, r ? JSON.parse(r.data) : null), cb);
  }
  set(sid, sess, cb) {
    const exp = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 864e5;
    db.run('INSERT INTO sessions(sid,data,expires) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET data=excluded.data, expires=excluded.expires', sid, JSON.stringify(sess), exp)
      .then(() => { this.clean(); cb && cb(null); }, (e) => cb && cb(e));
  }
  destroy(sid, cb) { db.run('DELETE FROM sessions WHERE sid = ?', sid).then(() => cb && cb(null), (e) => cb && cb(e)); }
  touch(sid, sess, cb) { cb && cb(null); } // no sliding expiry: avoids a database write on every page view
  clean() { // purge expired sessions at most once an hour per instance
    if (Date.now() - this.lastClean < 3600e3) return;
    this.lastClean = Date.now();
    db.run('DELETE FROM sessions WHERE expires < ?', Date.now()).catch(() => {});
  }
}
module.exports = SqlStore;
