/**
 * Dump the calculator's canonical species / move / item / ability / nature
 * names to data/calc-names.json.
 *
 * extract_trainers.py validates every name from the spreadsheet against this
 * list, so a typo or an unhandled form suffix is reported instead of silently
 * producing a Pokemon the calculator cannot load.
 *
 * Regenerate after updating the vendored calculator:
 *   cd upstream-calc && npm install && npm run build
 *   node tools/dump_calc_names.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const calcPath = path.join(root, 'upstream-calc/calc/dist/index.js');

if (!fs.existsSync(calcPath)) {
	console.error('Built calculator not found at ' + calcPath);
	console.error('Run: cd upstream-calc && npm install && npm run build');
	process.exit(1);
}

const calc = require(calcPath);
const gen = calc.Generations.get(9);

const out = {species: [], moves: [], items: [], abilities: [], natures: [],
	hiddenPowerIVs: {}};
for (const s of gen.species) out.species.push(s.name);
for (const m of gen.moves) out.moves.push(m.name);
for (const i of gen.items) out.items.push(i.name);
for (const a of gen.abilities) out.abilities.push(a.name);
for (const n of gen.natures) out.natures.push(n.name);

// Hidden Power's type is decided by the parity of the six IVs. These spreads
// list only the IVs that must be even; everything else defaults to 31. The
// extractor needs them to keep a Pokemon's stated Hidden Power type intact
// while still fitting the Speed stat the spreadsheet prints.
for (const move of out.moves) {
	const m = move.match(/^Hidden Power (\w+)$/);
	if (!m) continue;
	const ivs = calc.Stats.getHiddenPowerIVs(gen, m[1]);
	if (ivs) out.hiddenPowerIVs[m[1]] = ivs;
}

const dest = path.join(root, 'data/calc-names.json');
fs.mkdirSync(path.dirname(dest), {recursive: true});
fs.writeFileSync(dest, JSON.stringify(out, null, 1));

for (const key of Object.keys(out)) {
	console.log(`${key.padEnd(10)} ${out[key].length}`);
}
console.log('-> data/calc-names.json');
