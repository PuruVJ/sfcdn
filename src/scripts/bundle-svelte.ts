import { $ } from 'bun';
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
const versions = Object.keys(data.versions).filter((v) => compare_to_version(v, 3, 0, 0) >= 0);

const pnpm_files = {
	'.npmrc': 'auto-install-peers=true',
	'package.json': JSON.stringify({ name: 'anything' }),
	'pnpm-workspace.yaml': `packages:
  - 'svelte/*'`,
};
const root = 'src/scripts/localcache';
const folder = `${root}/svelte`;
if (true) {
	try {
		for (const v of versions) {
			await mkdir(folder + '/' + v, { recursive: true });
			// Write package.json with svelte version as dependency
			await $`echo '{ "dependencies": { "svelte": "${v}" } }' > ${folder + '/' + v}/package.json`;
			// Write an index.js file which export compile function from svelte/compiler
			await $`echo ${v.startsWith('4') ? 'const { compile } = require("svelte/compiler");\n\nmodule.exports = { compile }' : 'export {compile} from "svelte/compiler";'} > ${folder + '/' + v}/index.js`;
		}
	} catch {}

	await $`cd ${root} && echo ${pnpm_files['.npmrc']} > .npmrc`;
	await $`cd ${root} && echo '${pnpm_files['package.json']}' > package.json`;
	await $`cd ${root} && echo '${pnpm_files['pnpm-workspace.yaml']}' > pnpm-workspace.yaml`;

	// for (const version of versions) {
	// 	await $`echo "Copying ${version}" && cd ${
	// 		folder + '/' + version
	// 	} && pnpm install svelte@${version} acorn magic-string`;
	// }
	await $`cd ${root} && pnpm install`;
}

if (false) {
	const failed: string[] = [];
	const sizes = {};
	for (const version of versions.sort()) {
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
			sizes[version] =
				(
					(await readFile(folder + '/' + version + '/index.mjs', 'utf-8').then(
						(content) => content.length
					)) / 1024
				).toFixed(2) + 'kb';
		} catch (e) {
			failed.push(version);
		}
	}

	console.log(sizes);
	console.log('Failed to build:', failed);
}

// Write a file which imports from index.js within each folder, makes an object with {version: compile} and exports the object
// await $`echo 'export default {${versions
//   .map((v) => `"${v}": require("./${v}/index.js").compile`)
//   .join(',\n')}};' > ${folder}/index.js`;

const content =
	'export default new Map([\n' +
	versions
		.map(
			(v) =>
				`  ["${v}", () => import('./${v}/index.mjs').then(r => ${v.startsWith('4') ? 'r.default.compile' : 'r.compile'})]`
		)
		.join(',\n') +
	'\n]);';

await writeFile(folder + '/index.js', content);

export {};
