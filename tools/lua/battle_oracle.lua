-- Record every decision the REAL AI makes, by playing battles out.
-- Load ONCE. Quit mGBA first if a script is already loaded.
--
-- THIS REPLACES THE HP-INJECTION ORACLE, and the reason matters. That version
-- wrote HP into gBattleMons to manufacture positions from a handful of save
-- states. The writes landed -- verified -- but they manufactured states the
-- game may never reach, and editing one field silently changed others: setting
-- 15% HP put every Pokemon under its Sitrus Berry threshold, the berry fired,
-- and the AI was answering a different question than the one being asked.
-- That was caught only because it was checked. Other fields would break the
-- same way unnoticed.
--
-- Playing the battle out has none of that. Every position is one the game
-- actually produced, with real HP progressions, real switches and real faints.
-- It also yields MORE data per unit time: one state load gives twenty to forty
-- decisions instead of one.
--
-- HOW DECISIONS ARE DETECTED, without knowing which screen we are on. Poll
-- gBattleMons every frame and watch the FOE:
--     a PP entry drops   -> it used that move
--     the species changes -> it switched or was replaced
-- and log the position as it stood on the PREVIOUS frame, which is the state
-- the AI decided from. No screen classification, no text, and nothing that can
-- be confused by an animation frame.
--
-- HOW THE POSITION SPACE IS EXPLORED. By varying OUR move, not by editing
-- memory. The divergence test proved a different move sends the battle down a
-- genuinely different line, so replaying a state with a different button
-- pattern generates fresh, VALID positions and lets the game do the work of
-- keeping them legal.

local OUT = os.getenv("HOME") .. "/rr-screen-corpus/battle_oracle.tsv"
local STATES = {}
for i = 1, 5 do STATES[i] = os.getenv("HOME") .. "/RadicalRed-mGBA/RadicalRed.ss" .. i end

local MON, SIZE = 0x02023BE4, 0x58
local US, FOE = MON, MON + SIZE
local O_SP, O_MOVES, O_PP, O_HP, O_MAX = 0x00, 0x0C, 0x24, 0x28, 0x2C
-- ABILITY, and it is not a nicety. Our trainer data gives Surge's Pawmot Iron
-- Fist, but the RR dex lists Volt Absorb among Pawmot's abilities (id 10,
-- confirmed by Lanturn reading 10 and having Volt Absorb). If the real Pawmot
-- absorbs Electric, then FindMonThatAbsorbsOpponentsMove -- the FIRST check in
-- ShouldSwitch -- fires whenever our Lanturn is out with Shock Wave, which is
-- exactly the switch our port forbids and cannot explain. It would also mean
-- our damage calc is wrong for that matchup. Reading the ability off every
-- Pokemon that appears settles it by measurement instead of inference.
local O_ABILITY = 0x20

local KEY_A, KEY_RIGHT, KEY_DOWN = 1, 16, 128
-- Four button patterns, so replaying a state explores different lines. The
-- directions are harmless outside a menu.
-- EVERY pattern must open FIGHT first. The action menu is
--     FIGHT  BAG
--     POKEMON RUN
-- so a direction pressed there navigates the ACTION menu, not the move list:
-- the first version pressed Right at the top level and walked straight into
-- the BAG. The leading A selects FIGHT, the directions then pick the move
-- slot, and the trailing A fires it.
--
-- The leading B is a reset. If a previous sequence left us in a submenu -- the
-- bag, the party screen, a summary page -- B backs out of it, so a single
-- mis-step cannot strand the whole episode.
local KEY_B = 2
local PATTERNS = {
  {KEY_B, KEY_A, KEY_A},                        -- move 1
  {KEY_B, KEY_A, KEY_RIGHT, KEY_A},             -- move 2
  {KEY_B, KEY_A, KEY_DOWN, KEY_A},              -- move 3
  {KEY_B, KEY_A, KEY_DOWN, KEY_RIGHT, KEY_A},   -- move 4
}
local HOLD, GAP = 5, 22
-- ROTATE the pattern rather than repeating one. The first version held a
-- single pattern for a whole episode, so it selected the SAME move every turn,
-- drained that move's PP and then jammed against "no PP left" -- with Mienshao
-- it spammed Fake Out, which only works on the first turn anyway. Rotating
-- spreads PP across the moveset, keeps the battle progressing, and explores
-- far more positions per episode than any fixed choice could.
local EPISODE_FRAMES = 26000
-- END THE EPISODE WHEN THE BATTLE DOES. Without this the script wins the fight
-- and then keeps mashing A in the overworld, re-triggering the trainer and
-- burning the rest of the episode on dialogue.
--
-- Detected by SILENCE rather than by a flag: if the foe has not acted for this
-- many frames, the battle is over. That needs no address for battle state,
-- works the same in every fight, and fails safe -- a long animation costs one
-- early cut, never a wrong reading.
local IDLE_LIMIT = 2600

if _RR_BO_ACTIVE then
  console:error("battle_oracle: ALREADY RUNNING. Quit mGBA first."); return
end
_RR_BO_ACTIVE = true

local EPISODES = {}
for si = 1, #STATES do
  for pi = 1, #PATTERNS do EPISODES[#EPISODES+1] = {si = si, pi = pi} end
end

local out = io.open(OUT, "w")
out:write("episode\tstate\tpattern\tframe\tour_sp\tour_hp\tour_max\t" ..
          "foe_sp\tfoe_ability\tfoe_hp\tfoe_max\taction\tmove_id\tnew_sp\tnew_ability\n")

local ep, frame, phase = 0, 0, "load"
local prev, seq, seqStep, seqTimer, patIdx = nil, nil, 0, 0, 1
local idle = 0
local decisions = 0

local function snapshot()
  local s = {ourSp = emu:read16(US + O_SP), ourHP = emu:read16(US + O_HP),
             ourMax = emu:read16(US + O_MAX), foeSp = emu:read16(FOE + O_SP),
             foeAb = emu:read8(FOE + O_ABILITY),
             foeHP = emu:read16(FOE + O_HP), foeMax = emu:read16(FOE + O_MAX),
             pp = {}, moves = {}}
  for i = 0, 3 do
    s.pp[i+1] = emu:read8(FOE + O_PP + i)
    s.moves[i+1] = emu:read16(FOE + O_MOVES + i*2)
  end
  return s
end

local function log(action, moveId, newSp, newAb)
  decisions = decisions + 1
  out:write(string.format("%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%s\t%d\t%d\t%d\n",
    ep, EPISODES[ep].si, EPISODES[ep].pi, frame,
    prev.ourSp, prev.ourHP, prev.ourMax,
    prev.foeSp, prev.foeAb, prev.foeHP, prev.foeMax,
    action, moveId, newSp, newAb or 0))
  out:flush()
end

local function tick()
  if phase == "done" then return end

  if phase == "load" then
    ep = ep + 1
    if ep > #EPISODES then
      console:log(string.format("battle_oracle: done, %d decisions from %d episodes -> %s",
        decisions, #EPISODES, OUT))
      out:close(); phase = "done"; return
    end
    if not pcall(function() emu:loadStateFile(STATES[EPISODES[ep].si]) end) then
      console:error("cannot load state"); phase = "done"; return
    end
    patIdx = EPISODES[ep].pi           -- starting offset; it rotates from here
    seq = PATTERNS[patIdx]
    seqStep, seqTimer, frame, idle = 0, 0, 0, 0
    prev = snapshot()
    emu:setKeys(0)
    phase = "run"
    return
  end

  -- run
  frame = frame + 1
  idle = idle + 1
  if frame >= EPISODE_FRAMES or idle >= IDLE_LIMIT then
    emu:setKeys(0)
    console:log(string.format("  episode %d: %d frames, %s", ep, frame,
      idle >= IDLE_LIMIT and "battle over" or "frame cap"))
    phase = "load"
    return
  end

  -- drive the buttons
  seqTimer = seqTimer + 1
  if seqTimer <= HOLD then emu:setKeys(seq[seqStep + 1] or KEY_A)
  else
    emu:setKeys(0)
    if seqTimer >= HOLD + GAP then
      seqStep = seqStep + 1
      seqTimer = 0
      if seqStep >= #seq then          -- pattern finished: advance to the next
        seqStep = 0
        patIdx = (patIdx % #PATTERNS) + 1
        seq = PATTERNS[patIdx]
      end
    end
  end

  -- watch the foe
  local now = snapshot()
  if now.foeSp ~= prev.foeSp then
    log("switch", 0, now.foeSp, now.foeAb); idle = 0
  else
    for i = 1, 4 do
      if now.pp[i] < prev.pp[i] then log("move", prev.moves[i], 0, 0); idle = 0; break end
    end
  end
  prev = now
end

callbacks:add("frame", tick)
console:log(string.format("battle_oracle: %d episodes (%d states x %d patterns)",
  #EPISODES, #STATES, #PATTERNS))
