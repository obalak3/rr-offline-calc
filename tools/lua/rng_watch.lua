-- Watch the battle RNG candidates live, inside mGBA.
-- Load with Tools > Scripting > File > Load script, then just play.
--
-- WHY THIS EXISTS. The save-state search narrowed the value that decides a
-- crit or a burn from 65,536 words to two, using states James labelled by
-- outcome. Confirming which one, and learning how many advances separate a
-- decision point from the roll it produces, needs many labelled observations.
-- Collecting those by hand is hours of quicksaving. mGBA 0.10.5 ships Lua and
-- can read the same memory every frame while the game is played normally.
--
-- This does NOT replace the screen reader and does not change how the game is
-- played. It writes one line per change to a log, nothing else.

local CANDIDATES = {
  {name = "iwram_204", addr = 0x03000204, bits = 16},  -- prime suspect
  {name = "iwram_178", addr = 0x03000178, bits = 16},
  {name = "ewram_15D00", addr = 0x02015D00, bits = 32}, -- ticks while idle
}

local LOG = os.getenv("HOME") .. "/rr-screen-corpus/rng_watch.log"
local last = {}
local frame = 0
local out = io.open(LOG, "a")

local function read(c)
  if c.bits == 16 then return emu:read16(c.addr) end
  return emu:read32(c.addr)
end

local function tick()
  frame = frame + 1
  for _, c in ipairs(CANDIDATES) do
    local ok, v = pcall(read, c)
    if ok and v ~= last[c.name] then
      -- Log the CHANGE, not the value every frame: what matters is when a
      -- value moves and how far, since a seed advancing only on real events
      -- is exactly what distinguishes it from a frame counter.
      out:write(string.format("%d\t%s\t%s\t%s\n", frame, c.name,
        last[c.name] and string.format("%X", last[c.name]) or "-",
        string.format("%X", v)))
      out:flush()
      last[c.name] = v
    end
  end
end

callbacks:add("frame", tick)
console:log("rng_watch: logging to " .. LOG)
