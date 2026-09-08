#include <mgba/core/core.h>
#include <mgba/core/serialize.h>
#include <mgba/core/config.h>
#include <mgba/core/log.h>
#include <mgba-util/vfs.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <fcntl.h>
static void quiet(struct mLogger* l, int c, enum mLogLevel v, const char* f, va_list a) {(void)l;(void)c;(void)v;(void)f;(void)a;}
static struct mLogger LOGGER = { .log = quiet };
int main(int argc, char** argv) {
	mLogSetDefaultLogger(&LOGGER);
	struct mCore* core = mCoreFind(argv[1]); core->init(core); mCoreInitConfig(core, "headless");
	mCoreLoadFile(core, argv[1]); mCoreAutoloadSave(core); core->reset(core);
	struct VFile* vf = VFileOpen(argv[2], O_RDONLY); mCoreLoadStateNamed(core, vf, 8); vf->close(vf);
	// six max-HP values, any order, at stride 100, max HP at +0x58 and hp at +0x56
	int want[6] = {98, 112, 139, 102, 95, 108};
	for (uint32_t a = 0x02000000; a < 0x0203FF00 - 600; a += 2) {
		int seen = 0, ok = 1;
		for (int i = 0; i < 6 && ok; i++) {
			uint16_t m = core->busRead16(core, a + i * 100 + 0x58), h = core->busRead16(core, a + i * 100 + 0x56);
			int f = 0; for (int k = 0; k < 6; k++) if (want[k] == m && !((seen >> k) & 1)) { seen |= 1 << k; f = 1; break; }
			if (!f || h > m) ok = 0;
		}
		if (ok) { printf("party-like array at 0x%08x: ", a); for (int i = 0; i < 6; i++) printf("%u/%u ", core->busRead16(core, a + i * 100 + 0x56), core->busRead16(core, a + i * 100 + 0x58)); printf("\n"); }
	}
	// also gBattlerPartyIndexes candidates: two u16 near 0x02023BC4..0x02023BE4
	printf("bytes 0x02023BC4..: "); for (int i = 0; i < 32; i += 2) printf("%u ", core->busRead16(core, 0x02023BC4 + i)); printf("\n");
	return 0;
}
