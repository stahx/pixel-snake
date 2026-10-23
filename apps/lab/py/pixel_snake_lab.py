import atexit
import json
import math
import os
import queue
import sys
import threading
import time
import urllib.error
import urllib.request
import warnings
from pathlib import Path

import socketio

NAMESPACE = '/lab'
LAB_URL = 'http://127.0.0.1:3100'
ENTITY_TYPES = ('point', 'tail', 'player')
FIELD_NAMES = {'i': 'id', 't': 'type', 'x': 'x', 'y': 'y', 'c': 'color', 's': 'size',
               'p': 'player', 'n': 'name', 'pt': 'points', 'a': 'angle', 'b': 'boosting'}
AIM_DISTANCE = 200
# A head moves up to this far in the tick it dies, so its last seen position can miss the body by that much.
KILL_SLACK = 4


def load_env(path=next((folder / '.env' for folder in Path(__file__).resolve().parents if (folder / '.env').exists()), '')):
    if not os.path.exists(path):
        return
    with open(path) as file:
        for line in file:
            name, equals, value = line.strip().partition('=')
            if equals and not name.startswith('#'):
                os.environ.setdefault(name.strip(), value.strip().strip('\'"'))


LOG_EVERY = 2.0
LOG_BATCH = 1000
LOG_LINE_LENGTH = 1000


def _post(path, body, key):
    load_env()
    url = f'{os.environ.get("PIXEL_SNAKE_LAB_URL", LAB_URL)}/api/lab/agent/{path}'
    request = urllib.request.Request(
        url, method='POST', data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json',
                 'Authorization': f'Bearer {key or os.environ["PIXEL_SNAKE_LAB_KEY"]}'})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response) if response.status == 200 else None
    except urllib.error.HTTPError as error:
        try:
            message = json.load(error)['error']
        except (ValueError, KeyError):
            message = f'HTTP {error.code} from {url}: restart the lab on the current code'
        raise ConnectionError(message) from error
    except OSError as error:
        raise ConnectionError(f'lab unreachable at {url}: {error}') from error


def sync_config(run, config, overrides, key=None):
    """Report the run's parameters; returns them with the panel's pending edits and then `overrides` applied."""
    return _post('config', {'run': run, 'config': config, 'overrides': overrides}, key)['config']


def find_worlds(run, groups, key=None):
    """Each group's worlds as {group: [{'url', 'token', 'sessions'}]}; a restarting world has no url yet."""
    return _post('worlds', {'run': run, 'groups': groups}, key)


def split_lines(pending, chunk):
    *lines, pending = (pending + chunk).split(b'\n')
    return [line.decode(errors='replace').rstrip('\r')[:LOG_LINE_LENGTH] for line in lines], pending


def stream_output(run, key=None):
    terminal = os.dup(1)
    read_end, write_end = os.pipe()
    os.dup2(write_end, 1)
    os.dup2(write_end, 2)
    os.close(write_end)
    os.environ['PYTHONUNBUFFERED'] = '1'
    lines = queue.Queue()
    sending = threading.Lock()

    def pump():
        pending = b''
        while chunk := os.read(read_end, 65536):
            os.write(terminal, chunk)
            complete, pending = split_lines(pending, chunk)
            for line in complete:
                lines.put(line)

    def upload():
        with sending:
            batch = []
            while not lines.empty() and len(batch) < LOG_BATCH:
                batch.append(lines.get())
            if batch:
                try:
                    _post('logs', {'run': run, 'lines': batch}, key)
                except (ConnectionError, OSError) as error:
                    os.write(terminal, f'lab: lost {len(batch)} log lines: {error}\n'.encode())

    def keep_uploading():
        while True:
            time.sleep(LOG_EVERY)
            upload()

    def finish():
        sys.stdout.flush()
        sys.stderr.flush()
        time.sleep(0.2)
        os.dup2(terminal, 1)
        os.dup2(terminal, 2)
        while not lines.empty():
            upload()

    threading.Thread(target=pump, daemon=True).start()
    threading.Thread(target=keep_uploading, daemon=True).start()
    atexit.register(finish)


def fog_radius(me, info):
    fog, growth = info['fogRadius'], info['growth']
    progress = min(1.0, max(0.0, (me['size'] - growth['spawnSize']) / (growth['maxSize'] - growth['spawnSize'])))
    return fog['min'] + (fog['max'] - fog['min']) * progress


def touches(head, segment, width, height):
    dx = (segment['x'] - head['x'] + width / 2) % width - width / 2
    dy = (segment['y'] - head['y'] + height / 2) % height - height / 2
    low, high = -segment['size'] - KILL_SLACK, head['size'] + KILL_SLACK
    return low < dx < high and low < dy < high


def seen_kills(entities, me, removed, info):
    """Enemy heads that vanished well inside our view while touching our body: the kills a player can tell from the screen."""
    if not me or not info or me['id'] in removed:
        return []
    width, height = info['map']['width'], info['map']['height']
    body = [entity for entity in entities.values() if entity['type'] == 'tail' and entity['player'] == me['player']]
    view = fog_radius(me, info)
    kills = []
    for entity_id in removed:
        victim = entities.get(entity_id)
        if not victim or victim['type'] != 'player' or victim['player'] == me['player']:
            continue
        dx = (victim['x'] + victim['size'] / 2 - me['x'] - me['size'] / 2 + width / 2) % width - width / 2
        dy = (victim['y'] + victim['size'] / 2 - me['y'] - me['size'] / 2 + height / 2) % height - height / 2
        distance = math.hypot(dx, dy)
        if distance <= view - 2 * victim['size'] and any(touches(victim, segment, width, height) for segment in body):
            kills.append({'points': victim['points'], 'distance': distance, 'size': me['size']})
    return kills


def rename_fields(wire_entity):
    return {FIELD_NAMES[short_name]: value for short_name, value in wire_entity.items()}


def apply_update(entities, update):
    for wire_entity in update.get('a', []):
        entity = rename_fields(wire_entity)
        entity['type'] = ENTITY_TYPES[entity['type']]
        entities[entity['id']] = entity
    for wire_change in update.get('u', []):
        change = rename_fields(wire_change)
        if change['id'] in entities:
            entities[change['id']] = {**entities[change['id']], **change}
    for removed_id in update.get('r', []):
        entities.pop(removed_id, None)


class Game:
    def __init__(self, group, run='TRAINING', world=0, key=None):
        worlds = find_worlds(run, [group], key)[group]
        if world >= len(worlds):
            raise ConnectionError(f'group {group} has no world {world + 1}')
        url, token = worlds[world]['url'], worlds[world]['token']
        if not url:
            raise ConnectionError(f'world {group} #{world + 1} is restarting')
        self.info = None
        self.entities = {}
        self.leaderboard = []
        self.alive = False
        self.tick = 0
        self.kills = 0
        self.kill_points = 0
        self.seen_kills = []
        self.sid = None
        self._connect_error = None
        self._disconnected = False
        self._changed = threading.Condition()
        self._sio = socketio.Client(reconnection=False)
        self._sio.on('env-info', self._on_info, namespace=NAMESPACE)
        self._sio.on('update', self._on_update, namespace=NAMESPACE)
        self._sio.on('ded', self._on_dead, namespace=NAMESPACE)
        self._sio.on('kill', self._on_kill, namespace=NAMESPACE)
        self._sio.on('lab-error', lambda message: warnings.warn(message), namespace=NAMESPACE)
        self._sio.on('connect_error', self._on_connect_error, namespace=NAMESPACE)
        self._sio.on('disconnect', self._on_disconnect, namespace=NAMESPACE)
        try:
            self._sio.connect(url, auth={'token': token, 'run': run}, namespaces=[NAMESPACE], transports=['websocket'])
        except socketio.exceptions.ConnectionError as error:
            raise ConnectionError(self._connect_error or str(error)) from error
        self.sid = self._sio.get_sid(NAMESPACE)
        with self._changed:
            self._changed.wait_for(lambda: self.info and self.alive, timeout=5)

    @property
    def me(self):
        with self._changed:
            return next((entity for entity in self.entities.values()
                         if entity['type'] == 'player' and entity['player'] == self.sid), None)

    def observe(self, timeout=1.0):
        with self._changed:
            tick = self.tick
            self._changed.wait_for(lambda: self.tick != tick or not self.alive or self._disconnected, timeout=timeout)
            if self._disconnected:
                raise ConnectionError('Disconnected from the world')
            return {'tick': self.tick, 'alive': self.alive, 'me': self.me, 'kills': self.kills, 'kill_points': self.kill_points,
                    'seen_kills': list(self.seen_kills), 'entities': dict(self.entities), 'leaderboard': self.leaderboard}

    def aim(self, x, y):
        self._emit('change-dir', {'mouseX': x, 'mouseY': y})

    def steer(self, angle):
        me = self.me
        if me:
            head_x = me['x'] + me['size'] / 2
            head_y = me['y'] + me['size'] / 2
            self.aim(head_x + math.cos(angle) * AIM_DISTANCE, head_y + math.sin(angle) * AIM_DISTANCE)

    def boost(self, on):
        self._emit('player-speed', bool(on))

    def respawn(self):
        self._emit('player-join', {})
        with self._changed:
            self._changed.wait_for(lambda: self.alive, timeout=5)

    def refresh_info(self):
        self._emit('env-info')

    def log(self, **metrics):
        self._emit('log', metrics)

    def close(self):
        self._sio.disconnect()

    def _emit(self, event, data=None):
        try:
            self._sio.emit(event, data, namespace=NAMESPACE)
        except socketio.exceptions.BadNamespaceError as error:
            raise ConnectionError('Disconnected from the world') from error

    def _on_connect_error(self, data):
        self._connect_error = data.get('message') if isinstance(data, dict) else data

    def _on_disconnect(self, *reason):
        with self._changed:
            self._disconnected = True
            self.alive = False
            self._changed.notify_all()

    def _on_info(self, info):
        with self._changed:
            self.info = info
            self._changed.notify_all()

    def _on_update(self, update):
        with self._changed:
            self.seen_kills.extend(seen_kills(self.entities, self.me, update.get('r', []), self.info))
            apply_update(self.entities, update)
            if 'l' in update:
                self.leaderboard = update['l']
            self.alive = self.me is not None
            self.tick += 1
            self._changed.notify_all()

    def _on_kill(self, victim):
        with self._changed:
            self.kills += 1
            self.kill_points += victim['points']

    def _on_dead(self):
        with self._changed:
            self.alive = False
            self.entities.clear()
            self._changed.notify_all()
