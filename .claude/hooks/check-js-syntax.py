#!/usr/bin/env python3
"""Parse-check a JavaScript file right after it is edited.

A syntax error in tools/agent.js is not found until the agent next restarts,
which is usually in the middle of a fight. node --check costs milliseconds.
"""
import json
import os
import subprocess
import sys

try:
    path = json.load(sys.stdin).get("tool_input", {}).get("file_path", "")
except Exception:
    sys.exit(0)

if not path.endswith(".js") or "node_modules" in path or "upstream-calc" in path:
    sys.exit(0)
if not os.path.exists(path):
    sys.exit(0)

r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
if r.returncode:
    sys.stderr.write("This file no longer parses:\n" + (r.stderr or r.stdout))
    sys.exit(2)
sys.exit(0)
