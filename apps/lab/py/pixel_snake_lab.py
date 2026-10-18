import math
import os
import threading
import warnings

import socketio

NAMESPACE = '/lab'
ENTITY_TYPES = ('point', 'tail', 'player')
FIELD_NAMES = {'i': 'id', 't': 'type', 'x': 'x', 'y': 'y', 'c': 'color', 's': 'size',
               'p': 'player', 'n': 'name', 'pt': 'points', 'a': 'angle', 'b': 'boosting'}
AIM_DISTANCE = 200


def load_env(path=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env')):
    if not os.path.exists(path):
        return
    with open(path) as file:
        for line in file:
            name, equals, value = line.strip().partition('=')
            if equals and not name.startswith('#'):
                os.environ.setdefault(name.strip(), value.strip().strip('\'"'))


def parse_ports(ports):
    parsed = []
    for part in ports.split(','):
        first, _, last = part.partition('-')
        parsed.extend(range(int(first), int(last or first) + 1))
    return parsed


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
    def __init__(self, url='http://127.0.0.1:3030', run='TRAINING', key=None):
        self.info = None
        self.entities = {}
        self.leaderboard = []
        self.alive = False
        self.tick = 0
        self.sid = None
        self._connect_error = None
        self._disconnected = False
        self._changed = threading.Condition()
        self._sio = socketio.Client(reconnection=False)
        self._sio.on('env-info', self._on_info, namespace=NAMESPACE)
        self._sio.on('update', self._on_update, namespace=NAMESPACE)
        self._sio.on('ded', self._on_dead, namespace=NAMESPACE)
        self._sio.on('lab-error', lambda message: warnings.warn(message), namespace=NAMESPACE)
        self._sio.on('connect_error', self._on_connect_error, namespace=NAMESPACE)
        self._sio.on('disconnect', self._on_disconnect, namespace=NAMESPACE)
        load_env()
        key = key or os.environ['PIXEL_SNAKE_LAB_KEY']
        try:
            self._sio.connect(url, auth={'key': key, 'run': run}, namespaces=[NAMESPACE], transports=['websocket'])
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
                raise ConnectionError('Disconnected from the lab server')
            return {'tick': self.tick, 'alive': self.alive, 'me': self.me,
                    'entities': dict(self.entities), 'leaderboard': self.leaderboard}

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
        self._sio.emit(event, data, namespace=NAMESPACE)

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
            apply_update(self.entities, update)
            if 'l' in update:
                self.leaderboard = update['l']
            self.alive = self.me is not None
            self.tick += 1
            self._changed.notify_all()

    def _on_dead(self):
        with self._changed:
            self.alive = False
            self.entities.clear()
            self._changed.notify_all()
