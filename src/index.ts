import { parse } from 'acorn';
import { $ } from 'bun';
import { Elysia, redirect } from 'elysia';
import { type Node } from 'estree-walker';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { format } from 'prettier';
import * as resolve from 'resolve.exports';
import type { PackageJson } from 'type-fest';
import { walk } from 'zimmerframe';
import compilers from './scripts/localcache/svelte';

async function fetch_package_info(name: string, version = 'latest') {
	const url = `https://registry.npmjs.org/${name}/${version}`;

	const res = await fetch(url);
	return (await res.json()) as PackageJson;
}

const package_regex = /^(@[\w-]+\/[\w-]+|[\w-]+)?(?:@([\w.-]+))?\/?([\w-]+|[\w./-]+)?$/;

const FETCH_CACHE: Map<string, Promise<{ url: string; body: string }>> = new Map();

// async function fetch_if_uncached(url: string) {
// 	if (FETCH_CACHE.has(url)) {
// 		return FETCH_CACHE.get(url);
// 	}

// 	// if (uid !== current_id) throw ABORT;

// 	const promise = fetch(url)
// 		.then(async (r) => {
// 			if (!r.ok) throw new Error(await r.text());

// 			return {
// 				url: r.url,
// 				body: await r.text(),
// 			};
// 		})
// 		.catch((err) => {
// 			FETCH_CACHE.delete(url);
// 			throw err;
// 		});

// 	FETCH_CACHE.set(url, promise);
// 	return promise;
// }

// async function follow_redirects(url: string) {
// 	const res = await fetch_if_uncached(url);
// 	return res?.url;
// }

async function resolve_from_pkg(pkg: PackageJson, subpath: string, pkg_url_base: string) {
	// match legacy Rollup logic — pkg.svelte takes priority over pkg.exports
	if (typeof pkg.svelte === 'string' && subpath === '.') {
		return pkg.svelte;
	}

	// modern
	if (pkg.exports) {
		try {
			const [resolved] =
				resolve.exports(pkg, subpath, {
					browser: true,
					conditions: ['svelte', 'production'],
				}) || [];

			return resolved;
		} catch {
			// throw `no matched export path was found in "${pkg_name}/package.json"`;
		}
	}

	// console.log(pkg_url_base, subpath);

	// legacy
	if (subpath === '.') {
		let resolved_id = resolve.legacy(pkg, {
			fields: ['browser', 'module', 'main'],
		});

		if (typeof resolved_id === 'object' && !Array.isArray(resolved_id)) {
			const subpath = resolved_id['.'];
			if (subpath === false) return 'data:text/javascript,export {}';

			resolved_id =
				subpath ??
				resolve.legacy(pkg, {
					fields: ['module', 'main'],
				});
		}

		return resolved_id;
	}

	// last ditch — try to match index.js/index.mjs
	for (const index_file of ['', '.mjs', '.js', 'index.mjs', 'index.js']) {
		const joined = path.join(pkg_url_base, subpath);
		try {
			const indexUrl =
				index_file === ''
					? joined
					: index_file.startsWith('.')
						? joined.replace(/\/$/, '') + index_file
						: path.join(joined, index_file);

			console.log({ indexUrl });
			await stat(indexUrl);
			console.log(1);

			return '.' + indexUrl.replace(pkg_url_base, '');
		} catch {}
	}

	if (typeof pkg.browser === 'object') {
		// this will either return `pkg.browser[subpath]` or `subpath`
		return resolve.legacy(pkg, {
			browser: subpath,
		});
	}

	return subpath;
}

new Elysia()
	.get('/', ({}) => 'Hello')
	.get('/npm/*', async ({ params, query, request }) => {
		const slug = params['*'];

		const [, name, version = 'latest', export_or_file = '.'] = package_regex.exec(slug);

		const package_json = await fetch_package_info(name, version);

		const cwd = './packages';
		const proj_id = `${package_json.name}@${package_json.version}`;
		const folder = `${cwd}/${proj_id}`;

		try {
			await mkdir(folder, { recursive: true });
		} catch {}

		const folder_contents = await readdir(folder);
		if (!folder_contents.includes('pnpm-lock.yaml')) {
			await writeFile(
				`${folder}/package.json`,
				JSON.stringify({ dependencies: { [package_json.name]: package_json.version } }, null, 2)
			);

			await $`cd packages/${proj_id} && pnpm install --ignore-scripts`;
		}

		// Now resolve the file
		// We'll try to keep it as an export first.
		const resolved = String(
			await resolve_from_pkg(package_json, export_or_file, path.join(folder, 'node_modules', name))
		);
		const url = new URL(request.url);

		if (!/\.(js|svelte)$/.test(url.pathname)) {
			const new_pathname = path.resolve(url.pathname.replace(export_or_file, ''), resolved);
			console.log({ new_pathname, resolved });

			return redirect(new_pathname + url.search, 307);
		}

		const full_path = path.join(folder, 'node_modules', name, resolved);

		const content = await readFile(full_path, 'utf8');

		let output = content;

		if (full_path.endsWith('.svelte')) {
			try {
				// Fetch full version query.svelte

				console.log(version);
				const compile = (await compilers.get(
					query.svelte || '4.0.0'
				)()) as import('svelte/compiler');

				const { js } = await compile(content, {
					name: 'App',
					filename: full_path,
					// dev: true,
				});

				output = js.code;
			} catch (e) {
				console.error(e);
			}
		}

		const ast = parse(output, { ecmaVersion: 2020, sourceType: 'module' });

		const state = {
			importedModules: new Map<string, [number, number]>(),
		};

		const transformed = walk(ast as Node, state, {
			ImportExpression(node, { state, next }) {
				state.importedModules.set(node.source.value + '', [
					(node.source as Node).start,
					(node.source as Node).end,
				]);

				next();
			},
			ImportDeclaration(node, { state, next }) {
				state.importedModules.set(node.source.value + '', [
					(node.source as Node).start,
					(node.source as Node).end,
				]);

				next();
			},
		});

		console.log(state);

		// Now go through all the imports and resolve them
		return await format(output, { filepath: 'x.js', useTabs: true, singleQuote: true });
	})
	.listen(1234, ({ port }) => console.log('Listening on http://localhost:' + port));

export {};
