-- WHICH generator decides the damage roll? Measured by damage, not a checksum.
-- Load ONCE. Quit mGBA first if a script is already loaded.
--
-- WHAT THE PREVIOUS RUN ESTABLISHED, and it is a real result rather than a
-- failure. Planting 43 different seeds into 0x03005000 gave:
--     advance count   808 every time  -> the stream IS ours to control
--     damage          52 every time   -> completely unaffected
--     our HP          139 every time  -> completely unaffected
-- So that generator is genuinely consumed 808 times a turn and NONE of those
-- draws decide the damage roll or the crit. That is why the crit never went
-- away no matter what was written.
--
-- The explanation was already in the ROM and I under-read it. The multiplier
-- 0x41C64E6D appears FOURTEEN times, each beside a different RAM address.
-- Those are not duplicates -- they are separate generators sharing the same
-- constants, each with its own seed. We found the general-purpose one
-- (0x03005000, vanilla gRngValue). Battle rolls use another.
--
-- DAMAGE IS THE OUTCOME SIGNAL, not a memory digest. The earlier sweep tested
-- these same addresses with a checksum and saw nothing, but a digest answers
-- "did anything change" while damage answers "did the ROLL change", and a
-- damage roll spans sixteen values so a real hit is unmistakable.
--
-- Damage is max minus current on the foe, because the AI switches in this
-- position and the replacement arrives at full health.

local STATE = os.getenv("HOME") .. "/RadicalRed-mGBA/RadicalRed.ss5"
local OUT   = os.getenv("HOME") .. "/rr-screen-corpus/battle_rng.tsv"

local FOE_HP  = 0x02023BE4 + 0x58 + 0x28
local FOE_MAX = 0x02023BE4 + 0x58 + 0x2C

local PRESS, GAP, TAPS, SETTLE = 6, 30, 3, 700
local KEY_A = 1

-- 0x020386D0 FIRST and with every value, because the save states already
-- single it out: it holds three distinct high-entropy values across three
-- differently-ending battles AND is byte-identical across the idle pair. That
-- is the exact profile of the thing that decides these rolls, and it explains
-- why waiting thirty seconds never changed an outcome. 0x03005000 also varies
-- per battle but TICKS while idle, which disqualifies it -- and the 43-seed
-- run already proved it does not move the damage. The rest are byte-identical
-- in all five states and are almost certainly configuration, kept only so a
-- null on them is on the record.
local ADDRS = {
  0x020386D0,
  0x03005000,
  0x0202063C,
  0x0203AB16,
  0x0203F3D4,
  0x0203E038,
  0x02022B4C
}
-- THE FIRST THREE ARE THE DECISIVE TEST, and they are not arbitrary. They are
-- the values 0x020386D0 actually held in the three labelled save states:
--     BEC8B585  the run that did nothing
--     E00A10DE  the run that BURNED
--     78188FC1  the run that CRIT   (ss5's own value, so this one is a control
--                                    and must reproduce the crit)
-- Planting a seed from one outcome into the state of another predicts a
-- specific result rather than merely "something changed". If writing the burn
-- seed produces a burn and the normal seed produces neither, that is the
-- generator identified and its mapping demonstrated in one run. Arbitrary
-- values could only ever show that something moved.
local VALUES = {0xBEC8B585, 0xE00A10DE, 0x78188FC1, 0x12345678}

if _RR_BRNG_ACTIVE then
  console:error("battle_rng: ALREADY RUNNING. Quit mGBA before reloading.")
  return
end
_RR_BRNG_ACTIVE = true

local TRIALS = {}
for _, a in ipairs(ADDRS) do
  for _, v in ipairs(VALUES) do TRIALS[#TRIALS+1] = {addr = a, val = v} end
end

local out = io.open(OUT, "w")
out:write("trial\taddr\tvalue\tfoe_hp\tfoe_max\tdamage\tour_hp\n")

local trial, phase, t, taps = 0, "load", 0, 0

local function tick()
  if phase == "done" then return end
  t = t + 1

  if phase == "load" then
    trial = trial + 1
    if trial > #TRIALS + 1 then
      console:log("battle_rng: done -> " .. OUT); out:close(); phase = "done"; return
    end
    if not pcall(function() emu:loadStateFile(STATE) end) then
      console:error("battle_rng: cannot load " .. STATE); phase = "done"; return
    end
    if trial > 1 then
      local x = TRIALS[trial-1]
      -- Some pool entries are not word-aligned, so write both widths; a
      -- misaligned write32 would silently do nothing on some cores.
      pcall(function() emu:write32(x.addr, x.val) end)
      pcall(function() emu:write16(x.addr, x.val % 65536) end)
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
      local hp, mx = emu:read16(FOE_HP), emu:read16(FOE_MAX)
      local a, v = 0, 0
      if trial > 1 then a, v = TRIALS[trial-1].addr, TRIALS[trial-1].val end
      out:write(string.format("%d\t%d\t%d\t%d\t%d\t%d\t%d\n",
        trial, a, v, hp, mx, mx - hp, emu:read16(0x02023BE4 + 0x28)))
      out:flush()
      t, phase = 0, "load"
    end
  end
end

callbacks:add("frame", tick)
console:log(string.format("battle_rng: 1 control + %d trials", #TRIALS))
