import { $ } from 'bun';
import { Elysia } from 'elysia';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as resolve from 'resolve.exports';
import type { PackageJson } from 'type-fest';

async function fetch_package_info(name: string, version = 'latest') {
	const url = `https://registry.npmjs.org/${name}/${version}`;

	const res = await fetch(url);
	return (await res.json()) as PackageJson;
}

const package_regex = /^([\w-]+)?(?:@([\w.-]+))?\/?([\w-]+|[\w./-]+)?$/;

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

async function resolve_from_pkg(
	pkg_name: string,
	pkg: PackageJson,
	subpath: string
	// pkg_url_base: string
) {
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
			throw `no matched export path was found in "${pkg_name}/package.json"`;
		}
	}

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

		if (!resolved_id) {
			// last ditch — try to match index.js/index.mjs
			for (const index_file of ['index.mjs', 'index.js']) {
				try {
					// const indexUrl = new URL(index_file, `${pkg_url_base}/`).href;
					throw new Error('UNHANDLED');
					// return (await follow_redirects(indexUrl)) ?? '';
				} catch {
					// maybe the next option will be successful
				}
			}

			throw `could not find entry point in "${pkg_name}/package.json"`;
		}

		return resolved_id;
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
	.get('/npm/*', async ({ params }) => {
		const slug = params['*'];

		const [, name, version = 'latest', export_or_file = ''] = package_regex.exec(slug);

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
		const resolved = String(await resolve_from_pkg(name, package_json, export_or_file));

		const full_path = path.join(folder, 'node_modules', name, resolved);

		return await readFile(full_path, 'utf8');
	})
	.listen(1234, ({ port }) => console.log('Listening on http://localhost:' + port));

export {};
