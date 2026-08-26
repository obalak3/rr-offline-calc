-- Do the oracle's HP writes actually reach the game, and does the turn run?
-- Load ONCE. Quit mGBA first.
--
-- The pilot returned ONE action per state across all 25 HP combinations, and
-- two states returned "unknown" for every position. Two very different causes
-- produce that, and they need separating before anything is scaled up:
--   (a) the writes never land, or are overwritten, so every trial is really
--       the same position -- in which case the oracle measures nothing;
--   (b) the writes land fine and the AI genuinely has one best action across
--       the whole HP range -- in which case the data is real and boring.
-- Guessing between them is how today's worst hours were spent.
--
-- So this logs the HP READ BACK at three moments: immediately after writing,
-- after a short delay, and once the turn has resolved. If the value survives
-- to the second read, the write reached the game and (b) is the explanation.
-- It also records whether any PP moved at all, which separates "the turn ran
-- and the AI chose" from "the buttons never opened the menu".

local STATES = {}
for i = 1, 5 do STATES[i] = os.getenv("HOME") .. "/RadicalRed-mGBA/RadicalRed.ss" .. i end
local OUT = os.getenv("HOME") .. "/rr-screen-corpus/oracle_check.tsv"

local MON, SIZE = 0x02023BE4, 0x58
local US, FOE = MON, MON + SIZE
local O_SP, O_MOVES, O_PP, O_HP, O_MAX = 0x00, 0x0C, 0x24, 0x28, 0x2C

local KEY_A = 1
local PRESS, GAP, TAPS, SETTLE = 6, 30, 4, 620
local CHECK_AT = 90            -- frames after the write, before any pressing

if _RR_CHK_ACTIVE then
  console:error("oracle_check: ALREADY RUNNING. Quit mGBA first."); return
end
_RR_CHK_ACTIVE = true

local out = io.open(OUT, "w")
out:write("state\twrote_our\tread_immediately\tread_after_90f\tour_after_turn\t" ..
          "pp_before\tpp_after\tspecies_before\tspecies_after\n")

local function ppstr(base)
  local t = {}
  for i = 0, 3 do t[#t+1] = emu:read8(base + O_PP + i) end
  return table.concat(t, ",")
end

local idx, phase, t, taps, rec = 0, "load", 0, 0, nil

local function tick()
  if phase == "done" then return end
  t = t + 1

  if phase == "load" then
    idx = idx + 1
    if idx > #STATES then
      console:log("oracle_check: done -> " .. OUT); out:close(); phase = "done"; return
    end
    if not pcall(function() emu:loadStateFile(STATES[idx]) end) then
      console:error("cannot load " .. STATES[idx]); phase = "done"; return
    end
    local mx = emu:read16(US + O_MAX)
    local target = math.max(1, math.floor(mx * 0.15))   -- a big, obvious change
    emu:write16(US + O_HP, target)
    rec = {wrote = target, imm = emu:read16(US + O_HP),
           ppb = ppstr(FOE), spb = emu:read16(FOE + O_SP)}
    emu:setKeys(0)
    t, taps, phase = 0, 0, "hold"

  elseif phase == "hold" then
    emu:setKeys(0)
    if t >= CHECK_AT then
      rec.after90 = emu:read16(US + O_HP)
      t, phase = 0, "press"
    end

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
      out:write(string.format("%d\t%d\t%d\t%d\t%d\t%s\t%s\t%d\t%d\n",
        idx, rec.wrote, rec.imm, rec.after90, emu:read16(US + O_HP),
        rec.ppb, ppstr(FOE), rec.spb, emu:read16(FOE + O_SP)))
      out:flush()
      t, phase = 0, "load"
    end
  end
end

callbacks:add("frame", tick)
console:log("oracle_check: 5 states, writes verified at three moments")
