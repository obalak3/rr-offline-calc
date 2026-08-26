-- Write a candidate RNG value, play the turn, record what happened, reset.
-- Load with Tools > Scripting > File > Load script. Load it ONCE: mGBA adds a
-- frame callback per load and does not remove the old one, so loading twice
-- puts two copies in a fight over the same emulator.
--
-- WHY WRITE RATHER THAN OBSERVE. Everything before this was correlational --
-- "this word differs across states whose outcomes differed" -- and correlation
-- has misled this project repeatedly. Writing is causal: if poking the value
-- changes the outcome, it IS the seed; if it changes nothing, it is not.
-- It is also the only way to get samples, since reloading one state always
-- replays identically.
--
-- TIMING IS GENEROUS ON PURPOSE. Three earlier versions failed on it: reading
-- HP from a mis-computed address, a memory scan that stalled the frame
-- callback until presses stopped landing, and a settle window that reset
-- before the turn had finished. Every one produced numbers that looked like
-- data. Waiting too long costs minutes; sampling too early produces a
-- confounded result that looks like a discovery.

local STATE = os.getenv("HOME") .. "/RadicalRed-mGBA/RadicalRed.ss5"
local OUT   = os.getenv("HOME") .. "/rr-screen-corpus/seed_probe.tsv"

local ADDR, WIDTH = 0x03000204, 16

local PRESS  = 6      -- frames to hold A
local GAP    = 30     -- frames between presses
local TAPS   = 3      -- presses needed to get through the menu and fire
local SETTLE = 1800   -- ~30s of game time: move, damage, message, switch-in

local KEY_A = 1

local seeds = {}
for i = 0, 127 do seeds[#seeds + 1] = (i * 517) % 65536 end

local function digest(base, len)
  local s = emu:readRange(base, len)
  local h = 5381
  for i = 1, #s, 5 do h = (h * 33 + s:byte(i)) % 4294967296 end
  return h
end

local out = io.open(OUT, "w")
out:write("trial\tseed_written\tseed_after\td1\td2\td3\n")

local trial, phase, t, taps = 0, "load", 0, 0

local function tick()
  if phase == "done" then return end
  t = t + 1

  if phase == "load" then
    trial = trial + 1
    if trial > #seeds then
      console:log("seed_probe: done, " .. #seeds .. " trials -> " .. OUT)
      out:close(); phase = "done"; return
    end
    if not pcall(function() emu:loadStateFile(STATE) end) then
      console:error("seed_probe: cannot load " .. STATE); phase = "done"; return
    end
    if WIDTH == 16 then emu:write16(ADDR, seeds[trial])
    else emu:write32(ADDR, seeds[trial]) end
    emu:setKeys(0)
    t, taps, phase = 0, 0, "press"

  elseif phase == "press" then
    if t <= PRESS then
      emu:setKeys(KEY_A)
    else
      emu:setKeys(0)
      if t >= PRESS + GAP then
        taps = taps + 1
        t = 0
        if taps >= TAPS then phase = "settle" end
      end
    end

  elseif phase == "settle" then
    emu:setKeys(0)
    if t >= SETTLE then
      local after = (WIDTH == 16) and emu:read16(ADDR) or emu:read32(ADDR)
      out:write(string.format("%d\t%d\t%d\t%d\t%d\t%d\n",
        trial, seeds[trial], after,
        digest(0x02020000, 0x8000),
        digest(0x02028000, 0x8000),
        digest(0x03000000, 0x4000)))
      out:flush()
      t, phase = 0, "load"
    end
  end
end

callbacks:add("frame", tick)
console:log(string.format("seed_probe: %d trials at 0x%08X", #seeds, ADDR))
