import { $ } from 'bun';
import { stat } from 'fs/promises';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { build } from 'tsup';

const data = await fetch('https://registry.npmjs.org/svelte').then((r) => r.json());

function compare_to_version(version: string, major: number, minor: number, patch: number): number {
	const v = version.match(/^(\d+)\.(\d+)\.(\d+)/);

	// @ts-ignore
	return +v[1] - major || +v[2] - minor || +v[3] - patch;
}

const variablify = (str: string) => str.replaceAll('.', '_').replaceAll('-', '_');

// We're not gonna bother with any versions below v3 for now
const versions = Object.keys(data.versions)
	.filter((v) => compare_to_version(v, 3, 0, 0) >= 0)
	.filter((v) => !/(alpha|beta)/.test(v));

const package_files = {
	// '.npmrc': 'auto-install-peers=true',
	'package.json': JSON.stringify({ name: 'anything', workspaces: ['svelte/*'] }),
};
const root = 'src/scripts/localcache';
const folder = `${root}/svelte`;
if (true) {
	try {
		for (const v of versions) {
			await mkdir(folder + '/' + v, { recursive: true });
			// Write package.json with svelte version as dependency
			await $`echo '{ "name": "svelte-${v}", "dependencies": { "svelte": "${v}" } ${
				v.startsWith('3.29') ? ', "css-tree": "1.0.0-alpha22"' : ''
			} }' > ${folder + '/' + v}/package.json`;
			// Write an index.js file which export compile function from svelte/compiler
			await $`echo ${
				v.startsWith('4')
					? 'const { compile } = require("svelte/compiler");\n\nmodule.exports = { compile }'
					: 'export {compile} from "svelte/compiler";'
			} > ${folder + '/' + v}/index.js`;
		}
	} catch {}

	// await $`cd ${root} && echo ${package_files['.npmrc']} > .npmrc`;
	await $`cd ${root} && echo '${package_files['package.json']}' > package.json`;

	await $`cd ${root} && bun install`;
}

const CACHE = true;

if (true) {
	const failed: Set<String> = new Set();
	const sizes: Map<string, number> = new Map();
	for (const version of versions.sort()) {
		let should_build = true;
		if (CACHE) {
			try {
				await stat(folder + '/' + version + '/index.mjs');
				should_build = false;
			} catch {}
		}

		if (should_build) {
			try {
				await build({
					entry: [folder + '/' + version + '/index.js'],
					format: 'esm',
					outDir: folder + '/' + version,
					treeshake: 'smallest',
					pure: ['compile'],
					bundle: true,
					noExternal: ['svelte/compiler'],
				});
			} catch (e) {
				failed.add(version);
			}
		}

		try {
			sizes.set(
				version,
				Math.floor(
					((await readFile(folder + '/' + version + '/index.mjs', 'utf-8').then(
						(content) => content.length
					)) /
						1024) *
						100
				) / 100
			);
		} catch {}
	}

	console.log(sizes);
	console.log('Failed to build:', failed);
}

const content =
	'export default new Map([\n' +
	versions
		.map(
			(v) =>
				`  ["${v}", () => import('./${v}/index.mjs').then(r => ${
					v.startsWith('4') ? 'r.default.compile' : 'r.compile'
				})]`
		)
		.join(',\n') +
	'\n]);';

await writeFile(folder + '/index.js', content);
await writeFile(
	folder + '/index.d.ts',
	`declare const x: Map<string, () => Promise<(typeof import('svelte/compiler'))['compile']>>;
export default x;
`
);

export {};
