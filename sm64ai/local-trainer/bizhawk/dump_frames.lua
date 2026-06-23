-- dump_frames.lua — run inside BizHawk (EmuHawk) to capture aligned screenshots
-- while a SM64 TAS movie plays. Each saved PNG is named by the emulated input-frame
-- number, so build_dataset.py can pair frame N's image with input N from the .m64.
--
-- HOW TO USE
--   1. Tools > Lua Console > open this script (but DON'T run yet).
--   2. File > Movie > Play Movie...  pick your .m64 (BizHawk imports it).
--      (Use the matching SUPER MARIO 64 (U) ROM. We can't ship the ROM.)
--   3. With the movie playing from power-on, click "Run" on the script.
--   It fast-forwards through the movie, dropping PNGs into OUT_DIR, then stops.
--
-- Start with a SHORT individual-level movie (a few hundred frames) to validate the
-- pipeline before doing the long full-game runs.

local OUT_DIR = "frames"   -- created relative to the EmuHawk working dir
local NAME    = "run"      -- filename prefix; use a unique name per movie
local SUB     = 2          -- save every SUB-th frame (1 = every frame; 2 = ~30Hz)
local MAXFR   = 0          -- 0 = whole movie; otherwise stop after N frames (debug)

if not movie.isloaded() then
    console.log("No movie loaded. File > Movie > Play Movie... first, then Run.")
    return
end

-- best effort: make the folder
os.execute('mkdir "' .. OUT_DIR .. '" 2> nul')
os.execute('mkdir -p "' .. OUT_DIR .. '" 2> /dev/null')

client.speedmode(400)      -- fast-forward; rendering still happens so screenshots are valid
local total = movie.length()
console.log(string.format("Dumping %s frames (every %d) -> %s/", tostring(total), SUB, OUT_DIR))

while movie.isloaded() and emu.framecount() < total do
    local f = emu.framecount()
    if (f % SUB) == 0 then
        client.screenshot(string.format("%s/%s_%07d.png", OUT_DIR, NAME, f))
    end
    if MAXFR > 0 and f >= MAXFR then break end
    emu.frameadvance()
end

client.speedmode(100)
console.log("done dumping " .. NAME)
