-- MAP EVERY BATTLE SCREEN TO SOMETHING READABLE IN RAM.
--
-- Load ONCE. Quit mGBA first if any other script is loaded (script loads
-- stack, and closing the Scripting window does not unload them).
--
-- WHY THIS EXISTS, BEFORE ANY AGENT DOES ANYTHING. Every button failure this
-- project has had came from acting without knowing what screen was up: a
-- DOWN-walk that kept re-selecting the same Pokemon, a menu that bounced in
-- and out ten times, an address guessed a kilobyte away from the real one.
-- James's requirement is exact -- "you need to be fully aware of what every
-- screen looks like. Don't give me tests where you are randomly clicking."
--
-- So this presses nothing exploratory. It walks a DETERMINISTIC sequence whose
-- every step is known in advance, waits generously at each one, and dumps a
-- full RAM snapshot LABELLED with the screen that is up. The snapshots get
-- diffed offline (tools/find_screen_bytes.py) to find bytes that are constant
-- within a screen and different between screens. That byte is what the agent
-- will read before it is allowed to press anything.
--
-- It runs on the ARCHIVED battle states, never on James's live save slots.

local SRC   = os.getenv("HOME") .. "/rr-screen-corpus/savestates/ss1.ss"
local OUT   = os.getenv("HOME") .. "/rr-screen-corpus/screens/"

-- The two addresses already MEASURED, re-read here so the dumps carry them.
local ACTION_CURSOR = 0x02023FF8   -- 0 FIGHT, 1 BAG, 2 POKEMON, 3 RUN
local PARTY_IDX     = 0x0203B0A9   -- holds the party slot itself
local MON, SIZE     = 0x02023BE4, 0x58

-- Regions worth dumping: the battle structures and the whole of IWRAM, which
-- is where the battle's phase/function pointers live in this engine family.
local REGIONS = {
	{name = "ew", base = 0x02020000, len = 0x8000},
	{name = "iw", base = 0x03000000, len = 0x8000},
}

local KEY_A, KEY_B = 1, 2

if _RR_MAP_ACTIVE then
	console:error("map_screens: already running. Quit mGBA and reload.")
	return
end
_RR_MAP_ACTIVE = true

-- The script. Each step says how long to wait, what to press, and -- the whole
-- point -- WHICH SCREEN that leaves us on. `dump` marks the steps whose end
-- state gets snapshotted.
--
-- B at the action menu is inert in a trainer battle (you cannot flee), so the
-- unwind at the start cannot do anything except close a menu.
local STEPS = {
	{wait = 240, keys = 0,     screen = nil,            note = "settle after load"},
	{wait = 8,   keys = KEY_B, screen = nil,            note = "unwind any open menu"},
	{wait = 40,  keys = 0,     screen = nil},
	{wait = 8,   keys = KEY_B, screen = nil,            note = "unwind again"},
	{wait = 180, keys = 0,     screen = "action_menu",  dump = true},

	{wait = 8,   keys = KEY_A, screen = nil,            note = "FIGHT (cursor forced to 0)", setCursor = 0},
	{wait = 180, keys = 0,     screen = "move_list",    dump = true},

	{wait = 8,   keys = KEY_B, screen = nil,            note = "back out of the move list"},
	{wait = 180, keys = 0,     screen = "action_menu2", dump = true},

	{wait = 8,   keys = KEY_A, screen = nil,            note = "POKEMON", setCursor = 2},
	{wait = 240, keys = 0,     screen = "party_screen", dump = true},

	{wait = 8,   keys = KEY_A, screen = nil,            note = "open the slot submenu"},
	{wait = 180, keys = 0,     screen = "party_submenu", dump = true},

	{wait = 8,   keys = KEY_B, screen = nil,            note = "close the submenu"},
	{wait = 120, keys = 0,     screen = nil},
	{wait = 8,   keys = KEY_B, screen = nil,            note = "leave the party screen"},
	{wait = 180, keys = 0,     screen = "action_menu3", dump = true},

	-- Commit a move and watch the turn play out, so the moving/animating and
	-- text-waiting phases get labelled too.
	{wait = 8,   keys = KEY_A, screen = nil,            note = "FIGHT", setCursor = 0},
	{wait = 90,  keys = 0,     screen = nil},
	{wait = 8,   keys = KEY_A, screen = nil,            note = "commit move slot 0"},
	{wait = 60,  keys = 0,     screen = "turn_running", dump = true},
	{wait = 240, keys = 0,     screen = "turn_running2", dump = true},
	{wait = 600, keys = 0,     screen = "text_wait",    dump = true,
		note = "the turn has resolved; the game is holding on a message"},
	{wait = 8,   keys = KEY_A, screen = nil,            note = "advance the message"},
	{wait = 300, keys = 0,     screen = "after_turn",   dump = true},
}

local out = io.open(OUT .. "screens.tsv", "w")
out:write("step\tscreen\tframe\taction_cursor\tparty_idx\tus_hp\tfoe_hp\tnote\n")

local step, timer, dumped = 1, 0, 0

local function dumpRam(label)
	for _, r in ipairs(REGIONS) do
		local f = io.open(OUT .. label .. "." .. r.name .. ".bin", "wb")
		if f then f:write(emu:readRange(r.base, r.len)); f:close() end
	end
	dumped = dumped + 1
end

local frame = 0
local function tick()
	frame = frame + 1
	if step > #STEPS then return end
	local s = STEPS[step]

	if timer == 0 and s.setCursor ~= nil then
		emu:write8(ACTION_CURSOR, s.setCursor)
	end
	emu:setKeys(s.keys)
	timer = timer + 1

	if timer >= s.wait then
		if s.screen then
			out:write(string.format("%d\t%s\t%d\t%d\t%d\t%d\t%d\t%s\n",
				step, s.screen, frame,
				emu:read8(ACTION_CURSOR), emu:read8(PARTY_IDX),
				emu:read16(MON + 0x28), emu:read16(MON + SIZE + 0x28),
				s.note or ""))
			out:flush()
			if s.dump then dumpRam(s.screen) end
		end
		step = step + 1
		timer = 0
		if step > #STEPS then
			emu:setKeys(0)
			console:log("map_screens: done. " .. dumped .. " snapshots -> " .. OUT)
			out:close()
		end
	end
end

pcall(function() os.execute("mkdir -p '" .. OUT .. "'") end)
if not pcall(function() emu:loadStateFile(SRC) end) then
	console:error("map_screens: cannot load " .. SRC)
	return
end
callbacks:add("frame", tick)
console:log("map_screens: walking " .. #STEPS .. " known steps -> " .. OUT)
