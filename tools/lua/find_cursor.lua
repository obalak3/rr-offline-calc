-- Where is the battle menu cursor? Find it by DIFF-OF-DIFFS over all of RAM.
-- Load ONCE (quit mGBA first). ~30s. Writes ~/rr-screen-corpus/cursor_probe.txt
--
-- The previous version watched a 100-byte window chosen around an address I
-- had GUESSED, and reported "nothing changed" -- which proves nothing, since a
-- window built around a guess can only ever confirm that guess. This scans
-- IWRAM and EWRAM entirely: no assumption about where the cursor lives.
--
-- CONTROL CONDITION, because raw diffs are useless here. Between any two
-- moments hundreds of bytes change on their own -- frame counters, RNG,
-- animation state. So the run does the SAME wait twice: once pressing
-- nothing, once pressing a direction. Bytes that change in both are noise;
-- bytes that change ONLY when the key is pressed are input-caused, and the
-- cursor must be among them. That is the same discipline as the RNG hunt's
-- null test, which is what stopped a plausible-looking address from being
-- believed there.

local STATE = os.getenv("HOME") .. "/rr-screen-corpus/savestates/ss5.ss"
local OUT = os.getenv("HOME") .. "/rr-screen-corpus/cursor_probe.txt"
local KEY_A, KEY_RIGHT, KEY_DOWN = 1, 16, 128

local IW, IWLEN = 0x03000000, 0x8000
local EW, EWLEN = 0x02000000, 0x40000

if _RR_CUR2 then console:error("already running; quit mGBA first"); return end
_RR_CUR2 = true

local R = io.open(OUT, "w")
local function say(m) console:log(m); R:write(m.."\n"); R:flush() end

local function snap()
  return {iw = emu:readRange(IW, IWLEN), ew = emu:readRange(EW, EWLEN)}
end

local function changed(a, b)
  local set = {}
  for i = 1, #a.iw do
    if a.iw:byte(i) ~= b.iw:byte(i) then set["I"..i] = true end
  end
  for i = 1, #a.ew do
    if a.ew:byte(i) ~= b.ew:byte(i) then set["E"..i] = true end
  end
  return set
end

local function report(label, treat, ctrl, before, after)
  local n, shown = 0, 0
  say(label .. ":")
  for k in pairs(treat) do
    if not ctrl[k] then
      n = n + 1
      if shown < 25 then
        local kind, idx = k:sub(1,1), tonumber(k:sub(2))
        local base = (kind == "I") and IW or EW
        local src  = (kind == "I") and "iw" or "ew"
        say(string.format("   0x%08X  %d -> %d", base + idx - 1,
          before[src]:byte(idx), after[src]:byte(idx)))
        shown = shown + 1
      end
    end
  end
  say("   input-caused bytes: " .. n .. (n > 25 and " (first 25 shown)" or ""))
end

local phase, t, base0, ctrlAfter, treatBefore = "load", 0, nil, nil, nil
local ctrlSet, key, stage = nil, KEY_RIGHT, 1

local function tick()
  if phase == "done" then return end
  t = t + 1

  if phase == "load" then
    if not pcall(function() emu:loadStateFile(STATE) end) then
      say("cannot load " .. STATE); phase = "done"; return
    end
    emu:setKeys(0); t = 0; phase = "settle"

  elseif phase == "settle" then
    if t > 30 then base0 = snap(); t = 0; phase = "control" end

  elseif phase == "control" then          -- same wait, NO key
    emu:setKeys(0)
    if t > 40 then
      ctrlAfter = snap()
      ctrlSet = changed(base0, ctrlAfter)
      say("control (no key): " .. (function() local c=0 for _ in pairs(ctrlSet) do c=c+1 end return c end)() .. " bytes drift on their own")
      -- reload for the treatment run so both start identically
      pcall(function() emu:loadStateFile(STATE) end)
      emu:setKeys(0); t = 0; phase = "settle2"
    end

  elseif phase == "settle2" then
    if t > 30 then treatBefore = snap(); t = 0; phase = "treat" end

  elseif phase == "treat" then           -- same wait, WITH key
    emu:setKeys(t <= 8 and key or 0)
    if t > 40 then
      local after = snap()
      report(stage == 1 and "ACTION menu, RIGHT pressed" or "MOVE list, DOWN pressed",
        changed(treatBefore, after), ctrlSet, treatBefore, after)
      if stage == 1 then
        -- stage 2: open FIGHT first, then press DOWN
        stage, key = 2, KEY_DOWN
        pcall(function() emu:loadStateFile(STATE) end)
        emu:setKeys(0); t = 0; phase = "openfight"
      else
        say("find_cursor: done"); R:close(); phase = "done"
      end
    end

  elseif phase == "openfight" then
    emu:setKeys(t <= 8 and KEY_A or 0)
    if t > 50 then treatBefore = snap(); t = 0; phase = "treat" end
  end
end

callbacks:add("frame", tick)
console:log("find_cursor: full-RAM scan with control condition -> " .. OUT)
