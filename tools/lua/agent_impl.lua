-- THE ACTUATOR. Reads the battle, hands it to the planner, plays what comes
-- back, and checks that what it played actually happened.
--
-- Load ONCE per mGBA session, with a battle in progress. Quit mGBA first if
-- any other script is loaded; script loads stack and closing the Scripting
-- window does not unload them.
--
-- It NEVER presses a button without first reading which screen is up. Every
-- button failure this project has had came from not being able to do that --
-- a DOWN-walk that kept re-selecting the same Pokemon, a menu that bounced in
-- and out ten times, an address guessed a kilobyte from where it lives. The
-- screen map is docs/SCREEN-MAP.md, measured across two save states and
-- verified against James's screenshots of the real menus.
--
-- The loop is turn by turn, not a script:
--     wait until the game is asking us for an action
--     write the position, and what the AI has ALREADY committed to, to a file
--     wait for the planner to answer with one action
--     play it, verifying each menu transition before the next press
--     record what was predicted against what happened
-- The prediction log is the point of the early fights. Losing them is fine;
-- the log is what closes the gaps in the roll model.

local DIR = os.getenv("HOME") .. "/rr-agent/"

-- ---------------------------------------------------------------- addresses
-- All measured. See docs/SCREEN-MAP.md for how, and for the control conditions.
local CTRL_ME       = 0x03004FE0   -- which screen: the player's controller fn
local SCREEN_ID     = 0x02020014   -- secondary; separates party list from submenu
local ACTION_CURSOR = 0x02023FF8   -- 0 FIGHT 1 BAG 2 POKEMON 3 RUN
local MOVE_CURSOR   = 0x02023FFC   -- 0..3, the move list's 2x2 in reading order
local PARTY_IDX     = 0x0203B0A9   -- party slot; 7 is the Cancel button
local MON, SIZE     = 0x02023BE4, 0x58
local PARTY         = 0x02024284
local AI_TARGET     = 0x02000091   -- move slot, or destination party index
local AI_ACTION     = 0x0200005B   -- 1 switch, 0 move
local RNG           = 0x020386D0
-- TERRAIN TIMER, found by signature scan over 831 EWRAM dumps: exactly one
-- byte in the whole address space counts down once per turn through the 0..8
-- band and resets (5 for a plain terrain, 7-8 with Terrain Extender). Nothing
-- read the field before this, so every state the planner built inherited
-- Electric Terrain from Pincurchin's Electric Surge at roster index 0 and
-- NEVER let it expire -- inflating every Electric move by 1.3x for the whole
-- fight and blocking Sleep Powder on grounded targets, which is a path James
-- says he has taken on file.
local TERRAIN_TIMER = 0x020179BC

local S_ACTION, S_MOVES, S_PARTY, S_BUSY = 0x0802E439, 0x0802EA11, 0x08030685, 0x0802E3B5

-- INDEPENDENT DICE PER EPISODE.
--
-- A save state restores the RNG, and the planner is deterministic, so
-- replaying one state replays one fight EXACTLY: the zero-death Surge win of
-- 2026-08-27 came back HP for HP the next morning, and three ss1 sweeps were
-- byte-identical to each other. Counting such episodes measures reproducibility
-- and nothing else -- a "10/10" from them would be the false 11-0 record all
-- over again, in a new costume.
--
-- So every episode gets a fresh 32-bit seed written into the generator after
-- the state loads: same position, independent dice. The seed goes into the
-- results row, so a bad episode can be replayed exactly rather than described.
-- Frame-idling was considered and rejected on evidence: turns 64 and 65 logged
-- the identical seed, so the generator advances on consumption, not per frame.
math.randomseed(os.time() + math.floor((os.clock() * 1000) % 1000))
local function reseed()
	local seed = math.random(0, 65535) * 65536 + math.random(0, 65535)
	local ok = pcall(function() emu:write32(RNG, seed) end)
	_RR.seed = ok and seed or nil
	if ok then say("seeded RNG " .. string.format("0x%08X", seed)) end
end

-- IS A BATTLE EVEN RUNNING. The agent had no concept that a fight can END, so
-- when one did it went on reading gBattleMons -- which keeps the corpse of the
-- last battler -- and reported a live position from stale memory: "them hp=0,
-- us hp=98", forever, while mashing A at an overworld that would happily walk
-- it into an NPC conversation.
--
-- 0x030030F0 is the main-loop callback. It holds the SAME ROM pointer across
-- all ten in-battle snapshots -- action menu, move list, party screen,
-- animation and text alike -- and a different one once the battle is over,
-- which is exactly the signature of a main loop rather than a screen.
local MAIN_CB, CB_BATTLE = 0x030030F0, 0x080123E5

-- BattlePokemon, Gen 3 layout.
-- status2 holds the VOLATILES -- confusion among them -- and was never read.
-- The agent spammed Confuse Ray into an already-confused Manectric because the
-- model could not see the confusion it had just applied.
local O_ST2 = 0x50
local O_SP, O_MOVES, O_STAGES, O_AB, O_PP, O_HP, O_LV, O_MAX, O_ITEM, O_ST1 =
	0x00, 0x0C, 0x18, 0x20, 0x24, 0x28, 0x2A, 0x2C, 0x2E, 0x4C
-- The battler's REAL stats, in order atk, def, spe, spa, spd. Reading these
-- means the planner never has to infer the opponent's nature, EVs or IVs to
-- price a hit -- it uses the numbers the game is using.
local O_STATS = 0x02
-- Gen 3 party Pokemon: everything below is OUTSIDE the encrypted block.
local P_SIZE, P_STATUS, P_LEVEL, P_HP, P_MAX = 100, 0x50, 0x54, 0x56, 0x58

local KEY_A, KEY_B = 1, 2
local KEY_RIGHT, KEY_LEFT, KEY_UP, KEY_DOWN = 16, 32, 64, 128
-- Set by the presence of a file, so it can be flipped without a reload.
local RESTART = false
do
	local f = io.open(os.getenv("HOME") .. "/rr-agent/restart", "r")
	if f then f:close(); RESTART = true end
end

pcall(function() os.execute("mkdir -p '" .. DIR .. "'") end)

-- ------------------------------------------------------------------ reading
-- THE MAP COMPLETES ITSELF FROM REAL PLAY. The screens in docs/SCREEN-MAP.md
-- are the ones deliberately visited while mapping, and a real turn passes
-- through more than that -- 0x08030611 turned up mid-settle and is nowhere in
-- the map. Rather than keep patching one unnamed state at a time, every
-- controller value that has no name is recorded once, with what was happening
-- when it appeared. That turns the gap into a list instead of a surprise.
-- Forward-declared: noteUnknown below is defined before the logger is, and
-- called it as a global -- which is nil -- so every unrecognised screen threw.
-- That was the silent killer of an overnight run: the bootstrap pauses the
-- implementation on the first throw and its errors only reach the console.
local say
local seenUnknown = {}
local function noteUnknown(c)
	if seenUnknown[c] then return end
	seenUnknown[c] = true
	local f = io.open(DIR .. "unknown_screens.tsv", "a")
	if f then
		f:write(string.format("0x%08X\t%s\tus_hp=%d\tfoe_hp=%d\tid=%d\n",
			c, phase or "?", emu:read16(MON + O_HP),
			emu:read16(MON + SIZE + O_HP), emu:read8(SCREEN_ID)))
		f:close()
	end
	if say then
		say(string.format("NEW SCREEN 0x%08X seen during %s -- recorded", c, phase or "?"))
	end
end

local function screen()
	if emu:read32(MAIN_CB) ~= CB_BATTLE then return "nobattle" end
	local c = emu:read32(CTRL_ME)
	if c == S_ACTION then return "action" end
	if c == S_MOVES  then return "moves"  end
	if c == S_PARTY  then
		-- The submenu shares the controller pointer with the list behind it.
		return emu:read8(SCREEN_ID) == 9 and "party_submenu" or "party"
	end
	if c == S_BUSY   then return "busy"   end
	-- THE SECOND OPINION. The controller pointer is the primary map, but it
	-- takes values that mapping never visited -- 0x08032C4D turned up with
	-- SCREEN_ID reading 7, which is the move list, so the agent was staring at
	-- a menu it could have named from a byte it was already reading. Falling
	-- back to the secondary indicator turns an unknown screen into a known one
	-- instead of a stall.
	noteUnknown(c)
	local id = emu:read8(SCREEN_ID)
	if id == 1 then return "action" end
	if id == 7 then return "moves"  end
	if id == 8 then return "party"  end
	if id == 9 then return "party_submenu" end
	return string.format("unknown:0x%08X", c)
end

local function battler(base)
	local mv, pp, st = {}, {}, {}
	for i = 0, 3 do
		mv[i+1] = emu:read16(base + O_MOVES + i*2)
		pp[i+1] = emu:read8(base + O_PP + i)
	end
	for i = 0, 7 do st[i+1] = emu:read8(base + O_STAGES + i) end
	local stats = {}
	for i = 0, 4 do stats[i+1] = emu:read16(base + O_STATS + i*2) end
	return string.format(
		'{"species":%d,"level":%d,"hp":%d,"maxhp":%d,"ability":%d,"item":%d,'
		.. '"status":%d,"status2":%d,"moves":[%s],"pp":[%s],"stages":[%s],"stats":[%s]}',
		emu:read16(base + O_SP), emu:read8(base + O_LV),
		emu:read16(base + O_HP), emu:read16(base + O_MAX),
		emu:read8(base + O_AB), emu:read16(base + O_ITEM),
		emu:read32(base + O_ST1), emu:read32(base + O_ST2),
		table.concat(mv, ","), table.concat(pp, ","), table.concat(st, ","),
		table.concat(stats, ","))
end

-- The party's species sits inside the encrypted substructures, so it is not
-- read here. Level, HP and status are outside the encryption, and the planner
-- already knows the roster from the save file -- it matches on those instead,
-- and checks its answer against gBattleMons for whoever is actually out.
-- THEIR party. gEnemyParty sits directly after gPlayerParty: six slots of 100
-- bytes each, so +600. Level, HP, max HP and status all live OUTSIDE Gen 3's
-- encryption, which is enough to identify each member against the trainer data
-- and to know how hurt it is.
--
-- Until now their bench was five placeholder clones of whatever was out, which
-- is why the model kept "predicting" switches to Pokemon that do not exist, why
-- every opponent damage band came back empty, and why switch prediction has
-- never been measurable at all.
-- MEASURED, not assumed. gEnemyParty is 600 bytes BEFORE gPlayerParty in this
-- ROM, not after -- reading +600 gave level 126 and 9228 max HP. Found by
-- searching a full EWRAM dump for six 100-byte records whose levels matched
-- Surge's known 32/33/33/33/34, which landed on exactly one address whose max
-- HP values are his five Pokemon.
local FOE_PARTY = 0x0202402C

local function foeParty()
	local rows = {}
	for i = 0, 5 do
		local b = FOE_PARTY + i * P_SIZE
		-- THEIR RECORDS TOO, raw. gEnemyParty is laid out like ours and is
		-- unencrypted in this ROM, so species, moves, ability, item, nature,
		-- EVs and IVs of every opponent are readable. The sheet only has the
		-- bosses; a Rock Tunnel Pokemaniac's Flareon was matched to Professor
		-- Oak's and every line priced against a Pokemon that was not there
		-- (2026-09-04). RAM is the truth; the sheet is now the fallback.
		local hex = {}
		for k = 0, P_SIZE - 1 do hex[#hex+1] = string.format("%02x", emu:read8(b + k)) end
		rows[#rows+1] = string.format(
			'{"slot":%d,"level":%d,"hp":%d,"maxhp":%d,"status":%d,"raw":"%s"}',
			i, emu:read8(b + P_LEVEL), emu:read16(b + P_HP),
			emu:read16(b + P_MAX), emu:read32(b + P_STATUS), table.concat(hex))
	end
	return table.concat(rows, ",")
end

local function party()
	local rows = {}
	for i = 0, 5 do
		local b = PARTY + i * P_SIZE
		-- The whole 100-byte record too, as hex. This ROM keeps party records
		-- unencrypted, so the node side decodes species, moves, item, ability,
		-- nature, EVs and IVs from it directly -- the battery save only knows
		-- what the game last WROTE, and a save state loaded mid-run is not that.
		local hex = {}
		for k = 0, P_SIZE - 1 do hex[#hex+1] = string.format("%02x", emu:read8(b + k)) end
		rows[#rows+1] = string.format('{"slot":%d,"level":%d,"hp":%d,"maxhp":%d,"status":%d,"raw":"%s"}',
			i, emu:read8(b + P_LEVEL), emu:read16(b + P_HP), emu:read16(b + P_MAX),
			emu:read32(b + P_STATUS), table.concat(hex))
	end
	return table.concat(rows, ",")
end

-- ------------------------------------------------------------------ the loop
-- ALL PROGRESS LIVES IN A GLOBAL, so that a hot reload does not amputate an
-- action halfway through. The bootstrap can swap this file in at any moment --
-- including between writing FIGHT to the action cursor and writing the move
-- slot -- and the first live load proved it: the implementation reloaded
-- immediately after "playing move 1", reset phase to "wait", and abandoned the
-- press it was in the middle of. Reloading has to be invisible to a turn in
-- flight or it is not safe to iterate while the agent is playing.
_RR = _RR or {turn = 0, phase = "wait", timer = 0, pending = nil,
	want = nil, lastSig = "", attempts = 0}
local turn, phase, timer, pending, want = _RR.turn, _RR.phase, _RR.timer, _RR.pending, _RR.want
local lastSig, attempts = _RR.lastSig, _RR.attempts
local unstick = _RR.unstick or 0
local idle = _RR.idle or 0
local opened = _RR.opened or false
local moves = _RR.moves or 0
local lastCur = _RR.lastCur or -1
local cursorAt = _RR.cursorAt == nil and -1 or _RR.cursorAt
local swFails = _RR.swFails or 0
local swFrom = _RR.swFrom
local confirmAt = _RR.confirmAt

-- Written back on every tick; locals stay for readability and speed.
local function persist()
	_RR.turn, _RR.phase, _RR.timer = turn, phase, timer
	_RR.pending, _RR.want = pending, want
	_RR.lastSig, _RR.attempts = lastSig, attempts
	_RR.unstick = unstick
	_RR.idle = idle
	_RR.opened, _RR.moves, _RR.lastCur = opened, moves, lastCur
	_RR.cursorAt = cursorAt
	_RR.swFails = swFails
	_RR.swFrom = swFrom
	_RR.confirmAt = confirmAt
end
local log = io.open(DIR .. "agent.log", "a")
say = function(s) console:log("agent: " .. s); log:write(s .. "\n"); log:flush() end

local function positionSignature()
	return emu:read16(MON + O_SP) .. "/" .. emu:read16(MON + O_HP) .. "/"
		.. emu:read16(MON + SIZE + O_SP) .. "/" .. emu:read16(MON + SIZE + O_HP)
		.. "/" .. emu:read8(MON + O_PP) .. emu:read8(MON + O_PP + 1)
		.. emu:read8(MON + O_PP + 2) .. emu:read8(MON + O_PP + 3)
end

-- SAMPLE THE DECISION BYTES AT SEVERAL MOMENTS IN THE TURN.
--
-- The 32/32 validation came from states saved at one particular point in a
-- scripted press cycle. The live agent reads the instant the action menu
-- appears, and gets a nearly-constant value across changing positions -- which
-- is what LAST TURN'S LEFTOVER looks like, not a wrong answer. There is one
-- battle engine, so if the opponent's choice is in memory during a Surge fight
-- it is in memory during every fight; the question is only WHEN it is written.
--
-- So take a reading at each stage and let the log say which one matches what
-- they actually did.
-- SCREENSHOT THE EMULATOR ITSELF, not the desktop. mGBA can dump its own
-- framebuffer, so it does not matter whether the window is fullscreen, on
-- another Space, or not visible at all -- and James does not have to move it
-- to let me look. Wrapped in pcall because the API name varies by build; a
-- failure is recorded once and then ignored rather than killing the run.
local SHOTS = os.getenv("HOME") .. "/rr-agent/shots/"
local shotFails = 0
local function shot(tag)
	if shotFails > 3 then return end
	local path = SHOTS .. tag .. ".png"
	local ok = pcall(function() emu:screenshot(path) end)
	if not ok then
		shotFails = shotFails + 1
		if shotFails == 1 then say("screenshot API unavailable in this build") end
	end
end

local function sampleAI(tag)
	_RR.samples = _RR.samples or {}
	_RR.samples[tag] = emu:read8(AI_ACTION) .. "/" .. emu:read8(AI_TARGET)
end

-- THE AI'S OWN SCORE SHEET, read instead of reconstructed. The thinking
-- struct (battle.h:480) was located at 0x020003A4 by signature scan over 795
-- full-EWRAM dumps and verified exactly: across all 737 move turns, the
-- argmax of score[4] contained the slot the AI really chose, 737/737.
-- aiFlags reads 7 on every dump -- Surge runs all three AI bits -- and
-- simulatedRNG holds the pre-drawn bytes that decide its coin-flip branches
-- and argmax ties. Valid at the same 45-frame mark as the decision byte;
-- stale before the AI has thought, like everything else in this struct.
local AI_THINK = 0x020003A4
local function aiScoresJSON()
	local s = {}
	for i = 0, 3 do
		local v = emu:read8(AI_THINK + 4 + i)
		if v > 127 then v = v - 256 end
		s[#s + 1] = tostring(v)
	end
	local rng = {}
	for i = 0, 3 do rng[#rng + 1] = tostring(emu:read8(AI_THINK + 24 + i)) end
	return string.format('{"scores":[%s],"considered":%d,"flags":%d,"srng":[%s]}',
		table.concat(s, ","), emu:read16(AI_THINK + 2),
		emu:read32(AI_THINK + 12), table.concat(rng, ","))
end

local function samplesJSON()
	local t = _RR.samples or {}
	local parts = {}
	for _, tag in ipairs({"menu", "movelist", "committed", "resolving", "late",
			"t150", "t220", "t320"}) do
		if t[tag] then parts[#parts + 1] = '"' .. tag .. '":"' .. t[tag] .. '"' end
	end
	return "{" .. table.concat(parts, ",") .. "}"
end

-- HUNT THE AI'S SCORE ARRAY.
--
-- James's point: the chosen move is written late, but whatever DECIDES the move
-- must exist earlier. CFRU scores all four moves in AI_THINKING_STRUCT --
-- everything starts at 100 and each AI pass adjusts it -- then takes the
-- argmax. Those four bytes have to be in memory while the AI is thinking, which
-- is before the choice is committed. If we can find them we do not need to port
-- the scoring at all; we can read the AI's own evaluation.
--
-- And we can find them, because there is now ground truth: the right address is
-- the one whose argmax matches the move they actually used, turn after turn.
-- Dump RAM at the decision point and correlate offline.
local DUMPS = os.getenv("HOME") .. "/rr-agent/aidump/"
local dumpCount = 0
local function dumpForScoreHunt()
	if dumpCount >= 120 then return end
	dumpCount = dumpCount + 1
	_RR.dumpCount = dumpCount
	local tag = string.format("t%03d", turn)
	-- ALL of EWRAM, not an eighth of it. The window was 0x02020000..0x02028000,
	-- 32KB of a 256KB region -- and the decision bytes we already rely on live
	-- at 0x02000091, outside it entirely. Searching there for the AI's score
	-- array and finding nothing said very little.
	for _, r in ipairs({{n = "ew", b = 0x02000000, l = 0x40000},
			{n = "iw", b = 0x03000000, l = 0x8000}}) do
		local f = io.open(DUMPS .. tag .. "." .. r.n .. ".bin", "wb")
		if f then
			-- read in chunks; one 256KB readRange can be unhappy
			local step = 0x8000
			for off = 0, r.l - step, step do
				f:write(emu:readRange(r.b + off, step))
			end
			f:close()
		end
	end
end

local function writeState(kind)
	turn = turn + 1
	_RR.samples = {}
	sampleAI("menu")
	-- THE ORACLE'S INPUT. A save state of this exact menu, written next to
	-- state.json, so the brain can hand it to the windowless core
	-- (tools/headless/oracle) and play each candidate forward for real.
	-- Flags 10 = savedata + RTC, no screenshot. This is the scripting call,
	-- which goes straight to the core and never touches the front end's
	-- on-screen messages -- James's rule is that he must not see it.
	pcall(function() emu:saveStateFile(DIR .. "turn.ss", 10) end)

	local f = io.open(DIR .. "state.json", "w")
	f:write(string.format(
		'{"turn":%d,"kind":"%s","screen":"%s","rng":%d,"btype":%d,'
		.. '"b2sp":%d,"b3sp":%d,'
		.. '"ai_action":%d,"ai_target":%d,"terrainTurns":%d,'
		.. '"me":%s,"foe":%s,"party":[%s],"foeparty":[%s]}\n',
		turn, kind, screen(), emu:read32(RNG), emu:read32(0x02022B4C),
		emu:read16(MON + 2 * SIZE + O_SP), emu:read16(MON + 3 * SIZE + O_SP),
		emu:read8(AI_ACTION), emu:read8(AI_TARGET), emu:read8(TERRAIN_TIMER),
		battler(MON), battler(MON + SIZE), party(), foeParty()))
	f:close()
	os.remove(DIR .. "cmd.json")
	say(string.format("turn %d (%s): asked the planner. foe committed to %s %d",
		turn, kind, emu:read8(AI_ACTION) == 1 and "SWITCH" or "MOVE",
		emu:read8(AI_TARGET)))
end

local function readCommand()
	local f = io.open(DIR .. "cmd.json", "r")
	if not f then return nil end
	local body = f:read("*a"); f:close()
	local id = tonumber(body:match('"turn"%s*:%s*(%d+)'))
	if id ~= turn then return nil end             -- an answer to an older turn
	local act = body:match('"action"%s*:%s*"(%a+)"')
	if act == "load" then
		local file = body:match('"file"%s*:%s*"([^"]+)"')
		if file then
			say("loading state " .. file)
			pcall(function() emu:loadStateFile(file) end)
			-- The results row labels each fight with _RR.saveName, and this
			-- branch never set it -- so once the node started driving loads,
			-- every row inherited the LAST rotation load's label: hours of
			-- Surge fights recorded as "RadicalRed.ss1". The label follows
			-- the load, whoever performs it. Fresh dice per episode follow
			-- the load too, same as the rotation path.
			_RR.saveName = file:match("[^/]+$")
			_RR.latch = nil
			_RR.recorded = false
			reseed()
			lastSig = ""
			os.remove(DIR .. "state.json")
			os.remove(DIR .. "cmd.json")
		end
		return nil
	end
	local slot = tonumber(body:match('"slot"%s*:%s*(%d+)'))
	local from = tonumber(body:match('"from"%s*:%s*(%d+)'))
	local wantMax = tonumber(body:match('"wantMax"%s*:%s*(%d+)'))
	local wantLevel = tonumber(body:match('"wantLevel"%s*:%s*(%d+)'))
	local wantSpecies = tonumber(body:match('"wantSpecies"%s*:%s*(%d+)'))
	if not act or not slot then return nil end
	say("read command: " .. body:gsub("%s+$", ""))
	return {action = act, slot = slot, from = from,
		wantMax = wantMax, wantLevel = wantLevel, wantSpecies = wantSpecies}
end

local frame = 0
-- Every phase change, logged from one place. Four intervals have gone into
-- inferring the sequence from snapshots and getting it wrong each time; the
-- state machine should say where it goes rather than be reconstructed.
-- EVERYTHING inside the guard. The heartbeat write and the phase-transition
-- logging were added later and sat OUTSIDE it, so a throw in either escaped to
-- the bootstrap -- which pauses the implementation permanently and reports only
-- to the console. That is the third silent death tonight from the same cause:
-- a diagnostic that can itself fail, positioned where its failure is invisible.
-- The rule now is that tick() does nothing except call the guarded body.
-- HANDS OFF MEANS HANDS OFF. Writing setKeys(0) on every idle frame is not
-- "pressing nothing": the frontend writes James's real keys each frame too, so
-- the two alternate and the game sees his button pressed, released, pressed,
-- released -- one click became many, and at 5x fast-forward the catch screen
-- became impossible to leave. Release once when going idle, then stop touching
-- the keys until the agent actually has something to press.
local function handsOff()
	if not _RR.handsOff then
		pcall(function() emu:setKeys(0) end)
		_RR.handsOff = true
	end
end
local function handsOn()
	_RR.handsOff = false
end

local function tick_body()
	_RR.beat = (_RR.beat or 0) + 1
	if _RR.beat % 60 == 0 then
		local hb = io.open(DIR .. "heartbeat", "w")
		if hb then
			local okScr, scrNow = pcall(screen)
			hb:write(string.format(
				"%d beat=%d phase=%s timer=%s screen=%s idle=%s unstick=%s turn=%s",
				os.time(), _RR.beat, tostring(phase), tostring(timer),
				okScr and tostring(scrNow) or "?", tostring(idle),
				tostring(unstick), tostring(turn)))
			hb:close()
		end
	end
	-- STOP MEANS BOTH HALVES STAND DOWN, not just the brain.
	--
	-- The node side already refuses to answer while the panel's pause file
	-- exists, and while a question is merely unanswered this side presses
	-- nothing, so pausing looked complete. It was not: after 60 seconds an
	-- unanswered question expires into the "wait" phase, and that phase pushes
	-- the UI back where it belongs by tapping B out of the move list. So
	-- stopping mid-battle to take the turn by hand would work for a minute and
	-- then start fighting the person holding the controller.
	--
	-- Checked every frame rather than latched, because the whole point of the
	-- button is that it takes effect without a reload. The heartbeat above is
	-- deliberately still written: a paused emulator must not look like a dead
	-- one on the panel.
	if _RR.beat % 10 == 0 then
		local pf = io.open(DIR .. "pause", "r")
		if pf then pf:close(); _RR.paused = true else _RR.paused = false end
		-- WILD ENCOUNTERS ARE JAMES'S, NOT OURS. The node writes `wild` when
		-- it judges the opponent a bush Pokemon rather than a trainer, and this
		-- side then presses nothing, exactly as for STOP, so he can catch it.
		-- Cleared here the moment the battle is over, so the next trainer
		-- fight resumes without anybody touching a file.
		local wf = io.open(DIR .. "wild", "r")
		if wf then
			wf:close()
			-- SUSTAINED, not momentary. In a double battle the main callback
			-- leaves its in-battle value between the two action prompts, so a
			-- single "nobattle" read is not the end of anything: the first
			-- live doubles fight cleared this 193 times and the agent kept
			-- stepping back in on a fight that was James's to play.
			local okScr, scrNow = pcall(screen)
			if okScr and scrNow == "nobattle" then
				_RR.wildIdle = (_RR.wildIdle or 0) + 10
			else
				_RR.wildIdle = 0
			end
			if (_RR.wildIdle or 0) >= 600 then
				os.remove(DIR .. "wild"); _RR.wild = false; _RR.wildIdle = 0
				say("hands-off battle over; standing back up")
			else
				_RR.wild = true
			end
		else
			_RR.wild = false
		end
	end
	if _RR.paused or _RR.wild then
		handsOff()
		return
	end

	local before = phase
	tick_inner()
	if phase ~= before then
		local okS, sc = pcall(screen)
		say("phase " .. tostring(before) .. " -> " .. tostring(phase)
			.. " (screen " .. (okS and tostring(sc) or "?") .. ")")
	end
end

local function tick()
	local ok, err = pcall(tick_body)
	pcall(persist)
	if not ok then
		local f = io.open(DIR .. "errors.log", "a")
		if f then f:write(os.date() .. "  " .. tostring(err) .. "\n"); f:close() end
		if not _RR.lastErr or _RR.lastErr ~= tostring(err) then
			_RR.lastErr = tostring(err)
			pcall(say, "tick error (recorded, continuing): " .. tostring(err))
		end
		pcall(function() emu:setKeys(0) end)
	end
end

function tick_inner()
	frame = frame + 1
	if frame % 4 ~= 0 and phase == "wait" then return end

	local scr = screen()

	-- LATCH THE BODY COUNT WHILE THE BATTLE IS STILL UP. A lost fight ends in
	-- a whiteout that HEALS the party before the nobattle read happens, so
	-- every loss read as "neither side is wiped" and was silently dropped --
	-- two full collapses against Pawmot (turns 2685-2697, 2725-2737) left no
	-- row at all and the record claimed 11-0. The last in-battle read is the
	-- honest ending; keep it, and let the recorder fall back to it.
	if scr ~= "nobattle" and _RR.beat % 30 == 0 then
		local lm, lt = 0, 0
		local lmine, ltheirs = {}, {}
		for i = 0, 5 do
			local mh = emu:read16(PARTY + i * P_SIZE + P_HP)
			local th = emu:read16(FOE_PARTY + i * P_SIZE + P_HP)
			if mh > 0 then lm = lm + 1 end
			if th > 0 then lt = lt + 1 end
			lmine[#lmine+1] = mh .. "/" .. emu:read16(PARTY + i * P_SIZE + P_MAX)
			ltheirs[#ltheirs+1] = th .. "/" .. emu:read16(FOE_PARTY + i * P_SIZE + P_MAX)
		end
		_RR.latch = {ml = lm, tl = lt,
			mine = table.concat(lmine, " "), theirs = table.concat(ltheirs, " ")}
	end

	if phase == "wait" then
		-- PUT THE UI BACK WHERE IT BELONGS. Waiting only ever asks a question
		-- from the action menu or a forced party screen, so being parked
		-- anywhere else means standing there forever -- which is exactly what
		-- happened when a reload landed mid-press and left the move list open
		-- with nobody intending to choose a move. Backing out is safe: B in the
		-- move list returns to the action menu, and B in the submenu closes it.
		if scr == "moves" or scr == "party_submenu" then
			unstick = (unstick or 0) + 1
			emu:setKeys(unstick % 20 < 4 and KEY_B or 0)
			if unstick % 60 == 0 then
				say("recovering: parked on " .. scr .. " with nothing to do, backing out")
			end
			return
		end
		if scr == "nobattle" then
			-- Outside a battle the agent presses NOTHING. It has no map of the
			-- overworld and no business acting there. ONCE, not every frame.
			handsOff()
			unstick = (unstick or 0) + 1
			if unstick == 120 then
				say("the battle is over. " .. (_RR.fights or 0) .. " fought so far")
			end
			-- WHO ACTUALLY WON. 239 fights had been played without recording
			-- the outcome of a single one, so "is the agent any good" had no
			-- answer and every change was being judged on how sensible the
			-- individual clicks looked. The target is exact -- beat Surge
			-- losing nobody but Lilligant -- and it cannot be pursued without
			-- counting how often it happens.
			--
			-- Written once per battle, at the moment the ending is confirmed,
			-- from the same read that confirms it. Max HP identifies each of
			-- the six, so the casualties can be named afterwards.
			if unstick == 120 and not _RR.recorded then
				_RR.recorded = true
				local mine, theirs = {}, {}
				for i = 0, 5 do
					mine[#mine+1] = emu:read16(PARTY + i * P_SIZE + P_HP)
						.. "/" .. emu:read16(PARTY + i * P_SIZE + P_MAX)
					theirs[#theirs+1] = emu:read16(FOE_PARTY + i * P_SIZE + P_HP)
						.. "/" .. emu:read16(FOE_PARTY + i * P_SIZE + P_MAX)
				end
				local ml, tl = 0, 0
				for i = 0, 5 do
					if emu:read16(PARTY + i * P_SIZE + P_HP) > 0 then ml = ml + 1 end
					if emu:read16(FOE_PARTY + i * P_SIZE + P_HP) > 0 then tl = tl + 1 end
				end
				local res = (tl == 0 and ml > 0) and "WIN"
					or ((ml == 0) and "LOSS" or "UNCLEAR")
				-- ONLY REAL ENDINGS ARE RECORDED. Outside a battle the party
				-- reads are not meaningful and came back as all six at full
				-- health with the opponent half hurt, which is not an outcome
				-- of anything -- three such rows landed in the file and would
				-- have been counted in any win rate computed from it.
				--
				-- BUT A WHITEOUT HEALS THE PARTY before this read, so every
				-- LOSS used to arrive here as UNCLEAR and vanish. The latch
				-- taken while the battle was still up is the honest ending.
				if res == "UNCLEAR" and _RR.latch
					and (_RR.latch.ml == 0 or _RR.latch.tl == 0) then
					ml, tl = _RR.latch.ml, _RR.latch.tl
					mine = {_RR.latch.mine}
					theirs = {_RR.latch.theirs}
					res = (tl == 0 and ml > 0) and "WIN" or "LOSS"
					say("recording from the in-battle latch (post-battle read was healed)")
				end
				if res == "UNCLEAR" then
					say("not recording: neither side is wiped (" .. ml .. " v " .. tl .. ")")
					return
				end
				-- Which code produced this row (agent.js writes version.txt
				-- at startup). Without it, rows from different planner versions
				-- are indistinguishable and no change can be judged.
				local ver = "?"
				local vf = io.open(DIR .. "version.txt", "r")
				if vf then ver = vf:read("*l") or "?"; vf:close() end
				local rf = io.open(DIR .. "results.tsv", "a")
				if rf then
					-- The SEED is part of the result: without it an episode
					-- cannot be replayed, only described. "none" means the
					-- fight ran on whatever dice the save state carried.
					rf:write(string.format("%d\t%s\t%s\t%d\t%d\t%s\t%s\t%s\t%s\n",
						os.time(), res, _RR.saveName or "?", ml, tl,
						table.concat(mine, " "), table.concat(theirs, " "), ver,
						_RR.seed and string.format("0x%08X", _RR.seed) or "none"))
					rf:close()
				end
				say("RESULT " .. res .. " -- ours left " .. ml .. ", theirs left " .. tl)
			end
			-- Restart from the save, which is what makes a calibration run a
			-- LOOP: play, finish, reload, play again, without anybody watching.
			-- IS THE BATTLE REALLY OVER? "nobattle" only means the main-loop
			-- callback left its in-battle value, which also happens during
			-- transitions -- and a restart fired mid-fight throws away a game
			-- that was going fine, which James watched happen. Now that both
			-- parties are readable, check: a finished battle has one whole side
			-- wiped. If both sides still have something standing, this is a
			-- transition, not an ending.
			local mineLeft, theirsLeft = 0, 0
			for i = 0, 5 do
				if emu:read16(PARTY + i * P_SIZE + P_HP) > 0 then mineLeft = mineLeft + 1 end
				if emu:read16(FOE_PARTY + i * P_SIZE + P_HP) > 0 then theirsLeft = theirsLeft + 1 end
			end
			-- The transition guard is TIME-LIMITED. Outside a battle the party
			-- reads are not meaningful -- they can still show healthy Pokemon --
			-- so "both sides standing" stops being evidence of anything once we
			-- have been out of battle for a while. Without the limit this
			-- blocked every restart and the agent sat in nobattle for minutes,
			-- which is the opposite of the bug it was added to fix.
			if mineLeft > 0 and theirsLeft > 0 and unstick < 600 then
				if unstick % 300 == 0 then
					say("nobattle but both sides standing (" .. mineLeft .. " v "
						.. theirsLeft .. ") -- waiting, may be a transition")
				end
				return
			end
			if unstick > 240 and RESTART then
				-- ROTATE THE SAVE. Replaying one state gives byte-identical
				-- rolls every time -- turn 1 and turn 14 logged the same seed
				-- and the same eight draws -- because a save state restores the
				-- RNG. Repeating one fight can therefore never teach the roll
				-- model anything. Rotating gives different positions AND
				-- different dice, which is what the prediction log needs.
				local list = {}
				local lf = io.open(DIR .. "saves.txt", "r")
				if lf then
					for raw in lf:lines() do
						local line = raw:gsub("%s+$", "")
						if line ~= "" then list[#list + 1] = line end
					end
					lf:close()
				end
				local file = ""
				if #list > 0 then
					_RR.saveIdx = ((_RR.saveIdx or 0) % #list) + 1
					file = list[_RR.saveIdx]
				else
					local f = io.open(DIR .. "load.txt", "r")
					file = f and (f:read("*a") or ""):gsub("%s+$", "") or ""
					if f then f:close() end
				end
				local f = nil
				if file ~= "" and pcall(function() emu:loadStateFile(file) end) then
					_RR.fights = (_RR.fights or 0) + 1
					_RR.recorded = false
					reseed()
					-- The latch belongs to the fight that just ended; carrying
					-- it into the next one would record a stale ending.
					_RR.latch = nil
					_RR.saveName = file:match("[^/]+$")
					say("restarted (" .. _RR.fights .. ") with " .. file:match("[^/]+$"))
					os.remove(DIR .. "state.json")
					os.remove(DIR .. "cmd.json")
					lastSig, unstick = "", 0
				end
			end
			return
		end
		if scr == "busy" then
			-- A message is up and nobody is going to advance it. The settle
			-- phase presses A while busy, but a reload or a recovery can leave
			-- us WAITING while the game holds on text -- and then both sides
			-- wait for each other forever. Whoever is idle has to keep the
			-- game moving.
			unstick = (unstick or 0) + 1
			emu:setKeys(unstick % 30 < 4 and KEY_A or 0)
			if unstick % 240 == 0 then
				-- Report what is actually there. "Busy" that never ends is not
				-- a message -- it is a screen the map does not cover, and
				-- pressing A blindly at an unknown screen is the exact thing
				-- this agent is built not to do.
				say(string.format(
					"waiting: busy for %d frames. ctrl=0x%08X id=%d  us sp=%d hp=%d  them sp=%d hp=%d",
					unstick, emu:read32(CTRL_ME), emu:read8(SCREEN_ID),
					emu:read16(MON + O_SP), emu:read16(MON + O_HP),
					emu:read16(MON + SIZE + O_SP), emu:read16(MON + SIZE + O_HP)))
			end
			-- Stop pressing after a while. If A has not moved it in twenty
			-- seconds, it is not a message and mashing is doing something else.
			if unstick > 1200 then emu:setKeys(0) end
			-- Dump RAM once, LABELLED as whatever this is, so it can be diffed
			-- against the in-battle snapshots already on disk. The agent has no
			-- idea a battle can END; if this is the overworld then gBattleMons
			-- is just stale and every reading above is meaningless. Finding the
			-- flag that says "in battle" is the same measurement that produced
			-- the screen map, and needs nobody's help.
			if unstick > 1260 and not _RR_DUMPED then
				_RR_DUMPED = true
				local dir = os.getenv("HOME") .. "/rr-screen-corpus/screens/"
				for _, r in ipairs({{n = "ew", b = 0x02020000, l = 0x8000},
						{n = "iw", b = 0x03000000, l = 0x8000}}) do
					local f = io.open(dir .. "stuck." .. r.n .. ".bin", "wb")
					if f then f:write(emu:readRange(r.b, r.l)); f:close() end
				end
				say("dumped RAM as 'stuck' for offline comparison")
			end
			return
		end
		-- Reset only where nothing is being recovered from. This used to run
		-- before the party-screen branch, which re-incremented it to 1 every
		-- tick -- so "unstick % 20 < 4" was permanently true and B was HELD
		-- rather than pressed. A held button has no edge, so the menu never
		-- closed, and the log line keyed on the counter never fired either.
		-- The agent looked idle while mashing a button that could not work.
		if scr == "action" then unstick = 0 end

		-- A decision point is the game asking us, on a position we have not
		-- already answered. The signature guard is what stops the agent
		-- answering the same turn twice while the menu is still up.
		-- A party screen is only a QUESTION when our Pokemon has fainted. With
		-- everyone healthy it is a leftover from a switch that did not
		-- complete, and treating it as a forced switch made the agent ask the
		-- planner to replace a Pokemon that was standing there at full health.
		if scr == "party" and emu:read16(MON + O_HP) > 0 then
			unstick = (unstick or 0) + 1
			emu:setKeys(unstick % 20 < 4 and KEY_B or 0)
			if unstick % 180 == 0 then
				say("recovering: party screen open with nobody fainted, backing out")
			end
			return
		end
		if scr == "action" or scr == "party" then
			-- WATCHDOG. Sitting at a decision screen with an unchanged position
			-- and an answered question on disk is a deadlock: the agent will
			-- not re-ask because nothing has changed, and nothing will change
			-- because the answer it was given cannot be executed. That is
			-- exactly how the last two intervals were lost -- heartbeat
			-- ticking, log frozen, both halves waiting on each other. If we are
			-- still here after ten seconds, throw the question away and ask
			-- again; the planner may well answer differently now.
			idle = (idle or 0) + 1
			if idle > 600 then
				say("watchdog: idle at " .. scr .. " for 10s, discarding the question")
				os.remove(DIR .. "state.json")
				os.remove(DIR .. "cmd.json")
				lastSig, idle = "", 0
			end
			local sig = positionSignature()
			-- Re-ask when the position has moved on, OR when the question is
			-- simply unanswered: no state file on disk means nobody has been
			-- told about this turn. The first live run deadlocked exactly
			-- there -- the planner was not up yet, the ask timed out, and the
			-- signature guard then refused to ask again on a position that had
			-- not changed, so both halves sat waiting for each other.
			local asked = io.open(DIR .. "state.json", "r")
			if asked then asked:close() end
			if sig ~= lastSig or not asked then
				lastSig = sig
				pending = (scr == "party") and "forced" or "choose"
				writeState(pending)
				phase, timer, attempts, idle = "await", 0, 0, 0
			end
		end
		return
	end

	if phase == "await" then
		timer = timer + 1
		if timer % 15 ~= 0 then return end
		want = readCommand()
		if want then
			say(string.format("turn %d: playing %s %d", turn, want.action, want.slot))
			opened, moves, lastCur, cursorAt, swFrom, confirmAt = false, 0, -1, -1, nil, nil
			phase, timer = (want.action == "switch") and "sw_open" or "mv_open", 0
		elseif timer > 180 * 60 then   -- three minutes: a long think must not be re-asked away
			-- Ask again rather than giving up. The planner may simply not have
			-- been started yet, and a half that goes quiet forever is worse
			-- than one that repeats itself.
			say("turn " .. turn .. ": no answer in 180s; asking again")
			os.remove(DIR .. "state.json")
			lastSig = ""
			phase, timer = "wait", 0
		end
		return
	end

	-- Each branch below asserts the screen it expects BEFORE it presses, and
	-- asserts the screen it produced before moving on. A press that lands
	-- somewhere unexpected stops the agent instead of compounding.
	timer = timer + 1

	-- PRESS UNTIL THE SCREEN CHANGES, rather than pressing once and hoping.
	-- Each of these steps used to fire a single A and move on, so a press that
	-- did not register left the agent parked in a half-open menu with nothing
	-- to retry it -- the live run sat in the move list for five thousand frames
	-- doing exactly that. The screen itself is the acknowledgement: keep
	-- pressing while it has not changed, and advance the moment it has.
	if phase == "mv_open" then
		if scr == "moves" then phase, timer = "mv_pick", 0; return end
		if scr ~= "action" then
			if timer > 300 then
				say("mv_open: expected the action menu, saw " .. scr .. "; re-asking")
				os.remove(DIR .. "state.json"); lastSig = ""; phase = "wait"
			end
			return
		end
		emu:write8(ACTION_CURSOR, 0)                       -- FIGHT
		emu:setKeys(timer % 40 < 6 and KEY_A or 0)
		if timer > 600 then
			say("mv_open: FIGHT never opened the move list; re-asking")
			os.remove(DIR .. "state.json"); lastSig = ""; phase = "wait"
		end
		return
	end

	if phase == "mv_pick" then
		if timer == 1 then sampleAI("movelist") end
		if scr ~= "moves" then
			-- The move list closed, which means the move was taken.
			if timer > 4 then phase, timer = "settle", 0; return end
			return
		end
		emu:write8(MOVE_CURSOR, want.slot)
		emu:setKeys(timer % 40 < 6 and KEY_A or 0)
		if timer % 300 == 0 then
			say("mv_pick: still in the move list at slot " .. want.slot
				.. " after " .. timer .. " frames, cursor reads "
				.. emu:read8(MOVE_CURSOR))
		end
		if timer > 900 then
			say("mv_pick: the move would not commit; re-asking")
			os.remove(DIR .. "state.json"); lastSig = ""; phase = "wait"
		end
		return
	end

	if phase == "sw_open" then
		if scr == "party" or scr == "party_submenu" then
			phase, timer = "sw_pick", 0; return
		end
		if scr ~= "action" then
			if timer > 300 then
				say("sw_open: expected a menu, saw " .. scr .. "; re-asking")
				os.remove(DIR .. "state.json"); lastSig = ""; phase = "wait"
			end
			return
		end
		emu:write8(ACTION_CURSOR, 2)                       -- POKEMON
		emu:setKeys(timer % 40 < 6 and KEY_A or 0)
		if timer > 600 then
			say("sw_open: POKEMON never opened the party screen; re-asking")
			os.remove(DIR .. "state.json"); lastSig = ""; phase = "wait"
		end
		return
	end

	if phase == "sw_pick" then
		-- A DETERMINISTIC SEQUENCE, checked by outcome.
		--
		-- This flow has been driven off SCREEN_ID values whose meanings I
		-- inferred from single screenshots and got wrong more than once -- 9
		-- was read as the submenu when it is the list, so the agent jumped
		-- straight to confirming and pressed A on whoever was highlighted,
		-- which is the ACTIVE Pokemon, and the game answered "already in
		-- battle". Switches landed correctly 3 times in 126.
		--
		-- So no screen ids here. The cursor byte tracks the highlight (proved
		-- by dumping RAM before and after a press: it moved 0 -> 5, the only
		-- small-index byte in 256KB that changed), and it starts on the active
		-- because the active is displayed first. Navigate until it reads the
		-- target, then press A twice with a real gap -- once to open the
		-- submenu, once to take Shift -- and let the ACTIVE POKEMON CHANGING be
		-- the only evidence that it worked.
		if swFrom == nil then swFrom = emu:read16(MON + O_SP) end
		if emu:read16(MON + O_SP) ~= swFrom and emu:read16(MON + O_SP) ~= 0 then
			say("switch done: active changed")
			swFrom, swFails = nil, 0
			emu:setKeys(0)
			phase, timer = "settle", 0
			return
		end
		if timer < 50 then emu:setKeys(0); return end
		local cur = emu:read8(PARTY_IDX)
		-- RESOLVE THE TARGET HERE, AGAINST LIVE RAM. The index the planner
		-- computed can be stale: coming in swaps the arriving Pokemon into slot
		-- 0, so the numbering shifts during the fight and a slot decided one
		-- read earlier can name somebody else. Max HP is unique across the six,
		-- so matching on it picks the intended Pokemon no matter how the party
		-- has been renumbered, and it is read from the same gPlayerParty the
		-- screen itself is drawn from -- display position was measured to equal
		-- the RAM slot exactly, with the six HP values logged in the same tick
		-- as the screenshot that showed them.
		local target = want.slot
		if (want.wantMax and want.wantMax > 0) or (want.wantSpecies and want.wantSpecies > 0) then
			-- SPECIES FIRST. Max HP plus level is not unique on every team: with
			-- Ledyba and Froakie both at 41/L15 this picked Ledyba for a Froakie
			-- switch and then kept "switching" to the Ledyba already out. The
			-- species id sits at +0x20 of the same unencrypted record. The
			-- Pokemon on the field is never a candidate: the game refuses it.
			local found = nil
			local activeSp, activeHp = emu:read16(MON + O_SP), emu:read16(MON + O_HP)
			local function candidate(i, bySpecies)
				local b = PARTY + i * P_SIZE
				if emu:read16(b + P_HP) <= 0 then return false end
				if want.wantLevel and emu:read8(b + P_LEVEL) ~= want.wantLevel then return false end
				if bySpecies then
					if emu:read16(b + 0x20) ~= want.wantSpecies then return false end
				elseif want.wantMax and want.wantMax > 0 then
					if emu:read16(b + P_MAX) ~= want.wantMax then return false end
				end
				-- not the one already out
				if emu:read16(b + 0x20) == activeSp and emu:read16(b + P_HP) == activeHp then return false end
				return true
			end
			if want.wantSpecies and want.wantSpecies > 0 then
				for i = 0, 5 do if candidate(i, true) then found = i; break end end
			end
			if not found then
				for i = 0, 5 do if candidate(i, false) then found = i; break end end
			end
			if found and found ~= target then
				say("sw_pick: slot " .. target .. " is stale, "
					.. want.wantMax .. " max HP is really in slot " .. found)
			end
			if not found then
				say("sw_pick: nobody alive with " .. want.wantMax
					.. " max HP; dropping the switch")
				swFrom, opened, confirmAt = nil, false, nil
				os.remove(DIR .. "state.json"); lastSig = ""
				phase, timer = "wait", 0
				return
			end
			target = found
		end
		if cur ~= target then
			-- IT IS A TWO-COLUMN GRID AND DOWN ONLY WALKS ONE COLUMN. Logged
			-- live, the cursor cycled 0 -> 2 -> 4 -> 7 -> 0: the left column
			-- and then Cancel. Every odd slot -- the entire right column -- was
			-- unreachable, so any switch to one of them could never happen no
			-- matter how long it pressed.
			--
			-- So: RIGHT/LEFT to cross columns, DOWN/UP to change row, and the
			-- cursor byte to check each step actually landed.
			local step = (timer - 50) % 20
			local key = KEY_DOWN
			if cur > 5 then
				key = KEY_UP                       -- sitting on Cancel
			else
				local ccol, crow = cur % 2, math.floor(cur / 2)
				local tcol, trow = target % 2, math.floor(target / 2)
				if ccol ~= tcol then key = (tcol > ccol) and KEY_RIGHT or KEY_LEFT
				elseif crow > trow then key = KEY_UP
				else key = KEY_DOWN end
			end
			emu:setKeys(step < 5 and key or 0)
			if step == 5 then moves = moves + 1 end
			if timer > 900 then
				say("sw_pick: cursor stuck at " .. cur .. ", wanted " .. target)
				swFails = swFails + 1
				swFrom = nil
				os.remove(DIR .. "state.json"); lastSig = ""
				phase, timer = "wait", 0
			end
			return
		end
		-- on target: A, gap, A, then wait for the active to change
		if not opened then
			opened = true
			confirmAt = timer
			-- THE MAPPING, MEASURED IN ONE TICK. Four different display->RAM
			-- mappings have been derived by holding a screenshot next to a RAM
			-- read, and they contradicted each other because Gen 3 SWAPS party
			-- slots when you switch: the two readings were taken moments apart
			-- and the order moved in between. Max HP is a unique fingerprint
			-- for each of the six, so logging it in the SAME tick as the shot
			-- makes the mapping readable off the picture with nothing to guess.
			local fp = {}
			for i = 0, 5 do
				local b = PARTY + i * P_SIZE
				fp[#fp+1] = i .. ":" .. emu:read16(b + P_HP) .. "/" .. emu:read16(b + P_MAX)
			end
			say("sw_pick: on target slot " .. target .. " after " .. moves
				.. " presses | cursor=" .. cur .. " | active="
				.. emu:read16(MON + O_HP) .. "/" .. emu:read16(MON + O_MAX)
				.. " | RAM " .. table.concat(fp, " "))
			shot("map_cursor" .. cur)
		end
		local since = timer - (confirmAt or timer)
		if since < 8 then emu:setKeys(KEY_A)
		elseif since < 70 then emu:setKeys(0)
		elseif since < 78 then emu:setKeys(KEY_A)
		else
			emu:setKeys(0)
			if since > 400 then
				say("sw_pick: pressed twice on slot " .. target .. " and nothing switched")
				shot("failed_slot" .. target)
				swFails = swFails + 1
				swFrom, opened, confirmAt = nil, false, nil
				os.remove(DIR .. "state.json"); lastSig = ""
				phase, timer = "wait", 0
			end
		end
		return
	end

	if phase == "sw_confirm" then
		-- OUTCOME-DRIVEN, not screen-driven.
		--
		-- The screenshots showed what RAM could not: at sw_confirm timer 2 the
		-- game is still on the party LIST ("Choose a Pokemon.", Cancel button)
		-- while screen() reported party_submenu, because SCREEN_ID == 9 is not
		-- the submenu. Every transition in this flow was therefore one step out
		-- of sync, and the recovery in wait() would then press B on a switch
		-- that was actually in progress.
		--
		-- So stop tracking menus here. The switch is done when OUR ACTIVE
		-- POKEMON CHANGES, and nothing else is evidence of it. Press A on a
		-- steady cadence until that happens.
		-- SELECTING SHIFT COMMITS THE TURN, it does not swap immediately: the
		-- Pokemon changes when the turn RESOLVES. Waiting for the species to
		-- change therefore waits for something that cannot happen while the
		-- menu is still up, which is why this sat pressing A for four hundred
		-- frames. Leaving the party screen is the real acknowledgement.
		if swFrom == nil then swFrom = emu:read16(MON + O_SP) end
		local nowSp = emu:read16(MON + O_SP)
		local id = emu:read8(SCREEN_ID)
		-- Photograph the moment it claims success, because "left the party
		-- screen" keeps being satisfied by a transient state while the active
		-- Pokemon never actually changes.
		-- id 6 is the submenu OPEN, photographed: the party screen with
		-- Shift/Summary/Cancel still up. Treating it as "left the party screen"
		-- declared the switch committed while the menu was still sitting there,
		-- so the agent moved on, the active never changed, and it re-planned the
		-- same switch forever.
		if id ~= 6 and id ~= 8 and id ~= 9 then
			shot("committed_id" .. id)
			say("switch committed (left the party screen, id=" .. id .. ")")
			swFrom, swFails = nil, 0
			emu:setKeys(0)
			phase, timer = "settle", 0
			return
		end
		if nowSp ~= swFrom and nowSp ~= 0 then
			say("switch done: active is now species " .. nowSp)
			swFrom, swFails = nil, 0
			emu:setKeys(0)
			phase, timer = "settle", 0
			return
		end
		-- A SLOWER, LONGER PRESS. Six frames on and twenty-four off did not
		-- take, even with the cursor sitting on Shift. Menus in this engine
		-- swallow input for a while after a transition, so the press is now
		-- fifteen frames with a full second between attempts, and a shot is
		-- taken just after each one so the effect is visible rather than
		-- guessed at.
		local slot = timer % 90
		emu:setKeys(slot < 15 and KEY_A or 0)
		-- Photograph the whole confirmation, with the screen id in the name, so
		-- the failing frame can be identified rather than inferred. Switches
		-- land on the intended Pokemon 3 times out of 126.
		for _, at in ipairs({5, 20, 40, 70, 95, 130, 180}) do
			if timer == at then
				shot(string.format("cf%03d_id%d", at, emu:read8(SCREEN_ID)))
			end
		end
		if timer % 90 == 0 and timer > 0 then
			say("sw_confirm: still species " .. nowSp .. " after " .. timer .. " frames")
		end
		if timer > 420 then
			say("sw_confirm: the switch never took")
			swFails = swFails + 1
			swFrom = nil
			emu:setKeys(0)
			os.remove(DIR .. "state.json"); lastSig = ""
			phase, timer = "wait", 0
		end
		return
	end

	if phase == "settle" then
		-- The two samples that actually test the hypothesis: the opponent's
		-- controller may only write its choice once the player's input is in,
		-- which would make everything read at the menu a leftover from the
		-- previous turn. These were lost when the switch phases were rewritten.
		-- A LADDER OF LATE READS. 45 frames is exact for THIS turn; by 100 the
		-- value has moved on. James's question is what it moves on TO -- if it
		-- is the opponent's NEXT decision, then reading late is genuine
		-- foresight and the whole capability comes back. Three clean pairs
		-- could not answer it, so sample the whole tail and let volume decide.
		if timer == 1 then sampleAI("committed") end
		if timer == 45 then
			sampleAI("resolving")
			_RR.aiThink = aiScoresJSON()
			-- Dump HERE, not at the menu. Nothing score-shaped exists at the
			-- menu because the AI has not thought yet -- which is the same
			-- reason the chosen-move byte is stale there. At 45 frames the
			-- choice is already correct, so its scores should be present, and
			-- reading them would show WHICH move our port misprices rather than
			-- only that the argmax differs.
			dumpForScoreHunt()
		end
		if timer == 100 then sampleAI("late") end
		if timer == 150 then sampleAI("t150") end
		if timer == 220 then sampleAI("t220") end
		if timer == 320 then sampleAI("t320") end
		-- Advance messages ONLY while the game is busy. Pressing A blindly here
		-- was pressing it at the action menu too, which opens FIGHT -- so the
		-- agent kept re-opening the move list it had just come back from, never
		-- saw the action menu again, and declared that nothing had resolved
		-- after ninety seconds. It was undoing its own turn.
		-- Advance whenever the game is NOT showing a menu we own. Restricting
		-- this to the single known "busy" value was too narrow: a resolving
		-- turn passes through controller states the map does not name, so the
		-- text never got advanced and the turn never finished -- the agent sat
		-- re-asking the same position forever. Anything that is not one of our
		-- menus is either a message or an animation, and A is right for both.
		-- Being inside a battle is already guaranteed; "nobattle" is handled
		-- well before here and presses nothing.
		if scr == "nobattle" then
			-- The fight ended while we were settling. Stop pressing IMMEDIATELY:
			-- settle was mashing A for five thousand frames at an overworld it
			-- knows nothing about, which is how an agent starts a conversation
			-- with an NPC by accident.
			emu:setKeys(0)
			phase, timer = "wait", 0
			return
		end
		if scr == "party" then
			if timer < 3 then shot("settle_saw_party") end
			-- Our Pokemon fainted mid-turn and the game wants a replacement.
			-- Settle has nothing to say about that; it is a new question.
			emu:setKeys(0)
			phase, timer = "wait", 0
			return
		end
		local ourMenu = (scr == "action") or (scr == "moves")
			or (scr == "party_submenu")
		emu:setKeys((not ourMenu) and (timer % 30 < 4) and KEY_A or 0)
		if timer % 300 == 0 then
			say("settle: " .. scr .. " after " .. timer .. " frames")
		end
		if scr == "action" or scr == "party" then
			if positionSignature() ~= lastSig then
				local f = io.open(DIR .. "result.json", "w")
				f:write(string.format(
					'{"turn":%d,"me":%s,"foe":%s,"rng":%d,"ai_samples":%s,"ai_think":%s}\n',
					turn, battler(MON), battler(MON + SIZE), emu:read32(RNG),
					samplesJSON(), _RR.aiThink or 'null'))
				f:close()
				say("turn " .. turn .. ": resolved")
				emu:setKeys(0)
				phase, timer = "wait", 0
			end
		end
		if timer > 60 * 90 then
			say("settle: nothing resolved in 90s; re-asking")
			emu:setKeys(0)
			os.remove(DIR .. "state.json")
			lastSig = ""
			phase, timer = "wait", 0
		end
		return
	end
end

-- The turn counter lives in a global so it survives a hot reload; restarting
-- the numbering mid-fight would make the planner's answers stop matching the
-- questions they were answers to.
-- LOAD THE FIGHT OURSELVES. James keeps save states parked at the exact
-- decision point, so the agent should not need him to navigate to one: it
-- reads a filename out of load.txt at startup and loads it. Only on a FIRST
-- load, not on a hot reload -- otherwise every code change would restart the
-- fight from the save. That also makes
-- the loop restartable without a human -- lose a fight, reload, play it again
-- -- which is what a calibration run needs to be able to do unattended.
local ldf = (not _RR_LOADED_ONCE) and io.open(DIR .. "load.txt", "r") or nil
_RR_LOADED_ONCE = true
if ldf then
	local file = (ldf:read("*a") or ""):gsub("%s+$", "")
	ldf:close()
	if file ~= "" then
		if pcall(function() emu:loadStateFile(file) end) then
			say("loaded " .. file)
			_RR.saveName = file:match("[^/]+$")
			reseed()
		else
			say("COULD NOT LOAD " .. file)
		end
	end
end

say("implementation live. screen=" .. screen())

-- Handed back to the bootstrap, which owns the only frame callback. Reloading
-- this file swaps the logic without stacking another callback, which is the
-- whole point: mGBA cannot remove a callback once added.
return {tick = tick}
