-- Can the measurement detect a change at all? Four trials, about a minute.
-- Load ONCE. Quit mGBA first if a script is already loaded.
--
-- WHY THIS EXISTS. rng_hunt ran 48 trials and produced exactly ONE distinct
-- VRAM digest -- including 20 trials that corrupted addresses the game
-- actively rewrites with tile data. A byte-identical screen after corrupting
-- live graphics buffers is not believable, so the likelier explanation is that
-- the measurement is blind and every "this address is dead" verdict from that
-- run is worthless.
--
-- That is the failure this project keeps repeating: a null result that cannot
-- be told apart from a broken instrument. So before trusting any null, prove
-- the instrument can see a difference that is KNOWN to exist.
--
-- The four trials press A a different number of times, which selects a
-- different move or no move at all. Those MUST produce different screens and
-- different memory. If the digests still come out identical, the reader is
-- broken and the earlier run means nothing.
--
-- Five digests are recorded per trial, over different domains, so a domain
-- that readRange cannot actually reach shows up as a column that never moves
-- while the others do.

local STATE = os.getenv("HOME") .. "/RadicalRed-mGBA/RadicalRed.ss5"
local OUT   = os.getenv("HOME") .. "/rr-screen-corpus/signal_check.tsv"

local PRESS, GAP, SETTLE = 6, 30, 700
local KEY_A = 1
local TAP_COUNTS = {0, 1, 2, 3, 4}

if _RR_SIG_ACTIVE then
  console:error("signal_check: ALREADY RUNNING. Quit mGBA before reloading.")
  return
end
_RR_SIG_ACTIVE = true

local function digest(base, len)
  local ok, s = pcall(function() return emu:readRange(base, len) end)
  if not ok or not s or #s == 0 then return -1 end
  local h = 5381
  for i = 1, #s, 5 do h = (h * 33 + s:byte(i)) % 4294967296 end
  return h
end

local out = io.open(OUT, "w")
out:write("trial\ttaps\tvram\tewram_a\tewram_b\tiwram\tpalette\n")

local trial, phase, t, taps = 0, "load", 0, 0

local function tick()
  if phase == "done" then return end
  t = t + 1

  if phase == "load" then
    trial = trial + 1
    if trial > #TAP_COUNTS then
      console:log("signal_check: done -> " .. OUT); out:close(); phase = "done"; return
    end
    if not pcall(function() emu:loadStateFile(STATE) end) then
      console:error("signal_check: cannot load " .. STATE); phase = "done"; return
    end
    emu:setKeys(0)
    t, taps, phase = 0, 0, "press"

  elseif phase == "press" then
    if taps >= TAP_COUNTS[trial] then
      emu:setKeys(0); t, phase = 0, "settle"
    elseif t <= PRESS then
      emu:setKeys(KEY_A)
    else
      emu:setKeys(0)
      if t >= PRESS + GAP then taps, t = taps + 1, 0 end
    end

  elseif phase == "settle" then
    emu:setKeys(0)
    if t >= SETTLE then
      out:write(string.format("%d\t%d\t%d\t%d\t%d\t%d\t%d\n",
        trial, TAP_COUNTS[trial],
        digest(0x06000000, 0x18000),   -- VRAM
        digest(0x02020000, 0x8000),    -- EWRAM low
        digest(0x02030000, 0x8000),    -- EWRAM high
        digest(0x03000000, 0x4000),    -- IWRAM
        digest(0x05000000, 0x400)))    -- palette
      out:flush()
      t, phase = 0, "load"
    end
  end
end

callbacks:add("frame", tick)
console:log("signal_check: 5 trials with different tap counts")
