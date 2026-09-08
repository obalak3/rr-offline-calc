// Headless battle oracle. Loads a save state taken on our action menu, plays
// ONE action exactly as the Lua actuator would press it, runs until the game
// asks us again (or the battle ends), and prints what happened as JSON.
//   oracle <rom> <state.ss> move <slot0-3> [--save out.ss] [--frames N]
//   oracle <rom> <state.ss> switch <partySlot0-5> [--save out.ss]
//   oracle <rom> <state.ss> peek                       (no action: dump)
// Nothing is displayed anywhere; this is a bare core.
#include <mgba/core/core.h>
#include <mgba/core/serialize.h>
#include <mgba/core/config.h>
#include <mgba/core/log.h>
#include <mgba-util/vfs.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <fcntl.h>

// Addresses, copied from tools/lua/agent_impl.lua (Radical Red on this ROM).
#define MAIN_CB       0x030030F0
#define CB_BATTLE     0x080123E5
#define CTRL_ME       0x03004FE0
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
#define O_STAGES 0x18
#define O_HP 0x28
#define O_MAX 0x2C
#define O_ST1 0x4C
#define PARTY         0x02024284
#define FOE_PARTY     0x0202402C
#define P_SIZE 100
#define P_HP 0x56
#define P_MAX 0x58
#define AI_ACTION     0x0200005B
#define AI_TARGET     0x02000091
#define RNG           0x020386D0
#define KEY_A 1
#define KEY_B 2
#define KEY_RIGHT 16
#define KEY_LEFT 32
#define KEY_UP 64
#define KEY_DOWN 128

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
	uint8_t id = r8(SCREEN_ID);
	if (id == 1) return "action";
	if (id == 7) return "moves";
	if (id == 8) return "party";
	if (id == 9) return "party_submenu";
	return "unknown";
}

static void mon_json(const char* key, uint32_t base) {
	printf("\"%s\":{\"species\":%u,\"hp\":%u,\"maxhp\":%u,\"status\":%u,\"stages\":[", key,
		r16(base + O_SP), r16(base + O_HP), r16(base + O_MAX), r32(base + O_ST1));
	for (int i = 0; i < 8; i++) printf("%s%u", i ? "," : "", r8(base + O_STAGES + i));
	printf("]}");
}
static void party_json(const char* key, uint32_t base) {
	printf("\"%s\":[", key);
	for (int i = 0; i < 6; i++) printf("%s[%u,%u]", i ? "," : "", r16(base + i * P_SIZE + P_HP), r16(base + i * P_SIZE + P_MAX));
	printf("]");
}
static void dump(const char* label, int frame) {
	printf("{\"at\":\"%s\",\"frame\":%d,\"screen\":\"%s\",", label, frame, screen());
	mon_json("me", MON); printf(","); mon_json("foe", MON + MON_SIZE); printf(",");
	party_json("party", PARTY); printf(","); party_json("foeparty", FOE_PARTY);
	printf(",\"ai\":[%u,%u],\"rng\":\"%08x\"}\n", r8(AI_ACTION), r8(AI_TARGET), r32(RNG));
}

static void step(uint32_t keys) { core->setKeys(core, keys); core->runFrame(core); }

int main(int argc, char** argv) {
	if (argc < 4) { fprintf(stderr, "usage: oracle <rom> <state> move|switch|peek [n] [--save out] [--frames N]\n"); return 2; }
	const char* saveOut = NULL; int maxFrames = 6000;
	for (int i = 4; i < argc; i++) {
		if (!strcmp(argv[i], "--save") && i + 1 < argc) saveOut = argv[++i];
		else if (!strcmp(argv[i], "--frames") && i + 1 < argc) maxFrames = atoi(argv[++i]);
	}
	mLogSetDefaultLogger(&LOGGER);
	core = mCoreFind(argv[1]);
	if (!core) { fprintf(stderr, "no core\n"); return 1; }
	core->init(core);
	mCoreInitConfig(core, "headless");
	if (!mCoreLoadFile(core, argv[1])) { fprintf(stderr, "cannot load rom\n"); return 1; }
	mCoreAutoloadSave(core);
	core->reset(core);
	struct VFile* vf = VFileOpen(argv[2], O_RDONLY);
	if (!vf) { fprintf(stderr, "cannot open state\n"); return 1; }
	if (!mCoreLoadStateNamed(core, vf, SAVESTATE_RTC)) {
		vf->seek(vf, 0, SEEK_SET);
		if (!mCoreLoadStateNamed(core, vf, 0)) { fprintf(stderr, "cannot load state (stateSize %zu, file %ld)\n", core->stateSize(core), (long) vf->size(vf)); return 1; }
	}
	vf->close(vf);
	const char* what = argv[3];
	int slot = argc > 4 && argv[4][0] != '-' ? atoi(argv[4]) : 0;
	dump("before", 0);
	if (!strcmp(what, "peek")) return 0;
	int wantSwitch = !strcmp(what, "switch");
	// phases: 0 open menu, 1 pick move / pick party slot, 2 settle, 3 done
	int phase = 0, timer = 0, sinceLeft = 0, pressedA = 0;
	for (int frame = 1; frame <= maxFrames; frame++) {
		const char* scr = screen();
		uint32_t keys = 0;
		timer++;
		if (phase == 0) {
			if (!wantSwitch && !strcmp(scr, "moves")) { phase = 1; timer = 0; }
			else if (wantSwitch && (!strcmp(scr, "party") || !strcmp(scr, "party_submenu"))) { phase = 1; timer = 0; }
			else if (!strcmp(scr, "action")) {
				w8(ACTION_CURSOR, wantSwitch ? 2 : 0);
				keys = (timer % 40) < 6 ? KEY_A : 0;
			} else if (timer > 600) { printf("{\"error\":\"menu never opened\",\"screen\":\"%s\"}\n", scr); return 3; }
		} else if (phase == 1 && !wantSwitch) {
			if (strcmp(scr, "moves")) { if (timer > 4) { phase = 2; timer = 0; } }
			else { w8(MOVE_CURSOR, (uint8_t)slot); keys = (timer % 40) < 6 ? KEY_A : 0; }
			if (timer > 900) { printf("{\"error\":\"move would not commit\"}\n"); return 3; }
		} else if (phase == 1 && wantSwitch) {
			if (!strcmp(scr, "party") || !strcmp(scr, "party_submenu")) {
				// Walk the cursor to the slot with the d-pad exactly as the
				// actuator does (the party grid is two columns, Cancel is 7),
				// then A opens the submenu and A again takes SHIFT.
				int cur = r8(PARTY_IDX);
				if (!pressedA && cur != slot && !strcmp(scr, "party")) {
					int stepi = timer % 20;
					uint32_t key = KEY_DOWN;
					if (cur > 5) key = KEY_UP;
					else {
						int ccol = cur % 2, crow = cur / 2, tcol = slot % 2, trow = slot / 2;
						if (ccol != tcol) key = tcol > ccol ? KEY_RIGHT : KEY_LEFT;
						else if (crow > trow) key = KEY_UP;
						else key = KEY_DOWN;
					}
					keys = stepi < 5 ? key : 0;
					if (timer > 900) { printf("{\"error\":\"party cursor stuck at %d wanting %d\"}\n", cur, slot); return 3; }
				} else {
					if (!pressedA) { pressedA = 1; sinceLeft = timer; }
					int since = timer - sinceLeft;
					if (since < 8) keys = KEY_A;
					else if (since < 70) keys = 0;
					else if (since < 78) keys = KEY_A;
					else if (since > 400) { printf("{\"error\":\"switch would not commit\",\"screen\":\"%s\",\"cursor\":%d}\n", scr, cur); return 3; }
				}
			} else if (timer > 20) { phase = 2; timer = 0; sinceLeft = 0; }
		} else if (phase == 2) {
			// The turn is resolving. It is over when the game is back on OUR
			// menu (or a forced party pick, or out of battle) and has stayed
			// there for a few frames after at least a second of animation.
			int ours = !strcmp(scr, "action") || !strcmp(scr, "party") || !strcmp(scr, "nobattle");
			if (timer > 60 && ours) { sinceLeft++; if (sinceLeft >= 10) { phase = 3; } }
			else sinceLeft = 0;
			if (timer == 1) dump("committed", frame);
			// A dialogue box waiting for A (e.g. "It's super effective!" does
			// not wait in this ROM, but level-ups or item messages might):
			// mash A gently while busy, never on our own menu.
			if (!ours && !strcmp(scr, "busy") && timer > 120) keys = (timer % 40) < 4 ? KEY_A : 0;
			// Their Pokemon fainted: "Will you switch?" is an unknown screen
			// to the classifier; the actuator answers it with B (no), and so
			// do we, so the replacement comes in and the turn ends on our menu.
			if (!ours && !strcmp(scr, "unknown") && timer > 60) keys = (timer % 20) < 4 ? KEY_B : 0;
		}
		if (phase == 3) {
			dump("after", frame);
			if (saveOut) {
				struct VFile* out = VFileOpen(saveOut, O_RDWR | O_CREAT | O_TRUNC);
				if (out) { mCoreSaveStateNamed(core, out, SAVESTATE_RTC); out->close(out); }
			}
			core->deinit(core);
			return 0;
		}
		step(keys);
	}
	printf("{\"error\":\"frame budget exhausted\",\"screen\":\"%s\"}\n", screen());
	dump("after", maxFrames);
	return 4;
}
