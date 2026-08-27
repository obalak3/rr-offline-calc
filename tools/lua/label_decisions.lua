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

local KEY_A, KEY_RIGHT, KEY_DOWN, KEY_B = 1, 16, 128, 2
local PATTERNS = {
  {KEY_B, KEY_A, KEY_A},
  {KEY_B, KEY_A, KEY_RIGHT, KEY_A},
  {KEY_B, KEY_A, KEY_DOWN, KEY_A},
  {KEY_B, KEY_A, KEY_DOWN, KEY_RIGHT, KEY_A},
}
local HOLD, GAP, EPISODE_FRAMES, IDLE_LIMIT = 5, 22, 26000, 2600

if _RR_LBL_ACTIVE then
  console:error("label_decisions: already running. Quit mGBA first."); return
end
_RR_LBL_ACTIVE = true

local out = io.open(OUT .. "labels.tsv", "a")
out:write("# session " .. os.date() .. "\n")
out:write("statefile\taction\tmove_id\tslot\tnew_species\n")

local EPISODES = {}
for si = 1, #STATES do
  for pi = 1, #PATTERNS do EPISODES[#EPISODES+1] = {si = si, pi = pi} end
end

local ep, frame, phase, idle = 0, 0, "load", 0
local prev, seq, seqStep, seqTimer, patIdx = nil, nil, 0, 0, 1
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
    patIdx = EPISODES[ep].pi
    seq = PATTERNS[patIdx]
    seqStep, seqTimer, frame, idle = 0, 0, 0, 0
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

  seqTimer = seqTimer + 1
  if seqTimer <= HOLD then
    -- A state saved at the START of each input cycle is (approximately) the
    -- menu-time state the upcoming decision must be derivable from.
    if seqStep == 0 and seqTimer == 1 then
      saveCount = saveCount + 1
      lastSave = string.format("ep%03d_f%06d.ss", ep, frame)
      pcall(function() emu:saveStateFile(OUT .. lastSave) end)
    end
    emu:setKeys(seq[seqStep + 1] or KEY_A)
  else
    emu:setKeys(0)
    if seqTimer >= HOLD + GAP then
      seqStep = seqStep + 1
      seqTimer = 0
      if seqStep >= #seq then
        seqStep = 0
        patIdx = (patIdx % #PATTERNS) + 1
        seq = PATTERNS[patIdx]
      end
    end
  end

  local now = snapshot()
  if now.sp ~= prev.sp and now.sp ~= 0 and prev.sp ~= 0 then
    labels = labels + 1
    out:write(string.format("%s\tswitch\t0\t-1\t%d\n", lastSave, now.sp))
    out:flush(); idle = 0
  elseif now.sp == prev.sp then
    for i = 1, 4 do
      if now.pp[i] < prev.pp[i] and prev.moves[i] ~= 0 then
        labels = labels + 1
        out:write(string.format("%s\tmove\t%d\t%d\t0\n",
          lastSave, prev.moves[i], i - 1))
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
