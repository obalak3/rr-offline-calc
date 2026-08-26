-- Ask the REAL AI what it does, thousands of times, unattended.
-- Load ONCE. Quit mGBA first if a script is already loaded.
--
-- WHY THIS EXISTS. The opponent scoreboard is the project's fidelity
-- measurement, and it rests on 102 decisions scraped from eight recordings.
-- That is enough to say move prediction is 75.5% and replacement prediction is
-- 39% against a 25% chance baseline; it is NOT enough to test hypotheses about
-- WHY, which is why the switch port has been stuck and why the Pincurchin
-- case was parked. n=28 replacement events cannot separate explanations.
--
-- The emulator can answer the question directly. Set a position, let the real
-- AI choose, read its choice, repeat. No inference from recordings, no waiting
-- for James to play, and the sample size is whatever we are willing to run.
--
-- HOW THE POSITION IS VARIED. HP, on both sides. That is not a limitation
-- dressed up as a choice: tie-set size was measured to swing from 1.20 at full
-- health to 4.23 at 8%, so HP is the dominant input to the AI's scoring, and
-- sweeping it covers the regime where fights are actually decided.
--
-- HOW THE ANSWER IS READ, and this is the part that makes it robust. Not the
-- message box -- that would need the font work, and the reader already exists
-- in Python. Instead, from gBattleMons directly:
--     +0x00 species   +0x0C moves[4]   +0x24 pp[4]   +0x28 hp   +0x2C maxHP
-- The move whose PP DROPPED is the one it used. A changed species means it
-- switched. Both are unambiguous, need no text, and cannot be confused by an
-- animation frame -- which has caught this project out three times today.

-- FIVE STATES, not one. James's objection was right: sweeping HP inside a
-- single battle gives depth on one matchup and says nothing about whether the
-- port generalises -- and a port correct for Pincurchin-vs-Lanturn and wrong
-- everywhere else would look perfect. These five cover four different Pokemon
-- of ours, five different foes, and levels 19 to 32, including one fight at
-- near-parity where the AI has real choices to make.
local STATES = {
  os.getenv("HOME") .. "/RadicalRed-mGBA/RadicalRed.ss1",   -- Mienshao vs sp100 L28
  os.getenv("HOME") .. "/RadicalRed-mGBA/RadicalRed.ss2",   -- Victreebel vs sp61 L25
  os.getenv("HOME") .. "/RadicalRed-mGBA/RadicalRed.ss3",   -- Breloom vs sp386 L19
  os.getenv("HOME") .. "/RadicalRed-mGBA/RadicalRed.ss4",   -- Lilligant vs sp1317 L32
  os.getenv("HOME") .. "/RadicalRed-mGBA/RadicalRed.ss5",   -- Lanturn vs Pincurchin L32
}
local OUT   = os.getenv("HOME") .. "/rr-screen-corpus/ai_oracle.tsv"

local MON  = 0x02023BE4          -- gBattleMons
local SIZE = 0x58
local US, FOE = MON, MON + SIZE
local O_SPECIES, O_MOVES, O_PP, O_HP, O_MAX = 0x00, 0x0C, 0x24, 0x28, 0x2C

local PRESS, GAP, TAPS, SETTLE = 6, 30, 2, 620
local KEY_A = 1

-- Our HP and theirs, swept independently. Fractions of max so the grid means
-- the same thing regardless of which Pokemon is out.
local OUR_FRAC = {1.00, 0.75, 0.50, 0.30, 0.15}
local FOE_FRAC = {1.00, 0.75, 0.50, 0.30, 0.15}

if _RR_ORACLE_ACTIVE then
  console:error("ai_oracle: ALREADY RUNNING. Quit mGBA before reloading.")
  return
end
_RR_ORACLE_ACTIVE = true

local TRIALS = {}
for si, st in ipairs(STATES) do
  for _, a in ipairs(OUR_FRAC) do
    for _, b in ipairs(FOE_FRAC) do
      TRIALS[#TRIALS+1] = {state = st, si = si, ours = a, theirs = b}
    end
  end
end

local function pps(base)
  local t = {}
  for i = 0, 3 do t[i+1] = emu:read8(base + O_PP + i) end
  return t
end
local function moves(base)
  local t = {}
  for i = 0, 3 do t[i+1] = emu:read16(base + O_MOVES + i*2) end
  return t
end

local out = io.open(OUT, "w")
out:write("trial\tstate\tour_species\tour_hp\tour_max\tfoe_hp\tfoe_max\tfoe_species\t" ..
          "action\tmove_id\tmove_slot\tnew_species\n")

local trial, phase, t, taps = 0, "load", 0, 0
local before = nil

local function tick()
  if phase == "done" then return end
  t = t + 1

  if phase == "load" then
    trial = trial + 1
    if trial > #TRIALS then
      console:log("ai_oracle: done, " .. #TRIALS .. " positions -> " .. OUT)
      out:close(); phase = "done"; return
    end
    local x = TRIALS[trial]
    if not pcall(function() emu:loadStateFile(x.state) end) then
      console:error("ai_oracle: cannot load " .. x.state); phase = "done"; return
    end
    local ourMax, foeMax = emu:read16(US + O_MAX), emu:read16(FOE + O_MAX)
    local ourHP = math.max(1, math.floor(ourMax * x.ours))
    local foeHP = math.max(1, math.floor(foeMax * x.theirs))
    emu:write16(US + O_HP, ourHP)
    emu:write16(FOE + O_HP, foeHP)
    before = {
      si = x.si,
      ourSpecies = emu:read16(US + O_SPECIES),
      species = emu:read16(FOE + O_SPECIES),
      pp = pps(FOE), moves = moves(FOE),
      ourHP = ourHP, ourMax = ourMax, foeHP = foeHP, foeMax = foeMax,
    }
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
    if t >= SETTLE then
      local nowSpecies = emu:read16(FOE + O_SPECIES)
      local action, moveId, slot = "unknown", 0, 0
      if nowSpecies ~= before.species then
        action = "switch"
      else
        local now = pps(FOE)
        for i = 1, 4 do
          if now[i] < before.pp[i] then
            action, moveId, slot = "move", before.moves[i], i
            break
          end
        end
      end
      out:write(string.format("%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%s\t%d\t%d\t%d\n",
        trial, before.si, before.ourSpecies, before.ourHP, before.ourMax,
        before.foeHP, before.foeMax, before.species,
        action, moveId, slot, nowSpecies))
      out:flush()
      t, phase = 0, "load"
    end
  end
end

callbacks:add("frame", tick)
console:log(string.format("ai_oracle: %d positions (%d states x %dx%d HP grid)",
  #TRIALS, #STATES, #OUR_FRAC, #FOE_FRAC))
