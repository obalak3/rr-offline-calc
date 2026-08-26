-- Does a DIFFERENT MOVE from the SAME seed shift the RNG stream?
-- Load ONCE. Quit mGBA first if a script is already loaded.
--
-- THE CLAIM UNDER TEST. The seed fixes a tape of numbers; what a player's
-- choices change is where the playhead sits when an event asks for one. Scald
-- has a 30% burn and must draw to check it; Shock Wave has no secondary and
-- does not. If that is right, the two lines consume DIFFERENT numbers of draws
-- and everything downstream reads different values off the same tape -- which
-- is exactly why a prediction cannot be carried many turns forward.
--
-- Same seed, four different moves, and the measurement is the generator's
-- value AFTER the turn. Converting that back to an advance count says how many
-- draws each move consumed. Equal counts would refute the claim; different
-- counts confirm it and quantify the offset.
--
-- Lanturn's moves in slot order: Scald / Confuse Ray / Signal Beam / Shock Wave
-- so slot 1 has a secondary effect, slot 4 has none -- the cleanest contrast.

local STATE = os.getenv("HOME") .. "/RadicalRed-mGBA/RadicalRed.ss5"
local OUT   = os.getenv("HOME") .. "/rr-screen-corpus/divergence.tsv"

local RNG     = 0x020386D0
local FOE_HP  = 0x02023BE4 + 0x58 + 0x28
local FOE_MAX = 0x02023BE4 + 0x58 + 0x2C

local KEY_A, KEY_RIGHT, KEY_DOWN = 1, 16, 128
local PRESS, GAP, SETTLE = 6, 30, 700

-- Button sequence to reach each move slot from the action prompt:
-- A opens FIGHT with slot 1 highlighted, then navigate, then A to fire.
local ROUTES = {
  {KEY_A, KEY_A},                        -- slot 1
  {KEY_A, KEY_RIGHT, KEY_A},             -- slot 2
  {KEY_A, KEY_DOWN, KEY_A},              -- slot 3
  {KEY_A, KEY_DOWN, KEY_RIGHT, KEY_A},   -- slot 4
}
local SEEDS = {0x11111111, 0x5A5A5A5A, 0xDEADBEEF, 0x01234567}

if _RR_DIV_ACTIVE then
  console:error("divergence: ALREADY RUNNING. Quit mGBA before reloading.")
  return
end
_RR_DIV_ACTIVE = true

local TRIALS = {}
for si, s in ipairs(SEEDS) do
  for mi = 1, #ROUTES do TRIALS[#TRIALS+1] = {seed = s, move = mi} end
end

local out = io.open(OUT, "w")
out:write("trial\tseed\tmove\trng_after\tfoe_hp\tfoe_max\tdamage\n")

local trial, phase, t, step = 0, "load", 0, 0

local function tick()
  if phase == "done" then return end
  t = t + 1

  if phase == "load" then
    trial = trial + 1
    if trial > #TRIALS then
      console:log("divergence: done -> " .. OUT); out:close(); phase = "done"; return
    end
    if not pcall(function() emu:loadStateFile(STATE) end) then
      console:error("divergence: cannot load " .. STATE); phase = "done"; return
    end
    emu:write32(RNG, TRIALS[trial].seed)
    emu:setKeys(0)
    t, step, phase = 0, 0, "press"

  elseif phase == "press" then
    local route = ROUTES[TRIALS[trial].move]
    if step >= #route then
      emu:setKeys(0); t, phase = 0, "settle"
    elseif t <= PRESS then
      emu:setKeys(route[step + 1])
    else
      emu:setKeys(0)
      if t >= PRESS + GAP then step, t = step + 1, 0 end
    end

  elseif phase == "settle" then
    emu:setKeys(0)
    if t >= SETTLE then
      local hp, mx = emu:read16(FOE_HP), emu:read16(FOE_MAX)
      out:write(string.format("%d\t%d\t%d\t%d\t%d\t%d\t%d\n",
        trial, TRIALS[trial].seed, TRIALS[trial].move,
        emu:read32(RNG), hp, mx, mx - hp))
      out:flush()
      t, phase = 0, "load"
    end
  end
end

callbacks:add("frame", tick)
console:log(string.format("divergence: %d trials (%d seeds x %d moves)",
  #TRIALS, #SEEDS, #ROUTES))
