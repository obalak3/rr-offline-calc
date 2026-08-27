# The first thing to run when mGBA is back

## Why

Every player implementation loses the SIMULATED Surge fight — greedy, static
plan, per-turn re-planning, and a 3-ply search with perfect opponent prediction.
James beats the real fight losing one Pokemon. Sets, damage and replacement
order have all been checked against live observation and all match, and neither
the 24% move-prediction gap nor free potions make the simulated fight winnable.

So either the simulated opponent is slightly too hard, or our players are simply
not good enough. Those two look identical from inside the simulator. They do not
look identical against the real game.

## The experiment

Run the LIVE agent on Surge with the SAME greedy policy the simulation baseline
uses, and compare kills.

    printf "%s/RadicalRed-mGBA/RadicalRed.ss5\n" "$HOME" > ~/rr-agent/saves.txt
    pkill -f "node tools/agent.js"
    GREEDY=1 nohup node tools/agent.js > ~/rr-agent/agent-node.log 2>&1 &
    # then load tools/lua/bootstrap.lua in mGBA, once

`ss5` is the Surge save. `restart` is already present, so it replays the fight
indefinitely and rotates nothing.

## What the numbers mean

In simulation, greedy killed:

    2 of their 5   in 11 of 20 episodes
    3 of their 5   in  7 of 20
    4 of their 5   in  2 of 20      never a win

Count the same distribution from the live log:

    grep -c "restarted" ~/rr-agent/agent.log      # episodes
    grep "the battle is over" ~/rr-agent/agent.log

- **More kills live than simulated** -> the simulated opponent is too hard, and
  every Surge number in this repo is measuring a fight that is not being played.
  That would also retract the original "the advisor loses Surge 6/6" finding
  that started this whole line of work.
- **The same distribution** -> the environment is sound and the planner work
  stands; our players are the weak part, which is a much better problem to have.

Twenty episodes is enough to tell 2-4 kills from 5.
