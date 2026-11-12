(function () {
  const list = document.getElementById('todo-list');
  const input = document.getElementById('new-todo');
  const addBtn = document.getElementById('add-btn');
  const filter = document.getElementById('filter');
  const statusLine = document.getElementById('status-line');
  let todos = [];

  function render() {
    const f = filter.value;
    list.innerHTML = '';
    todos
      .filter((t) => f === 'all' || t.status === f)
      .forEach((t) => {
        const li = document.createElement('li');
        li.className = 'todo ' + (t.status === 'DONE' ? 'done' : 'open');
        li.dataset.id = t.id;
        const title = document.createElement('span');
        title.className = 'title';
        title.textContent = t.title;
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = t.status === 'DONE' ? 'Done' : t.status === 'OPEN' ? 'Open' : 'Unknown';
        const btn = document.createElement('button');
        btn.className = 'toggle';
        btn.type = 'button';
        btn.textContent = t.status === 'DONE' ? 'Reopen' : 'Complete';
        btn.addEventListener('click', () => toggle(t.id));
        li.append(title, ' ', badge, ' ', btn);
        list.appendChild(li);
      });
    const open = todos.filter((t) => t.status === 'OPEN').length;
    statusLine.textContent = `${open} open of ${todos.length}`;
  }

  async function load() {
    try {
      const me = await (await fetch('/api/me')).json();
      document.getElementById('welcome').textContent = `Welcome, ${me.username}`;
      const res = await fetch('/api/todos');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      todos = await res.json();
      render();
    } catch (e) {
      statusLine.textContent = 'Could not load todos';
    }
  }

  async function add() {
    const title = input.value.trim();
    if (!title) return;
    const res = await fetch('/api/todos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) });
    if (!res.ok) {
      statusLine.textContent = 'Could not add todo';
      return;
    }
    todos.push(await res.json());
    input.value = '';
    render();
  }

  async function toggle(id) {
    const res = await fetch(`/api/todos/${id}/toggle`, { method: 'POST' });
    if (!res.ok) return;
    const updated = await res.json();
    todos = todos.map((t) => (t.id === updated.id ? updated : t));
    render();
  }

  addBtn.addEventListener('click', add);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && add());
  filter.addEventListener('change', render);
  load();
})();
