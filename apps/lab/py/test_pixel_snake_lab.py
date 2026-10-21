import http.server
import json
import os
import threading

import pytest
import socketio

import pixel_snake_lab
from pixel_snake_lab import Game, apply_update, find_worlds, load_env, split_lines


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
