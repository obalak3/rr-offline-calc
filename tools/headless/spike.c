// Headless mGBA spike: load the ROM and a save state, step frames, read the
// battle structs. No window, no audio. Build: see build.sh.
#include <mgba/core/core.h>
#include <mgba/core/serialize.h>
#include <mgba/core/config.h>
#include <mgba-util/vfs.h>
#include <mgba/core/log.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <fcntl.h>

static void quiet(struct mLogger* l, int cat, enum mLogLevel lv, const char* fmt, va_list args) { (void)l;(void)cat;(void)lv;(void)fmt;(void)args; }
static struct mLogger LOGGER = { .log = quiet };

int main(int argc, char** argv) {
	mLogSetDefaultLogger(&LOGGER);
	if (argc < 3) { fprintf(stderr, "usage: spike <rom> <state> [frames]\n"); return 2; }
	int frames = argc > 3 ? atoi(argv[3]) : 60;
	struct mCore* core = mCoreFind(argv[1]);
	if (!core) { fprintf(stderr, "no core for %s\n", argv[1]); return 1; }
	core->init(core);
	mCoreInitConfig(core, "headless");
	if (!mCoreLoadFile(core, argv[1])) { fprintf(stderr, "cannot load rom\n"); return 1; }
	mCoreAutoloadSave(core);
	core->reset(core);
	struct VFile* vf = VFileOpen(argv[2], O_RDONLY);
	if (!vf) { fprintf(stderr, "cannot open state\n"); return 1; }
	bool ok = mCoreLoadStateNamed(core, vf, SAVESTATE_RTC);
	vf->close(vf);
	printf("state loaded: %s\n", ok ? "yes" : "NO");
	// gBattleMons: player at 0x02023BE4, opponent +0x58; HP at +0x28, species +0x00
	for (int i = 0; i <= frames; i++) {
		static uint32_t lastHp = 0xffff, lastSp = 0xffff;
		uint32_t sp0 = core->busRead16(core, 0x02023BE4), hp0 = core->busRead16(core, 0x02023BE4 + 0x28);
		if (i % 120 == 0 || sp0 != lastSp || hp0 != lastHp) {
			lastSp = sp0; lastHp = hp0;
			uint32_t base = 0x02023BE4;
			printf("frame %3d  us sp=%u hp=%u  them sp=%u hp=%u  rng=%08x\n", i,
				core->busRead16(core, base), core->busRead16(core, base + 0x28),
				core->busRead16(core, base + 0x58), core->busRead16(core, base + 0x58 + 0x28),
				core->busRead32(core, 0x020386D0));
			printf("           iwram rng candidate 0x03005000=%08x\n", core->busRead32(core, 0x03005000));
		}
		core->setKeys(core, (i % 40) < 6 ? 1 : 0); /* A */
		core->runFrame(core);
	}
	core->deinit(core);
	return 0;
}
