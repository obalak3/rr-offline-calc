-- Prove (or kill) the battle-RNG address by WRITING it and watching the result.
--
-- Load with Tools > Scripting > File > Load script. It drives the emulator by
-- itself; nobody plays. Runs on a COPY of a save state, never a live run.
--
-- WHY WRITING RATHER THAN WATCHING. The save-state search narrowed the value
-- that decides a crit or a burn to two words, using states labelled by
-- outcome. That is correlational, and this project has been burned by
-- correlational evidence repeatedly -- a matching number is not a mechanism.
-- Writing is causal: if poking a value into this address changes the outcome,
-- it IS the seed, and if it changes nothing, it is not, and no amount of
-- further correlation would have told us.
--
-- It also solves the sample-size problem. Reloading the same state always
-- gives the same result (verified: waiting thirty seconds changes nothing), so
-- variety cannot come from replaying. It has to come from writing different
-- seeds, which is why write access is the piece that makes this possible at
-- all.
--
-- WHAT IT MEASURES. Not "did it crit", which is one bit. The party's HP after
-- the turn gives the DAMAGE, and a damage roll is one of sixteen values, so
-- every trial yields about four bits. That is what makes a few hundred trials
-- enough to recover the seed-to-roll mapping rather than merely confirm an
-- address.
--
-- Output: rr-screen-corpus/seed_probe.tsv, one row per trial.

local STATE   = os.getenv("HOME") .. "/RadicalRed-mGBA/RadicalRed.ss5"
local OUT     = os.getenv("HOME") .. "/rr-screen-corpus/seed_probe.tsv"

-- Candidates that survived the save-state filter: constant while idling,
-- distinct in every battle. 0x03000204 is the prime suspect (high-entropy
-- 16-bit); 0x03000178 has all-zero low bytes and is probably a counter, kept
-- as a control so a null result on it is informative.
local ADDR    = 0x03000204
local WIDTH   = 16

-- Party copies located from the save state by matching level 34 and our six
-- known max HPs. 0x0202E5AC is the battle-order copy, active Pokemon first.
local PARTY   = 0x0202E5AC
local MONSIZE = 100
local HP_OFF  = 0x56

local PRESS_FRAMES = 4      -- how long to hold a button
local GAP_FRAMES   = 20     -- between presses
local PRESSES      = 3      -- enough to get through menu -> move -> confirm
local SETTLE       = 420    -- frames for the turn to fully resolve

local KEY_A = 1

-- Seeds to sweep. Spread across the 16-bit space rather than sequential: a
-- contiguous run would sample one narrow region of the generator and could
-- look deceptively structured.
local seeds = {}
for i = 0, 255 do seeds[#seeds + 1] = (i * 257) % 65536 end

local out = io.open(OUT, "w")
out:write("trial\tseed_written\tseed_after\thp1\thp2\thp3\thp4\thp5\thp6\n")

local trial, phase, timer, pressed = 0, "load", 0, 0

local function readHP()
  local hp = {}
  for i = 0, 5 do
    hp[#hp + 1] = emu:read16(PARTY + i * MONSIZE + HP_OFF)
  end
  return hp
end

local function writeSeed(v)
  if WIDTH == 16 then emu:write16(ADDR, v) else emu:write32(ADDR, v) end
end

local function readSeed()
  if WIDTH == 16 then return emu:read16(ADDR) else return emu:read32(ADDR) end
end

local function tick()
  if phase == "done" then return end

  if phase == "load" then
    trial = trial + 1
    if trial > #seeds then
      console:log("seed_probe: finished " .. #seeds .. " trials -> " .. OUT)
      out:close()
      phase = "done"
      return
    end
    local ok = pcall(function() emu:loadStateFile(STATE) end)
    if not ok then
      console:error("seed_probe: could not load " .. STATE)
      phase = "done"
      return
    end
    writeSeed(seeds[trial])
    pressed, timer, phase = 0, 0, "press"
    return
  end

  if phase == "press" then
    timer = timer + 1
    if timer <= PRESS_FRAMES then
      emu:setKeys(KEY_A)
    elseif timer <= PRESS_FRAMES + GAP_FRAMES then
      emu:setKeys(0)
    else
      pressed, timer = pressed + 1, 0
      if pressed >= PRESSES then phase = "settle" end
    end
    return
  end

  if phase == "settle" then
    emu:setKeys(0)
    timer = timer + 1
    if timer >= SETTLE then
      local hp = readHP()
      out:write(string.format("%d\t%d\t%d\t%s\n", trial, seeds[trial],
        readSeed(), table.concat(hp, "\t")))
      out:flush()
      timer, phase = 0, "load"
    end
    return
  end
end

callbacks:add("frame", tick)
console:log(string.format(
  "seed_probe: %d trials, writing 0x%08X (%d-bit), logging to %s",
  #seeds, ADDR, WIDTH, OUT))
