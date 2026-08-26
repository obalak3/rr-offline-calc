-- Which memory address actually decides the roll? Sweep the candidates.
-- Load with Tools > Scripting > File > Load script. ONCE -- mGBA stacks a
-- frame callback per load and never removes the old one.
--
-- WHY THIS REPLACES THE SEED SWEEP. seed_probe wrote 128 different values into
-- 0x03000204 and every trial produced a BYTE-IDENTICAL end state, with the
-- written value still sitting there afterwards. So the write lands, persists,
-- and is never read. That address is dead. It looked perfect on every
-- correlational test -- high-entropy, one distinct value per battle, untouched
-- by idling -- which is the eighth pass's lesson again: a variable being
-- present and plausible says nothing about whether anything consults it.
--
-- So instead of varying the VALUE at one address, vary the ADDRESS. Each trial
-- corrupts one candidate with a fixed arbitrary value and records the end
-- state. Trial 1 is a CONTROL that writes nothing, and it is the baseline
-- every other trial is compared against: any address whose trial differs from
-- the control is read by something that matters. Any address whose trial
-- matches the control is dead, like 0x03000204.
--
-- 45 candidates, from the save-state filter: constant across an idle pair,
-- distinct in all five recorded battles, non-zero throughout.

local STATE = os.getenv("HOME") .. "/RadicalRed-mGBA/RadicalRed.ss5"
local OUT   = os.getenv("HOME") .. "/rr-screen-corpus/addr_sweep.tsv"

local POKE = 0x5A5A5A5A   -- arbitrary, just needs to differ from whatever is there

local PRESS, GAP, TAPS, SETTLE = 6, 30, 3, 1800
local KEY_A = 1

local ADDRS = {
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

-- GUARD AGAINST A SECOND COPY. mGBA adds a frame callback per script load and
-- does not remove the previous one, and closing the Scripting window does not
-- unload it either. Two live copies both call loadStateFile, so one resets the
-- state while the other is mid-press -- which looks exactly like broken timing
-- and wasted a long debugging detour. Only restarting the emulator truly
-- clears the context; this at least makes the situation visible.
if _RR_SWEEP_ACTIVE then
  console:error("addr_sweep: ALREADY RUNNING. Restart mGBA before loading again.")
  return
end
_RR_SWEEP_ACTIVE = true

local function digest(base, len)
  local s = emu:readRange(base, len)
  local h = 5381
  for i = 1, #s, 5 do h = (h * 33 + s:byte(i)) % 4294967296 end
  return h
end

local out = io.open(OUT, "w")
out:write("trial\taddr\tbefore\tafter\td1\td2\td3\n")

local trial, phase, t, taps, before = 0, "load", 0, 0, 0

local function tick()
  if phase == "done" then return end
  t = t + 1

  if phase == "load" then
    trial = trial + 1
    if trial > #ADDRS + 1 then
      console:log("addr_sweep: done -> " .. OUT); out:close(); phase = "done"; return
    end
    if not pcall(function() emu:loadStateFile(STATE) end) then
      console:error("addr_sweep: cannot load " .. STATE); phase = "done"; return
    end
    if trial > 1 then
      local a = ADDRS[trial - 1]
      before = emu:read32(a)
      emu:write32(a, POKE)
    else
      before = 0            -- control trial: nothing written
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
      local a = (trial > 1) and ADDRS[trial - 1] or 0
      out:write(string.format("%d\t%d\t%d\t%d\t%d\t%d\t%d\n",
        trial, a, before, (a ~= 0) and emu:read32(a) or 0,
        digest(0x02020000, 0x8000),
        digest(0x02028000, 0x8000),
        digest(0x03000000, 0x4000)))
      out:flush()
      t, phase = 0, "load"
    end
  end
end

callbacks:add("frame", tick)
console:log(string.format("addr_sweep: 1 control + %d addresses", #ADDRS))
