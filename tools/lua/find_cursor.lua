-- Locate the battle menu cursors by pressing a direction and watching RAM.
-- Load ONCE. Quit mGBA first. Takes about 20 seconds.
--
-- WHY. Driving the menus with blind button sequences does not scale: a timing
-- drift sends a direction to the ACTION menu instead of the move list, and the
-- script walks into the BAG or -- worse -- RUN, which ends the battle. Writing
-- the cursor directly removes navigation entirely: set FIGHT, set the move
-- slot, press A twice. No drift, no stray menus, and it behaves the same in
-- every fight.
--
-- Vanilla FireRed puts gActionSelectionCursor at 0x02023BCE and
-- gMoveSelectionCursor at 0x02023BD2, and gBattleMons IS at its vanilla
-- address here, so those are plausible. But the bytes there are ambiguous
-- across the save states -- 0 in four, 2 in one -- and this project has lost
-- hours to an address that looked plausible and was not (0x03000204, written
-- 128 times, read never).
--
-- So: snapshot the region, press RIGHT, snapshot again, and report what
-- changed. A cursor MUST move. Anything that does not is not it.

local STATE = os.getenv("HOME") .. "/RadicalRed-mGBA/RadicalRed.ss5"
local LO, HI = 0x02023B80, 0x02023BE4
local KEY_A, KEY_RIGHT, KEY_DOWN = 1, 16, 128

if _RR_CUR_ACTIVE then
  console:error("find_cursor: ALREADY RUNNING. Quit mGBA first."); return
end
_RR_CUR_ACTIVE = true

local function snap()
  local t = {}
  for a = LO, HI - 1 do t[a] = emu:read8(a) end
  return t
end

local function diff(a, b, label)
  local n = 0
  for addr = LO, HI - 1 do
    if a[addr] ~= b[addr] then
      console:log(string.format("  %s: 0x%08X  %d -> %d", label, addr, a[addr], b[addr]))
      n = n + 1
    end
  end
  if n == 0 then console:log("  " .. label .. ": nothing changed") end
end

local t, phase = 0, "load"
local atPrompt, afterRight, afterFight, afterDown

local function tick()
  t = t + 1
  if phase == "load" then
    if not pcall(function() emu:loadStateFile(STATE) end) then
      console:error("cannot load state"); phase = "done"; return
    end
    emu:setKeys(0); t, phase = 0, "settle1"

  elseif phase == "settle1" then
    if t > 40 then atPrompt = snap(); t, phase = 0, "right" end

  elseif phase == "right" then           -- at the ACTION menu, move the cursor
    emu:setKeys(t <= 6 and KEY_RIGHT or 0)
    if t > 50 then
      afterRight = snap()
      console:log("ACTION menu, after pressing RIGHT:")
      diff(atPrompt, afterRight, "action")
      t, phase = 0, "reset"
    end

  elseif phase == "reset" then           -- back to a clean prompt, then FIGHT
    if not pcall(function() emu:loadStateFile(STATE) end) then phase="done"; return end
    emu:setKeys(0); t, phase = 0, "fight"

  elseif phase == "fight" then
    emu:setKeys(t <= 6 and KEY_A or 0)
    if t > 60 then afterFight = snap(); t, phase = 0, "down" end

  elseif phase == "down" then            -- now in the MOVE list
    emu:setKeys(t <= 6 and KEY_DOWN or 0)
    if t > 50 then
      afterDown = snap()
      console:log("MOVE list, after pressing DOWN:")
      diff(afterFight, afterDown, "move")
      console:log("find_cursor: done")
      phase = "done"
    end
  end
end

callbacks:add("frame", tick)
console:log("find_cursor: watching 0x02023B80..0x02023BE3")
