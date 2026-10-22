<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { connect, use } from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { CanvasRenderer } from 'echarts/renderers';
import {
  AriaComponent, DataZoomComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent,
} from 'echarts/components';
import VChart from 'vue-echarts';
import { mergeWindows } from '../lab/progress.js';

use([LineChart, CanvasRenderer, GridComponent, TooltipComponent, LegendComponent, AriaComponent, MarkAreaComponent, MarkLineComponent, DataZoomComponent]);
connect('run');

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
const VIEW_MS = 10 * 3600_000;
const AGENT_COLUMNS = [
  { key: 'id', label: 'Agent' },
  { key: 'world', label: 'Świat' },
  { key: 'alive', label: 'Stan' },
  { key: 'score', label: 'Wynik' },
  { key: 'ticks', label: 'Czas życia' },
];
const PARAMETERS = [
  ['TIMESCALE', 'Tempo gry'],
  ['POINTS_AMOUNT', 'Jedzenie'],
  ['FOG_RADIUS_MIN', 'Widok min'],
  ['FOG_RADIUS_MAX', 'Widok max'],
  ['NORMAL_SPEED', 'Prędkość'],
  ['BOOST_SPEED', 'Prędkość boost'],
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
const runWindow = ref(30);
const runFollow = ref(true);
let runRange = null;
const agentSort = ref({ key: 'score', desc: true });
const page = ref(0);
const draft = ref({});
const logsOpen = ref(false);
const logs = ref([]);
const logBox = ref(null);
const newRun = ref(null);
const startGroups = ref([]);
const preview = ref(null);
const models = ref([]);
const groupData = ref({ limits: {}, defaults: {}, groups: [] });
const groupDrafts = ref({});
const newGroup = ref(null);
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
  [runs.value, live.value, models.value, groupData.value] = await Promise.all([api('/runs'), api('/live'), api('/models'), api('/groups')]);
  if (!runId.value && runs.value.length) runId.value = runs.value[0].id;
  if (runId.value) progress.value = await api(`/runs/${runId.value}/progress`);
}

async function open(target) {
  view.value = target;
  if (target === 'runs') await loadRuns();
  else if (target === 'compare') await loadCompare();
  else if (target === 'groups') [groupData.value, models.value] = await Promise.all([api('/groups'), api('/models')]);
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
const savedGroup = (group) => JSON.stringify([group.config, group.sessions, group.opponents]);
const lineupOf = (group) => (group.opponents.length ? group.opponents : group.sessions.map(() => [{ model: null, count: group.config.BOTS }]));
const draftOf = (group) => ({
  saved: savedGroup(group),
  config: { ...group.config },
  sessions: [...group.sessions],
  opponents: lineupOf(group).map((rows) => rows.map((row) => ({ ...row }))),
});
watch(() => groupData.value.groups, (groups) => {
  for (const group of groups) {
    if (groupDrafts.value[group.id]?.saved === savedGroup(group)) continue;
    groupDrafts.value[group.id] = draftOf(group);
  }
});
const groupCards = computed(() => [
  ...groupData.value.groups.map((group) => ({ group, draft: groupDrafts.value[group.id] })),
  ...(newGroup.value ? [{ group: null, draft: newGroup.value }] : []),
].filter((card) => card.draft));
const changedParameters = (card) => PARAMETERS.map(([name]) => name).filter((name) => card.draft.config[name] !== card.group.config[name]);
const processesChanged = (card) => JSON.stringify([card.draft.sessions, card.draft.opponents])
  !== JSON.stringify([card.group.sessions, lineupOf(card.group)]);
const groupChanged = (card) => changedParameters(card).length > 0 || processesChanged(card);
const groupAction = (work) => action(async () => {
  await work();
  groupData.value = await api('/groups');
});
const startNewGroup = () => {
  const names = groupData.value.groups.map((group) => group.name);
  let next = groupData.value.groups.length + 1;
  while (names.includes(String(next))) next++;
  const { defaults } = groupData.value;
  newGroup.value = { name: String(next), config: { ...defaults }, sessions: [1], opponents: [[{ model: null, count: defaults.BOTS }]] };
};
const createGroup = () => groupAction(async () => {
  await api('/groups', { method: 'POST', body: newGroup.value });
  newGroup.value = null;
});
const saveGroup = (card) => groupAction(async () => {
  const config = Object.fromEntries(changedParameters(card).map((name) => [name, card.draft.config[name]]));
  const body = {
    ...(Object.keys(config).length && { config }),
    ...(processesChanged(card) && { sessions: card.draft.sessions, opponents: card.draft.opponents }),
  };
  await api(`/groups/${card.group.id}`, { method: 'PATCH', body });
});
const resetGroup = (card) => {
  groupDrafts.value[card.group.id] = draftOf(card.group);
};
const addProcess = (draft) => {
  draft.sessions.push(draft.sessions.at(-1));
  draft.opponents.push(draft.opponents.at(-1).map((row) => ({ ...row })));
};
const removeProcess = (draft) => {
  draft.sessions.pop();
  draft.opponents.pop();
};
const modelLabel = (model) => model.replace('/', ' · ').replace(/\.pt$/, '');
const lineupLabel = (rows) => rows.map((row) => (row.model ? `${modelLabel(row.model)} × ${row.count}` : `boty × ${row.count}`)).join(' · ') || 'brak';
const playersIn = (group, index) => group.sessions[index] + lineupOf(group)[index].reduce((sum, row) => sum + (row.model ? row.count : 0), 0);
const startGroup = (group) => groupAction(() => api(`/groups/${group.id}/start`, { method: 'POST' }));
const stopGroup = (group) => groupAction(async () => {
  if (!window.confirm(`Zatrzymać grupę „${group.name}”?`)) return;
  await api(`/groups/${group.id}/stop`, { method: 'POST' });
});
const deleteGroup = (group) => groupAction(async () => {
  if (!window.confirm(`Usunąć grupę „${group.name}”?`)) return;
  await api(`/groups/${group.id}`, { method: 'DELETE' });
});
const groupSummary = (group) => `światy: ${group.sessions.length} · sesje: ${group.sessions.reduce((sum, count) => sum + count, 0)}`;
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
const resetDraft = () => { draft.value = { ...run.value?.config, ...run.value?.config_pending }; };
watch(() => JSON.stringify([run.value?.id, run.value?.config, run.value?.config_pending]), resetDraft, { immediate: true });
watch(() => run.value?.id, () => {
  startModel.value = '';
  startGroups.value = [...(run.value?.trainer?.groups ?? [])];
}, { immediate: true });
const startTrainer = () => action(async () => {
  const [modelRun, file] = startModel.value.split(/\/(?=[^/]+$)/);
  const body = {
    groups: startGroups.value,
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
const shortId = (agent) => agent.id.slice(0, 6);

const agentOrder = ref([]);

function orderAgents() {
  const { key, desc } = agentSort.value;
  const direction = desc ? -1 : 1;
  agentOrder.value = [...(liveRun.value?.agents ?? [])]
    .sort((a, b) => (a[key] > b[key] ? direction : a[key] < b[key] ? -direction : 0))
    .map((agent) => agent.id);
}
watch(() => liveRun.value?.agents, () => { if (!preview.value) orderAgents(); }, { immediate: true });

const sortedAgents = computed(() => {
  const byId = new Map((liveRun.value?.agents ?? []).map((agent) => [agent.id, agent]));
  const ordered = agentOrder.value.filter((id) => byId.has(id));
  const added = [...byId.keys()].filter((id) => !agentOrder.value.includes(id));
  return [...ordered, ...added].map((id) => byId.get(id));
});
const pageCount = computed(() => Math.max(1, Math.ceil(sortedAgents.value.length / PAGE_SIZE)));
const pageAgents = computed(() => sortedAgents.value.slice(page.value * PAGE_SIZE, (page.value + 1) * PAGE_SIZE));
watch(pageCount, (count) => { page.value = Math.min(page.value, count - 1); });
watch(runId, () => { page.value = 0; preview.value = null; });
watch([runId, runAxis], () => {
  runFollow.value = true;
  runRange = null;
});

function sortAgents(key) {
  const { key: current, desc } = agentSort.value;
  agentSort.value = { key, desc: key === current ? !desc : ['alive', 'score', 'ticks'].includes(key) };
  page.value = 0;
  orderAgents();
}
function togglePreview(agent) {
  preview.value = preview.value === agent.id ? null : agent.id;
  if (!preview.value) orderAgents();
}
const closePreview = (event) => { if (event.key === 'Escape' && preview.value) togglePreview({ id: preview.value }); };
const windows = computed(() => mergeWindows(progress.value, runWindow.value * 60_000));
const rows = computed(() => windows.value.filter((r) => r.episodes > 0));
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
    axisPointer: { type: 'line', lineStyle: { color: INK.muted } },
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
// Runs trained before trainer starts were recorded have no starts, so a silence of several windows also counts as a break.
const breaks = computed(() => {
  const windowMs = live.value.flushMinutes * 60_000;
  const times = progress.value.filter((r) => r.episodes > 0).map((r) => new Date(r.recorded_at).getTime());
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
const trainedSince = (last, ms) => {
  let need = ms;
  let cursor = last;
  for (const { from, to } of breaks.value.filter((b) => b.to > b.from).sort((a, b) => b.to - a.to)) {
    if (need <= cursor - to) break;
    need -= cursor - to;
    cursor = from;
  }
  return cursor - need;
};
const xRange = computed(() => {
  const first = new Date(progress.value[0].recorded_at).getTime();
  const last = new Date(progress.value.at(-1).recorded_at).getTime();
  if (runAxis.value === 'time') return { min: first, max: last, span: VIEW_MS };
  return { min: episodesAt(first), max: episodesAt(last), span: episodesAt(last) - episodesAt(trainedSince(last, VIEW_MS)) };
});
const runZoom = () => {
  const { min, max, span } = xRange.value;
  const width = runRange ? runRange.end - runRange.start : span;
  const [startValue, endValue] = runFollow.value ? [Math.max(min, max - width), max] : [runRange.start, runRange.end];
  const shared = { xAxisIndex: 0, filterMode: 'none', startValue, endValue };
  return [
    { type: 'inside', ...shared, zoomOnMouseWheel: 'ctrl', moveOnMouseWheel: 'shift' },
    {
      type: 'slider',
      ...shared,
      height: 18,
      bottom: 4,
      showDetail: false,
      brushSelect: false,
      borderColor: INK.border,
      fillerColor: 'rgba(57, 135, 229, 0.15)',
      handleStyle: { color: INK.raised, borderColor: INK.muted },
      moveHandleStyle: { color: INK.axis },
      dataBackground: { lineStyle: { color: INK.axis }, areaStyle: { color: INK.grid } },
      selectedDataBackground: { lineStyle: { color: SERIES[0] }, areaStyle: { color: 'rgba(57, 135, 229, 0.12)' } },
    },
  ];
};
function onRunZoom(event) {
  const { start, end } = event.batch?.[0] ?? event;
  const { min, max } = xRange.value;
  runRange = { start: min + (start / 100) * (max - min), end: min + (end / 100) * (max - min) };
  runFollow.value = end >= 99.9;
}
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
  const option = chart(series.map((s) => {
    const data = [
      ...breaks.value.map(({ from, to }) => [byEpisodes ? episodesAt(from) + 0.5 : (from + to) / 2, null]),
      ...s.data.map(([at, value]) => [x(at), value]),
    ].sort(([a], [b]) => a - b);
    const lone = (i) => data[i - 1]?.[1] == null && data[i + 1]?.[1] == null;
    return { ...s, data, showSymbol: true, symbolSize: (value, { dataIndex }) => (lone(dataIndex) ? 8 : 0) };
  }), yFormat);
  option.xAxis = { ...option.xAxis, min: xRange.value.min, max: xRange.value.max };
  option.grid = { ...option.grid, bottom: 52 };
  option.dataZoom = runZoom();
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

const scoreChart = computed(() => timeChart([line('Średni wynik', SERIES[0], rows.value.map((r) => [r.recorded_at, r.score_avg]))]));
const bestChart = computed(() => timeChart([line('Najlepszy wynik', SERIES[0], rows.value.map((r) => [r.recorded_at, r.score_max]))]));
const survivalChart = computed(() => timeChart(
  [line('Średni czas życia', SERIES[0], rows.value.map((r) => [r.recorded_at, seconds(r.ticks_avg)]))],
  (v) => `${number(v)} s`,
));
const deathChart = computed(() => {
  const counted = windows.value.filter((r) => Object.keys(r.deaths).length);
  const causes = DEATHS.filter(([cause]) => counted.some((r) => r.deaths[cause]));
  return timeChart((causes.length ? causes : DEATHS.slice(0, 1)).map(([cause, label, color]) => ({
    ...line(label, color, counted.map((r) => [r.recorded_at, r.deaths[cause] || 0])),
    stack: 'deaths',
    areaStyle: { color, opacity: 0.85 },
    lineStyle: { width: 1, color: INK.surface },
  })));
});
const metricCharts = computed(() => metricNames.value.map((name) => ({
  name,
  option: timeChart([line(name, SERIES[0], windows.value
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
    if (busy.value || !['runs', 'groups'].includes(view.value)) return;
    try {
      if (view.value === 'groups') {
        groupData.value = await api('/groups');
        return;
      }
      const episodes = run.value?.episodes;
      [live.value, runs.value, groupData.value] = await Promise.all([api('/live'), api('/runs'), api('/groups')]);
      if (run.value && run.value.episodes !== episodes) progress.value = await api(`/runs/${runId.value}/progress`);
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
        <button :class="{ active: view === 'groups' }" @click="action(() => open('groups'))">Grupy</button>
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
              Czeka na pierwszy start: <code>python py/ppo_agent.py --groups &lt;grupy&gt; --run {{ run.name }}</code> z kluczem {{ run.key_name }}.
            </p>
          </div>

          <article class="card trainer">
            <template v-if="run.trainer?.running">
              <span class="state">
                <span class="dot" :class="{ on: isLive(run.id) }"></span>
                {{ stopping === run.id ? 'Zatrzymuje się, zapisuje checkpoint…' : isLive(run.id) ? 'Trenuje' : 'Startuje…' }}
                <span v-if="run.trainer.groups" class="muted">· grupy {{ run.trainer.groups.join(', ') }}</span>
              </span>
              <button class="ghost" :disabled="busy || stopping === run.id" @click="stopTrainer">Stop</button>
            </template>
            <p v-else-if="isLive(run.id)" class="state">
              <span class="dot on"></span> Trenuje z terminala <span class="muted">· zatrzymasz go Ctrl+C w tamtym terminalu</span>
            </p>
            <form v-else class="trainer-form" @submit.prevent="startTrainer">
              <fieldset class="group-pick">
                <legend>Grupy</legend>
                <label v-for="group in groupData.groups" :key="group.id" class="pick" :class="{ picked: startGroups.includes(group.name) }">
                  <input v-model="startGroups" type="checkbox" :value="group.name" :disabled="!group.running">
                  {{ group.name }} <span class="muted">{{ group.running ? groupSummary(group) : 'zatrzymana' }}</span>
                </label>
                <p v-if="!groupData.groups.length" class="muted">Brak grup. Utwórz je w zakładce Grupy.</p>
              </fieldset>
              <label v-if="models.length" class="model-pick">Model początkowy
                <select v-model="startModel">
                  <option value="">{{ hasCheckpoints ? 'Ostatni checkpoint tego runu' : 'Nowy model' }}</option>
                  <optgroup v-for="m in models" :key="m.run" :label="m.run">
                    <option v-for="file in m.files" :key="file" :value="`${m.run}/${file}`">{{ m.run }} · {{ file.replace('.pt', '') }}</option>
                  </optgroup>
                </select>
              </label>
              <button class="primary" :disabled="busy || !startGroups.length">Start</button>
              <p class="muted">
                Uruchamia <code>python py/ppo_agent.py --groups {{ startGroups.join(',') || '…' }} --run {{ run.name }}{{ startModel && ` --model py/checkpoints/${startModel}` }}</code> na tej maszynie z parametrami poniżej.
                Każdy świat grupy dostaje tyle sesji, ile ustawia grupa.
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
                  <template v-for="agent in pageAgents" :key="agent.id">
                  <tr :class="{ previewing: preview === agent.id }">
                    <td><code>{{ shortId(agent) }}</code></td>
                    <td>{{ agent.world }}</td>
                    <td>{{ agent.alive ? 'Żyje' : 'Czeka na respawn' }}</td>
                    <td>{{ number(agent.score) }}</td>
                    <td>{{ number(seconds(agent.ticks)) }} s</td>
                    <td>
                      <button class="ghost small" :disabled="!agent.view" :aria-expanded="preview === agent.id" @click="togglePreview(agent)">
                        {{ preview === agent.id ? 'Zwiń' : 'Podgląd' }}
                      </button>
                    </td>
                  </tr>
                  <tr v-if="preview === agent.id" class="preview-row">
                    <td :colspan="AGENT_COLUMNS.length + 1">
                      <iframe :src="agent.view" :title="`Podgląd agenta ${shortId(agent)}`"></iframe>
                      <p class="muted">
                        Widok agenta: tylko to, co jest w jego mgle. Kolejność tabeli stoi, dopóki podgląd jest otwarty.
                        <a :href="agent.view" target="_blank" rel="noopener">Otwórz w nowej karcie</a>
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

          <div v-if="progress.length" class="chart-controls">
            <div class="segmented" role="group" aria-label="Oś pozioma">
              <button :class="{ active: runAxis === 'time' }" @click="runAxis = 'time'">Czas</button>
              <button :class="{ active: runAxis === 'episodes' }" @click="runAxis = 'episodes'">Łączne epizody</button>
            </div>
            <div class="segmented" role="group" aria-label="Okno uśredniania">
              <button v-for="minutes in [live.flushMinutes, 30, 60]" :key="minutes" :class="{ active: runWindow === minutes }" @click="runWindow = minutes">
                {{ minutes === 60 ? '1 h' : `${minutes} min` }}
              </button>
            </div>
            <div class="zoom-controls">
              <button v-if="!runFollow" class="small" @click="runFollow = true">Najnowsze →</button>
              <span class="muted">Przeciągnij wykres w bok, żeby się cofnąć. Ctrl + kółko albo szczypanie zmienia zakres.</span>
            </div>
          </div>

          <div v-if="progress.length" class="charts">
            <article class="card">
              <h2>Średni wynik</h2>
              <v-chart class="chart" :option="scoreChart" group="run" autoresize @datazoom="onRunZoom" />
            </article>
            <article class="card">
              <h2>Najlepszy wynik w oknie</h2>
              <v-chart class="chart" :option="bestChart" group="run" autoresize @datazoom="onRunZoom" />
            </article>
            <article class="card">
              <h2>Czas życia</h2>
              <v-chart class="chart" :option="survivalChart" group="run" autoresize @datazoom="onRunZoom" />
            </article>
            <article class="card">
              <h2>Przyczyny końca epizodu</h2>
              <v-chart class="chart" :option="deathChart" group="run" autoresize @datazoom="onRunZoom" />
            </article>
            <article v-for="metric in metricCharts" :key="metric.name" class="card">
              <h2>{{ metric.name }} <small class="muted">trener</small></h2>
              <v-chart class="chart" :option="metric.option" group="run" autoresize @datazoom="onRunZoom" />
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
                  <tr v-for="r in windows" :key="r.recorded_at">
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

      <section v-else-if="view === 'groups'" class="groups">
        <h1>Grupy światów</h1>
        <p class="muted">
          Grupa to światy gry z tymi samymi ustawieniami. Każdy świat to osobny proces z własną mapą i botami, więc światy liczą się na osobnych rdzeniach.
          Trener z <code>--groups</code> dostaje adres i token każdego świata oraz liczbę sesji, które ma w nim grać, a po restarcie świata pyta o nowy adres.
          Tempo gry przyspiesza grę: mechanika i boty liczą czas w tickach, więc agenci grają w tę samą grę, tylko szybciej.
          „Otwórz” pokazuje świat w nowej karcie: możesz patrzeć albo dołączyć jako gracz.
          Przeciwnicy w procesie to zwykłe boty albo zapisany model, który gra bez uczenia; jego epizody trafiają do runu <code>&lt;model&gt;-play</code>.
        </p>

        <form v-for="card in groupCards" :key="card.group?.id ?? 'new'" class="card group" @submit.prevent="card.group ? saveGroup(card) : createGroup()">
          <div class="group-head">
            <template v-if="card.group">
              <h2>{{ card.group.name }}</h2>
              <span class="state"><span class="dot" :class="{ on: card.group.running }"></span>{{ card.group.running ? 'Działa' : 'Zatrzymana' }}</span>
              <button v-if="card.group.running" type="button" class="ghost" :disabled="busy" @click="stopGroup(card.group)">Stop</button>
              <template v-else>
                <button type="button" class="primary" :disabled="busy || groupChanged(card)" @click="startGroup(card.group)">Start</button>
                <button type="button" class="ghost" :disabled="busy" @click="deleteGroup(card.group)">Usuń</button>
              </template>
            </template>
            <label v-else class="group-name">Nazwa nowej grupy
              <input v-model="card.draft.name" maxlength="40" pattern="[\w.\-]+" placeholder="np. quiet" required autofocus>
            </label>
          </div>

          <div v-if="card.group?.running" class="table-scroll">
            <table>
              <thead><tr><th>Świat</th><th>Port</th><th>Ticki/s</th><th>Krok</th><th>Agenci</th><th>Przeciwnicy</th><th><span class="sr-only">Podgląd</span></th></tr></thead>
              <tbody>
                <tr v-for="(world, index) in card.group.worlds" :key="index">
                  <td>#{{ index + 1 }} <span class="muted">PID {{ world.pid }}</span></td>
                  <td>{{ world.port ?? 'restart…' }}</td>
                  <td>{{ number(world.tps) }}</td>
                  <td>{{ world.stepMs == null ? '—' : `${number(world.stepMs)} ms` }}</td>
                  <td>{{ world.agents }} / {{ playersIn(card.group, index) }}</td>
                  <td>{{ lineupLabel(lineupOf(card.group)[index]) }}</td>
                  <td><a v-if="world.view" :href="world.view" target="_blank" rel="noopener">Otwórz</a></td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="params-grid">
            <label v-for="[name, label] in PARAMETERS" :key="name" :class="{ changed: card.group && card.draft.config[name] !== card.group.config[name] }">{{ label }}
              <input
                v-model.number="card.draft.config[name]" type="number" required
                :min="groupData.limits[name][0]" :max="groupData.limits[name][1]" :step="groupData.limits[name][2] ? 1 : 'any'"
              >
            </label>
          </div>

          <fieldset class="processes" :disabled="card.group?.running">
            <legend>Procesy · sesje trenera i przeciwnicy w każdym</legend>
            <div v-for="(count, index) in card.draft.sessions" :key="index" class="process">
              <span class="process-number">#{{ index + 1 }}</span>
              <label>Sesje
                <input v-model.number="card.draft.sessions[index]" type="number" min="1" max="32" step="1" required>
              </label>
              <div v-for="(opponent, row) in card.draft.opponents[index]" :key="row" class="opponent">
                <label>Przeciwnik
                  <select v-model="opponent.model">
                    <option :value="null">Boty</option>
                    <optgroup v-for="m in models" :key="m.run" :label="m.run">
                      <option v-for="file in m.files" :key="file" :value="`${m.run}/${file}`">{{ modelLabel(`${m.run}/${file}`) }}</option>
                    </optgroup>
                  </select>
                </label>
                <label>Ile
                  <input v-model.number="opponent.count" type="number" min="1" :max="opponent.model ? 32 : 100" step="1" required>
                </label>
                <button type="button" class="ghost small" :aria-label="`Usuń przeciwnika ${row + 1} z procesu ${index + 1}`" @click="card.draft.opponents[index].splice(row, 1)">×</button>
              </div>
              <button v-if="card.draft.opponents[index].length < 4" type="button" class="ghost small" @click="card.draft.opponents[index].push({ model: null, count: 1 })">+ przeciwnik</button>
            </div>
            <button type="button" class="ghost" @click="addProcess(card.draft)">+ proces</button>
            <button v-if="card.draft.sessions.length > 1" type="button" class="ghost" @click="removeProcess(card.draft)">− proces</button>
          </fieldset>

          <div class="params-actions">
            <template v-if="card.group">
              <button class="primary" :disabled="busy || !groupChanged(card)">Zapisz</button>
              <button type="button" class="ghost" :disabled="!groupChanged(card)" @click="resetGroup(card)">Odrzuć</button>
            </template>
            <template v-else>
              <button class="primary" :disabled="busy">Utwórz grupę</button>
              <button type="button" class="ghost" @click="newGroup = null">Anuluj</button>
            </template>
          </div>
          <p class="muted">
            {{ card.group?.running
              ? 'Zapisane ustawienia trafiają do działających światów od razu. Procesy zmienisz po zatrzymaniu grupy, a trenerzy zobaczą je po swoim restarcie.'
              : 'Ustawienia i procesy zaczną działać po starcie grupy.' }}
          </p>
        </form>

        <button v-if="!newGroup" class="new-group" :disabled="busy" @click="startNewGroup">+ Nowa grupa</button>
        <p class="muted">Działające grupy wstają same po restarcie labu. Świat, który padnie, lab uruchamia ponownie na nowym porcie.</p>
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
