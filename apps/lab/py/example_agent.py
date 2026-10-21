import argparse
import multiprocessing
import random
import signal
import threading

from pixel_snake_lab import Game, find_worlds

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


def play(group, world, run, episodes, label):
    game = Game(group, run=run, world=world)
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


def play_world(group, world, run, episodes, sessions):
    threads = [threading.Thread(target=play, args=(group, world, run, episodes, f'{group} #{world + 1} session {number}'),
                                daemon=True)
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
    parser.add_argument('--groups', required=True, help='lab groups to play in, e.g. quiet,crowded')
    parser.add_argument('--episodes', type=int, default=3)
    parser.add_argument('--run', default='random-baseline')
    args = parser.parse_args()

    signal.signal(signal.SIGTERM, signal.default_int_handler)
    processes = [multiprocessing.Process(target=play_world, args=(group, world, args.run, args.episodes, found['sessions']),
                                         daemon=True)
                 for group, listed in find_worlds(args.run, args.groups.split(',')).items()
                 for world, found in enumerate(listed)]
    for process in processes:
        process.start()
    try:
        for process in processes:
            process.join()
    except KeyboardInterrupt:
        pass
