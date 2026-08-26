# Ties are the fight, and you can play against them

Written 2026-08-25 from James's account of eight recorded Lt. Surge attempts.
This is his domain knowledge, not an inference from the code, and it changes
what the advisor should be optimising.

A caveat he asked for and which applies to this whole file: take the CONCEPTS,
not his play. "I am not the best pokemon player. I made mistakes in the clean
win run too. I am no person to be modeled after. The end goal is to get
something better than me, not simulate me." Tie-collapsing is a real mechanic
worth building on. The particular switches he made are not ground truth, and his
win rate is a floor to beat rather than a target to match.

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


## MEASURED 2026-08-25: ties are HP-dependent, and damage creates them

`tools/count_ties.js` at FULL HP says Lt. Surge is almost tie-free: 28 of 30
matchups have one clearly best move, and only Mienshao produces ties (4-way,
against Vikavolt and Manectric). That flatly contradicted James's report that
Pawmot coin-flips between Thunder Punch and Drain Punch against his Mienshao.

He was right and the full-HP snapshot was the wrong measurement. Sweeping his
Mienshao's health against Pawmot:

    Mienshao 98/98   Thunder Punch alone        103 vs 100
    Mienshao 74/98   Thunder Punch alone        109 vs 100
    Mienshao 49/98   Drain Punch + Thunder Punch TIE at 109
    Mienshao 29/98   ALL FOUR moves tie at 109

**The opponent becomes less predictable exactly as you get weaker.** As a
Pokemon drops, more of the AI's moves become kill-capable, they all collect the
same bonus, and the tied set grows. At full health Pawmot is deterministic; near
half it is a coin flip; below a third it is a four-sided die every turn.

Three consequences, and the first two are advice we could give today:

1. **HP thresholds are tie thresholds.** "Keep Mienshao above 50% and Pawmot
   stays predictable" is concrete, checkable, and exactly the kind of thing the
   advisor should say. It is also invisible in any full-HP analysis.
2. **It explains the run-killer without luck.** James lost runs to that flip
   while trying to scout it with Detect. The flip was manufactured by the damage
   his Mienshao had already taken, and scouting cannot work anyway because the
   tie is re-rolled each turn.
3. **Any tie measurement must sweep HP.** A tie count taken at full health
   understates the real number badly, and check_forks.js scoring a specific line
   is right to look at actual positions rather than a matchup table.
