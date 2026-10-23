import http.server
import json
import os
import threading

import pytest
import socketio

import pixel_snake_lab
from pixel_snake_lab import Game, apply_update, find_worlds, load_env, seen_kills, split_lines, touches


def test_load_env(tmp_path, monkeypatch):
    monkeypatch.delenv('PIXEL_SNAKE_LAB_KEY', raising=False)
    monkeypatch.setenv('PIXEL_SNAKE_LAB_URL', 'from-shell')
    env = tmp_path / '.env'
    env.write_text('# comment\nPIXEL_SNAKE_LAB_KEY="psl_abc=="\nPIXEL_SNAKE_LAB_URL=from-file\n\n')

    load_env(str(env))
    load_env(str(tmp_path / 'missing'))

    assert os.environ['PIXEL_SNAKE_LAB_KEY'] == 'psl_abc=='
    assert os.environ['PIXEL_SNAKE_LAB_URL'] == 'from-shell'


def test_apply_update():
    entities = {}
    apply_update(entities, {'a': [
        {'i': 1, 't': 2, 'x': 10, 'y': 20, 'c': '#fff', 's': 10, 'p': 'sid', 'n': 'TRAINING', 'pt': 0, 'a': 1.5},
        {'i': 2, 't': 0, 'x': 50, 'y': 60, 'c': '#000', 's': 16},
        {'i': 3, 't': 1, 'x': 5, 'y': 5, 'c': '#f00', 'p': 'other'},
    ]})
    before_change = dict(entities)
    apply_update(entities, {'u': [{'i': 1, 'x': 12, 'y': 21, 'pt': 2, 'a': 1.6, 'b': 1}, {'i': 99, 'x': 0, 'y': 0}],
                            'r': [3]})

    assert entities == {
        1: {'id': 1, 'type': 'player', 'x': 12, 'y': 21, 'color': '#fff', 'size': 10, 'player': 'sid',
            'name': 'TRAINING', 'points': 2, 'angle': 1.6, 'boosting': 1},
        2: {'id': 2, 'type': 'point', 'x': 50, 'y': 60, 'color': '#000', 'size': 16},
    }
    assert before_change[1]['x'] == 10


def test_seen_kills():
    info = {'map': {'width': 4000, 'height': 4000}, 'fogRadius': {'min': 300, 'max': 2500},
            'growth': {'spawnSize': 10, 'maxSize': 100}}
    me = {'id': 1, 'type': 'player', 'player': 'me', 'x': 1000, 'y': 1000, 'size': 20, 'points': 30}
    entities = {
        1: me,
        2: {'id': 2, 'type': 'tail', 'player': 'me', 'x': 1030, 'y': 1000, 'size': 20},
        3: {'id': 3, 'type': 'tail', 'player': 'me', 'x': 1530, 'y': 1000, 'size': 20},
        10: {'id': 10, 'type': 'player', 'player': 'a', 'x': 1032, 'y': 1012, 'size': 10, 'points': 40},
        11: {'id': 11, 'type': 'player', 'player': 'b', 'x': 1300, 'y': 1300, 'size': 10, 'points': 90},
        12: {'id': 12, 'type': 'player', 'player': 'c', 'x': 1532, 'y': 1005, 'size': 10, 'points': 70},
        13: {'id': 13, 'type': 'point', 'x': 1031, 'y': 1001, 'size': 8},
    }

    assert seen_kills(entities, me, [10, 11, 12, 13], info) == [{'points': 40, 'distance': pytest.approx(27.89, abs=0.01), 'size': 20}]
    assert seen_kills(entities, me, [1, 10], info) == []
    assert seen_kills(entities, None, [10], info) == []


def test_touches():
    assert touches({'x': 3998, 'y': 10, 'size': 10}, {'x': 2, 'y': 12, 'size': 10}, 4000, 4000)
    assert touches({'x': 100, 'y': 100, 'size': 10}, {'x': 113, 'y': 100, 'size': 10}, 4000, 4000)
    assert not touches({'x': 100, 'y': 100, 'size': 10}, {'x': 115, 'y': 100, 'size': 10}, 4000, 4000)


def test_find_worlds(monkeypatch):
    worlds = {'quiet': [{'url': 'http://127.0.0.1:51000', 'token': 'run-1.signed', 'sessions': 2}]}
    received = []

    class Lab(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            received.append((self.path, self.headers['Authorization'], body))
            status, reply = (200, worlds) if body['groups'] == ['quiet'] else (409, {'error': 'Group crowded is not running'})
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(reply).encode())

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Lab)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv('PIXEL_SNAKE_LAB_URL', f'http://127.0.0.1:{server.server_port}')
    try:
        assert find_worlds('ppo-1', ['quiet'], key='psl_x') == worlds
        assert received == [('/api/lab/agent/worlds', 'Bearer psl_x', {'run': 'ppo-1', 'groups': ['quiet']})]
        with pytest.raises(ConnectionError, match='Group crowded is not running'):
            find_worlds('ppo-1', ['crowded'], key='psl_x')
    finally:
        server.shutdown()
        server.server_close()
    with pytest.raises(ConnectionError, match='lab unreachable'):
        find_worlds('ppo-1', ['quiet'], key='psl_x')


def test_split_lines():
    assert split_lines(b'', b'update 1\nupd') == (['update 1'], b'upd')
    assert split_lines(b'upd', b'ate 2\r\n\n') == (['update 2', ''], b'')
    assert split_lines(b'', 'zażółć\n'.encode()[:3]) == ([], 'zażółć'.encode()[:3])
    assert split_lines(b'', b'x' * 1500 + b'\n') == (['x' * 1000], b'')


def test_game_init(monkeypatch):
    monkeypatch.setattr(pixel_snake_lab, 'find_worlds',
                        lambda run, groups, key: {'quiet': [{'url': None, 'token': None, 'sessions': 2}]})

    with pytest.raises(ConnectionError, match='world quiet #1 is restarting'):
        Game('quiet')
    with pytest.raises(ConnectionError, match='group quiet has no world 2'):
        Game('quiet', world=1)


def test_game_emit():
    game = Game.__new__(Game)
    game._sio = socketio.Client()

    with pytest.raises(ConnectionError):
        game.boost(True)
