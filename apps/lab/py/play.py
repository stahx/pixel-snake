import argparse
import sys
import threading
from functools import partial
from pathlib import Path

from controller import keep_playing, play
from model import load
from pixel_snake_lab import Game, find_worlds, stream_output


def play_session(group, world, run, net):
    for _ in play(Game(group, run=run, world=world), net):
        pass


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Play a trained model in lab worlds without training it.')
    parser.add_argument('--model', type=Path, required=True, help='checkpoint, e.g. py/checkpoints/ppo-1/latest.pt')
    parser.add_argument('--groups', required=True, help='lab groups to play in: every world gets the sessions its group sets')
    parser.add_argument('--run', help="run the episodes are logged under (default: <the model's run>-play)")
    args = parser.parse_args()
    run = args.run or f'{args.model.resolve().parent.name}-play'
    try:
        net = load(args.model)
        worlds = find_worlds(run, args.groups.split(','))
    except (ValueError, OSError) as error:
        sys.exit(f'{parser.prog}: error: {error}')
    stream_output(run)

    sessions = []
    for group, listed in worlds.items():
        for world, found in enumerate(listed):
            for number in range(found['sessions']):
                label = f'{group} #{world + 1} session {number}'
                session = partial(play_session, group, world, run, net)
                sessions.append(threading.Thread(target=keep_playing, args=(session, label), daemon=True))
    for session in sessions:
        session.start()
    try:
        for session in sessions:
            session.join()
    except KeyboardInterrupt:
        pass
