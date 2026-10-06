// Minimal SQLite-backed express-session store (no native dependencies).
const session = require('express-session');
const { db } = require('../db');

class SqliteStore extends session.Store {
  constructor() {
    super();
    this.get_ = db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires > ?');
    this.set_ = db.prepare('INSERT INTO sessions(sid,data,expires) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET data=excluded.data, expires=excluded.expires');
    this.del_ = db.prepare('DELETE FROM sessions WHERE sid = ?');
    setInterval(() => { try { db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()); } catch {} }, 3600e3).unref();
  }
  get(sid, cb) { try { const r = this.get_.get(sid, Date.now()); cb(null, r ? JSON.parse(r.data) : null); } catch (e) { cb(e); } }
  set(sid, sess, cb) {
    try {
      const exp = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 864e5;
      this.set_.run(sid, JSON.stringify(sess), exp); cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) { try { this.del_.run(sid); cb && cb(null); } catch (e) { cb && cb(e); } }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}
module.exports = SqliteStore;
