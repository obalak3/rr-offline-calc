-- Recover the exact damage roll from the seed. Load ONCE; quit mGBA first.
--
-- THE ADDRESSES ARE ALL VANILLA FIRE RED, which is the finding that made this
-- possible and the one a day of memory-differencing missed:
--    0x03005000  gRngValue     (named in the ROM beside 0x41C64E6D)
--    0x02024284  gPlayerParty
--    0x02023BE4  gBattleMons, 0x58 per battler, curHP at +0x28, maxHP at +0x2C
-- so the foe's live HP is 0x02023C64. Verified against three save states
-- reading Pincurchin at 78/95, 79/95 and 80/95.
--
-- WHAT IS BEING CALIBRATED. Gen-3 damage is
--     damage = base * (100 - Random() % 16) / 100
-- so the roll is one of sixteen values and is drawn from the generator we now
-- control. Knowing the seed does NOT yet predict the roll, because an unknown
-- number of draws happen between the save point and the damage calculation --
-- animations and AI decisions consume them too.
--
-- That offset is measurable rather than guessable. Plant a known seed, read
-- the damage actually dealt, and the roll follows from the damage. Do it for
-- forty seeds and only ONE advance count k satisfies
--     (LCG^k(seed) >> 16) % 16  ==  observed roll
-- for every trial at once. Forty trials is far more constraint than a
-- sixteen-value unknown needs, which is the point: a single fit would be
-- meaningless, forty simultaneous fits cannot be coincidence.
--
-- Recording HP BEFORE as well as after matters: it proves the turn actually
-- resolved rather than the state being read mid-animation, which has already
-- produced one confounded result today.

local STATE = os.getenv("HOME") .. "/RadicalRed-mGBA/RadicalRed.ss5"
local OUT   = os.getenv("HOME") .. "/rr-screen-corpus/crit_calib.tsv"

-- THE BATTLE RNG, not 0x03005000. That one is vanilla gRngValue: consumed
-- exactly 808 times a turn but proved (43 seeds, identical damage every time)
-- to decide none of this. 0x020386D0 is the generator whose value actually
-- moves the roll, confirmed by replanting each save state's own seed and
-- getting that state's own outcome back.
local RNG     = 0x020386D0
local FOE_HP  = 0x02023BE4 + 0x58 + 0x28
local FOE_MAX = 0x02023BE4 + 0x58 + 0x2C
local OUR_HP  = 0x02023BE4 + 0x28

local PRESS, GAP, TAPS, SETTLE = 6, 30, 3, 700
local KEY_A = 1

if _RR_CRIT_ACTIVE then
  console:error("calibrate: ALREADY RUNNING. Quit mGBA before reloading.")
  return
end
_RR_CRIT_ACTIVE = true

-- Spread across the 32-bit space rather than sequential: consecutive seeds
-- give correlated low bits and could make a wrong k look plausible.
local seeds = {}
-- 256 seeds rather than 64, purely to collect CRITS. The damage roll is
-- already solved (draw #1232, concordance 1.000 over 1417 pairs), but only 6
-- of 64 trials crit, and a sweep of divisors 3-64 across 4000 indices returned
-- NINE exact matches for the crit rule -- nine answers is no answer. At the
-- observed ~9% crit rate this yields roughly 24 crits, at which point a
-- spurious divisor match has probability around 10^-27 and the index is
-- forced. Nothing else about the run changes.
for i = 0, 255 do seeds[#seeds+1] = (i * 2654435761) % 4294967296 end

local out = io.open(OUT, "w")
out:write("trial\tseed\tfoe_before\tfoe_after\tfoe_max\tswitched\tour_after\trng_after\n")

-- THE FOE SWITCHES OUT during the settle window, so reading its HP at the end
-- reads the REPLACEMENT (max 125) rather than the Pokemon that took the hit
-- (max 95). Sampling only at the end measured the wrong Pokemon entirely.
-- Instead, track HP every frame for as long as the active foe still has the
-- max HP it started with, and keep the LAST such reading: that is the damaged
-- Pokemon at rest, after the hit and before it leaves.
local trial, phase, t, taps, before = 0, "load", 0, 0, 0
local startMax, lastHP, sawSwitch = 0, 0, 0

local function tick()
  if phase == "done" then return end
  t = t + 1

  if phase == "load" then
    trial = trial + 1
    if trial > #seeds then
      console:log("calibrate: done, " .. #seeds .. " trials -> " .. OUT)
      out:close(); phase = "done"; return
    end
    if not pcall(function() emu:loadStateFile(STATE) end) then
      console:error("calibrate: cannot load " .. STATE); phase = "done"; return
    end
    before = emu:read16(FOE_HP)
    startMax = emu:read16(FOE_MAX)
    lastHP, sawSwitch = before, 0
    emu:write32(RNG, seeds[trial])
    emu:setKeys(0)
    t, taps, phase = 0, 0, "press"

  elseif phase == "press" then
    if t <= PRESS then emu:setKeys(KEY_A)
    else
      emu:setKeys(0)
      if t >= PRESS + GAP then
        taps, t = taps + 1, 0
        if taps >= TAPS then phase = "settle" end
      end
    end

  elseif phase == "settle" then
    emu:setKeys(0)
    -- The AI SWITCHES rather than taking the hit in this position, so Scald
    -- lands on the replacement. Tracking only while the original Pokemon was
    -- out froze the reading at its undamaged HP and reported zero damage on
    -- all 48 trials -- the third time today a value was read at a moment when
    -- it described something else. What matters is the Pokemon that actually
    -- took the hit, and since a replacement arrives at full health its damage
    -- is simply max minus current.
    if emu:read16(FOE_MAX) ~= startMax then sawSwitch = 1 end
    lastHP = emu:read16(FOE_HP)
    if t >= SETTLE then
      out:write(string.format("%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\n",
        trial, seeds[trial], before, lastHP, emu:read16(FOE_MAX), sawSwitch,
        emu:read16(OUR_HP), emu:read32(RNG)))
      out:flush()
      t, phase = 0, "load"
    end
  end
end

callbacks:add("frame", tick)
console:log(string.format("calibrate: %d trials, foe HP at 0x%08X", #seeds, FOE_HP))
