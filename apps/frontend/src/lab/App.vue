<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { use } from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { CanvasRenderer } from 'echarts/renderers';
import { AriaComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import VChart from 'vue-echarts';

use([LineChart, BarChart, CanvasRenderer, GridComponent, TooltipComponent, LegendComponent, AriaComponent, MarkAreaComponent, MarkLineComponent]);

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
  pause: 'rgba(255,255,255,0.04)',
};
const DEATHS = [
  ['bot', 'Bot', SERIES[0]],
  ['human', 'Człowiek', SERIES[1]],
  ['agent', 'Inny agent', SERIES[2]],
  ['disconnect', 'Rozłączenie', SERIES[3]],
  ['admin', 'Admin', INK.muted],
];
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const PAGE_SIZE = 10;
const LOG_LINES = 2000;
const AGENT_COLUMNS = [
  { key: 'id', label: 'Agent' },
  { key: 'room', label: 'Serwer' },
  { key: 'alive', label: 'Stan' },
  { key: 'score', label: 'Wynik' },
  { key: 'ticks', label: 'Czas życia' },
];

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
const compareIds = ref([]);
const compareColors = ref({});
const compareData = ref({});
const compareAxis = ref('time');
const runAxis = ref('time');
const agentSort = ref({ key: 'score', desc: true });
const page = ref(0);
const preview = ref(null);
const draft = ref({});
const logsOpen = ref(false);
const logs = ref([]);
const logBox = ref(null);
const newRun = ref(null);
const startRooms = ref([]);
const models = ref([]);
const roomServers = ref({ firstPort: 3031, running: [] });
const roomsDraft = ref({ count: 20, timescale: 1.5 });
const startModel = ref('');
const stopping = ref(null);

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
  [runs.value, live.value, models.value] = await Promise.all([api('/runs'), api('/live'), api('/models')]);
  if (!runId.value && runs.value.length) runId.value = runs.value[0].id;
  if (runId.value) progress.value = await api(`/runs/${runId.value}/progress`);
}

async function open(target) {
  view.value = target;
  if (target === 'runs') await loadRuns();
  else if (target === 'compare') await loadCompare();
  else if (target === 'rooms') roomServers.value = await api('/rooms');
  else keys.value = await api('/keys');
}

async function loadCompare() {
  runs.value = await api('/runs');
  if (!compareIds.value.length) runs.value.slice(0, 2).forEach((r) => pickCompare(r.id));
  const loaded = await Promise.all(compareIds.value.map((id) => api(`/runs/${id}/progress`)));
  compareData.value = Object.fromEntries(compareIds.value.map((id, i) => [id, loaded[i]]));
}

function pickCompare(id) {
  const used = Object.values(compareColors.value);
  compareColors.value = { ...compareColors.value, [id]: SERIES.find((color) => !used.includes(color)) };
  compareIds.value = [...compareIds.value, id];
}

const toggleCompare = (id) => action(async () => {
  if (compareIds.value.includes(id)) {
    compareIds.value = compareIds.value.filter((other) => other !== id);
    const { [id]: _, ...colors } = compareColors.value;
    compareColors.value = colors;
    return;
  }
  pickCompare(id);
  compareData.value = { ...compareData.value, [id]: await api(`/runs/${id}/progress`) };
});

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
  newRun.value = null;
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
const startRoomServers = () => action(async () => {
  await api('/rooms/start', { method: 'POST', body: roomsDraft.value });
  roomServers.value = await api('/rooms');
});
const stopRoomServers = () => action(async () => {
  if (!window.confirm('Zatrzymać pokoje treningowe?')) return;
  await api('/rooms/stop', { method: 'POST' });
  for (let i = 0; i < 20 && roomServers.value.running.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    roomServers.value = await api('/rooms');
  }
});
const copyKey = async () => {
  await navigator.clipboard.writeText(newKey.value.key);
  copied.value = true;
};

const run = computed(() => runs.value.find((r) => r.id === runId.value));
const hasCheckpoints = computed(() => models.value.some((m) => m.run === run.value?.name));
const templates = computed(() => runs.value.filter((r) => r.config));
const activeKeys = computed(() => keys.value.filter((k) => !k.revoked_at));
const templateValues = (id) => {
  const from = runs.value.find((r) => r.id === id);
  return { ...from?.config, ...from?.config_pending };
};
const startRun = () => action(async () => {
  keys.value = await api('/keys');
  const from = run.value?.config ? run.value : templates.value[0];
  const keyId = activeKeys.value.some((k) => k.id === run.value?.key_id) ? run.value.key_id : activeKeys.value[0]?.id;
  newRun.value = { name: '', keyId, from: from?.id, values: templateValues(from?.id) };
});
const createRun = () => action(async () => {
  const { name, keyId, values } = newRun.value;
  const bad = Object.keys(values).find((n) => !Number.isFinite(values[n]));
  if (bad) throw new Error(`${bad}: wpisz liczbę.`);
  const { id } = await api('/runs', { method: 'POST', body: { name: name.trim(), key_id: keyId, values } });
  newRun.value = null;
  runId.value = id;
  await loadRuns();
});
const roomsOf = (trainer) => trainer.rooms ?? [{ ports: trainer.ports, sessions: trainer.sessions }];
const resetDraft = () => { draft.value = { ...run.value?.config, ...run.value?.config_pending }; };
watch(() => JSON.stringify([run.value?.id, run.value?.config, run.value?.config_pending]), resetDraft, { immediate: true });
watch(() => run.value?.id, () => {
  startModel.value = '';
  startRooms.value = run.value?.trainer
    ? roomsOf(run.value.trainer).map((room) => ({ ...room }))
    : [{ ports: '3031-3040', sessions: 1 }, { ports: '3041-3050', sessions: 10 }];
}, { immediate: true });
const startTrainer = () => action(async () => {
  const [modelRun, file] = startModel.value.split(/\/(?=[^/]+$)/);
  const body = {
    rooms: startRooms.value.map((room) => ({ ports: room.ports.trim(), sessions: room.sessions })),
    ...(startModel.value && { model: { run: modelRun, file } }),
  };
  stopping.value = null;
  run.value.trainer = (await api(`/runs/${run.value.id}/start`, { method: 'POST', body })).trainer;
});
const stopTrainer = () => action(async () => {
  if (!window.confirm(`Zatrzymać trening „${run.value.name}”? Trener zapisze checkpoint jak po Ctrl+C.`)) return;
  await api(`/runs/${run.value.id}/stop`, { method: 'POST' });
  stopping.value = run.value.id;
});
const baseline = computed(() => run.value?.config ?? run.value?.config_pending ?? {});
const parameterNames = computed(() => Object.keys(baseline.value).sort());
const isChanged = (name) => draft.value[name] !== baseline.value[name];
async function putConfig(values) {
  run.value.config_pending = (await api(`/runs/${run.value.id}/config`, { method: 'PUT', body: { values } })).config_pending;
  resetDraft();
}
const saveConfig = () => action(async () => {
  const values = Object.fromEntries(parameterNames.value.filter(isChanged).map((name) => [name, draft.value[name]]));
  const bad = Object.keys(values).find((name) => !Number.isFinite(values[name]));
  if (bad) throw new Error(`${bad}: wpisz liczbę.`);
  await putConfig(values);
});
const discardConfig = () => action(() => putConfig({}));

async function loadLogs() {
  const id = runId.value;
  const after = logs.value.at(-1)?.id;
  const added = await api(`/runs/${id}/logs${after ? `?after=${after}` : ''}`);
  if (id !== runId.value || !added.length) return;
  const box = logBox.value;
  const following = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  logs.value = [...logs.value, ...added].slice(-LOG_LINES);
  if (following) nextTick(() => { if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight; });
}
const toggleLogs = (event) => {
  logsOpen.value = event.target.open;
  if (logsOpen.value) action(loadLogs);
};
watch(runId, () => { logs.value = []; if (logsOpen.value) action(loadLogs); });
const logTime = (at) => new Date(at).toLocaleTimeString('pl-PL');
const liveRun = computed(() => live.value.runs.find((r) => r.runId === runId.value));
const isLive = (id) => live.value.runs.some((r) => r.runId === id);
const serverUrl = (port) => `${location.protocol}//${location.hostname}:${port}`;
const shortId = (agent) => agent.id?.slice(0, 6) ?? '—';
const previewUrl = (agent) => `${serverUrl(agent.room)}/?follow=${encodeURIComponent(agent.id)}`;

const liveAgents = computed(() => (liveRun.value?.agents ?? []).map((agent, index) => ({
  ...agent,
  key: agent.id ?? `${agent.room}:${index}`,
})));
const agentOrder = ref([]);

function orderAgents() {
  const { key, desc } = agentSort.value;
  const direction = desc ? -1 : 1;
  agentOrder.value = [...liveAgents.value]
    .sort((a, b) => (a[key] > b[key] ? direction : a[key] < b[key] ? -direction : 0))
    .map((agent) => agent.key);
}
watch(liveAgents, () => { if (!preview.value) orderAgents(); }, { immediate: true });

const sortedAgents = computed(() => {
  const byKey = new Map(liveAgents.value.map((agent) => [agent.key, agent]));
  const ordered = agentOrder.value.filter((key) => byKey.has(key));
  const added = [...byKey.keys()].filter((key) => !agentOrder.value.includes(key));
  return [...ordered, ...added].map((key) => byKey.get(key));
});
const pageCount = computed(() => Math.max(1, Math.ceil(sortedAgents.value.length / PAGE_SIZE)));
const pageAgents = computed(() => sortedAgents.value.slice(page.value * PAGE_SIZE, (page.value + 1) * PAGE_SIZE));
watch(pageCount, (count) => { page.value = Math.min(page.value, count - 1); });
watch(runId, () => { page.value = 0; preview.value = null; });

function sortAgents(key) {
  const { key: current, desc } = agentSort.value;
  agentSort.value = { key, desc: key === current ? !desc : ['alive', 'score', 'ticks'].includes(key) };
  page.value = 0;
  orderAgents();
}
function togglePreview(agent) {
  preview.value = preview.value === agent.key ? null : agent.key;
  if (!preview.value) orderAgents();
}
const closePreview = (event) => { if (event.key === 'Escape' && preview.value) togglePreview({ key: preview.value }); };
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
  grid: { left: 4, right: 12, top: series.length > 1 ? 34 : 12, bottom: 4 },
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
// Rooms on older code record no starts, so a silence of several windows also counts as a break.
const breaks = computed(() => {
  const windowMs = live.value.flushMinutes * 60_000;
  const times = rows.value.map((r) => new Date(r.recorded_at).getTime());
  const gaps = times.slice(1).map((to, i) => ({ from: times[i], to })).filter(({ from, to }) => to - from > 3 * windowMs)
    .map(({ from, to }) => ({ from, to, label: `przerwa ${pause(to - from)}` }));
  const starts = (run.value?.starts ?? []).map((at) => new Date(at).getTime())
    .filter((at) => at > times[0] && !gaps.some(({ from, to }) => at >= from && at <= to));
  const clusters = [];
  for (const at of starts) {
    if (clusters.length && at - clusters.at(-1).at(-1) <= 3 * windowMs) clusters.at(-1).push(at);
    else clusters.push([at]);
  }
  const restarts = clusters.flatMap((cluster) => cluster.map((at, i) => ({
    from: at, to: at, label: i ? null : cluster.length > 1 ? `restart ×${cluster.length}` : 'restart',
  })));
  return [...gaps, ...restarts];
});
const pause = (ms) => {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};
const episodeTotals = computed(() => {
  let total = 0;
  return progress.value.map((r) => [new Date(r.recorded_at).getTime(), total += r.episodes]);
});
const episodesAt = (at) => episodeTotals.value.findLast(([time]) => time <= at)?.[1] ?? 0;
const valueAxis = (option, xLabel, yFormat) => {
  option.xAxis = { ...option.xAxis, type: 'value', axisLabel: { ...option.xAxis.axisLabel, formatter: xLabel } };
  option.tooltip = {
    ...option.tooltip,
    axisPointer: { ...option.tooltip.axisPointer, label: { show: false } },
    formatter: (params) => [
      xLabel(params[0].axisValue),
      ...params.map((p) => `${p.marker} ${p.seriesName} <b>${yFormat(p.value[1])}</b>`),
    ].join('<br>'),
  };
  return option;
};
const timeChart = (series, yFormat = (v) => number(v)) => {
  const byEpisodes = runAxis.value === 'episodes';
  const x = (at) => (byEpisodes ? episodesAt(new Date(at).getTime()) : new Date(at).getTime());
  const option = chart(series.map((s) => ({
    ...s,
    data: [
      ...breaks.value.map(({ from, to }) => [byEpisodes ? episodesAt(from) + 0.5 : (from + to) / 2, null]),
      ...s.data.map(([at, value]) => [x(at), value]),
    ].sort(([a], [b]) => a - b),
  })), yFormat);
  const edge = { color: INK.muted, type: 'dashed', width: 1 };
  if (byEpisodes) {
    option.series[0].markLine = {
      silent: true,
      symbol: 'none',
      lineStyle: edge,
      label: { formatter: '{b}', position: 'insideEndTop', color: INK.muted, fontSize: 11 },
      data: breaks.value.map(({ from, label }) => ({ xAxis: episodesAt(from) + 0.5, name: label ?? '' })),
    };
    return valueAxis(option, (v) => `${number(v)} epizodów`, yFormat);
  }
  option.series[0].markArea = {
    silent: true,
    itemStyle: { color: INK.pause },
    label: { position: 'insideTop', color: INK.muted, fontSize: 11, distance: 6 },
    data: breaks.value.filter(({ from, to }) => to > from).map(({ from, to, label }) => [{ xAxis: from, name: label }, { xAxis: to }]),
  };
  option.series[0].markLine = {
    silent: true,
    symbol: 'none',
    lineStyle: edge,
    label: { show: false },
    data: breaks.value.flatMap(({ from, to, label }) => {
      if (to > from) return [{ xAxis: from }, { xAxis: to }];
      return [label ? { xAxis: from, label: { show: true, formatter: label, color: INK.muted, fontSize: 11 } } : { xAxis: from }];
    }),
  };
  return option;
};

const scoreChart = computed(() => timeChart([
  line('Średni wynik', SERIES[0], rows.value.map((r) => [r.recorded_at, r.score_avg])),
  line('Najlepszy wynik', SERIES[1], rows.value.map((r) => [r.recorded_at, r.score_max])),
]));
const survivalChart = computed(() => timeChart(
  [line('Średni czas życia', SERIES[0], rows.value.map((r) => [r.recorded_at, seconds(r.ticks_avg)]))],
  (v) => `${number(v)} s`,
));
const deathChart = computed(() => {
  const counted = progress.value.filter((r) => Object.keys(r.deaths).length);
  const option = chart(DEATHS
    .map(([cause, label, color]) => ({
      name: label,
      type: 'bar',
      stack: 'deaths',
      barMaxWidth: 24,
      data: counted.map((r) => r.deaths[cause] || 0),
      itemStyle: { color, borderColor: INK.surface, borderWidth: 1 },
    }))
    .filter((series) => series.data.some((count) => count > 0)));
  option.xAxis = {
    ...option.xAxis,
    type: 'category',
    data: counted.map((r) => new Date(r.recorded_at).toLocaleTimeString('pl-PL', { timeStyle: 'short' })),
  };
  return option;
});
const metricCharts = computed(() => metricNames.value.map((name) => ({
  name,
  option: timeChart([line(name, SERIES[0], progress.value
    .filter((r) => r.metrics[name] != null)
    .map((r) => [r.recorded_at, r.metrics[name]]))]),
})));

const compareRuns = computed(() => compareIds.value
  .map((id) => runs.value.find((r) => r.id === id))
  .filter((r) => r && compareData.value[r.id]));

const niceStep = (range) => {
  const raw = Math.max(1, range / 60);
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * power).find((step) => step >= raw);
};
const compareStep = computed(() => (compareAxis.value === 'time'
  ? live.value.flushMinutes
  : niceStep(Math.max(0, ...compareRuns.value.map((r) => compareData.value[r.id].reduce((sum, row) => sum + row.episodes, 0))))));

function comparePoints(r, value) {
  const start = new Date(r.created_at).getTime();
  const step = compareStep.value;
  const points = new Map();
  let episodes = 0;
  for (const row of compareData.value[r.id]) {
    episodes += row.episodes;
    const y = value(row);
    if (y == null) continue;
    const x = compareAxis.value === 'time' ? (new Date(row.recorded_at).getTime() - start) / 60000 : episodes;
    points.set(Math.round(x / step) * step, y);
  }
  return [...points];
}

function compareChart(value, yFormat = (v) => number(v)) {
  const option = chart(compareRuns.value.map((r) => line(r.name, compareColors.value[r.id], comparePoints(r, value))), yFormat);
  const xLabel = compareAxis.value === 'time' ? (v) => `${number(v)} min` : (v) => `${number(v)} epizodów`;
  return valueAxis(option, xLabel, yFormat);
}

const compareCharts = computed(() => {
  const metrics = [...new Set(compareRuns.value.flatMap((r) => compareData.value[r.id].flatMap((row) => Object.keys(row.metrics))))].sort();
  return [
    { name: 'Średni wynik', option: compareChart((row) => (row.episodes ? row.score_avg : null)) },
    { name: 'Czas życia', option: compareChart((row) => (row.episodes ? seconds(row.ticks_avg) : null), (v) => `${number(v)} s`) },
    { name: 'Najlepszy wynik w oknie', option: compareChart((row) => (row.episodes ? row.score_max : null)) },
    { name: 'Zjedzone punkty', option: compareChart((row) => (row.episodes ? row.eaten_avg : null)) },
    ...metrics.map((name) => ({ name, trainer: true, option: compareChart((row) => row.metrics[name] ?? null) })),
  ];
});

const compareSummary = computed(() => compareRuns.value.map((r) => {
  const rowsWithEpisodes = compareData.value[r.id].filter((row) => row.episodes > 0);
  const recent = rowsWithEpisodes.slice(-3);
  const recentEpisodes = recent.reduce((sum, row) => sum + row.episodes, 0);
  const recentAverage = (field) => (recentEpisodes
    ? recent.reduce((sum, row) => sum + row[field] * row.episodes, 0) / recentEpisodes
    : null);
  const last = compareData.value[r.id].at(-1);
  return {
    ...r,
    color: compareColors.value[r.id],
    minutes: last ? (new Date(last.recorded_at) - new Date(r.created_at)) / 60000 : 0,
    recentScore: recentAverage('score_avg'),
    recentSurvival: recentAverage('ticks_avg'),
  };
}));

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
      [live.value, runs.value] = await Promise.all([api('/live'), api('/runs')]);
      if (logsOpen.value && runId.value) await loadLogs();
    } catch (e) {
      error.value = e.message;
    }
  }, 2000);
});
onMounted(() => window.addEventListener('keydown', closePreview));
onUnmounted(() => {
  clearInterval(timer);
  window.removeEventListener('keydown', closePreview);
});
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
        <button :class="{ active: view === 'compare' }" @click="action(() => open('compare'))">Porównanie</button>
        <button :class="{ active: view === 'rooms' }" @click="action(() => open('rooms'))">Pokoje</button>
        <button :class="{ active: view === 'keys' }" @click="action(() => open('keys'))">Klucze</button>
      </nav>
      <button class="ghost" @click="logout">Wyloguj</button>
    </header>

    <main class="content">
      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <section v-if="view === 'compare'" class="compare">
        <article class="card">
          <h2>Runy do porównania <span class="muted">· do {{ SERIES.length }}</span></h2>
          <div class="compare-picker">
            <label v-for="r in runs" :key="r.id" class="pick" :class="{ picked: compareIds.includes(r.id) }">
              <input
                type="checkbox"
                :checked="compareIds.includes(r.id)"
                :disabled="busy || (!compareIds.includes(r.id) && compareIds.length >= SERIES.length)"
                @change="toggleCompare(r.id)"
              />
              <span class="swatch" :style="{ background: compareColors[r.id] || 'transparent' }"></span>
              {{ r.name }}
            </label>
          </div>
          <div class="segmented" role="group" aria-label="Oś pozioma">
            <button :class="{ active: compareAxis === 'time' }" @click="compareAxis = 'time'">Minuty od startu</button>
            <button :class="{ active: compareAxis === 'episodes' }" @click="compareAxis = 'episodes'">Łączne epizody</button>
          </div>
        </article>

        <article v-if="compareSummary.length" class="card">
          <div class="table-scroll">
            <table>
              <thead>
                <tr><th>Run</th><th>Trenuje</th><th>Epizody</th><th>Rekord</th><th>Śr. wynik (ost. {{ number(live.flushMinutes * 3) }} min)</th><th>Czas życia (ost. {{ number(live.flushMinutes * 3) }} min)</th></tr>
              </thead>
              <tbody>
                <tr v-for="r in compareSummary" :key="r.id">
                  <td><span class="swatch" :style="{ background: r.color }"></span> {{ r.name }}</td>
                  <td>{{ number(r.minutes) }} min</td>
                  <td>{{ number(r.episodes) }}</td>
                  <td>{{ number(r.best_score) }}</td>
                  <td>{{ number(r.recentScore) }}</td>
                  <td>{{ r.recentSurvival == null ? '—' : `${number(seconds(r.recentSurvival))} s` }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>

        <p v-if="!compareRuns.length" class="muted">Zaznacz co najmniej jeden run.</p>
        <div v-else class="charts">
          <article v-for="item in compareCharts" :key="item.name" class="card">
            <h2>{{ item.name }} <span v-if="item.trainer" class="muted">trener</span></h2>
            <v-chart class="chart" :option="item.option" autoresize />
          </article>
        </div>
      </section>

      <section v-if="view === 'runs'" class="runs">
        <aside class="run-list">
          <button class="new-run" :class="{ selected: newRun }" :disabled="busy" @click="startRun">+ Nowy run</button>
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

        <form v-if="newRun" class="run" @submit.prevent="createRun">
          <div class="run-head">
            <h1>Nowy run</h1>
            <p class="muted">Panel zakłada run i jego parametry. Trening startuje dopiero, gdy uruchomisz trenera z tą nazwą.</p>
          </div>
          <article class="card new-run-form">
            <label>Nazwa
              <input v-model="newRun.name" maxlength="40" pattern="\w[\w .:\-]*" placeholder="np. slither-v6" required autofocus>
            </label>
            <label>Klucz trenera
              <select v-model="newRun.keyId" required>
                <option v-for="key in activeKeys" :key="key.id" :value="key.id">{{ key.name }}</option>
              </select>
            </label>
            <label v-if="templates.length">Parametry z runu
              <select v-model="newRun.from" @change="newRun.values = templateValues(newRun.from)">
                <option v-for="r in templates" :key="r.id" :value="r.id">{{ r.name }}</option>
              </select>
            </label>
          </article>
          <article class="card params">
            <h2>Parametry</h2>
            <p v-if="!templates.length" class="muted">Żaden run nie zgłosił jeszcze parametrów, więc trener wystartuje z domyślnymi z kodu.</p>
            <div v-else class="table-scroll">
              <table>
                <thead><tr><th>Parametr</th><th>Wartość</th></tr></thead>
                <tbody>
                  <tr v-for="name in Object.keys(newRun.values).sort()" :key="name">
                    <td><label :for="`new-${name}`"><code>{{ name }}</code></label></td>
                    <td><input :id="`new-${name}`" v-model.number="newRun.values[name]" type="number" step="any" required></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="params-actions">
              <button class="primary" :disabled="busy || !activeKeys.length">Utwórz run</button>
              <button type="button" class="ghost" @click="newRun = null">Anuluj</button>
            </div>
            <p v-if="!activeKeys.length" class="muted">Brak aktywnego klucza. Utwórz go w zakładce Klucze.</p>
          </article>
        </form>

        <div v-else-if="run" class="run">
          <div class="run-head">
            <h1>{{ run.name }}</h1>
            <p class="muted">Klucz {{ run.key_name }} · ostatnio {{ date(run.last_seen_at) }}</p>
            <p v-if="!run.config && run.config_pending" class="muted">
              Czeka na pierwszy start: <code>python py/ppo_agent.py --run {{ run.name }}</code> z kluczem {{ run.key_name }}.
            </p>
          </div>

          <article class="card trainer">
            <template v-if="run.trainer?.running">
              <span class="state">
                <span class="dot" :class="{ on: isLive(run.id) }"></span>
                {{ stopping === run.id ? 'Zatrzymuje się, zapisuje checkpoint…' : isLive(run.id) ? 'Trenuje' : 'Startuje…' }}
                <span class="muted">· {{ roomsOf(run.trainer).map((room) => `${room.ports}: ${room.sessions} sesji na pokój`).join(' · ') }}</span>
              </span>
              <button class="ghost" :disabled="busy || stopping === run.id" @click="stopTrainer">Stop</button>
            </template>
            <p v-else-if="isLive(run.id)" class="state">
              <span class="dot on"></span> Trenuje z terminala <span class="muted">· zatrzymasz go Ctrl+C w tamtym terminalu</span>
            </p>
            <form v-else class="trainer-form" @submit.prevent="startTrainer">
              <div v-for="(room, index) in startRooms" :key="index" class="room-group">
                <label>Porty
                  <input v-model="room.ports" placeholder="3031-3040" required>
                </label>
                <label>Sesje na pokój
                  <input v-model.number="room.sessions" type="number" min="1" max="32" step="1" required>
                </label>
                <button v-if="startRooms.length > 1" type="button" class="ghost" @click="startRooms.splice(index, 1)">Usuń</button>
              </div>
              <label v-if="models.length" class="model-pick">Model początkowy
                <select v-model="startModel">
                  <option value="">{{ hasCheckpoints ? 'Ostatni checkpoint tego runu' : 'Nowy model' }}</option>
                  <optgroup v-for="m in models" :key="m.run" :label="m.run">
                    <option v-for="file in m.files" :key="file" :value="`${m.run}/${file}`">{{ m.run }} · {{ file.replace('.pt', '') }}</option>
                  </optgroup>
                </select>
              </label>
              <button type="button" class="ghost" @click="startRooms.push({ ports: '', sessions: 1 })">+ grupa</button>
              <button class="primary" :disabled="busy">Start</button>
              <p class="muted">
                Uruchamia <code>python py/ppo_agent.py --run {{ run.name }}{{ startModel && ` --model py/checkpoints/${startModel}` }}</code> na tej maszynie z parametrami poniżej.
                <template v-if="startModel && hasCheckpoints">Wagi i licznik update'ów z wybranego checkpointu zastąpią postęp tego runu przy następnym zapisie.</template>
                Wyjście trenera, także błędy sprzed połączenia: <code>apps/lab/py/checkpoints/{{ run.name }}/trainer.log</code>.
              </p>
            </form>
          </article>

          <div class="tiles">
            <article v-for="tile in tiles" :key="tile.label" class="card tile">
              <span>{{ tile.label }}</span>
              <strong>{{ tile.value }}</strong>
            </article>
          </div>

          <article v-if="liveRun" class="card">
            <h2>Na żywo</h2>
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th v-for="column in AGENT_COLUMNS" :key="column.key"
                        :aria-sort="agentSort.key === column.key ? (agentSort.desc ? 'descending' : 'ascending') : 'none'">
                      <button class="sort" @click="sortAgents(column.key)">
                        {{ column.label }}<span v-if="agentSort.key === column.key">{{ agentSort.desc ? ' ↓' : ' ↑' }}</span>
                      </button>
                    </th>
                    <th><span class="sr-only">Podgląd</span></th>
                  </tr>
                </thead>
                <tbody>
                  <template v-for="agent in pageAgents" :key="agent.key">
                  <tr :class="{ previewing: preview === agent.key }">
                    <td><code>{{ shortId(agent) }}</code></td>
                    <td><a :href="serverUrl(agent.room)" target="_blank" rel="noopener">{{ serverUrl(agent.room) }}</a></td>
                    <td>{{ agent.alive ? 'Żyje' : 'Czeka na respawn' }}</td>
                    <td>{{ number(agent.score) }}</td>
                    <td>{{ number(seconds(agent.ticks)) }} s</td>
                    <td>
                      <button class="ghost small" :disabled="!agent.id" :aria-expanded="preview === agent.key" @click="togglePreview(agent)">
                        {{ preview === agent.key ? 'Zwiń' : 'Podgląd' }}
                      </button>
                    </td>
                  </tr>
                  <tr v-if="preview === agent.key" class="preview-row">
                    <td :colspan="AGENT_COLUMNS.length + 1">
                      <iframe :src="previewUrl(agent)" :title="`Podgląd agenta ${shortId(agent)}`"></iframe>
                      <p class="muted">
                        Widok agenta: tylko to, co jest w jego mgle. Kolejność tabeli stoi, dopóki podgląd jest otwarty.
                        <a :href="previewUrl(agent)" target="_blank" rel="noopener">Otwórz w nowej karcie</a>
                      </p>
                    </td>
                  </tr>
                  </template>
                </tbody>
              </table>
            </div>
            <div v-if="pageCount > 1" class="pager">
              <button class="ghost" :disabled="page === 0" @click="page--">‹ Poprzednia</button>
              <span class="muted">Strona {{ page + 1 }} z {{ pageCount }} · {{ number(sortedAgents.length) }} agentów</span>
              <button class="ghost" :disabled="page >= pageCount - 1" @click="page++">Następna ›</button>
            </div>
            <p class="muted">
              Bieżące okno: {{ number(liveRun.pending?.episodes ?? 0) }} epizodów, zapis co {{ number(live.flushMinutes) }} min.
            </p>
          </article>
          <details class="card params" :open="!!run.config_pending">
            <summary>
              Parametry
              <span v-if="run.config_pending" class="pending">{{ run.config ? `${Object.keys(run.config_pending).length} czeka na restart trenera` : 'czeka na pierwszy start' }}</span>
            </summary>
            <p v-if="!parameterNames.length" class="muted">
              Ten run nie zgłosił parametrów: trenuje go starszy trener albo trener JS.
            </p>
            <form v-else @submit.prevent="saveConfig">
              <p class="muted">
                Zmiany wchodzą przy następnym starcie trenera (Ctrl+C i uruchom ponownie) i trafiają do
                <code>checkpoints/{{ run.name }}/config.json</code>. Flaga w CLI wygrywa z panelem.
              </p>
              <div class="table-scroll">
                <table>
                  <thead><tr><th>Parametr</th><th>Teraz</th><th>Przy następnym starcie</th></tr></thead>
                  <tbody>
                    <tr v-for="name in parameterNames" :key="name" :class="{ changed: isChanged(name) }">
                      <td><label :for="`param-${name}`"><code>{{ name }}</code></label></td>
                      <td>{{ run.config?.[name] ?? '—' }}</td>
                      <td><input :id="`param-${name}`" v-model.number="draft[name]" type="number" step="any" required></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="params-actions">
                <button class="primary" :disabled="busy">Zapisz zmiany</button>
                <button v-if="run.config && run.config_pending" type="button" class="ghost" :disabled="busy" @click="discardConfig">Odrzuć oczekujące</button>
              </div>
            </form>
          </details>

          <details class="card logs" :open="logsOpen" @toggle="toggleLogs">
            <summary>Logi trenera <span class="muted">· ostatnie {{ number(LOG_LINES) }} linii</span></summary>
            <pre v-if="logs.length" ref="logBox"><template v-for="entry in logs" :key="entry.id"><span class="muted">{{ logTime(entry.at) }}</span> {{ entry.line }}
</template></pre>
            <p v-else class="muted">Brak logów. Trener w Pythonie wysyła tu wszystko, co wypisuje w terminalu.</p>
          </details>

          <p v-if="!progress.length" class="muted">Brak zapisanego postępu. Pierwszy zapis po upływie okna albo po rozłączeniu trenera.</p>

          <div v-if="progress.length" class="segmented" role="group" aria-label="Oś pozioma">
            <button :class="{ active: runAxis === 'time' }" @click="runAxis = 'time'">Czas</button>
            <button :class="{ active: runAxis === 'episodes' }" @click="runAxis = 'episodes'">Łączne epizody</button>
          </div>

          <div v-if="progress.length" class="charts">
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

      <section v-else-if="view === 'rooms'" class="rooms">
        <h1>Pokoje treningowe</h1>
        <p class="muted">Osobne serwery gry dla trenerów, od portu {{ roomServers.firstPort }}. Timescale przyspiesza grę: mechanika i boty liczą czas w tickach, więc agenci grają w tę samą grę, tylko szybciej.</p>

        <article v-for="r in roomServers.running" :key="r.pid" class="card key-row">
          <span>
            {{ r.count }} pokoi · porty {{ roomServers.firstPort }}–{{ roomServers.firstPort + r.count - 1 }} ·
            timescale {{ r.timescale ? `${number(r.timescale)}×` : 'z TIMESCALE (domyślnie 1×)' }}
            <span class="muted">· PID {{ r.pid }}</span>
          </span>
          <button class="ghost" :disabled="busy" @click="stopRoomServers">Stop</button>
        </article>

        <form v-if="!roomServers.running.length" class="card key-form" @submit.prevent="startRoomServers">
          <label>Liczba pokoi
            <input v-model.number="roomsDraft.count" type="number" min="1" max="40" step="1" required>
          </label>
          <label>Timescale
            <input v-model.number="roomsDraft.timescale" type="number" min="0.25" max="4" step="0.25" required>
          </label>
          <button class="primary" :disabled="busy">Start</button>
        </form>
        <p class="muted">Stop działa jak Ctrl+C, także dla pokoi uruchomionych z terminala. Najpierw zatrzymaj trenujące runy, bo straciłyby połączenie. Wyższy timescale pomaga, dopóki starcza CPU.</p>
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
