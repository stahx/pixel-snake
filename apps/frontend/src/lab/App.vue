<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { use } from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { CanvasRenderer } from 'echarts/renderers';
import { AriaComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import VChart from 'vue-echarts';

use([LineChart, BarChart, CanvasRenderer, GridComponent, TooltipComponent, LegendComponent, AriaComponent]);

const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500'];
const INK = {
  primary: '#f0efec',
  secondary: '#c3c2b7',
  muted: '#898781',
  grid: '#2c2c2a',
  axis: '#383835',
  surface: '#1a1a19',
  raised: '#232321',
  border: 'rgba(255,255,255,0.10)',
};
const DEATHS = [['bot', 'Bot'], ['human', 'Człowiek'], ['agent', 'Inny agent'], ['disconnect', 'Rozłączenie']];
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

const view = ref('loading');
const error = ref('');
const busy = ref(false);
const password = ref('');
const runs = ref([]);
const live = ref({ tickRate: 60, flushMinutes: 5, runs: [] });
const runId = ref(null);
const progress = ref([]);
const keys = ref([]);
const keyName = ref('');
const newKey = ref(null);
const copied = ref(false);

const number = (v) => (v == null ? '—' : new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 2 }).format(v));
const date = (v) => (v ? new Date(v).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const seconds = (ticks) => ticks / live.value.tickRate;

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/api/lab${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body && JSON.stringify(body),
  });
  if (response.status === 401 && path !== '/login') {
    view.value = 'login';
    throw new Error('Sesja wygasła, zaloguj się ponownie.');
  }
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function action(work) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await work();
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function loadRuns() {
  [runs.value, live.value] = await Promise.all([api('/runs'), api('/live')]);
  if (!runId.value && runs.value.length) runId.value = runs.value[0].id;
  if (runId.value) progress.value = await api(`/runs/${runId.value}/progress`);
}

async function open(target) {
  view.value = target;
  if (target === 'runs') await loadRuns();
  else keys.value = await api('/keys');
}

const login = () => action(async () => {
  await api('/login', { method: 'POST', body: { password: password.value } });
  password.value = '';
  await open('runs');
});
const logout = () => action(async () => {
  await api('/logout', { method: 'POST' });
  view.value = 'login';
});
const selectRun = (id) => action(async () => {
  runId.value = id;
  progress.value = await api(`/runs/${id}/progress`);
});
const createKey = () => action(async () => {
  newKey.value = await api('/keys', { method: 'POST', body: { name: keyName.value } });
  keyName.value = '';
  copied.value = false;
  keys.value = await api('/keys');
});
const revokeKey = (key) => action(async () => {
  if (!window.confirm(`Unieważnić klucz „${key.name}”? Podłączeni trenerzy zostaną rozłączeni.`)) return;
  await api(`/keys/${key.id}`, { method: 'DELETE' });
  keys.value = await api('/keys');
});
const copyKey = async () => {
  await navigator.clipboard.writeText(newKey.value.key);
  copied.value = true;
};

const run = computed(() => runs.value.find((r) => r.id === runId.value));
const liveRun = computed(() => live.value.runs.find((r) => r.runId === runId.value));
const isLive = (id) => live.value.runs.some((r) => r.runId === id);
const rows = computed(() => progress.value.filter((r) => r.episodes > 0));
const metricNames = computed(() => [...new Set(progress.value.flatMap((r) => Object.keys(r.metrics)))].sort());

const tiles = computed(() => {
  const pending = liveRun.value?.pending;
  const best = Math.max(run.value?.best_score ?? 0, pending?.scoreMax ?? 0);
  return [
    { label: 'Epizody', value: number((run.value?.episodes ?? 0) + (pending?.episodes ?? 0)) },
    { label: 'Najlepszy wynik', value: number(best) },
    { label: 'Śr. wynik (ostatnie okno)', value: number(rows.value.at(-1)?.score_avg) },
    { label: 'Agenci na żywo', value: number(liveRun.value?.agents.filter((a) => a.alive).length ?? 0) },
  ];
});

const chart = (series, yFormat = (v) => number(v)) => ({
  animation: false,
  aria: { enabled: true },
  textStyle: { fontFamily: FONT },
  grid: { left: 4, right: 12, top: series.length > 1 ? 34 : 12, bottom: 4, containLabel: true },
  legend: series.length > 1
    ? { left: 0, top: 0, icon: 'rect', itemWidth: 14, itemHeight: 3, textStyle: { color: INK.secondary } }
    : undefined,
  tooltip: {
    trigger: 'axis',
    backgroundColor: INK.raised,
    borderColor: INK.border,
    textStyle: { color: INK.primary },
    axisPointer: { type: series[0]?.type === 'bar' ? 'shadow' : 'line', lineStyle: { color: INK.muted } },
    valueFormatter: yFormat,
  },
  xAxis: {
    type: 'time',
    axisLine: { lineStyle: { color: INK.axis } },
    axisTick: { show: false },
    axisLabel: { color: INK.muted, hideOverlap: true },
    splitLine: { show: false },
  },
  yAxis: {
    type: 'value',
    axisLabel: { color: INK.muted, formatter: yFormat },
    splitLine: { lineStyle: { color: INK.grid } },
  },
  series,
});
const line = (name, color, data) => ({
  name,
  type: 'line',
  data,
  showSymbol: data.length === 1,
  symbolSize: 8,
  lineStyle: { width: 2, color, cap: 'round', join: 'round' },
  itemStyle: { color, borderColor: INK.surface, borderWidth: 2 },
});

const scoreChart = computed(() => chart([
  line('Średni wynik', SERIES[0], rows.value.map((r) => [r.recorded_at, r.score_avg])),
  line('Najlepszy wynik', SERIES[1], rows.value.map((r) => [r.recorded_at, r.score_max])),
]));
const survivalChart = computed(() => chart(
  [line('Średni czas życia', SERIES[0], rows.value.map((r) => [r.recorded_at, seconds(r.ticks_avg)]))],
  (v) => `${number(v)} s`,
));
const deathChart = computed(() => {
  const option = chart(DEATHS
    .map(([cause, label], i) => ({
      name: label,
      type: 'bar',
      stack: 'deaths',
      barMaxWidth: 24,
      data: rows.value.map((r) => r.deaths[cause] || 0),
      itemStyle: { color: SERIES[i], borderColor: INK.surface, borderWidth: 1 },
    }))
    .filter((series) => series.data.some((count) => count > 0)));
  option.xAxis = {
    ...option.xAxis,
    type: 'category',
    data: rows.value.map((r) => new Date(r.recorded_at).toLocaleTimeString('pl-PL', { timeStyle: 'short' })),
  };
  return option;
});
const metricCharts = computed(() => metricNames.value.map((name) => ({
  name,
  option: chart([line(name, SERIES[0], progress.value
    .filter((r) => r.metrics[name] != null)
    .map((r) => [r.recorded_at, r.metrics[name]]))]),
})));

let timer;
onMounted(async () => {
  try {
    await api('/session');
    await open('runs');
  } catch (e) {
    if (view.value !== 'login') {
      view.value = 'login';
      error.value = e.message;
    }
  }
  timer = setInterval(async () => {
    if (view.value !== 'runs' || busy.value) return;
    try {
      live.value = await api('/live');
    } catch (e) {
      error.value = e.message;
    }
  }, 2000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div v-if="view === 'loading'" class="center muted">Ładowanie…</div>

  <main v-else-if="view === 'login'" class="center">
    <form class="card login" @submit.prevent="login">
      <h1>RL Lab</h1>
      <p class="muted">Panel treningów Pixel Snake.</p>
      <label>Hasło
        <input v-model="password" type="password" autocomplete="current-password" required autofocus>
      </label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button class="primary" :disabled="busy">Zaloguj</button>
    </form>
  </main>

  <div v-else class="shell">
    <header class="topbar">
      <strong class="brand">RL Lab</strong>
      <nav>
        <button :class="{ active: view === 'runs' }" @click="action(() => open('runs'))">Runy</button>
        <button :class="{ active: view === 'keys' }" @click="action(() => open('keys'))">Klucze</button>
      </nav>
      <button class="ghost" @click="logout">Wyloguj</button>
    </header>

    <main class="content">
      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <section v-if="view === 'runs'" class="runs">
        <aside class="run-list">
          <button
            v-for="r in runs" :key="r.id"
            :class="{ selected: r.id === runId }"
            @click="selectRun(r.id)"
          >
            <span class="run-name">{{ r.name }}<span v-if="isLive(r.id)" class="live">LIVE</span></span>
            <small>{{ r.key_name }} · {{ number(r.episodes) }} epizodów</small>
          </button>
          <p v-if="!runs.length" class="muted">Brak runów. Utwórz klucz i podłącz trenera.</p>
        </aside>

        <div v-if="run" class="run">
          <div class="run-head">
            <h1>{{ run.name }}</h1>
            <p class="muted">Klucz {{ run.key_name }} · ostatnio {{ date(run.last_seen_at) }}</p>
          </div>

          <div class="tiles">
            <article v-for="tile in tiles" :key="tile.label" class="card tile">
              <span>{{ tile.label }}</span>
              <strong>{{ tile.value }}</strong>
            </article>
          </div>

          <article v-if="liveRun" class="card">
            <h2>Na żywo</h2>
            <table>
              <thead><tr><th>Agent</th><th>Stan</th><th>Wynik</th><th>Czas życia</th></tr></thead>
              <tbody>
                <tr v-for="(agent, i) in liveRun.agents" :key="i">
                  <td>#{{ i + 1 }}</td>
                  <td>{{ agent.alive ? 'Żyje' : 'Czeka na respawn' }}</td>
                  <td>{{ number(agent.score) }}</td>
                  <td>{{ number(seconds(agent.ticks)) }} s</td>
                </tr>
              </tbody>
            </table>
            <p class="muted">
              Bieżące okno: {{ number(liveRun.pending?.episodes ?? 0) }} epizodów, zapis co {{ number(live.flushMinutes) }} min.
            </p>
          </article>

          <p v-if="!progress.length" class="muted">Brak zapisanego postępu. Pierwszy zapis po upływie okna albo po rozłączeniu trenera.</p>

          <div v-else class="charts">
            <article class="card">
              <h2>Wynik w epizodzie</h2>
              <v-chart class="chart" :option="scoreChart" autoresize />
            </article>
            <article class="card">
              <h2>Czas życia</h2>
              <v-chart class="chart" :option="survivalChart" autoresize />
            </article>
            <article class="card">
              <h2>Przyczyny końca epizodu</h2>
              <v-chart class="chart" :option="deathChart" autoresize />
            </article>
            <article v-for="metric in metricCharts" :key="metric.name" class="card">
              <h2>{{ metric.name }} <small class="muted">trener</small></h2>
              <v-chart class="chart" :option="metric.option" autoresize />
            </article>
          </div>

          <details v-if="progress.length" class="card">
            <summary>Tabela postępu</summary>
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Zapis</th><th>Epizody</th><th>Śr. wynik</th><th>Najlepszy</th><th>Śr. życie</th>
                    <th v-for="[, label] in DEATHS" :key="label">{{ label }}</th>
                    <th v-for="name in metricNames" :key="name">{{ name }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in progress" :key="r.recorded_at">
                    <td>{{ date(r.recorded_at) }}</td>
                    <td>{{ number(r.episodes) }}</td>
                    <td>{{ number(r.score_avg) }}</td>
                    <td>{{ number(r.score_max) }}</td>
                    <td>{{ r.ticks_avg == null ? '—' : `${number(seconds(r.ticks_avg))} s` }}</td>
                    <td v-for="[cause] in DEATHS" :key="cause">{{ number(r.deaths[cause] || 0) }}</td>
                    <td v-for="name in metricNames" :key="name">{{ number(r.metrics[name]) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>
        </div>
      </section>

      <section v-else class="keys">
        <h1>Klucze trenerów</h1>
        <p class="muted">Klucz identyfikuje maszynę, z której trenujesz. Trener podaje go w <code>Game(key=...)</code> albo w <code>PIXEL_SNAKE_LAB_KEY</code>.</p>

        <form class="card key-form" @submit.prevent="createKey">
          <label>Nazwa maszyny
            <input v-model="keyName" maxlength="40" placeholder="np. macbook" required>
          </label>
          <button class="primary" :disabled="busy">Utwórz klucz</button>
        </form>

        <article v-if="newKey" class="card new-key">
          <h2>Klucz „{{ newKey.name }}”</h2>
          <p class="muted">Skopiuj teraz. Serwer trzyma tylko jego hash i nie pokaże go ponownie.</p>
          <div class="key-row">
            <code>{{ newKey.key }}</code>
            <button @click="copyKey">{{ copied ? 'Skopiowano' : 'Kopiuj' }}</button>
          </div>
        </article>

        <article class="card">
          <table>
            <thead><tr><th>Nazwa</th><th>Utworzony</th><th>Ostatnio użyty</th><th>Stan</th><th></th></tr></thead>
            <tbody>
              <tr v-for="key in keys" :key="key.id">
                <td>{{ key.name }}</td>
                <td>{{ date(key.created_at) }}</td>
                <td>{{ date(key.last_used_at) }}</td>
                <td>{{ key.revoked_at ? `Unieważniony ${date(key.revoked_at)}` : 'Aktywny' }}</td>
                <td><button v-if="!key.revoked_at" class="ghost" @click="revokeKey(key)">Unieważnij</button></td>
              </tr>
            </tbody>
          </table>
          <p v-if="!keys.length" class="muted">Brak kluczy.</p>
        </article>
      </section>
    </main>
  </div>
</template>
