import argparse
import multiprocessing
import random
import signal
import threading

from pixel_snake_lab import Game

TURNS = (-0.5, 0.0, 0.5)
ACTIONS = [(turn, boost) for turn in TURNS for boost in (False, True)]
TICKS_PER_ACTION = 4
DEATH_PENALTY = -100.0


def choose_action(observation):
    return random.choice(ACTIONS)


def reward_for(observation, next_observation):
    if not next_observation['alive']:
        return DEATH_PENALTY
    return next_observation['me']['points'] - observation['me']['points']


def play(url, run, episodes, label):
    game = Game(url=url, run=run)
    for episode in range(episodes):
        observation = game.observe()
        episode_return = 0.0
        steps = 0
        while observation['alive']:
            me = observation['me']
            turn, boost = choose_action(observation)
            game.steer(me['angle'] + turn)
            game.boost(boost and me['points'] > 0)
            for _ in range(TICKS_PER_ACTION):
                next_observation = game.observe()
            episode_return += reward_for(observation, next_observation)
            steps += 1
            observation = next_observation
        game.log(reward=episode_return, steps=steps)
        print(f'{label} episode {episode}: return {episode_return:.1f}, steps {steps}', flush=True)
        game.respawn()
    game.close()


def parse_ports(ports):
    parsed = []
    for part in ports.split(','):
        first, _, last = part.partition('-')
        parsed.extend(range(int(first), int(last or first) + 1))
    return parsed


def play_room(url, run, episodes, sessions):
    threads = [threading.Thread(target=play, args=(url, run, episodes, f'{url} session {number}'), daemon=True)
               for number in range(sessions)]
    for thread in threads:
        thread.start()
    try:
        for thread in threads:
            thread.join()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='http://127.0.0.1')
    parser.add_argument('--ports', type=parse_ports, default='3030', help='servers: 3030, 3031-3050 or 3031,3035')
    parser.add_argument('--sessions', type=int, default=1, help='training sessions per server')
    parser.add_argument('--episodes', type=int, default=3)
    parser.add_argument('--run', default='random-baseline')
    args = parser.parse_args()

    signal.signal(signal.SIGTERM, signal.default_int_handler)
    rooms = [multiprocessing.Process(target=play_room, args=(f'{args.host}:{port}', args.run, args.episodes, args.sessions),
                                     daemon=True)
             for port in args.ports]
    for room in rooms:
        room.start()
    try:
        for room in rooms:
            room.join()
    except KeyboardInterrupt:
        pass
