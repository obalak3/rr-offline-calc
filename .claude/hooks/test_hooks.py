#!/usr/bin/env python3
"""Do the hooks still fire, and still stay quiet where they should?

Written because the first version of both hooks was a silent no-op: they were
shell scripts piping their program into `python3 -`, which reads its program
from stdin, so the JSON the hook was supposed to read was swallowed as source
code. Every case below passed as "allowed" because nothing ran at all. A hook
that fails open is worse than no hook, because it is believed.

    python3 .claude/hooks/test_hooks.py
"""
import json
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
GUARD = str(HERE / "guard-live-agent.py")
CHECK = str(HERE / "check-js-syntax.py")

BROKEN = pathlib.Path("/tmp/rr_hook_broken.js")
BROKEN.write_text("const a = {\n")

CASES = [
    # the live-brain guard must REFUSE these
    (GUARD, {"command": """node -e "require('./tools/agent.js')" """}, 2,
     "node -e require(./tools/agent.js)"),
    (GUARD, {"command": """node --eval "const a=require('/x/tools/agent.js')" """}, 2,
     "node --eval, absolute path"),
    (GUARD, {"command": """nodejs -p "require('./agent.js').VERSION" """}, 2,
     "nodejs -p"),
    (GUARD, {"command": """cat x | node -e "require('./tools/agent.js')" """}, 2,
     "hidden later in a pipeline"),
    # ...and must ALLOW these, which are all things we really do
    (GUARD, {"command": "node tools/agent.js --probe"}, 0, "running the agent as a program"),
    (GUARD, {"command": "node tools/test_deathlast.js"}, 0, "a test harness"),
    (GUARD, {"command": "grep -n chooseAction tools/agent.js"}, 0, "grepping the brain"),
    (GUARD, {"command": """node -e "console.log(1)" && wc -l tools/agent.js"""}, 0,
     "unrelated node -e, agent.js after &&"),
    (GUARD, {"command": "node tools/doubles_advisor.js state.ss"}, 0, "running the advisor"),
    # the syntax check
    (CHECK, {"file_path": str(ROOT / "tools/lib/deathlast.js")}, 0, "a .js file that parses"),
    (CHECK, {"file_path": str(BROKEN)}, 2, "a .js file that does not parse"),
    (CHECK, {"file_path": str(ROOT / "docs/PLAN-SEARCH.md")}, 0, "a non-JS file"),
    (CHECK, {"file_path": str(ROOT / "node_modules/x.js")}, 0, "vendored code"),
]


def main():
    failures = 0
    for hook, tool_input, want, label in CASES:
        r = subprocess.run([hook], input=json.dumps({"tool_input": tool_input}),
                           capture_output=True, text=True)
        ok = r.returncode == want
        failures += not ok
        print(f"  {'PASS' if ok else 'FAIL'}  {label:<42} exit={r.returncode} want={want}")
    print(f"\n{failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
