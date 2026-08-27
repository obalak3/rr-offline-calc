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

local S_ACTION, S_MOVES, S_PARTY, S_BUSY = 0x0802E439, 0x0802EA11, 0x08030685, 0x0802E3B5

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
local O_SP, O_MOVES, O_STAGES, O_AB, O_PP, O_HP, O_LV, O_MAX, O_ITEM, O_ST1 =
	0x00, 0x0C, 0x18, 0x20, 0x24, 0x28, 0x2A, 0x2C, 0x2E, 0x4C
-- The battler's REAL stats, in order atk, def, spe, spa, spd. Reading these
-- means the planner never has to infer the opponent's nature, EVs or IVs to
-- price a hit -- it uses the numbers the game is using.
local O_STATS = 0x02
-- Gen 3 party Pokemon: everything below is OUTSIDE the encrypted block.
local P_SIZE, P_STATUS, P_LEVEL, P_HP, P_MAX = 100, 0x50, 0x54, 0x56, 0x58

local KEY_A, KEY_B = 1, 2
-- Set by the presence of a file, so it can be flipped without a reload.
local RESTART = false
do
	local f = io.open(os.getenv("HOME") .. "/rr-agent/restart", "r")
	if f then f:close(); RESTART = true end
end

pcall(function() os.execute("mkdir -p '" .. DIR .. "'") end)

-- ------------------------------------------------------------------ reading
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
		.. '"status":%d,"moves":[%s],"pp":[%s],"stages":[%s],"stats":[%s]}',
		emu:read16(base + O_SP), emu:read8(base + O_LV),
		emu:read16(base + O_HP), emu:read16(base + O_MAX),
		emu:read8(base + O_AB), emu:read16(base + O_ITEM),
		emu:read32(base + O_ST1),
		table.concat(mv, ","), table.concat(pp, ","), table.concat(st, ","),
		table.concat(stats, ","))
end

-- The party's species sits inside the encrypted substructures, so it is not
-- read here. Level, HP and status are outside the encryption, and the planner
-- already knows the roster from the save file -- it matches on those instead,
-- and checks its answer against gBattleMons for whoever is actually out.
local function party()
	local rows = {}
	for i = 0, 5 do
		local b = PARTY + i * P_SIZE
		rows[#rows+1] = string.format('{"slot":%d,"level":%d,"hp":%d,"maxhp":%d,"status":%d}',
			i, emu:read8(b + P_LEVEL), emu:read16(b + P_HP), emu:read16(b + P_MAX),
			emu:read32(b + P_STATUS))
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

-- Written back on every tick; locals stay for readability and speed.
local function persist()
	_RR.turn, _RR.phase, _RR.timer = turn, phase, timer
	_RR.pending, _RR.want = pending, want
	_RR.lastSig, _RR.attempts = lastSig, attempts
	_RR.unstick = unstick
end
local log = io.open(DIR .. "agent.log", "a")
local function say(s) console:log("agent: " .. s); log:write(s .. "\n"); log:flush() end

local function positionSignature()
	return emu:read16(MON + O_SP) .. "/" .. emu:read16(MON + O_HP) .. "/"
		.. emu:read16(MON + SIZE + O_SP) .. "/" .. emu:read16(MON + SIZE + O_HP)
		.. "/" .. emu:read8(MON + O_PP) .. emu:read8(MON + O_PP + 1)
		.. emu:read8(MON + O_PP + 2) .. emu:read8(MON + O_PP + 3)
end

local function writeState(kind)
	turn = turn + 1
	local f = io.open(DIR .. "state.json", "w")
	f:write(string.format(
		'{"turn":%d,"kind":"%s","screen":"%s","rng":%d,'
		.. '"ai_action":%d,"ai_target":%d,'
		.. '"me":%s,"foe":%s,"party":[%s]}\n',
		turn, kind, screen(), emu:read32(RNG),
		emu:read8(AI_ACTION), emu:read8(AI_TARGET),
		battler(MON), battler(MON + SIZE), party()))
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
			lastSig = ""
			os.remove(DIR .. "state.json")
			os.remove(DIR .. "cmd.json")
		end
		return nil
	end
	local slot = tonumber(body:match('"slot"%s*:%s*(%d+)'))
	if not act or not slot then return nil end
	say("read command: " .. body:gsub("%s+$", ""))
	return {action = act, slot = slot}
end

local frame = 0
local function tick()
	local ok, err = pcall(tick_inner)
	persist()
	if not ok then error(err) end
end

function tick_inner()
	frame = frame + 1
	if frame % 4 ~= 0 and phase == "wait" then return end

	local scr = screen()

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
			-- overworld and no business acting there.
			emu:setKeys(0)
			unstick = (unstick or 0) + 1
			if unstick == 120 then
				say("the battle is over. " .. (_RR.fights or 0) .. " fought so far")
			end
			-- Restart from the save, which is what makes a calibration run a
			-- LOOP: play, finish, reload, play again, without anybody watching.
			if unstick > 240 and RESTART then
				local f = io.open(DIR .. "load.txt", "r")
				local file = f and (f:read("*a") or ""):gsub("%s+$", "") or ""
				if f then f:close() end
				if file ~= "" and pcall(function() emu:loadStateFile(file) end) then
					_RR.fights = (_RR.fights or 0) + 1
					say("restarted the fight (" .. _RR.fights .. ")")
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
		unstick = 0

		-- A decision point is the game asking us, on a position we have not
		-- already answered. The signature guard is what stops the agent
		-- answering the same turn twice while the menu is still up.
		if scr == "action" or scr == "party" then
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
				phase, timer, attempts = "await", 0, 0
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
			phase, timer = (want.action == "switch") and "sw_open" or "mv_open", 0
		elseif timer > 60 * 60 then
			-- Ask again rather than giving up. The planner may simply not have
			-- been started yet, and a half that goes quiet forever is worse
			-- than one that repeats itself.
			say("turn " .. turn .. ": no answer in 60s; asking again")
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

	if phase == "mv_open" then
		-- Already in the move list is not a failure, it is a shortcut. The
		-- first live run tripped here because James still had the controls and
		-- had opened FIGHT himself between the ask and the answer: the agent
		-- refused to press into a screen it did not expect, which is right,
		-- and then gave up, which is not. Being further along than expected is
		-- the one surprise that needs no recovery.
		if scr == "moves" then phase, timer = "mv_pick", 0; return end
		if scr ~= "action" then
			if timer > 240 then
				say("mv_open: expected the action menu, saw " .. scr .. "; re-asking")
				os.remove(DIR .. "state.json")
				lastSig = ""
				phase = "wait"
			end
			return
		end
		emu:write8(ACTION_CURSOR, 0)                       -- FIGHT
		emu:setKeys(timer <= 6 and KEY_A or 0)
		if timer > 60 then phase, timer = "mv_pick", 0 end
		return
	end

	if phase == "mv_pick" then
		if scr ~= "moves" then
			if timer > 180 then
				attempts = attempts + 1
				say("mv_pick: the move list did not open (saw " .. scr .. "), retrying")
				phase, timer = (attempts < 3) and "mv_open" or "wait", 0
			end
			return
		end
		emu:write8(MOVE_CURSOR, want.slot)
		emu:setKeys(timer <= 6 and KEY_A or 0)
		if timer > 60 then phase, timer = "settle", 0 end
		return
	end

	if phase == "sw_open" then
		if scr ~= "action" and scr ~= "party" then
			if timer > 240 then
				say("sw_open: expected a menu, saw " .. scr .. "; re-asking")
				os.remove(DIR .. "state.json"); lastSig = ""; phase = "wait"
			end
			return
		end
		if scr == "party" then phase, timer = "sw_pick", 0; return end
		emu:write8(ACTION_CURSOR, 2)                       -- POKEMON
		emu:setKeys(timer <= 6 and KEY_A or 0)
		if timer > 90 then phase, timer = "sw_pick", 0 end
		return
	end

	if phase == "sw_pick" then
		if scr ~= "party" then
			if timer > 240 then
				attempts = attempts + 1
				say("sw_pick: the party screen did not open (saw " .. scr .. "), retrying")
				phase, timer = (attempts < 3) and "sw_open" or "wait", 0
			end
			return
		end
		-- 7 is the Cancel button, not a Pokemon. Writing the slot directly
		-- avoids the 2x3 grid entirely; a DOWN-only walk cannot reach the
		-- right-hand column at all, which is why earlier attempts kept
		-- re-selecting the same Pokemon.
		emu:write8(PARTY_IDX, want.slot)
		emu:setKeys(timer <= 6 and KEY_A or 0)
		if timer > 90 then phase, timer = "sw_confirm", 0 end
		return
	end

	if phase == "sw_confirm" then
		-- On a voluntary switch a submenu opens -- Shift / Summary / Cancel,
		-- cursor already on Shift, so one A does it. On a FORCED switch, after
		-- one of ours has fainted, there is no submenu at all.
		if scr == "party_submenu" then
			emu:setKeys(timer <= 6 and KEY_A or 0)
			if timer > 40 then phase, timer = "settle", 0 end
			return
		end
		if scr ~= "party" then phase, timer = "settle", 0; return end
		if timer > 180 then
			say("sw_confirm: stuck on the party screen; backing out and re-asking")
			emu:setKeys(KEY_B)
			os.remove(DIR .. "state.json")
			lastSig = ""
			phase, timer = "wait", 0
		end
		return
	end

	if phase == "settle" then
		-- Advance messages ONLY while the game is busy. Pressing A blindly here
		-- was pressing it at the action menu too, which opens FIGHT -- so the
		-- agent kept re-opening the move list it had just come back from, never
		-- saw the action menu again, and declared that nothing had resolved
		-- after ninety seconds. It was undoing its own turn.
		local advancing = (scr == "busy") and (timer % 40 < 4)
		emu:setKeys(advancing and KEY_A or 0)
		if scr == "action" or scr == "party" then
			if positionSignature() ~= lastSig then
				local f = io.open(DIR .. "result.json", "w")
				f:write(string.format('{"turn":%d,"me":%s,"foe":%s,"rng":%d}\n',
					turn, battler(MON), battler(MON + SIZE), emu:read32(RNG)))
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
