-- LOAD THIS ONCE. Then never again.
--
-- mGBA has no command-line flag for loading a script and no way to unload one,
-- so every code change so far has cost a full cycle: quit mGBA, relaunch, load
-- the save, click through the scripting menu. That is a bad trade when the
-- thing being iterated on needs a fix roughly every turn, and it is time taken
-- from James for no reason. His question was the right one -- "are you sure you
-- can't run these scripts without me".
--
-- So this file is deliberately tiny and is not expected to change. It owns the
-- ONE frame callback that will ever be registered, and on each frame it calls
-- into an implementation table it reads from disk. When the implementation
-- file changes, it is re-read and swapped in underneath. Callbacks stack in
-- mGBA and cannot be removed, which is why the callback lives here and the
-- logic does not: reloading the logic adds nothing to the stack.
--
-- A broken implementation cannot take the emulator down with it: the load and
-- every tick run inside pcall, and a failure is reported and then ignored
-- until the next version lands.

local IMPL  = os.getenv("HOME") .. "/rr-offline-calc/tools/lua/agent_impl.lua"
local STAMP = os.getenv("HOME") .. "/rr-agent/reload"

if _RR_BOOT then
	console:error("bootstrap: already loaded. It hot-reloads; nothing to do.")
	return
end
_RR_BOOT = true

local impl, lastStamp, failed = nil, nil, false

local function readAll(path)
	local f = io.open(path, "r")
	if not f then return nil end
	local body = f:read("*a")
	f:close()
	return body
end

local function reload()
	local src = readAll(IMPL)
	if not src then
		console:error("bootstrap: cannot read " .. IMPL)
		return
	end
	local chunk, err = load(src, "agent_impl")
	if not chunk then
		console:error("bootstrap: syntax error: " .. tostring(err))
		failed = true
		return
	end
	local ok, res = pcall(chunk)
	if not ok then
		console:error("bootstrap: impl failed to start: " .. tostring(res))
		failed = true
		return
	end
	if type(res) ~= "table" or type(res.tick) ~= "function" then
		console:error("bootstrap: impl did not return a table with tick()")
		failed = true
		return
	end
	impl = res
	failed = false
	console:log("bootstrap: implementation loaded")
end

local frame = 0
callbacks:add("frame", function()
	frame = frame + 1
	-- Check for a new implementation twice a second. Cheap, and it means a fix
	-- lands without anybody touching the emulator.
	if frame % 30 == 0 then
		-- WATCH THE FILE ITSELF, not only the stamp. Editing agent_impl.lua and
		-- forgetting to touch ~/rr-agent/reload left the emulator running code
		-- that no longer existed on disk, with nothing in any log to say so.
		-- The stamp still works and is still honoured; this just removes the
		-- step a person has to remember.
		local stamp = (readAll(STAMP) or "") .. "|" .. #(readAll(IMPL) or "")
		if stamp ~= lastStamp then
			lastStamp = stamp
			reload()
		end
	end
	if impl and not failed then
		local ok, err = pcall(impl.tick)
		if not ok then
			console:error("bootstrap: tick error, pausing impl: " .. tostring(err))
			failed = true
		end
	end
end)

reload()
console:log("bootstrap: watching " .. IMPL)
