-- SECOND PASS: verify the screen pointer, and MEASURE the move cursor.
--
-- Load ONCE, after quitting mGBA. Runs unattended on an archived state.
--
-- Pass one found 0x03004FE0 -- the player's battle-controller function pointer
-- -- taking a different value at the action menu, the move list and the party
-- screen. That was ONE sample of each screen from ONE save state, which is the
-- amount of evidence that has misled this project every previous time: three
-- hand probes concluded the AI decides after the player commits, and a powered
-- dataset said the opposite. So this re-reaches all three screens from a
-- DIFFERENT state by a different route and checks the same values come back.
-- If they do not, the pointer is tracking something incidental and the agent
-- must not be built on it.
--
-- It also measures the one address still missing. Choosing a move without
-- pressing directions blind needs the MOVE CURSOR, the move list's equivalent
-- of gActionSelectionCursor. It is found the way the action cursor was found
-- and the way the guessed one was not: press a direction inside the move list,
-- diff against the same screen unpressed, and take the byte that moves the way
-- the cursor moves. A CONTROL dump with no press at all is taken first, so
-- timers and animation counters get subtracted rather than mistaken for the
-- answer.

local SRC = os.getenv("HOME") .. "/rr-screen-corpus/savestates/ss2.ss"
local OUT = os.getenv("HOME") .. "/rr-screen-corpus/screens2/"

local ACTION_CURSOR = 0x02023FF8
local PARTY_IDX     = 0x0203B0A9
local CTRL_ME       = 0x03004FE0   -- the candidate under test
local CTRL_FOE      = 0x03004FE4

local REGIONS = {
	{name = "ew", base = 0x02020000, len = 0x8000},
	{name = "iw", base = 0x03000000, len = 0x8000},
}

local KEY_A, KEY_B = 1, 2
local KEY_RIGHT, KEY_LEFT, KEY_DOWN = 16, 32, 128

if _RR_MAP2_ACTIVE then
	console:error("map_screens2: already running. Quit mGBA and reload.")
	return
end
_RR_MAP2_ACTIVE = true

local STEPS = {
	{wait = 240, keys = 0,     note = "settle after load"},
	{wait = 8,   keys = KEY_B},
	{wait = 40,  keys = 0},
	{wait = 8,   keys = KEY_B},
	{wait = 180, keys = 0,     screen = "v_action_menu",    dump = true},

	{wait = 8,   keys = KEY_A, setCursor = 0, note = "FIGHT"},
	{wait = 180, keys = 0,     screen = "v_move_slot0",     dump = true},
	{wait = 120, keys = 0,     screen = "v_move_slot0b",    dump = true,
		note = "CONTROL: same screen, nothing pressed"},

	{wait = 8,   keys = KEY_RIGHT},
	{wait = 150, keys = 0,     screen = "v_move_right",     dump = true},
	{wait = 8,   keys = KEY_DOWN},
	{wait = 150, keys = 0,     screen = "v_move_rightdown", dump = true},
	{wait = 8,   keys = KEY_LEFT},
	{wait = 150, keys = 0,     screen = "v_move_down",      dump = true},

	{wait = 8,   keys = KEY_B, note = "back to the action menu"},
	{wait = 180, keys = 0,     screen = "v_action_menu2",   dump = true},

	{wait = 8,   keys = KEY_A, setCursor = 2, note = "POKEMON"},
	{wait = 240, keys = 0,     screen = "v_party_screen",   dump = true},
	{wait = 8,   keys = KEY_B},
	{wait = 180, keys = 0,     screen = "v_action_menu3",   dump = true},
}

local out = io.open(OUT .. "screens2.tsv", "w")
out:write("step\tscreen\tframe\tctrl_me\tctrl_foe\taction_cursor\tparty_idx\tnote\n")

local step, timer, frame, dumped = 1, 0, 0, 0

local function dumpRam(label)
	for _, r in ipairs(REGIONS) do
		local f = io.open(OUT .. label .. "." .. r.name .. ".bin", "wb")
		if f then f:write(emu:readRange(r.base, r.len)); f:close() end
	end
	dumped = dumped + 1
end

local function tick()
	frame = frame + 1
	if step > #STEPS then return end
	local s = STEPS[step]
	if timer == 0 and s.setCursor ~= nil then emu:write8(ACTION_CURSOR, s.setCursor) end
	emu:setKeys(s.keys)
	timer = timer + 1
	if timer >= s.wait then
		if s.screen then
			out:write(string.format("%d\t%s\t%d\t0x%08X\t0x%08X\t%d\t%d\t%s\n",
				step, s.screen, frame,
				emu:read32(CTRL_ME), emu:read32(CTRL_FOE),
				emu:read8(ACTION_CURSOR), emu:read8(PARTY_IDX), s.note or ""))
			out:flush()
			if s.dump then dumpRam(s.screen) end
		end
		step = step + 1; timer = 0
		if step > #STEPS then
			emu:setKeys(0)
			console:log("map_screens2: done. " .. dumped .. " snapshots -> " .. OUT)
			out:close()
		end
	end
end

pcall(function() os.execute("mkdir -p '" .. OUT .. "'") end)
if not pcall(function() emu:loadStateFile(SRC) end) then
	console:error("map_screens2: cannot load " .. SRC); return
end
callbacks:add("frame", tick)
console:log("map_screens2: verifying 0x03004FE0 and hunting the move cursor")
