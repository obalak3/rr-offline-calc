// doracle -- the hidden oracle for DOUBLE battles.
//
// Loads a save state taken at a doubles action menu, answers BOTH of our
// prompts exactly as the actuator would (write the cursor, press A), runs the
// turn to completion, and prints what actually happened. Same bargain as the
// singles oracle: this ROM consumes its battle RNG per call and the state
// restores it, so what the hidden core reports for a pair of actions IS what
// the live game would do for the same pair. Nothing is displayed anywhere.
//
//   doracle <rom> <state.ss> <spec0> <spec2> [--save out.ss] [--frames N]
//
//     spec := m<slot>[@<target>]   move 0-3, target is a BATTLER index (1,3,2)
//           | s<partySlot>         switch to party slot 0-5
//           | -                    that battler is not expected to be asked
//
//   doracle <rom> <state.ss> peek        dump the position, press nothing
//
// The screen map this drives is docs/SCREEN-MAP.md "Double battles": the turn
// asks battler 0 then battler 2 on their own entries of the controller table,
// a single-target move opens a picker whose cursor holds a battler index, and
// a spread move skips that picker entirely.
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

#define MAIN_CB       0x030030F0
#define CB_BATTLE     0x080123E5
#define CTRL          0x03004FE0          // + 4 * battler
#define S_ACTION      0x0802E439
#define S_MOVES       0x0802EA11
#define S_PARTY       0x08030685
#define S_BUSY        0x0802E3B5
#define S_TARGET      0x090AB46D          // the doubles target picker
#define TARGET_CURSOR 0x03004FF4          // holds a BATTLER index while it is up
#define SCREEN_ID     0x02020014
#define ACTION_CURSOR 0x02023FF8          // + battler
#define MOVE_CURSOR   0x02023FFC          // + battler
#define PARTY_IDX     0x0203B0A9
#define MON           0x02023BE4
#define MON_SIZE      0x58
#define O_SP 0x00
#define O_LV 0x2A
#define O_STAGES 0x18
#define O_HP 0x28
#define O_MAX 0x2C
#define O_ST1 0x4C
#define O_AB 0x20
#define O_ITEM 0x2E
#define O_MOVES 0x0C
#define O_PP 0x24
#define O_ST2 0x50
#define O_STATS 0x02
#define PARTY         0x02024284
#define FOE_PARTY     0x0202402C
#define P_SIZE 100
#define P_HP 0x56
#define P_MAX 0x58
#define P_STATUS 0x50
#define P_LEVEL 0x54
#define P_SPECIES 0x20
#define RNG           0x020386D0
// The field status word and the side timer Tailwind drives, both found
// 2026-09-15 and already shipped by the singles actuator. See
// docs/SCREEN-MAP.md; bit 0x1000 is Electric Terrain and 0x8000 is Grassy,
// both measured, and the rest of the word is unidentified but shipped whole.
#define FIELD_STATUS  0x030020D0
#define TAILWIND_TIMER 0x020179C8
#define AI_ACTION     0x0200005B
#define AI_TARGET     0x02000091
#define KEY_A 1
#define KEY_RIGHT 16
#define KEY_LEFT 32
#define KEY_UP 64
#define KEY_DOWN 128

static void quiet(struct mLogger* l, int c, enum mLogLevel v, const char* f, va_list a) { (void)l;(void)c;(void)v;(void)f;(void)a; }
static struct mLogger LOGGER = { .log = quiet };
static struct mCore* core;
static int dbg = 0;

static uint32_t r32(uint32_t a) { return core->busRead32(core, a); }
static uint16_t r16(uint32_t a) { return core->busRead16(core, a); }
static uint8_t  r8(uint32_t a)  { return core->busRead8(core, a); }
static void w8(uint32_t a, uint8_t v) { core->busWrite8(core, a, v); }
static uint32_t ctrl(int b) { return r32(CTRL + 4 * b); }

static const char* screen_of(int b) {
	if (r32(MAIN_CB) != CB_BATTLE) return "nobattle";
	uint32_t c = ctrl(b);
	if (c == S_ACTION) return "action";
	if (c == S_MOVES) return "moves";
	if (c == S_TARGET) return "target";
	if (c == S_PARTY) return r8(SCREEN_ID) == 9 ? "party_submenu" : "party";
	if (c == S_BUSY) return "busy";
	return "other";
}
static int known_ctrl(uint32_t c) {
	return c == S_ACTION || c == S_MOVES || c == S_PARTY || c == S_BUSY || c == S_TARGET;
}
static const char* screen_any(void) {
	if (r32(MAIN_CB) != CB_BATTLE) return "nobattle";
	if (ctrl(0) == S_ACTION || ctrl(2) == S_ACTION) return "action";
	if (ctrl(0) == S_PARTY || ctrl(2) == S_PARTY) return "party";
	return "busy";
}

static void battler_json(uint32_t base) {
	printf("{\"species\":%u,\"level\":%u,\"hp\":%u,\"maxhp\":%u,\"ability\":%u,\"item\":%u,\"status\":%u,\"status2\":%u,\"moves\":[",
		r16(base + O_SP), r8(base + O_LV), r16(base + O_HP), r16(base + O_MAX), r8(base + O_AB), r16(base + O_ITEM),
		r32(base + O_ST1), r32(base + O_ST2));
	for (int i = 0; i < 4; i++) printf("%s%u", i ? "," : "", r16(base + O_MOVES + i * 2));
	printf("],\"pp\":[");
	for (int i = 0; i < 4; i++) printf("%s%u", i ? "," : "", r8(base + O_PP + i));
	printf("],\"stages\":[");
	for (int i = 0; i < 8; i++) printf("%s%u", i ? "," : "", r8(base + O_STAGES + i));
	printf("],\"stats\":[");
	for (int i = 0; i < 5; i++) printf("%s%u", i ? "," : "", r16(base + O_STATS + i * 2));
	printf("]}");
}
static void rows_json(uint32_t base) {
	for (int i = 0; i < 6; i++) {
		uint32_t b = base + i * P_SIZE;
		printf("%s{\"slot\":%d,\"level\":%u,\"hp\":%u,\"maxhp\":%u,\"status\":%u,\"raw\":\"", i ? "," : "", i,
			r8(b + P_LEVEL), r16(b + P_HP), r16(b + P_MAX), r32(b + P_STATUS));
		for (int k = 0; k < P_SIZE; k++) printf("%02x", r8(b + k));
		printf("\"}");
	}
}
// Short form for before/after: enough to score a turn without re-parsing sets.
static void dump(const char* label, int frame) {
	printf("{\"at\":\"%s\",\"frame\":%d,\"screen\":\"%s\",\"asking\":%d,\"battlers\":[",
		label, frame, screen_any(),
		ctrl(0) == S_ACTION || ctrl(0) == S_PARTY ? 0 : (ctrl(2) == S_ACTION || ctrl(2) == S_PARTY ? 2 : -1));
	for (int b = 0; b < 4; b++) {
		uint32_t m = MON + b * MON_SIZE;
		printf("%s{\"species\":%u,\"hp\":%u,\"maxhp\":%u,\"status\":%u,\"stages\":[", b ? "," : "",
			r16(m + O_SP), r16(m + O_HP), r16(m + O_MAX), r32(m + O_ST1));
		for (int i = 0; i < 8; i++) printf("%s%u", i ? "," : "", r8(m + O_STAGES + i));
		printf("]}");
	}
	printf("],\"party\":[");
	for (int i = 0; i < 6; i++) printf("%s[%u,%u]", i ? "," : "",
		r16(PARTY + i * P_SIZE + P_HP), r16(PARTY + i * P_SIZE + P_MAX));
	printf("],\"foeparty\":[");
	for (int i = 0; i < 6; i++) printf("%s[%u,%u]", i ? "," : "",
		r16(FOE_PARTY + i * P_SIZE + P_HP), r16(FOE_PARTY + i * P_SIZE + P_MAX));
	printf("]}\n");
}
static void obs_json(void) {
	printf("{\"at\":\"obs\",\"turn\":0,\"kind\":\"%s\",\"screen\":\"%s\",\"doubles\":true,\"rng\":%u,\"btype\":%u,"
		"\"ai_action\":%u,\"ai_target\":%u,\"terrainTurns\":%u,"
		"\"fieldStatus\":%u,\"tailwindTimer\":%u,\"battlers\":[",
		!strcmp(screen_any(), "party") ? "forced" : "decision", screen_any(),
		r32(RNG), r32(0x02022B4C), r8(AI_ACTION), r8(AI_TARGET), r8(0x020179BC),
		r32(FIELD_STATUS), r8(TAILWIND_TIMER));
	for (int b = 0; b < 4; b++) { if (b) printf(","); battler_json(MON + b * MON_SIZE); }
	printf("],\"party\":["); rows_json(PARTY);
	printf("],\"foeparty\":["); rows_json(FOE_PARTY); printf("]}\n");
}

static void step(uint32_t keys) { core->setKeys(core, keys); core->runFrame(core); }

// One of our two Pokemon, and how far through answering it we are.
enum { WANT_NONE, WANT_MOVE, WANT_SWITCH };
enum { ST_WAIT, ST_MENU, ST_MOVES, ST_TARGET, ST_PARTY, ST_CONFIRM, ST_DONE };
struct side {
	int battler;
	int want;            // WANT_*
	int slot;            // move slot, or party slot
	int target;          // battler index, -1 for "leave the default"
	int state;
	int since;           // frames in this state
	int pressedA;
	int partyAt;         // frame the party screen opened
	int partyTarget;     // resolved display slot
	uint16_t wantSp;     // for a switch: who we asked for, before the menu
	uint16_t wantMax;
};

static int parse_spec(const char* s, struct side* out) {
	if (!strcmp(s, "-")) { out->want = WANT_NONE; return 1; }
	if (s[0] == 'm') {
		out->want = WANT_MOVE; out->target = -1;
		if (sscanf(s + 1, "%d@%d", &out->slot, &out->target) >= 1) return 1;
		return 0;
	}
	if (s[0] == 's') { out->want = WANT_SWITCH; return sscanf(s + 1, "%d", &out->slot) == 1; }
	return 0;
}

int main(int argc, char** argv) {
	if (argc < 4) {
		fprintf(stderr, "usage: doracle <rom> <state> <spec0> <spec2> [--save out] [--frames N]\n"
		                "       doracle <rom> <state> peek\n"
		                "  spec: m<slot>[@<targetBattler>] | s<partySlot> | -\n");
		return 2;
	}
	const char* rom = argv[1];
	const char* statePath = argv[2];
	const char* saveOut = NULL;
	int maxFrames = 6000;
	int peek = !strcmp(argv[3], "peek");
	struct side me[2];
	memset(me, 0, sizeof(me));
	me[0].battler = 0; me[1].battler = 2;
	me[0].target = me[1].target = -1;
	me[0].partyTarget = me[1].partyTarget = -1;
	if (!peek) {
		if (argc < 5) { fprintf(stderr, "need two specs\n"); return 2; }
		if (!parse_spec(argv[3], &me[0])) { fprintf(stderr, "bad spec '%s'\n", argv[3]); return 2; }
		if (!parse_spec(argv[4], &me[1])) { fprintf(stderr, "bad spec '%s'\n", argv[4]); return 2; }
	}
	for (int i = peek ? 3 : 5; i < argc; i++) {
		if (!strcmp(argv[i], "--save") && i + 1 < argc) saveOut = argv[++i];
		else if (!strcmp(argv[i], "--frames") && i + 1 < argc) maxFrames = atoi(argv[++i]);
	}
	if (getenv("ORACLE_DEBUG")) dbg = 1;

	mLogSetDefaultLogger(&LOGGER);
	core = mCoreFind(rom);
	if (!core) { fprintf(stderr, "no core for %s\n", rom); return 3; }
	core->init(core);
	mCoreInitConfig(core, NULL);
	core->setVideoBuffer(core, malloc(256 * 256 * 4), 256);
	if (!mCoreLoadFile(core, rom)) { printf("{\"error\":\"cannot load rom\"}\n"); return 3; }
	core->reset(core);
	struct VFile* vf = VFileOpen(statePath, O_RDONLY);
	if (!vf || !mCoreLoadStateNamed(core, vf, 0)) { printf("{\"error\":\"cannot load state\"}\n"); return 3; }
	vf->close(vf);

	if (r32(MAIN_CB) != CB_BATTLE) { printf("{\"error\":\"not in a battle\"}\n"); return 3; }

	dump("before", 0);
	if (peek) { obs_json(); return 0; }

	// Which of our two is actually being asked can only be read from the
	// controller table, so the loop never assumes an order: it drives whichever
	// side is at a menu and stops when both have answered.
	for (int i = 0; i < 2; i++) {
		if (me[i].want == WANT_SWITCH) {
			uint32_t b = PARTY + me[i].slot * P_SIZE;
			me[i].wantSp = r16(b + P_SPECIES);
			me[i].wantMax = r16(b + P_MAX);
			if (r16(b + P_HP) == 0) { printf("{\"error\":\"switch target has fainted\"}\n"); return 3; }
		}
		// A state can begin on a FORCED REPLACEMENT rather than an action menu:
		// after a faint the game asks, on the fainted battler's own controller,
		// which is the same S_PARTY value a voluntary switch uses (measured
		// 2026-09-14). There is no FIGHT to choose first, so start at the list.
		if (me[i].want == WANT_SWITCH && ctrl(me[i].battler) == S_PARTY) {
			me[i].state = ST_PARTY; me[i].partyAt = -1; me[i].since = 0;
		} else {
			me[i].state = me[i].want == WANT_NONE ? ST_DONE : ST_WAIT;
		}
	}

	int frame = 0, answered = 0, settled = 0;
	// A frame-by-frame HP trace, so what a turn did can be separated into WHEN
	// it happened. Entry hazards land the moment a Pokemon arrives, before
	// anyone attacks, and a before-and-after of the whole turn cannot tell that
	// apart from the hit it takes afterwards -- which is exactly why two
	// attempts to pin the Spikes address were inconclusive.
	int traceHp = getenv("ORACLE_TRACE_HP") != NULL;
	uint16_t lastHp[4];
	for (int b = 0; b < 4; b++) lastHp[b] = r16(MON + b * MON_SIZE + O_HP);
	while (frame < maxFrames) {
		if (traceHp) {
			for (int b = 0; b < 4; b++) {
				uint16_t h = r16(MON + b * MON_SIZE + O_HP);
				if (h != lastHp[b]) {
					fprintf(stderr, "f%-5d b%d species %u: %u -> %u  (%+d)\n", frame, b,
						r16(MON + b * MON_SIZE + O_SP), lastHp[b], h, (int)h - (int)lastHp[b]);
					lastHp[b] = h;
				}
			}
		}
		uint32_t keys = 0;
		int acted = 0;
		for (int i = 0; i < 2 && !acted; i++) {
			struct side* s = &me[i];
			if (s->state == ST_DONE) continue;
			uint32_t c = ctrl(s->battler);
			const char* scr = screen_of(s->battler);
			int aFrames = (s->since % 40) < 6;

			if (s->state == ST_WAIT) {
				// Let the menu settle before answering it. Pressing on the very
				// first frame after a state load reached FIGHT but not POKEMON:
				// the action cursor is re-initialised while the menu opens, so a
				// write landing before that is thrown away.
				if (c == S_ACTION && frame >= 20) { s->state = ST_MENU; s->since = 0; }
				else continue;
			}
			if (s->state == ST_MENU) {
				if (dbg && s->since == 0) fprintf(stderr, "f%d b%d: menu, cursor -> %d\n", frame, s->battler, s->want == WANT_SWITCH ? 2 : 0);
				if (c != S_ACTION) {
					if (dbg) fprintf(stderr, "f%d b%d: menu taken, ctrl=%08x\n", frame, s->battler, c);               // the menu took the press
					s->state = (s->want == WANT_SWITCH) ? ST_PARTY : ST_MOVES;
					s->since = 0; s->pressedA = 0; s->partyAt = -1;
				} else {
					w8(ACTION_CURSOR + s->battler, s->want == WANT_SWITCH ? 2 : 0);
					keys = aFrames ? KEY_A : 0;
					acted = 1;
				}
			} else if (s->state == ST_MOVES) {
				if (c == S_MOVES) {
					w8(MOVE_CURSOR + s->battler, (uint8_t)s->slot);
					keys = aFrames ? KEY_A : 0;
					acted = 1;
				} else if (c == S_TARGET) {
					s->state = ST_TARGET; s->since = 0;
				} else if (s->since > 30) {
					// The move list is gone and no picker came: a spread or
					// self-targeted move needs no target (measured: Icy Wind).
					if (dbg) fprintf(stderr, "b%d: no target step (move %d)\n", s->battler, s->slot);
					s->state = ST_DONE; answered++;
				}
			} else if (s->state == ST_TARGET) {
				if (c == S_TARGET) {
					if (s->target >= 0) w8(TARGET_CURSOR, (uint8_t)s->target);
					keys = aFrames ? KEY_A : 0;
					acted = 1;
				} else if (s->since > 8) {
					if (dbg) fprintf(stderr, "b%d: target taken (%d)\n", s->battler, s->target);
					s->state = ST_DONE; answered++;
				}
			} else if (s->state == ST_PARTY) {
				// Same rule as the singles core and the actuator: the wanted
				// Pokemon was identified before the menu opened, and is found in
				// the LIVE party once the screen has settled, because this ROM
				// reorders gPlayerParty while the party screen is up.
				if (c != S_PARTY) {
					// Three different reasons the party screen is not up:
					// it has not opened yet (about 23 frames, through an
					// intermediate controller value), it has closed because the
					// switch committed, or it never came at all.
					if (s->pressedA && s->since > 8) {
						if (dbg) fprintf(stderr, "f%d b%d: switch committed\n", frame, s->battler);
						s->state = ST_DONE; answered++;
						continue;
					}
					if (s->partyAt < 0 && s->since > 90) {
						printf("{\"error\":\"party screen never opened for battler %d\"}\n", s->battler);
						return 3;
					}
					s->since++;
					acted = 1;
					break;
				}
				if (s->partyAt < 0) s->partyAt = frame;
				if (frame - s->partyAt < 50) { acted = 1; break; }
				if (s->partyTarget < 0) {
					uint16_t a0sp = r16(MON + O_SP), a0hp = r16(MON + O_HP);
					uint16_t a2sp = r16(MON + 2 * MON_SIZE + O_SP), a2hp = r16(MON + 2 * MON_SIZE + O_HP);
					for (int pass = 0; pass < 2 && s->partyTarget < 0; pass++) {
						for (int k = 0; k < 6 && s->partyTarget < 0; k++) {
							uint32_t b = PARTY + k * P_SIZE;
							if (r16(b + P_HP) == 0) continue;
							// Neither of the two already on the field is a candidate.
							if (r16(b + P_SPECIES) == a0sp && r16(b + P_HP) == a0hp) continue;
							if (r16(b + P_SPECIES) == a2sp && r16(b + P_HP) == a2hp) continue;
							if (pass == 0 && r16(b + P_SPECIES) == s->wantSp && r16(b + P_MAX) == s->wantMax) s->partyTarget = k;
							if (pass == 1 && r16(b + P_MAX) == s->wantMax) s->partyTarget = k;
						}
					}
					if (s->partyTarget < 0 && frame - s->partyAt < 110) { acted = 1; break; }
					if (s->partyTarget < 0) {
						printf("{\"error\":\"wanted Pokemon (species %u, max HP %u) is not in the party as displayed\"}\n",
							s->wantSp, s->wantMax);
						return 3;
					}
					if (dbg) fprintf(stderr, "b%d: switch target is display slot %d\n", s->battler, s->partyTarget);
				}
				int cur = r8(PARTY_IDX);
				if (!s->pressedA && cur != s->partyTarget) {
					// Two columns: left is 0,2,4 and right is 1,3,5, with 7 for
					// Cancel, so DOWN alone can never reach the right column.
					int stepi = s->since % 20;
					uint32_t key = KEY_DOWN;
					if (cur > 5) key = KEY_UP;
					else {
						int ccol = cur % 2, crow = cur / 2, tcol = s->partyTarget % 2, trow = s->partyTarget / 2;
						if (ccol != tcol) key = tcol > ccol ? KEY_RIGHT : KEY_LEFT;
						else if (crow > trow) key = KEY_UP;
						else key = KEY_DOWN;
					}
					keys = stepi < 5 ? key : 0;
					acted = 1;
				} else {
					if (!s->pressedA) { s->pressedA = 1; s->since = 0; }
					// A, a real gap, A: one opens the submenu, one takes SHIFT.
					if (s->since < 8) keys = KEY_A;
					else if (s->since < 70) keys = 0;
					else if (s->since < 78) keys = KEY_A;
					else if (s->since > 400) { printf("{\"error\":\"switch would not commit for battler %d\"}\n", s->battler); return 3; }
					acted = 1;
				}
			}
			s->since++;
		}

		if (me[0].state == ST_DONE && me[1].state == ST_DONE) {
			// Both answered. The turn is over when the game comes back to us.
			settled++;
			int ours = ctrl(0) == S_ACTION || ctrl(2) == S_ACTION || ctrl(0) == S_PARTY || ctrl(2) == S_PARTY;
			if (settled > 20) {
				if (r32(MAIN_CB) != CB_BATTLE) break;
				if (ours) break;
			}
			// A MESSAGE BOX HOLDS THE TURN. Measured 2026-09-14: with one of
			// ours fainted the game sat at the busy value for 2700 frames and
			// never offered a replacement; tapping A walked it through the
			// message and the party screen then opened on the fainted
			// battler's controller. The singles core has always done this.
			if (!ours && settled > 90) {
				int unknown = !known_ctrl(ctrl(0)) || !known_ctrl(ctrl(2));
				// "Will you switch?" after THEIR Pokemon faints is answered no,
				// the same way the actuator answers it.
				if (unknown) keys = (settled % 20) < 4 ? 2 /* B */ : 0;
				else keys = (settled % 40) < 4 ? KEY_A : 0;
			}
		}
		step(keys);
		frame++;
	}

	dump("after", frame);
	obs_json();
	if (saveOut) {
		struct VFile* out = VFileOpen(saveOut, O_RDWR | O_CREAT | O_TRUNC);
		if (out) { mCoreSaveStateNamed(core, out, 0); out->close(out); }
	}
	return 0;
}
