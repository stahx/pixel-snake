import random

from pixel_snake_lab import Game

ACTIONS = [(turn, boost) for turn in (-0.5, 0.0, 0.5) for boost in (False, True)]


def policy(obs):
    return random.randrange(len(ACTIONS))


game = Game(run='random-baseline')
print(game.info)

for episode in range(3):
    obs = game.observe()
    episode_return, steps = 0.0, 0
    while obs['alive']:
        turn, boost = ACTIONS[policy(obs)]
        game.steer(obs['me']['angle'] + turn)
        game.boost(boost and obs['me']['points'] > 0)
        for _ in range(4):
            next_obs = game.observe()
        reward = -100.0 if not next_obs['alive'] else next_obs['me']['points'] - obs['me']['points']
        episode_return += reward
        steps += 1
        obs = next_obs
    game.log(reward=episode_return, steps=steps)
    print(f'episode {episode}: return {episode_return:.1f}, steps {steps}')
    game.respawn()

game.close()
