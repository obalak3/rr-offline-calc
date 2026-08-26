-- Watch James PLAY, and record every battle. Load ONCE per mGBA session, then
-- forget about it. It injects nothing, loads nothing, and never touches play.
--
-- WHY THIS INSTEAD OF THE SCREEN RECORDER for the fresh run. The screen
-- pipeline reads the foe's species by whole-name template, and the template
-- set was built from the Surge corpus -- five Pokemon. A fresh run meets new
-- trainers every fight, each needing new templates before its recordings
-- become trajectories. gBattleMons needs none of that: species, level, HP,
-- max HP, ability, item, moves and PP for BOTH sides, exact rather than
-- inferred from a 48-pixel bar, for any fight, including ones nobody thought
-- to announce. The screen reader remains the LIVE advisor's input, per the
-- settled direction; this is the data pipeline.
--
-- ALSO LOGGED: the battle RNG seed at 0x020386D0. With draw #3 (crit, %24)
-- and draw #4 (damage roll, %16) solved, a logged seed makes every recorded
-- turn's rolls reconstructable after the fact.
--
-- One row whenever the watched state CHANGES, with a frame counter, appended
-- to one TSV per mGBA session. Battles are segmented at analysis time: a
-- session boundary row is written on load, and our species going valid/invalid
-- marks battle edges well enough.

local OUT_DIR = os.getenv("HOME") .. "/rr-screen-corpus/run2/"
local MON, SIZE = 0x02023BE4, 0x58
local US, FOE = MON, MON + SIZE
local O_SP, O_MOVES, O_PP, O_AB, O_HP, O_LV, O_MAX, O_ITEM =
	0x00, 0x0C, 0x24, 0x20, 0x28, 0x2A, 0x2C, 0x2E
local RNG = 0x020386D0

if _RR_PLOG_ACTIVE then
	console:error("passive_logger: already running in this mGBA. Nothing to do.")
	return
end
_RR_PLOG_ACTIVE = true

local path = OUT_DIR .. "passive_" .. os.date("%Y%m%d_%H%M%S") .. ".tsv"
local out = io.open(path, "a")
out:write("frame\tside\tspecies\tlevel\thp\tmax\tability\titem\tmoves\tpp\trng\n")

local frame, last = 0, {}

local function side(base)
	local mv, pp = {}, {}
	for i = 0, 3 do
		mv[i+1] = emu:read16(base + O_MOVES + i*2)
		pp[i+1] = emu:read8(base + O_PP + i)
	end
	return {
		sp = emu:read16(base + O_SP), lv = emu:read8(base + O_LV),
		hp = emu:read16(base + O_HP), mx = emu:read16(base + O_MAX),
		ab = emu:read8(base + O_AB), it = emu:read16(base + O_ITEM),
		mv = table.concat(mv, ","), pp = table.concat(pp, ","),
	}
end

local function sig(s) return s.sp .. "|" .. s.hp .. "|" .. s.pp .. "|" .. s.ab end

local function tick()
	frame = frame + 1
	if frame % 4 ~= 0 then return end        -- 15 Hz is plenty; play is untouched
	local rng = emu:read32(RNG)
	for name, base in pairs({us = US, foe = FOE}) do
		local s = side(base)
		if sig(s) ~= last[name] then
			last[name] = sig(s)
			out:write(string.format("%d\t%s\t%d\t%d\t%d\t%d\t%d\t%d\t%s\t%s\t%d\n",
				frame, name, s.sp, s.lv, s.hp, s.mx, s.ab, s.it, s.mv, s.pp, rng))
			out:flush()
		end
	end
end

callbacks:add("frame", tick)
console:log("passive_logger: watching. Log: " .. path)
