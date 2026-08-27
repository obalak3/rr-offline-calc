-- Find the PARTY SCREEN cursor by diff-of-diffs, exactly as the action-menu
-- cursor was found. Load ONCE (quit mGBA first). ~30s.
-- Writes ~/rr-screen-corpus/party_cursor.txt
--
-- Why: three rounds of frame-count guessing left DOWN presses being eaten in
-- the party screen -- the cursor stayed on the active slot and the harness
-- kept re-selecting Lanturn. James: "only one button click is failing."
-- Writing the cursor removes the timing question entirely, but only the
-- MEASURED address may be written; the guessed action-cursor address was
-- wrong by a kilobyte.

local STATE = os.getenv("HOME") .. "/rr-screen-corpus/savestates/ss5.ss"
local OUT = os.getenv("HOME") .. "/rr-screen-corpus/party_cursor.txt"
local ACTION_CURSOR, ACT_POKEMON = 0x02023FF8, 2
local KEY_A, KEY_DOWN = 1, 128
local IW, IWLEN, EW, EWLEN = 0x03000000, 0x8000, 0x02000000, 0x40000

if _RR_PC then console:error("already running; quit mGBA first"); return end
_RR_PC = true
local R = io.open(OUT, "w")
local function say(m) console:log(m); R:write(m.."\n"); R:flush() end
local function snap() return {iw=emu:readRange(IW,IWLEN), ew=emu:readRange(EW,EWLEN)} end
local function changed(a,b)
  local s={}
  for i=1,#a.iw do if a.iw:byte(i)~=b.iw:byte(i) then s["I"..i]=true end end
  for i=1,#a.ew do if a.ew:byte(i)~=b.ew:byte(i) then s["E"..i]=true end end
  return s
end

local phase,t = "load",0
local base,ctrlSet,treatBefore,snap1

local function tick()
  if phase=="done" then return end
  t=t+1
  if phase=="load" then
    if not pcall(function() emu:loadStateFile(STATE) end) then say("load failed"); phase="done"; return end
    emu:setKeys(0); t=0; phase="open1"
  elseif phase=="open1" then
    if t==5 then emu:write8(ACTION_CURSOR, ACT_POKEMON) end
    emu:setKeys(t>=6 and t<=12 and KEY_A or 0)
    if t>150 then base=snap(); t=0; phase="ctrl" end   -- generous settle: 2.5s
  elseif phase=="ctrl" then
    emu:setKeys(0)
    if t>40 then
      ctrlSet=changed(base,snap())
      local c=0; for _ in pairs(ctrlSet) do c=c+1 end
      say("party screen open; control drift: "..c.." bytes")
      treatBefore=snap(); t=0; phase="treat"
    end
  elseif phase=="treat" then
    -- ONE Down, settle, snapshot; then ANOTHER Down, settle, snapshot.
    -- The cursor is whatever counts 0 -> 1 -> 2 in lockstep with the
    -- presses. 338 bytes moved on a single press (cursor-slide animation,
    -- sound engine); nothing but a slot index counts monotonically.
    emu:setKeys(t<=8 and KEY_DOWN or 0)
    if t>50 then snap1=snap(); t=0; phase="treat2" end
  elseif phase=="treat2" then
    emu:setKeys(t<=8 and KEY_DOWN or 0)
    if t>50 then
      local snap2=snap()
      local n=0
      say("bytes stepping by a CONSTANT stride across two DOWNs (any stride):")
      -- A slot index steps by 1; a pixel-coordinate cursor steps by the row
      -- height (8, 16, 24...). Any byte with x -> x+d -> x+2d for constant
      -- d is cursor-shaped; the audio counter that fooled the +1-only probe
      -- gets filtered by requiring d to reproduce EXACTLY twice and by
      -- excluding the sound-engine region reported last run.
      for _,seg in ipairs({{treatBefore.iw,snap1.iw,snap2.iw,IW,"I"},{treatBefore.ew,snap1.ew,snap2.ew,EW,"E"}}) do
        local a,b,c,basea=seg[1],seg[2],seg[3],seg[4]
        for i=1,#a do
          local x,y,z=a:byte(i),b:byte(i),c:byte(i)
          local d=y-x
          if d~=0 and d>-65 and d<65 and z-y==d then
            local addr=basea+i-1
            if not (addr>=0x03005F00 and addr<=0x03007000) then  -- sound engine
              n=n+1
              if n<=15 then say(string.format("   0x%08X  %d -> %d -> %d  (stride %+d)", addr,x,y,z,d)) end
            end
          end
        end
      end
      say("   monotone hits: "..n)
      say("done"); R:close(); phase="done"
    end
  end
end
callbacks:add("frame", tick)
console:log("find_party_cursor -> "..OUT)
