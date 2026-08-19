/**
 * Hash-stamp the one asset the page loads without going through its HTML.
 *
 * Every script and stylesheet named in index.html is stamped by the upstream
 * build, so rebuilding changes their URLs and no stale copy survives. The
 * Pokedex bundle is different: it is 3.9 MB and only pulled in on demand, by a
 * script tag that rr-dex.js builds at runtime from a literal path. Nothing
 * stamps that path, so a browser holding the previous bundle keeps it --
 * silently, and for a file whose contents decide every species' abilities and
 * movepools.
 *
 * Run automatically by `npm run build`, after pruning.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dist = path.join(__dirname, '../upstream-calc/dist');
const loader = path.join(dist, 'js/rr-dex.js');
const bundle = path.join(dist, 'js/data/rr-dex-data.js');

if (!fs.existsSync(loader) || !fs.existsSync(bundle)) {
	console.error('Nothing to stamp: build the site first.');
	process.exit(1);
}

const hash = crypto.createHash('sha1')
	.update(fs.readFileSync(bundle)).digest('hex').slice(0, 8);

const source = fs.readFileSync(loader, 'utf8');
const stamped = source.replace(
	/(var DATA_SRC = ")([^"?]+)(\?[0-9a-f]+)?(")/,
	`$1$2?${hash}$4`);

if (stamped === source && !source.includes(`?${hash}`)) {
	console.error('Could not find DATA_SRC in js/rr-dex.js -- not stamped.');
	process.exit(1);
}
fs.writeFileSync(loader, stamped);

/*
 * Restamp the loader itself in index.html.
 *
 * The upstream build hashed js/rr-dex.js before this rewrote it, so when only
 * the bundle changes, the loader's own URL stays the same -- and a browser
 * holding the cached loader keeps asking for the old bundle. Stamping the file
 * we just modified with a hash of what it now contains closes the chain:
 * index.html is never cached, so the new loader URL is always seen, and the new
 * loader carries the new bundle URL.
 */
const loaderHash = crypto.createHash('sha1')
	.update(fs.readFileSync(loader)).digest('hex').slice(0, 8);
const indexPath = path.join(dist, 'index.html');
const html = fs.readFileSync(indexPath, 'utf8');
const rewritten = html.replace(
	/(src=")(\.\/js\/rr-dex\.js)(\?[0-9a-f]+)?(")/,
	`$1$2?${loaderHash}$4`);
if (rewritten === html) {
	console.error('Could not find js/rr-dex.js in index.html -- not restamped.');
	process.exit(1);
}
fs.writeFileSync(indexPath, rewritten);

const match = stamped.match(/var DATA_SRC = "([^"]+)"/);
console.log(`Pokedex bundle stamped: ${match ? match[1] : '?'}`);
console.log(`Pokedex loader restamped: js/rr-dex.js?${loaderHash}`);
