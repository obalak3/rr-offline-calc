// dscan -- a windowless prodder for mapping screens the agent does not know.
//
// Built for double battles (2026-09-14). The actuator's screen map covers the
// action menu, the move list and the party screen, all measured in SINGLES. A
// double battle adds at least two things nothing here has ever seen: the game
// asks TWICE per turn (once per Pokemon of ours), and choosing an attack opens
// a TARGET picker. James's rule is that nothing presses a button before the
// screen is known, so this tool only looks: it plays a scripted key sequence
// on a windowless core and reports what the machine did.
//
//   dscan <rom> <state.ss> --script "wait:60,A:6,wait:40" [--trace] [--dump F]
//
// Script steps are `KEY:frames`, comma separated. KEY is one of
// wait A B UP DOWN LEFT RIGHT L R START SELECT. `--trace` prints one line
// whenever any watched byte changes; `--dump F` writes EWRAM (256K) and IWRAM
// (32K) to F at the END of the script, for diffing two runs against each other
// (the way the action and move cursors were found: press a direction, diff
// against a control dump of the same screen with nothing pressed, and keep the
// byte that moves like a cursor).
#include <mgba/core/core.h>
#include <mgba/core/serialize.h>
#include <mgba/core/config.h>
#include <mgba/core/log.h>
#include <mgba-util/vfs.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>

#define MAIN_CB       0x030030F0
#define CB_BATTLE     0x080123E5
#define CTRL_ME       0x03004FE0
#define CTRL_FOE      0x03004FE4
#define S_ACTION      0x0802E439
#define S_MOVES       0x0802EA11
#define S_PARTY       0x08030685
#define S_BUSY        0x0802E3B5
#define SCREEN_ID     0x02020014
#define ACTION_CURSOR 0x02023FF8
#define MOVE_CURSOR   0x02023FFC
#define PARTY_IDX     0x0203B0A9
#define MON           0x02023BE4
#define MON_SIZE      0x58
#define O_SP 0x00
#define O_MOVES 0x0C
#define O_PP 0x24
#define O_HP 0x28
#define O_MAX 0x2C

#define EWRAM 0x02000000
#define EWRAM_LEN 0x40000
#define IWRAM 0x03000000
#define IWRAM_LEN 0x8000

static void quiet(struct mLogger* l, int c, enum mLogLevel v, const char* f, va_list a) { (void)l;(void)c;(void)v;(void)f;(void)a; }
static struct mLogger LOGGER = { .log = quiet };
static struct mCore* core;

static uint32_t r32(uint32_t a) { return core->busRead32(core, a); }
static uint16_t r16(uint32_t a) { return core->busRead16(core, a); }
static uint8_t  r8(uint32_t a)  { return core->busRead8(core, a); }
static void w8(uint32_t a, uint8_t v) { core->busWrite8(core, a, v); }

static const char* screen(void) {
	if (r32(MAIN_CB) != CB_BATTLE) return "nobattle";
	uint32_t c = r32(CTRL_ME);
	if (c == S_ACTION) return "action";
	if (c == S_MOVES) return "moves";
	if (c == S_PARTY) return r8(SCREEN_ID) == 9 ? "party_submenu" : "party";
	if (c == S_BUSY) return "busy";
	return "UNKNOWN";
}

struct keymap { const char* name; uint32_t bit; };
static struct keymap KEYS[] = {
	{"wait", 0}, {"A", 1}, {"B", 2}, {"SELECT", 4}, {"START", 8},
	{"RIGHT", 16}, {"LEFT", 32}, {"UP", 64}, {"DOWN", 128},
	{"R", 256}, {"L", 512}, {NULL, 0}
};

static void dump_ram(const char* path) {
	FILE* f = fopen(path, "wb");
	if (!f) { fprintf(stderr, "cannot write %s\n", path); return; }
	for (uint32_t a = 0; a < EWRAM_LEN; a++) fputc(r8(EWRAM + a), f);
	for (uint32_t a = 0; a < IWRAM_LEN; a++) fputc(r8(IWRAM + a), f);
	fclose(f);
}

int main(int argc, char** argv) {
	if (argc < 3) { fprintf(stderr, "usage: dscan <rom> <state> [--script S] [--trace] [--dump F]\n"); return 2; }
	const char* rom = argv[1];
	const char* statePath = argv[2];
	const char* script = "wait:120";
	const char* dumpPath = NULL;
	int trace = 0, info = 0;
	uint32_t watch[16]; int nwatch = 0;
	for (int i = 3; i < argc; i++) {
		if (!strcmp(argv[i], "--script") && i + 1 < argc) script = argv[++i];
		else if (!strcmp(argv[i], "--dump") && i + 1 < argc) dumpPath = argv[++i];
		else if (!strcmp(argv[i], "--trace")) trace = 1;
		else if (!strcmp(argv[i], "--info")) info = 1;
		else if (!strcmp(argv[i], "--watch") && i + 1 < argc) {
			char wb[256]; strncpy(wb, argv[++i], sizeof(wb) - 1); wb[sizeof(wb) - 1] = 0;
			for (char* t = strtok(wb, ","); t && nwatch < 16; t = strtok(NULL, ",")) watch[nwatch++] = (uint32_t)strtoul(t, NULL, 16);
		}
	}

	mLogSetDefaultLogger(&LOGGER);
	core = mCoreFind(rom);
	if (!core) { fprintf(stderr, "no core for %s\n", rom); return 3; }
	core->init(core);
	mCoreInitConfig(core, NULL);
	core->setVideoBuffer(core, malloc(256 * 256 * 4), 256);
	if (!mCoreLoadFile(core, rom)) { fprintf(stderr, "cannot load rom\n"); return 3; }
	core->reset(core);
	struct VFile* vf = VFileOpen(statePath, O_RDONLY);
	if (!vf || !mCoreLoadStateNamed(core, vf, 0)) { fprintf(stderr, "cannot load state %s\n", statePath); return 3; }
	vf->close(vf);

	if (info) {
		for (int b = 0; b < 4; b++) {
			uint32_t m = MON + b * MON_SIZE;
			printf("{\"battler\":%d,\"species\":%u,\"hp\":%u,\"maxhp\":%u,\"moves\":[%u,%u,%u,%u],\"pp\":[%u,%u,%u,%u]}\n",
				b, r16(m + O_SP), r16(m + O_HP), r16(m + O_MAX),
				r16(m + O_MOVES), r16(m + O_MOVES + 2), r16(m + O_MOVES + 4), r16(m + O_MOVES + 6),
				r8(m + O_PP), r8(m + O_PP + 1), r8(m + O_PP + 2), r8(m + O_PP + 3));
		}
		return 0;
	}

	// What we watch. Any change prints a line; that is how a screen nobody has
	// mapped announces itself.
	uint32_t lastCtrl = 0, lastFoe = 0;
	uint8_t lastId = 0, lastAct = 0, lastMv = 0, lastParty = 0;
	uint8_t lastWatch[16]; memset(lastWatch, 0, sizeof(lastWatch));
	int first = 1, frame = 0;

	char buf[1024];
	strncpy(buf, script, sizeof(buf) - 1); buf[sizeof(buf) - 1] = 0;
	for (char* tok = strtok(buf, ","); tok; tok = strtok(NULL, ",")) {
		char name[32]; int n = 0;
		// poke:ADDRHEX=VALUE -- write one byte, consume no frames. The actuator
		// chooses by WRITING a cursor rather than walking it with the d-pad
		// (docs/SCREEN-MAP.md: directions can only be pressed blind), so the
		// question "can the target be set the same way" has to be answerable.
		{
			unsigned int pa = 0, pv = 0;
			if (sscanf(tok, "poke:%x=%u", &pa, &pv) == 2) {
				w8(pa, (uint8_t)pv);
				printf("poke %08x = %u\n", pa, pv);
				continue;
			}
		}
		// until:N -- run up to N frames, stopping as soon as either of our two
		// battlers is asked again (or the battle ends). The turn is over when
		// the game comes back to us, which is not a fixed number of frames.
		{
			int un = 0;
			if (sscanf(tok, "until:%d", &un) == 1) {
				for (int i = 0; i < un; i++) {
					core->setKeys(core, 0);
					core->runFrame(core);
					frame++;
					uint32_t a0 = r32(CTRL_ME), a2 = r32(CTRL_ME + 8);
					if (i > 30 && (a0 == S_ACTION || a2 == S_ACTION || a0 == S_PARTY || a2 == S_PARTY
							|| r32(MAIN_CB) != CB_BATTLE)) break;
				}
				continue;
			}
		}
		if (sscanf(tok, "%31[^:]:%d", name, &n) != 2) { fprintf(stderr, "bad step '%s'\n", tok); return 2; }
		uint32_t keys = 0; int found = 0;
		for (int i = 0; KEYS[i].name; i++) if (!strcmp(KEYS[i].name, name)) { keys = KEYS[i].bit; found = 1; break; }
		if (!found) { fprintf(stderr, "unknown key '%s'\n", name); return 2; }
		for (int i = 0; i < n; i++) {
			core->setKeys(core, keys);
			core->runFrame(core);
			frame++;
			uint32_t ctrl = r32(CTRL_ME), foeCtrl = r32(CTRL_ME + 8);
			uint8_t id = r8(SCREEN_ID), act = r8(ACTION_CURSOR), mv = r8(MOVE_CURSOR), pty = r8(PARTY_IDX);
			int wchanged = 0;
			for (int k = 0; k < nwatch; k++) if (r8(watch[k]) != lastWatch[k]) wchanged = 1;
			if (trace && (first || wchanged || ctrl != lastCtrl || foeCtrl != lastFoe || id != lastId
					|| act != lastAct || mv != lastMv || pty != lastParty)) {
				printf("f%-5d %-9s c0=%08x c1=%08x c2=%08x c3=%08x id=%-3u acur=%-3u mcur=%-3u pidx=%-3u  b:",
					frame, screen(), r32(CTRL_ME), r32(CTRL_ME + 4), r32(CTRL_ME + 8), r32(CTRL_ME + 12),
					id, act, mv, pty);
				for (int b = 0; b < 4; b++)
					printf(" %u:%u/%u", r16(MON + b * MON_SIZE + O_SP),
						r16(MON + b * MON_SIZE + O_HP), r16(MON + b * MON_SIZE + O_MAX));
				for (int k = 0; k < nwatch; k++) printf("  %08x=%u", watch[k], r8(watch[k]));
				printf("\n");
				fflush(stdout);
				for (int k = 0; k < nwatch; k++) lastWatch[k] = r8(watch[k]);
				lastCtrl = ctrl; lastFoe = foeCtrl; lastId = id;
				lastAct = act; lastMv = mv; lastParty = pty; first = 0;
			}
		}
	}
	printf("{\"at\":\"end\",\"frame\":%d,\"screen\":\"%s\",\"ctrl\":\"%08x\",\"id\":%u,\"battlers\":[",
		frame, screen(), r32(CTRL_ME), r8(SCREEN_ID));
	for (int b = 0; b < 4; b++) printf("%s{\"species\":%u,\"hp\":%u,\"maxhp\":%u}", b ? "," : "",
		r16(MON + b * MON_SIZE + O_SP), r16(MON + b * MON_SIZE + O_HP), r16(MON + b * MON_SIZE + O_MAX));
	printf("]}\n");
	if (dumpPath) dump_ram(dumpPath);
	return 0;
}
