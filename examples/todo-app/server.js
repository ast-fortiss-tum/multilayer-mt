// Minimal demo subject for MultilayerMT: server-rendered login + a small
// client-side todo app backed by a JSON API. No dependencies.
// State is kept per session cookie so parallel mutant runs do not interfere.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3123);
const sessions = new Map(); // sid -> { user, todos, nextId }
const USERS = { 'alice@example.com': { password: 'secret1', username: 'alice', userId: 1 } };

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="/static/style.css"></head><body>
<header role="banner"><nav aria-label="Main"><a href="/" id="home-link">Home</a> <a href="/about" id="about-link">About</a> <a href="/todos" id="todos-link">Todos</a></nav></header>
<main>${body}</main>
<footer role="contentinfo"><p>Demo app &copy; MultilayerMT</p></footer></body></html>`;
}

function loginPage(error) {
  return page('Login', `
<h1>Sign in</h1>
<img src="/static/logo.svg" alt="Todo logo" width="48" height="48">
${error ? `<p class="error" role="alert" id="login-error">${error}</p>` : ''}
<form id="login-form" method="post" action="/login">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" placeholder="you@example.com" required aria-describedby="email-help">
  <small id="email-help">Use your work address</small>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" minlength="4" required>
  <button id="login-btn" class="btn primary" type="submit">Log in</button>
</form>`);
}

function todosPage() {
  return page('Todos', `
<h1 id="welcome">Loading...</h1>
<div class="toolbar">
  <input id="new-todo" placeholder="What needs to be done?" aria-label="New todo" maxlength="80">
  <button id="add-btn" class="btn" type="button">Add</button>
  <select id="filter" aria-label="Filter"><option value="all">All</option><option value="OPEN">Open</option><option value="DONE">Done</option></select>
</div>
<p id="status-line" aria-live="polite"></p>
<ul id="todo-list"></ul>
<script src="/static/app.js"></script>`);
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((c) => c.trim().split('=')));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => resolve(b));
  });
}
function send(res, status, body, type = 'text/html; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'content-type': type, ...headers });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sid = parseCookies(req).sid;
  const session = sid && sessions.get(sid);

  if (url.pathname.startsWith('/static/')) {
    const file = path.join(__dirname, 'static', path.basename(url.pathname));
    if (!fs.existsSync(file)) return send(res, 404, 'not found', 'text/plain');
    const type = { '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'text/plain';
    return send(res, 200, fs.readFileSync(file), type);
  }
  if (url.pathname === '/' && req.method === 'GET') return send(res, 200, loginPage(url.searchParams.get('error')));
  if (url.pathname === '/about') return send(res, 200, page('About', '<h1>About</h1><p id="about-text">A tiny todo application used to demonstrate multi-layer mutation testing.</p>'));
  if (url.pathname === '/login' && req.method === 'POST') {
    const form = new URLSearchParams(await readBody(req));
    const email = (form.get('email') || '').trim();
    const u = USERS[email];
    if (!u || u.password !== form.get('password')) {
      return send(res, 302, '', 'text/plain', { location: '/?error=' + encodeURIComponent('Invalid email or password') });
    }
    const id = crypto.randomUUID();
    sessions.set(id, {
      user: u,
      nextId: 3,
      todos: [
        { id: 1, title: 'Write thesis', status: 'OPEN', userId: u.userId, priority: 2 },
        { id: 2, title: 'Run mutation study', status: 'DONE', userId: u.userId, priority: 1 },
      ],
    });
    return send(res, 302, '', 'text/plain', { location: '/todos', 'set-cookie': `sid=${id}; Path=/; HttpOnly` });
  }
  if (url.pathname === '/todos') {
    if (!session) return send(res, 302, '', 'text/plain', { location: '/' });
    return send(res, 200, todosPage());
  }
  // JSON API
  if (url.pathname.startsWith('/api/')) {
    if (!session) return send(res, 401, JSON.stringify({ error: 'unauthorized' }), 'application/json');
    if (url.pathname === '/api/me') {
      return send(res, 200, JSON.stringify({ username: session.user.username, userId: session.user.userId }), 'application/json');
    }
    if (url.pathname === '/api/todos' && req.method === 'GET') {
      return send(res, 200, JSON.stringify(session.todos), 'application/json');
    }
    if (url.pathname === '/api/todos' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const title = String(body.title || '').trim();
      if (!title) return send(res, 400, JSON.stringify({ error: 'title required' }), 'application/json');
      const todo = { id: session.nextId++, title, status: 'OPEN', userId: session.user.userId, priority: 3 };
      session.todos.push(todo);
      return send(res, 201, JSON.stringify(todo), 'application/json');
    }
    const m = url.pathname.match(/^\/api\/todos\/(\d+)\/toggle$/);
    if (m && req.method === 'POST') {
      const t = session.todos.find((x) => x.id === Number(m[1]));
      if (!t) return send(res, 404, JSON.stringify({ error: 'not found' }), 'application/json');
      t.status = t.status === 'DONE' ? 'OPEN' : 'DONE';
      return send(res, 200, JSON.stringify(t), 'application/json');
    }
  }
  send(res, 404, page('Not found', '<h1>404</h1>'));
});

server.listen(PORT, () => console.log(`todo-app listening on http://localhost:${PORT}`));
