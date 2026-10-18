import os

from pixel_snake_lab import apply_update, load_env, parse_ports


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


def test_parse_ports():
    assert parse_ports('3030') == [3030]
    assert parse_ports('3031-3034') == [3031, 3032, 3033, 3034]
    assert parse_ports('3030,3035-3036') == [3030, 3035, 3036]
