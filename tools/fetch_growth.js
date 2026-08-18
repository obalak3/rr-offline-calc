/**
 * Cache the six experience-growth curves, one species list each.
 *
 * A box Pokemon stores experience, not level -- the game derives the level from
 * the two together -- so importing the PC needs to know which curve a species
 * is on. Nothing in the Radical Red dex snapshot carries it, and there are only
 * six lists, so they are fetched once and cached in data/ alongside the other
 * snapshots. The build never reaches the network.
 *
 * Run: node tools/fetch_growth.js      (only when refreshing the cache)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const dir = path.join(__dirname, '../data');

function get(url) {
	return new Promise((resolve, reject) => {
		https.get(url, res => {
			if (res.statusCode !== 200) return reject(new Error(url + ': ' + res.statusCode));
			let body = '';
			res.on('data', c => { body += c; });
			res.on('end', () => resolve(body));
		}).on('error', reject);
	});
}

(async () => {
	for (let i = 1; i <= 6; i++) {
		const body = await get(`https://pokeapi.co/api/v2/growth-rate/${i}/`);
		const parsed = JSON.parse(body);
		fs.writeFileSync(path.join(dir, `gr${i}.json`), body);
		console.log(`gr${i}.json  ${parsed.name}  ${parsed.pokemon_species.length} species`);
	}
})().catch(e => { console.error(e.message); process.exit(1); });
