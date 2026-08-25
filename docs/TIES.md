# Ties are the fight, and you can play against them

Written 2026-08-25 from James's account of eight recorded Lt. Surge attempts.
This is his domain knowledge, not an inference from the code, and it changes
what the advisor should be optimising.

## What he does, and why it works

> "I brought in Hatterene, because I know that Thunder Punch is Pawmot's
> strongest move against it. By removing the tie (previously none of my
> switch-ins had Thunder Punch as the clear best move), I now safely switched to
> Diggersby."

Read that again, because it is a strategy this project has no concept of. He did
not bring Hatterene to win a matchup. He brought it to make the OPPONENT
PREDICTABLE. CFRU picks uniformly among every move tied at the top score
(`ai_master.c:360`, `AIRandom() % numOfBestMoves`), so the size of that tied set
is a property of the position -- and the position is partly HIS choice. Sending
in a Pokemon against which one move is clearly best collapses the tie set to
one, and the opponent becomes deterministic for that turn.

**So tie count is a controllable quantity, not just a hazard to measure.**
`check_forks.js` counts ties to say how fragile a plan is. Nothing in the app
tries to REDUCE them, and a player who knows the game does exactly that.

## The run-killer, and the mistake inside it

> "The most prevalent run killer was that against my Mienshao, Pawmot randomly
> chose between Thunder Punch and Drain Punch. I used Detect to see which he
> would, then switched and he sometimes did it again, sometimes did the other
> move causing me to fail the run."

The scouting does not work, and the source says why. The tie is re-rolled from
scratch every time the AI chooses: it recomputes scores, collects everything at
the maximum, and takes `AIRandom() % numOfBestMoves` again. **Last turn's pick
carries no information about this turn's.** Spending a turn on Detect to observe
a coin flip buys nothing except the turn it costs.

This is worth telling him in the app, plainly, at the moment it matters: *this
is a genuine coin flip and watching it will not help; the ways out are to change
the matchup so the tie disappears, or to pick a line that survives both.*

## What the advisor should therefore do

1. **Report ties as ties.** When the AI has two or more actions at the top,
   say so and name them. That is a coin flip the player is about to take, and
   he currently discovers it by losing runs.
2. **Prefer actions that shrink the opponent's tie set.** Every candidate switch
   can be scored by how many moves the AI would have tied at the top afterwards.
   Fewer is better, all else equal, and this is cheap: `RRAI.scoreAll` already
   produces the numbers.
3. **Never advise scouting a tie.** It cannot work.
4. **Price the fight by its ties, not just its damage.** James: "This fight is
   genuinely a difficult one, as there are a lot of ties." That is the honest
   description of Lt. Surge and it is not visible anywhere in our current
   output.

## Why his resets happened, which is the same problem

> "Some of the fast resets I did happened because I followed a path where in
> previous routes caused a switch, and I planned accordingly, but while playing
> something else happened."

He was doing what our sheets do: assuming the AI repeats. It does not, wherever
a tie exists, and the AI's replacement choice has its own coin flip on top
(`ai_switching.c:2437`, 50% when scores are equal and neither faints). A plan
that reads as a fixed sequence of turns is lying about a fight like this one.
