#!/usr/bin/env python3
"""Refuse any command that loads the live brain into a throwaway node process.

`node -e "require('./tools/agent.js')"` does not inspect the agent, it STARTS
one: the module opens the emulator bridge and begins pressing buttons. Run while
James is playing, that is a second agent fighting the first for control of his
game. The rule has lived in a document for weeks, which means it was enforced by
remembering it. This enforces it instead.

Running the file as a program (`node tools/agent.js --probe`) is a normal,
supported thing and is deliberately NOT blocked.
"""
import json
import re
import sys

try:
    cmd = json.load(sys.stdin).get("tool_input", {}).get("command", "")
except Exception:
    sys.exit(0)

# node/nodejs given an inline-script flag, anywhere in a pipeline, where the
# inline script names the brain. Stops at | ; & so a later, unrelated mention of
# agent.js in the same line is not caught.
INLINE = re.compile(r"\bnode(?:js)?\b[^|;&]*?\s-(?:-eval|-print|e|p)\b([^|;&]*)")
BRAIN = re.compile(r"agent\.js|tools/agent|doubles_advisor")

for m in INLINE.finditer(cmd):
    if BRAIN.search(m.group(1)):
        sys.stderr.write(
            "REFUSED: this loads the live brain into an ad-hoc node process, which\n"
            "starts a second agent against the running game rather than inspecting it.\n"
            "To read the module, open the file. To exercise a decision, use the oracle\n"
            "or one of the tools/test_*.js harnesses.\n")
        sys.exit(2)
sys.exit(0)
