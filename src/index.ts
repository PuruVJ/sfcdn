import { cors } from '@elysiajs/cors';
import { parse } from 'acorn';
import { $ } from 'bun';
import { Database } from 'bun:sqlite';
import { Elysia, redirect } from 'elysia';
import { type Node } from 'estree-walker';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as pacote from 'pacote';
import { format } from 'prettier';
import * as resolve from 'resolve.exports';
import type { PackageJson } from 'type-fest';
import { walk } from 'zimmerframe';
import compilers from './scripts/localcache/svelte';
import MagicString from 'magic-string';

const db = new Database('db.sqlite');

class Cache {
	get(key: string) {
		return (
			db.query('SELECT `value` FROM cache WHERE key = ? LIMIT 1').get(key) as {
				value: string;
			} | null
		)?.value;
	}

	set(key: string, value: string) {
		try {
			db.query('INSERT OR REPLACE INTO cache (`key`, `value`) VALUES (?, ?)').run(key, value);
		} catch (e) {
			console.error(e);
		}
	}
}

const cache = new Cache();

async function fetch_package_info(name: string, version?: string) {
	let url = `https://registry.npmjs.org/${name}`;
	if (version) url += `/${version}`;

	const res = await fetch(url);
	return (await res.json()) as PackageJson;
}

const URL_REGEX =
	/^(\/?(?<registry>npm|github)\/)?(?<name>(?:@[\w-]+\/)?[\w-]+)(?:@(?<version>\d+\.\d+\.?\d*|[\w.-]+))?(\/?(?<extra>[\w./-]+)?)$/;
const PROCESSED_URL_REGEX =
	/^\/(?<registry>npm|github)\/(?<name>(?:@[\w-]+\/)?[\w-]+)@(?<version>\d+\.\d+\.\d+|[\w.-]+)\/(?<extra>[\w./-]+)!!cdnv:.*$/;

const BUILD_VERSION = 'pre.1';

// ORDER SENSITIVE
const reserved_flags = ['svelte', 'metadata'] as const;
const flag_aliases = {
	svelte: 's',
	metadata: 'md',
} satisfies Record<(typeof reserved_flags)[number], string | null>;

async function resolve_config_from_url(url: URL) {
	// First check whether its already processed to the format we like. Should be starting with !!cdnv:something at the very end
	const processed = PROCESSED_URL_REGEX.exec(url.pathname);

	let registry: string, name: string, semversion: string, export_or_file: string;
	let flags = {} as Partial<Record<(typeof reserved_flags)[number], string>>;

	if (processed) {
		// All the info is the url. Get it!
		({
			registry = 'npm',
			name,
			version: semversion = 'latest',
			extra: export_or_file = '.',
		} = processed.groups ?? {});

		// Also get the options
		const flags_arr = url.pathname.split('!!')[1].split(';');

		for (const option of flags_arr) {
			// TODO: Do something with it at some point ig
			const [aliased_key, val] = option.split(':').reduce((acc: string[], curr, i) => {
				if (i === 0) acc[0] = curr;
				else {
					acc[1] ??= '';
					acc[1] += curr;
				}
				return acc;
			}, []);

			if (aliased_key === 'cdnv') continue;
			for (const [real, alias] of Object.entries(flag_aliases)) {
				if (aliased_key === alias) {
					flags[real as (typeof reserved_flags)[number]] = val;
				}
			}
		}
	} else {
		// First thing, resolve the version number of the package itself
		({
			registry = 'npm',
			name,
			version: semversion = 'latest',
			extra: export_or_file = '.',
		} = URL_REGEX.exec(url.pathname)?.groups ?? {});

		// For svelte options
		const svelte_flag = url.searchParams.get('svelte') || '4';

		if (url.pathname.endsWith('.svelte')) {
			// The versin could be anything from 2 to 3.1 to 4.0.0 to 5 to next. Resolve it how npm install does
			const { version } = await pacote.manifest(`svelte@${svelte_flag}`);
			flags.svelte = version;
		}
	}

	if (url.searchParams.has('metadata')) {
		const metadata_val = url.searchParams.get('metadata');
		flags.metadata = '1';

		if (metadata_val) {
			if (/(false|0|null)/.test(metadata_val)) {
				delete flags.metadata;
			}
		}
	}

	const { version } = await pacote.manifest(`${name}@${semversion}`);
	const package_json = await fetch_package_info(name, version);

	const cwd = './packages';
	const proj_id = `${package_json.name}@${package_json.version}`;
	const folder = `${cwd}/${proj_id}`;

	try {
		await mkdir(folder, { recursive: true });
	} catch {}

	const subpath = String(
		await resolve_from_pkg(package_json, export_or_file, path.join(folder, 'node_modules', name))
	);

	return {
		registry,
		name,
		version,
		subpath,
		url,
		folder,
		proj_id,
		flags,
	};
}

async function stringify_url_from_config(
	config: Awaited<ReturnType<typeof resolve_config_from_url>>
) {
	// We dont wanna mutate the original URL object
	const temp = new URL(config.url);

	for (const flag of reserved_flags) {
		// Remove all flags if here
		temp.searchParams.delete(flag);
	}

	temp.pathname = `/${config.registry}/${path.join(config.name + '@' + config.version, config.subpath)}${temp.search}`;

	const flag_str_arr = [];
	// Sorted in order of the reserved flags
	for (const [key, value] of Object.entries(config.flags)) {
		if (value === null) continue;

		flag_str_arr.push(`${flag_aliases[key as (typeof reserved_flags)[number]] || key}:${value}`);
	}

	temp.pathname += '!!' + 'cdnv:' + BUILD_VERSION + ';' + flag_str_arr.toSorted().join(';');

	return temp;
}

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
	for (const index_file of ['', '.mjs', '.js', '/index.mjs', '/index.js']) {
		const joined = path.join(pkg_url_base, subpath) + index_file;
		try {
			const indexUrl = joined;

			const info = await stat(indexUrl);
			if (info.isDirectory()) throw new Error('Is a directory');

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
	.use(cors())
	.get('/', ({}) => 'Hello')
	.get('/favicon.ico', ({ set }) => (set.status = 204))
	.get('/*', async ({ request, set }) => {
		const config = await resolve_config_from_url(new URL(request.url));
		const resolved_url = await stringify_url_from_config(config);

		const hit = cache.get(resolved_url.pathname);

		// if (hit) {
		// 	set.headers['Content-Type'] = 'application/javascript';
		// 	set.headers['Content-Encoding'] = 'gzip';
		// 	console.info('CACHE HIT:', resolved_url.pathname);
		// 	return Bun.gzipSync(hit);
		// }

		const folder_contents = await readdir(config.folder);
		if (!folder_contents.includes('pnpm-lock.yaml')) {
			await writeFile(
				`${config.folder}/package.json`,
				JSON.stringify({ dependencies: { [config.name]: config.version } }, null, 2)
			);

			await $`cd packages/${config.proj_id} && pnpm install --prefer-offline --ignore-scripts`;
		}

		if (config.url.pathname !== resolved_url.pathname) {
			return redirect(resolved_url.toString(), 307);
		}

		const full_path = path.join(config.folder, 'node_modules', config.name, config.subpath);

		const content = await readFile(full_path, 'utf8');

		let output = content;

		if (config.flags.svelte) {
			try {
				const compile = (await compilers.get(
					config.flags.svelte
				)?.()) as (typeof import('svelte/compiler'))['compile'];

				const { js } = compile(content, {
					name: 'App',
					filename: full_path,
					// dev: true,
				});

				output = js.code;
			} catch (e) {
				console.error(e);
			}
		}
		try {
			const ast = parse(output, { ecmaVersion: 2020, sourceType: 'module' });

			const state = {
				imports_exports: new Map<string, [number, number]>(),
			};

			const transformed = walk(ast as Node, state, {
				_(node, { state, next }) {
					const node_types: (typeof node)['type'][] = [
						'ImportExpression',
						'ImportDeclaration',
						'ExportNamedDeclaration',
						'ExportAllDeclaration',
						'ExportDefaultDeclaration',
					];

					if (!node_types.includes(node.type)) {
						return next(state);
					}

					if ('source' in node && node.source != null && 'value' in node.source) {
						state.imports_exports.set((node.source as any).value + '', [
							(node.source as any).start,
							(node.source as any).end,
						]);
					}

					next(state);
				},
			});

			const ms = new MagicString(output);
			for (const [import_path, [start, end]] of state.imports_exports) {
				let final_path = path.join('/npm/', import_path);
				if (import_path.startsWith('.')) {
					// Resolve with pathname
					const resolved = new URL(import_path, config.url);
					final_path = resolved.pathname;
				}

				// We also need to point the dependency to the version in the package.json of the current package

				ms.overwrite(start, end, `'${final_path}'`);
			}

			console.log(1);
			output = ms.toString();
			console.log(2);

			console.log(state);
		} catch (e) {
			console.error(e);
		}

		cache.set(resolved_url.pathname, output);

		set.headers['Content-Type'] = 'application/javascript';
		set.headers['Content-Encoding'] = 'gzip';

		output = await format(output, { filepath: 'x.js', useTabs: true, singleQuote: true });
		return Bun.gzipSync(output);
	})
	.listen(1234, ({ port }) => console.log('Listening on http://localhost:' + port));
