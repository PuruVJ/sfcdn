import { cors } from '@elysiajs/cors';
import { parse, type Literal } from 'acorn';
import { $ } from 'bun';
import { Database } from 'bun:sqlite';
import { Elysia } from 'elysia';
import { type Node } from 'estree-walker';
import MagicString from 'magic-string';
import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import * as pacote from 'pacote';
import * as resolve from 'resolve.exports';
import type { PackageJson } from 'type-fest';
import { walk } from 'zimmerframe';
import compilers from './scripts/localcache/svelte';

const db = new Database('db.sqlite');

const PACKAGES_ROOT = './packages';

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

class InstallQueue {
	async add(package_name: string, version: string, instant = false) {
		const proj_id = `${package_name}@${version}`;
		const folder = `${PACKAGES_ROOT}/${proj_id}`;

		try {
			await mkdir(folder, { recursive: true });
		} catch {}

		const folder_contents = await readdir(folder);
		if (folder_contents.includes('bun.lockb')) {
			return;
		}

		await Bun.write(
			Bun.file(`${folder}/package.json`),
			JSON.stringify({ dependencies: { [package_name]: version } }, null, 2)
		);

		await $`cd packages/${proj_id} && bun install --ignore-scripts --production`;
	}
}

const installer = new InstallQueue();

async function fetch_package_info(name: string, version?: string) {
	let url = `https://registry.npmjs.org/${name}`;
	if (version) url += `/${version}`;

	const res = await fetch(url);
	return (await res.json()) as PackageJson;
}

const URL_REGEX =
	/^(\/?(?<registry>npm|github)\/)?(?<name>(?:@[\w-]+\/)?[\w.-]+)(?:@(?<version>[\w.-]+))?(\/?(?<extra>[\w./-]+)?)$/;

const PROCESSED_URL_REGEX =
	/^\/(?<registry>npm|github)\/(?<name>(?:@[\w-]+\/)?[\w.-]+)@(?<version>\d+\.\d+\.\d+(?:-[\w.-]+)?)\/(?<extra>[\w./-]+)!!cdnv:.*$/;

const BUILD_VERSION = 'pre.1';

// ORDER SENSITIVE
const reserved_flags = ['svelte', 'metadata'] as const;
const flag_aliases = {
	svelte: 's',
	metadata: 'md',
} satisfies Record<(typeof reserved_flags)[number], string | null>;

async function resolve_config_from_url(url: URL) {
	// First check whether its already processed to the format we like. Should be starting with !!cdnv:something at the very end
	const already_processed = PROCESSED_URL_REGEX.exec(url.pathname);

	let registry: string, name: string, semversion: string, export_or_file: string;
	let flags = {} as Partial<Record<(typeof reserved_flags)[number], string>>;

	if (already_processed) {
		// All the info is the url. Get it!
		({
			registry = 'npm',
			name,
			version: semversion = 'latest',
			extra: export_or_file = '.',
		} = already_processed.groups ?? {});

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
		const svelte_flag = url.searchParams.get('svelte');

		if (url.pathname.endsWith('.svelte') || svelte_flag) {
			// The versin could be anything from 2 to 3.1 to 4.0.0 to 5 to next. Resolve it how npm install does
			const { version } = await pacote.manifest(`svelte@${svelte_flag || '4'}`);
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

	let final_version = semversion;
	if (!already_processed) {
		const { version } = await pacote.manifest(`${name}@${semversion}`);
		final_version = version;
	}
	const package_json = await fetch_package_info(name, final_version);

	const proj_id = `${package_json.name}@${package_json.version}`;
	const folder = `${PACKAGES_ROOT}/${proj_id}`;

	try {
		await mkdir(folder, { recursive: true });
	} catch {}

	const subpath = String(
		await resolve_from_pkg(package_json, export_or_file, path.join(folder, 'node_modules', name))
	);

	return {
		registry,
		name,
		version: final_version,
		subpath,
		url,
		package_json,
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

	temp.pathname = `/${config.registry}/${path.join(
		config.name + '@' + config.version,
		config.subpath
	)}${temp.search}`;

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
		} catch (e) {
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

const current_urls = new Set<string>();

let CACHE = true;

async function compile_url(request: Request, follow_up = false): Promise<Response> {
	if (current_urls.has(request.url) && follow_up) {
		console.log('FOLLOWUP NONOPERATIONAL:', request.url);
		return new Response(null, { status: 204 });
	}

	const config = await resolve_config_from_url(new URL(request.url));
	const resolved_url = await stringify_url_from_config(config);

	current_urls.add(resolved_url.href);

	if (config.url.pathname !== resolved_url.pathname) {
		return new Response(null, {
			status: 307,
			headers: {
				Location: resolved_url.toString(),
			},
		});
	}

	console.log(config.flags);

	const hit = cache.get(resolved_url.pathname);

	if (CACHE)
		if (hit) {
			console.info('CACHE HIT:', resolved_url.pathname);
			current_urls.delete(resolved_url.href);

			return new Response(Bun.gzipSync(hit), {
				headers: {
					'Content-Type': 'application/javascript',
					'Content-Encoding': 'gzip',
					// 'Cache-Control': 'public, max-age=31536000, immutable',
				},
			});
		}

	await installer.add(config.name, config.version, true);

	const full_path = path.join(config.folder, 'node_modules', config.name, config.subpath);

	const content = await Bun.file(full_path).text();

	let output = content;

	if (config.flags.svelte && full_path.endsWith('.svelte')) {
		try {
			const compile = await compilers.get(config.flags.svelte)?.();

			if (!compile)
				throw new Error('Could not find compiler for svelte version ' + config.flags.svelte);

			const { js } = compile(content, {
				name: 'App',
				filename: full_path,
				dev: false,
			});

			output = js.code;
		} catch (e) {
			console.trace('compiler-err', e, content, full_path);
		}
	}

	let urls_to_fetch = new Set<string>();
	if (!full_path.endsWith('.d.ts')) {
		try {
			const ast = parse(output, {
				ecmaVersion: 2022,
				sourceType: 'module',
				sourceFile: full_path,
			});

			const imports_exports = new Map<string, Set<[number, number]>>();

			walk(ast as Node, imports_exports, {
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
						const typed_node_source = node.source as Literal;
						if (!state.has(typed_node_source.value + '')) {
							state.set(typed_node_source.value + '', new Set());
						}

						state
							.get(typed_node_source.value + '')
							?.add([typed_node_source.start, typed_node_source.end]);
					}

					next(state);
				},
			});

			const ms = new MagicString(output);

			for (const [import_path, locs] of imports_exports) {
				let final_path = path.join('/npm/', import_path);
				if (import_path.startsWith('.')) {
					// console.log('Relative import:', import_path);
					// Resolve with pathname
					const resolved = new URL(import_path, config.url);
					if (config.flags.svelte) {
						resolved.searchParams.set('svelte', config.flags.svelte);
					}

					final_path = (await stringify_url_from_config(await resolve_config_from_url(resolved)))
						.pathname;
					// console.log({ final_path });
				} else {
					// We also need to point the dependency to the version in the package.json of the current package
					config.package_json.dependencies ??= {};
					config.package_json.devDependencies ??= {};
					config.package_json.peerDependencies ??= {};

					const [name] = /(?:@[^/]+\/)?[^/]+/.exec(import_path) ?? [];
					if (!name) throw new Error('Could not extract name from import path ' + import_path);

					let version =
						config.package_json.dependencies[name] ??
						config.package_json.devDependencies[name] ??
						config.package_json.peerDependencies[name] ??
						'latest';

					if (config.flags.svelte && name === 'svelte') {
						version = config.flags.svelte;
					}

					const { version: resolved_version } = await pacote.manifest(`${name}@${version}`);
					const package_json = await fetch_package_info(name, resolved_version);

					final_path = String(
						await resolve_from_pkg(
							package_json,
							final_path.replace(`/npm/${name}`, '').replace(/^\//, ''),
							path.join(config.folder, 'node_modules', name)
						)
					);

					final_path = path.join('/npm/', name + '@' + resolved_version, final_path);

					await installer.add(name, resolved_version);

					final_path = (
						await stringify_url_from_config(
							await resolve_config_from_url(new URL(final_path, config.url.origin))
						)
					).pathname;
					// console.log(final_path);}
				}

				// Fire off the request to process subsequent imports and exports too
				urls_to_fetch.add(new URL(final_path, config.url.origin).href);
				// compile_url(new Request(new URL(final_path, config.url.origin)), true);
				// console.log('Following ', new URL(final_path, config.url.origin).href);

				for (const [start, end] of locs) {
					ms.overwrite(start, end, `'${final_path}'`);
				}
			}

			output = ms.toString();
		} catch (e) {
			console.trace(e);
		}
	}

	cache.set(resolved_url.pathname, output);
	current_urls.delete(resolved_url.href);

	for (const url of urls_to_fetch) {
		compile_url(new Request(url), true);
	}

	return new Response(Bun.gzipSync(output), {
		headers: {
			'Content-Type': 'application/javascript',
			'Content-Encoding': 'gzip',
			// 'Cache-Control': 'public, max-age=31536000, immutable',
		},
	});
}

const app = new Elysia()
	.use(cors())
	.get('/', ({}) => 'Hello')
	.get('/favicon.ico', ({ set }) => (set.status = 204))
	.get('/*', ({ request }) => {
		return compile_url(request);
	});
// .listen(1234, ({ port }) => console.log('Listening on http://localhost:' + port));

console.log('Listening on http://localhost:1234');
Bun.serve({
	port: 1234,
	fetch(request) {
		return app.handle(request);
	},
});
