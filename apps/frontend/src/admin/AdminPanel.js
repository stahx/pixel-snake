const CONFIG_FIELDS = [
  ['TIMESCALE', 'Tempo gry'],
  ['BOTS', 'Boty'],
  ['POINTS_AMOUNT', 'Jedzenie'],
  ['FOG_RADIUS_MIN', 'Widok min'],
  ['FOG_RADIUS_MAX', 'Widok max'],
  ['NORMAL_SPEED', 'Prędkość'],
  ['BOOST_SPEED', 'Prędkość boost'],
];
const PLAYER_TYPES = { human: 'człowiek', bot: 'bot', agent: 'agent' };

class AdminPanel {
  constructor(game) {
    this.game = game;
    this.loggedIn = false;
    this.expanded = true;
    this.players = [];
    this.selected = null;
    this.edited = new Set();
    this.timer = null;

    this.root = document.createElement('div');
    this.root.id = 'admin-panel';
    this.root.hidden = true;
    this.root.innerHTML = `
      <button type="button" class="admin-toggle"></button>
      <div class="admin-body">
        <form class="admin-login admin-row">
          <input name="password" type="password" placeholder="Hasło" autocomplete="current-password" required>
          <button>Zaloguj</button>
        </form>
        <div class="admin-main">
          <p class="admin-stats">Ładowanie…</p>
          <form class="admin-config">
            <div class="admin-fields">
              ${CONFIG_FIELDS.map(([name, label]) => `<label>${label}<input name="${name}" type="number" step="any" required></label>`).join('')}
            </div>
            <button>Zapisz ustawienia</button>
          </form>
          <form class="admin-spawn admin-row">
            <input name="points" type="number" min="0" step="1" value="100" required aria-label="Punkty nowego węża">
            <select name="where" aria-label="Gdzie">
              <option value="near">obok mnie</option>
              <option value="random">losowo</option>
            </select>
            <button>Dodaj węża</button>
          </form>
          <div class="admin-players">
            <table>
              <thead><tr><th>Gracz</th><th>Typ</th><th>Pkt</th><th>Rozm.</th></tr></thead>
              <tbody></tbody>
            </table>
          </div>
          <fieldset class="admin-tools" disabled>
            <legend></legend>
            <form class="admin-points admin-row">
              <input name="points" type="number" min="0" step="1" required aria-label="Punkty">
              <button>Ustaw punkty</button>
            </form>
            <form class="admin-teleport admin-row">
              <input name="x" type="number" step="any" placeholder="x" required>
              <input name="y" type="number" step="any" placeholder="y" required>
              <button>Teleportuj</button>
            </form>
            <button type="button" class="admin-kill">Zabij</button>
          </fieldset>
          <button type="button" class="admin-logout">Wyloguj</button>
        </div>
        <p class="admin-error" role="alert"></p>
      </div>`;
    document.body.append(this.root);

    const find = (selector) => this.root.querySelector(selector);
    this.toggle = find('.admin-toggle');
    this.body = find('.admin-body');
    this.loginForm = find('.admin-login');
    this.main = find('.admin-main');
    this.stats = find('.admin-stats');
    this.configForm = find('.admin-config');
    this.list = find('.admin-players');
    this.tbody = find('tbody');
    this.tools = find('.admin-tools');
    this.legend = find('legend');
    this.pointsForm = find('.admin-points');
    this.error = find('.admin-error');

    for (const type of ['keydown', 'keyup', 'mousemove']) {
      this.root.addEventListener(type, (event) => event.stopPropagation());
    }
    this.toggle.addEventListener('click', () => {
      this.expanded = !this.expanded;
      this.#layout();
    });
    this.configForm.addEventListener('input', (event) => this.edited.add(event.target.name));
    this.tbody.addEventListener('click', (event) => {
      const row = event.target.closest('tr');
      if (row) this.#select(row.dataset.id);
    });
    this.tbody.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.#select(event.target.closest('tr').dataset.id);
    });

    this.#on(this.loginForm, 'submit', async () => {
      await this.#api('/login', { method: 'POST', body: { password: this.loginForm.elements.password.value } });
      this.loginForm.reset();
      this.loggedIn = true;
      this.#layout();
    });
    this.#on(find('.admin-logout'), 'click', async () => {
      await this.#api('/logout', { method: 'POST' });
      this.loggedIn = false;
      this.#layout();
    });
    this.#on(this.configForm, 'submit', async () => {
      const values = Object.fromEntries([...this.edited].map((name) => [name, Number(this.configForm.elements[name].value)]));
      await this.#api('/config', { method: 'PATCH', body: values });
      this.edited.clear();
      await this.#refresh();
    });
    this.#on(find('.admin-spawn'), 'submit', async (form) => {
      const near = form.elements.where.value === 'near';
      if (near && !this.#mine()) throw new Error('Nie masz węża: dołącz do gry albo wybierz „losowo”.');
      const body = { points: Number(form.elements.points.value), near: near ? this.game.socket.id : undefined };
      await this.#api('/spawn', { method: 'POST', body });
      await this.#refresh();
    });
    this.#on(this.pointsForm, 'submit', (form) => this.#player('/points', 'PUT', { points: Number(form.elements.points.value) }));
    this.#on(find('.admin-teleport'), 'submit', (form) => this.#player('/teleport', 'POST', {
      x: Number(form.elements.x.value),
      y: Number(form.elements.y.value),
    }));
    this.#on(find('.admin-kill'), 'click', () => this.#player('/kill', 'POST'));

    window.addEventListener('hashchange', () => this.#check());
    this.#check();
  }

  async #check() {
    const { status } = await fetch('/api/admin/session');
    this.loggedIn = status === 204;
    if (this.loggedIn || (status === 401 && location.hash === '#admin')) this.#layout();
    else this.root.hidden = true;
  }

  #layout() {
    this.root.hidden = false;
    this.toggle.textContent = this.expanded ? 'Admin ▾' : 'Admin ▸';
    this.toggle.setAttribute('aria-expanded', this.expanded);
    this.body.hidden = !this.expanded;
    this.loginForm.hidden = this.loggedIn;
    this.main.hidden = !this.loggedIn;
    clearInterval(this.timer);
    if (this.loggedIn && this.expanded) {
      this.#refresh();
      this.timer = setInterval(() => this.#refresh(), 1000);
    }
  }

  #on(element, type, work) {
    element.addEventListener(type, async (event) => {
      event.preventDefault();
      this.error.textContent = '';
      try {
        await work(element);
      } catch (error) {
        this.error.textContent = error.message;
      }
    });
  }

  async #api(path, { method = 'GET', body } = {}) {
    const response = await fetch(`/api/admin${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body && JSON.stringify(body),
    });
    if (response.status === 401 && path !== '/login') {
      this.loggedIn = false;
      this.#layout();
      throw new Error('Sesja wygasła, zaloguj się ponownie.');
    }
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  }

  async #player(path, method, body) {
    await this.#api(`/players/${encodeURIComponent(this.selected)}${path}`, { method, body });
    await this.#refresh();
  }

  #mine() {
    return this.players.find((player) => player.id === this.game.socket.id);
  }

  async #refresh() {
    let state;
    try {
      state = await this.#api('/state');
    } catch (error) {
      this.stats.textContent = error.message;
      if (!this.loggedIn) this.error.textContent = error.message;
      return;
    }
    this.players = state.players;
    this.stats.textContent = `${state.tps.toFixed(1)} ticków/s · krok ${state.stepMs.toFixed(2)} ms · jedzenie ${state.food} · ogony ${state.tails}`;
    for (const [name] of CONFIG_FIELDS) {
      const input = this.configForm.elements[name];
      if (!this.edited.has(name) && input !== document.activeElement) input.value = state.config[name];
    }
    if (!this.players.some((player) => player.id === this.selected)) this.selected = this.#mine()?.id;
    if (!this.list.matches(':hover, :has(:focus-visible)')) this.#renderPlayers();
    this.#renderTools();
  }

  #renderPlayers() {
    this.tbody.replaceChildren(...this.players.map((player) => {
      const row = document.createElement('tr');
      row.dataset.id = player.id;
      row.tabIndex = 0;
      row.classList.toggle('selected', player.id === this.selected);
      const name = (player.name || 'Brak') + (player.id === this.game.socket.id ? ' (ty)' : '');
      for (const text of [name, PLAYER_TYPES[player.type], player.points, player.size]) {
        const cell = document.createElement('td');
        cell.textContent = text;
        row.append(cell);
      }
      return row;
    }));
  }

  #renderTools() {
    const selected = this.players.find((player) => player.id === this.selected);
    this.tools.disabled = !selected;
    this.legend.textContent = selected ? `Wybrany: ${selected.name || 'Brak'}` : 'Kliknij gracza na liście';
  }

  #select(id) {
    this.selected = id;
    for (const row of this.tbody.rows) row.classList.toggle('selected', row.dataset.id === id);
    this.pointsForm.elements.points.value = this.players.find((player) => player.id === id)?.points ?? '';
    this.#renderTools();
  }
}
