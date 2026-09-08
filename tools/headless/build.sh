#!/bin/sh
# Builds the headless spike against the locally built mGBA 0.10.5 core (mgba-build).
D="$(cd "$(dirname "$0")" && pwd)"
clang -O1 -I"$D/mgba-src/include" -I"$D/mgba-build/include" -L"$D/mgba-build" -lmgba -Wl,-rpath,"$D/mgba-build" -o "$D/spike" "$D/spike.c"
