-- Mass-produce LABELED QUICKSAVES: a saved state at every decision point,
-- paired with what the AI then actually did. Load ONCE; quit mGBA first if
-- any script is already loaded.
--
-- WHY. James bets the AI's upcoming choice is derivable from the save file
-- ("a bit might point to the first slot, or the fourth"). Three hand-made
-- probes could not test that properly -- with only three labeled states, two
-- sharing slot 0, a slot pointer is indistinguishable from zero. This makes
-- the dataset the hunt actually needs: hundreds of (state file, known next
-- action) pairs, all four move slots represented, moves and switches both.
-- The RNG hunt only cracked after the same escalation (5 hand saves -> 256
-- automated trials); this is that step for the decision hunt.
--
-- It plays the five ARCHIVED fight states (rr-screen-corpus/savestates/,
-- the old-team saves -- James's live slots are untouched), rotating our move
-- each turn, and:
--   * saves a state into rr-screen-corpus/labels/ BEFORE each of our presses
--   * watches gBattleMons; when the foe acts (PP drop = move+slot, species
--     change = switch+target), appends: statefile, action, move id, slot,
--     incoming species  ->  labels.tsv
--
-- Fully unattended; the machine just has to stay awake. Chunkable: rows and
-- files accumulate, and rerunning adds more.

local SRC = os.getenv("HOME") .. "/rr-screen-corpus/savestates/"
local OUT = os.getenv("HOME") .. "/rr-screen-corpus/labels/"
local STATES = {"ss1.ss","ss2.ss","ss3.ss","ss4.ss","ss5.ss"}

local MON, SIZE = 0x02023BE4, 0x58
local US, FOE = MON, MON + SIZE
local O_SP, O_MOVES, O_PP = 0x00, 0x0C, 0x24

local KEY_A, KEY_B, KEY_DOWN = 1, 2, 128
local HOLD, GAP, EPISODE_FRAMES, IDLE_LIMIT = 5, 22, 26000, 2600

-- SWITCH-DRIVEN, on James's call: "this test constantly has the pokemon make
-- the same move... I would suggest switching, so that automatically the
-- opponent does different moves." Correct, and for a better reason than
-- convenience: the AI picks against WHOEVER IS OUT, so rotating our Pokemon
-- makes it vary its choice without us varying anything -- which is exactly the
-- spread of moves, slots and switch decisions the label set needs.
--
-- BAG AND RUN ARE NOW STRUCTURALLY UNREACHABLE. gActionSelectionCursor was
-- MEASURED at 0x02023FF8 (full-RAM diff with a control condition: 6
-- input-caused bytes out of 3418 drifting, and this one goes 0->1 exactly as
-- FIGHT->BAG). It is written directly, so no direction key is ever pressed at
-- the action menu -- which is the only menu where BAG and RUN can be hit. The
-- guessed address (0x02023BCE) was wrong, so pressing blind or writing the
-- guess would both have failed silently.
local ACTION_CURSOR = 0x02023FF8
local ACT_FIGHT, ACT_POKEMON = 0, 2
-- Party-screen logical cursor, MEASURED by the two-press stride probe:
-- 0x0203B0A9 holds THE PARTY SLOT ITSELF. The probe read 0 -> 2 -> 4 not
-- because the encoding is 2*slot, but because RR's party screen is a 2x3
-- GRID in party order (left column = slots 0,2,4) and DOWN walks that
-- column. James's screenshot settled it. Writing 2*slot selected slots
-- 2,4,6,8 -- hence sometimes-Lanturn, sometimes-stuck. (The +8-stride byte found alongside it is the cursor SPRITE's
-- pixel position, which follows this value.) Written, not navigated: the
-- DOWN-walk that kept re-selecting Lanturn is gone entirely. This write is
-- also the experiment: every label row now records which of ours ended up
-- active, so if this address is wrong the data says so by itself.
local PARTY_IDX = 0x0203B0A9

if _RR_LBL_ACTIVE then
  console:error("label_decisions: already running. Quit mGBA first."); return
end
_RR_LBL_ACTIVE = true

local out = io.open(OUT .. "labels.tsv", "a")
out:write("# session " .. os.date() .. "\n")
out:write("statefile\taction\tmove_id\tslot\tnew_species\tour_active\n")

local EPISODES = {}
for si = 1, #STATES do
  for pi = 1, 5 do EPISODES[#EPISODES+1] = {si = si, pi = pi} end
end

local ep, frame, phase, idle = 0, 0, "load", 0
local prev, seqTimer, stepDown = nil, 0, 1
local lastSave, saveCount, labels = "", 0, 0

local function snapshot()
  local s = {sp = emu:read16(FOE + O_SP), pp = {}, moves = {}}
  for i = 0, 3 do
    s.pp[i+1] = emu:read8(FOE + O_PP + i)
    s.moves[i+1] = emu:read16(FOE + O_MOVES + i*2)
  end
  return s
end

local function tick()
  if phase == "done" then return end

  if phase == "load" then
    ep = ep + 1
    if ep > #EPISODES then
      console:log(string.format("label_decisions: done. %d saves, %d labels.",
        saveCount, labels))
      out:close(); phase = "done"; return
    end
    if not pcall(function() emu:loadStateFile(SRC .. STATES[EPISODES[ep].si]) end) then
      console:error("cannot load " .. STATES[EPISODES[ep].si]); phase = "done"; return
    end
    stepDown = EPISODES[ep].pi
    seqTimer, frame, idle = 0, 0, 0
    prev = snapshot()
    emu:setKeys(0)
    phase = "run"
    return
  end

  frame = frame + 1
  idle = idle + 1
  if frame >= EPISODE_FRAMES or idle >= IDLE_LIMIT then
    emu:setKeys(0); phase = "load"; return
  end

  -- One cycle: save the state, force the cursor to POKEMON, confirm, walk
  -- down to the next party slot, confirm. Directions only ever land inside
  -- the party screen, where they are harmless.
  seqTimer = seqTimer + 1
  if seqTimer == 1 then
    saveCount = saveCount + 1
    lastSave = string.format("ep%03d_f%06d.ss", ep, frame)
    pcall(function() emu:saveStateFile(OUT .. lastSave) end)
  end
  if seqTimer <= 6 then
    emu:setKeys(KEY_B)                    -- unwind any half-open menu
  elseif seqTimer <= 14 then
    emu:setKeys(0)
  elseif seqTimer == 15 then
    emu:write8(ACTION_CURSOR, ACT_POKEMON)
    emu:setKeys(KEY_A)
  elseif seqTimer <= 20 then
    emu:setKeys(KEY_A)                    -- open the party screen
  elseif seqTimer <= 90 then
    emu:setKeys(0)                        -- generous settle
    if seqTimer == 88 then emu:write8(PARTY_IDX, stepDown) end
  elseif seqTimer <= 96 then
    emu:write8(PARTY_IDX, stepDown)   -- re-assert, then select
    emu:setKeys(KEY_A)
  elseif seqTimer <= 120 then
    emu:setKeys(0)                        -- Shift submenu settles
  elseif seqTimer <= 126 then
    emu:setKeys(KEY_A)                    -- confirm SHIFT
  elseif seqTimer <= 136 then
    emu:setKeys(0)
  elseif seqTimer <= 142 then
    emu:setKeys(KEY_A)                    -- spare confirm / message advance
  elseif seqTimer <= 230 then
    emu:setKeys(0)                        -- the exchange plays out
  else
    seqTimer = 0
    stepDown = (stepDown % 5) + 1
  end

  local now = snapshot()
  if now.sp ~= prev.sp and now.sp ~= 0 and prev.sp ~= 0 then
    labels = labels + 1
    out:write(string.format("%s\tswitch\t0\t-1\t%d\t%d\n", lastSave, now.sp, emu:read16(US + O_SP)))
    out:flush(); idle = 0
  elseif now.sp == prev.sp then
    for i = 1, 4 do
      if now.pp[i] < prev.pp[i] and prev.moves[i] ~= 0 then
        labels = labels + 1
        out:write(string.format("%s\tmove\t%d\t%d\t0\t%d\n",
          lastSave, prev.moves[i], i - 1, emu:read16(US + O_SP)))
        out:flush(); idle = 0
        break
      end
    end
  end
  prev = now
end

callbacks:add("frame", tick)
console:log(string.format("label_decisions: %d episodes -> %slabels.tsv",
  #EPISODES, OUT))
