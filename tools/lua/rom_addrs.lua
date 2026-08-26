-- Test the RNG addresses the ROM ITSELF names. Load ONCE; quit mGBA first.
--
-- WHY THIS SUPERSEDES EVERYTHING BEFORE IT. Every address tested today came
-- from differencing save-state FILES, using assumed offsets for where IWRAM
-- and EWRAM sit inside mGBA's serialized state. Those offsets were wrong --
-- proved by the ROM naming 0x03005000 as the RNG while that word reads as ZERO
-- through the parser, and by the party HP reading zero from an address the same
-- arithmetic produced. So the 48 "dead" verdicts were not about dead
-- addresses; they were about addresses that do not exist.
--
-- The ROM does not require any of that. An ARM literal pool keeps a function's
-- constants together, so the word sitting beside the LCG multiplier
-- 0x41C64E6D IS the seed's address. Found by searching the ROM for the
-- constant, which is the standard way to do this and needs no guessing.
--
--   0x03005000  named twice, and the vanilla FireRed gRngValue
--   0x0202063C  named three times
--   0x020386D0, 0x0203AB16, 0x0203F3D4
--
-- Each gets three values, because one value could coincide with what is
-- already there. Trial 1 writes nothing and is the control.
--
-- The measurement is trusted now: signal_check varied the tap count and the
-- digests moved (VRAM 4010722709 / 985476778 / 2377212464 / 1564892215), so a
-- null here means the address really is not read, not that we are blind.

local STATE = os.getenv("HOME") .. "/RadicalRed-mGBA/RadicalRed.ss5"
local OUT   = os.getenv("HOME") .. "/rr-screen-corpus/rom_addrs.tsv"

local PRESS, GAP, TAPS, SETTLE = 6, 30, 3, 700
local KEY_A = 1

local ADDRS  = {0x03005000, 0x0202063C, 0x020386D0, 0x0203AB16, 0x0203F3D4}
local VALUES = {0x00000000, 0xA5A5A5A5, 0xDEADBEEF}

if _RR_ROM_ACTIVE then
  console:error("rom_addrs: ALREADY RUNNING. Quit mGBA before reloading.")
  return
end
_RR_ROM_ACTIVE = true

local TRIALS = {}
for _, a in ipairs(ADDRS) do
  for _, v in ipairs(VALUES) do TRIALS[#TRIALS+1] = {addr = a, val = v} end
end

local function digest(base, len)
  local ok, s = pcall(function() return emu:readRange(base, len) end)
  if not ok or not s or #s == 0 then return -1 end
  local h = 5381
  for i = 1, #s, 5 do h = (h * 33 + s:byte(i)) % 4294967296 end
  return h
end

local out = io.open(OUT, "w")
out:write("trial\taddr\tvalue\tbefore\tafter\tvram\tewram\n")

local trial, phase, t, taps, before = 0, "load", 0, 0, 0

local function tick()
  if phase == "done" then return end
  t = t + 1

  if phase == "load" then
    trial = trial + 1
    if trial > #TRIALS + 1 then
      console:log("rom_addrs: done -> " .. OUT); out:close(); phase = "done"; return
    end
    if not pcall(function() emu:loadStateFile(STATE) end) then
      console:error("rom_addrs: cannot load " .. STATE); phase = "done"; return
    end
    if trial > 1 then
      local x = TRIALS[trial-1]
      before = emu:read32(x.addr)
      emu:write32(x.addr, x.val)
    else
      before = 0
    end
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
      local a, v = 0, 0
      if trial > 1 then a, v = TRIALS[trial-1].addr, TRIALS[trial-1].val end
      out:write(string.format("%d\t%d\t%d\t%d\t%d\t%d\t%d\n",
        trial, a, v, before, (a ~= 0) and emu:read32(a) or 0,
        digest(0x06000000, 0x18000), digest(0x02020000, 0x8000)))
      out:flush()
      t, phase = 0, "load"
    end
  end
end

callbacks:add("frame", tick)
console:log(string.format("rom_addrs: 1 control + %d trials", #TRIALS))
