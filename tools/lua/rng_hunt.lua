-- WHICH memory word decides the roll? One unattended run, no reloading.
-- Load ONCE with Tools > Scripting > File > Load script.
-- If it ever needs restarting, QUIT mGBA first: closing the Scripting window
-- does not unload a script, and two live copies fight over loadStateFile,
-- which looks exactly like broken timing and cost a long detour to notice.
--
-- THE EXPERIMENT. ss5 always crits -- that is what makes it a test bench
-- rather than a problem. Load it, change ONE thing, play the turn:
--   outcome unchanged  -> that word does not decide the roll
--   outcome changed    -> it does
-- Trial 1 changes nothing and is the control every other trial is read
-- against.
--
-- ORDER MATTERS. 0x02015D00 is tested FIRST and with four values, because it
-- is the only word in RAM that satisfies the LCG recurrence between two states
-- (8CE26C62 -> 4DE9B161 in 3461 advances, with invented constants matching
-- nothing). It was set aside on the grounds that it ticks while idling and
-- idling does not change outcomes -- but the idle pair was not captured on the
-- action-select menu, so a generator that only advances during animations
-- would look exactly like this. That reasoning was never tested, only assumed.
--
-- 0x03000204 is NOT retried: 128 values written, byte-identical outcome every
-- time, value still present afterwards. Written, never read. Dead.
--
-- THE OUTCOME SIGNAL IS VRAM, deliberately. The earlier digests hashed the
-- same memory being written, so a write could register as an "outcome change"
-- by hashing itself. VRAM is never touched here, and a different damage roll
-- draws a different health bar, so it reflects the RESULT and nothing else.

local STATE = os.getenv("HOME") .. "/RadicalRed-mGBA/RadicalRed.ss5"
local OUT   = os.getenv("HOME") .. "/rr-screen-corpus/rng_hunt.tsv"

local PRESS, GAP, TAPS, SETTLE = 6, 30, 3, 700
local KEY_A = 1

local VALUES = {0x00000000, 0x11111111, 0xA5A5A5A5, 0xDEADBEEF}

local PRIME = {0x02015D00}
local REST  = {
  0x03000178,
  0x03000204,
  0x020115C8,
  0x02011CB0,
  0x02017DC8,
  0x02017DD0,
  0x02017E40,
  0x02017E48,
  0x02017E50,
  0x020184F0,
  0x020184F8,
  0x02018500,
  0x02018504,
  0x0201850C,
  0x02018534,
  0x0201853C,
  0x02018544,
  0x0201854C,
  0x02018554,
  0x02018574,
  0x02018598,
  0x0201859C,
  0x020185A8,
  0x020185B4,
  0x020185C4,
  0x02018780,
  0x020189EC,
  0x020190BC,
  0x02038D00,
  0x02039500,
  0x0203C310,
  0x0203C31C,
  0x0203C984,
  0x0203C990,
  0x0203CB80,
  0x0203CD2C,
  0x0203CD30,
  0x0203CD90,
  0x0203CD94,
  0x0203CDF4,
  0x0203CDF8,
  0x0203CE58,
  0x0203CE5C,
  0x0203CEBC,
  0x0203CEC0
}

-- Build the trial list: the prime suspect with every test value, then the
-- filtered candidates with one value each.
local TRIALS = {}
for _, v in ipairs(VALUES) do
  for _, a in ipairs(PRIME) do TRIALS[#TRIALS+1] = {addr = a, val = v} end
end
for _, a in ipairs(REST) do
  if a ~= 0x03000204 then TRIALS[#TRIALS+1] = {addr = a, val = 0xA5A5A5A5} end
end

if _RR_HUNT_ACTIVE then
  console:error("rng_hunt: ALREADY RUNNING. Quit mGBA before loading again.")
  return
end
_RR_HUNT_ACTIVE = true

local function digest(base, len)
  local s = emu:readRange(base, len)
  local h = 5381
  for i = 1, #s, 5 do h = (h * 33 + s:byte(i)) % 4294967296 end
  return h
end

local out = io.open(OUT, "w")
out:write("trial\taddr\tvalue\tbefore\tafter\tvram\n")

local trial, phase, t, taps, before = 0, "load", 0, 0, 0

local function tick()
  if phase == "done" then return end
  t = t + 1

  if phase == "load" then
    trial = trial + 1
    if trial > #TRIALS + 1 then
      console:log("rng_hunt: done, " .. #TRIALS .. " trials -> " .. OUT)
      out:close(); phase = "done"; return
    end
    if not pcall(function() emu:loadStateFile(STATE) end) then
      console:error("rng_hunt: cannot load " .. STATE); phase = "done"; return
    end
    if trial > 1 then
      local x = TRIALS[trial - 1]
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
        taps = taps + 1; t = 0
        if taps >= TAPS then phase = "settle" end
      end
    end

  elseif phase == "settle" then
    emu:setKeys(0)
    if t >= SETTLE then
      local a, v = 0, 0
      if trial > 1 then a, v = TRIALS[trial-1].addr, TRIALS[trial-1].val end
      out:write(string.format("%d\t%d\t%d\t%d\t%d\t%d\n",
        trial, a, v, before, (a ~= 0) and emu:read32(a) or 0,
        digest(0x06000000, 0x18000)))
      out:flush()
      t, phase = 0, "load"
    end
  end
end

callbacks:add("frame", tick)
console:log(string.format("rng_hunt: 1 control + %d trials", #TRIALS))
