/* eslint-disable @typescript-eslint/no-explicit-any */

import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import { minify } from "html-minifier-terser";
import { Module } from "node:module";
import jsdom from "global-jsdom";

import type { App } from "vue";
import type { EnvironmentConfig, RsbuildConfig, RsbuildEntry, RsbuildPlugin, RsbuildPluginAPI } from "@rsbuild/core";
import type { ExternalItem } from "@rspack/core";
import type { Options as HtmlMinifierOptions } from "html-minifier-terser";

const htmlMinOption: HtmlMinifierOptions = {
	collapseWhitespace: true,
	removeComments: true,
	minifyJS: {
		/**
		 * This is required to make the script runnable even in IE 8 so that at least the error messages can be displayed.
		 * Not that I think there's anyone that still uses IE 8, but that there's no downside of doing so.
		 * The only difference result in this setting is that the `catch` variables are mangled in a non-shadowing way.
		 */
		ie8: true,
	},
};

export interface PluginVueSSGOptions {

	/**
	 * The modules for the root components corresponding to the web entries of Rsbuild.
	 * Each entry could be a SFC file, or any module that exports a Vue component as its default export.
	 * 
	 * Those web entries without a corresponding entry here will not be injected
	 * (but will still be minified if enabled).
	 */
	entry: RsbuildEntry;

	/**
	 * Same as {@link OutputConfig.externals}.
	 * Vue-related packages are treated as such automatically.
	 */
	externals?: ExternalItem[];

	/**
	 * Whether to minify the HTML.
	 *
	 * The minification will take place BEFORE injecting the SSG contents,
	 * since the SSG contents typically include HTML comment placeholders.
	 * This feature internally uses `html-minifier-terser`,
	 * and you can also pass in an object to customize it.
	 * 
	 * @see https://www.npmjs.com/package/html-minifier-terser
	 * @default
	 * ```js
	 * {
	 * 	collapseWhitespace: true,
	 * 	removeComments: true,
	 * 	minifyJS: {
	 * 		ie8: true
	 * 	}
	 * }
	 * ```
	 */
	minify?: boolean | HtmlMinifierOptions;

	/**
	 * Where to inject the SSG contents.
	 * The first matching instance will be replaced by the SSG contents.
	 * 
	 * @default "__VUE_SSG__"
	 */
	target?: string | RegExp;

	/** Additional processing of the HTML after injecting the SSG contents. */
	postProcess?: (html: string, entryName: string) => string;

	/** Additional setups for the Vue {@link App} instance. */
	appFactory?: (app: App, entryName: string) => void;

	/**
	 * Whether to register and use jsdom.
	 * 
	 * Pass in a function for additional setups for the `globalThis` object.
	 * For the sake of convenience, the object is given as `any` type,
	 * making it easier to manipulate.
	 * 
	 * @default false
	 */
	jsdom?: boolean | ((global: any) => void);
}

const HtmlRegex = /\.html?$/i;

export const pluginVueSSG = (options: PluginVueSSGOptions): RsbuildPlugin => ({
	name: "rsbuild-plugin-vue-ssg",

	/** The implementation here is based on Rspress. */
	setup(api: RsbuildPluginAPI) {
		if(options.jsdom) {
			jsdom();
			if(typeof options.jsdom == "function") options.jsdom(globalThis);
		}

		api.modifyRsbuildConfig((config: RsbuildConfig) => {
			if(!("web" in config.environments!)) moveToEnvironments(config);
			config.environments!.node = createNodeEnvironment(config, options);
		});

		let htmlResolver: PromiseWithResolvers<void>;

		api.onBeforeEnvironmentCompile(({ environment }) => {
			if(environment.name == "node") {
				htmlResolver = Promise.withResolvers();
			}
		});

		const ModuleConstructor = Module as any;
		const paths = ModuleConstructor._nodeModulePaths(process.cwd());
		const results: Record<string, string> = {};

		api.processAssets(
			{ stage: "optimize-transfer", targets: ["node"] },
			({ assets, compilation }) => {
				const tasks: Promise<unknown>[] = [];
				for(const [assetName, assetSource] of Object.entries(assets)) {
					const m = new ModuleConstructor();
					m.paths = paths; // So that NPM modules can be resolved (especially Vue)
					m._compile(assetSource.source().toString(), "virtual.cjs");
					const app = createSSRApp(m.exports.default);
					const entryName = assetName.replace(/\.js$/, "");
					if(options.appFactory) options.appFactory(app, entryName);
					const task = renderToString(app).then(html => results[entryName] = html);
					tasks.push(task);
					compilation.deleteAsset(assetName);
				}
				Promise.all(tasks).then(() => htmlResolver.resolve(), e => htmlResolver.reject(e));
			}
		);

		api.processAssets(
			{ stage: "report", targets: ["web"] },
			async ({ assets, compilation, compiler }) => {
				async function replace(html: string, assetName: string): Promise<void> {
					const entryName = assetName.replace(HtmlRegex, "");
					if(options.minify ?? true) {
						const minOption = typeof options.minify == "object" ? options.minify : htmlMinOption;
						html = patchScript(await minify(html, minOption));
					}
					await htmlResolver.promise;
					const result = results[entryName];
					html = result ? html.replace(options.target ?? "__VUE_SSG__", result) : html;
					if(options.postProcess) html = options.postProcess(html, entryName);
					compilation.deleteAsset(assetName);
					compilation.emitAsset(assetName, new compiler.webpack.sources.RawSource(html));
				}

				const tasks: Promise<void>[] = [];
				for(const [assetName, assetSource] of Object.entries(assets)) {
					if(!assetName.match(HtmlRegex)) continue;
					const html = assetSource.source().toString();
					tasks.push(replace(html, assetName));
				}
				await Promise.all(tasks);
			}
		);
	},
});

function moveToEnvironments(config: RsbuildConfig): void {
	config.environments!.web = {
		html: config.html,
		output: config.output,
		performance: config.performance,
		source: {
			entry: config.source?.entry,
		},
		tools: config.tools,
	};
	delete config.html;
	delete config.output;
	delete config.performance;
	delete config.source?.entry;
	delete config.tools;
}

function createNodeEnvironment(config: RsbuildConfig, options: PluginVueSSGOptions): EnvironmentConfig {
	return {
		source: {
			entry: options.entry,
		},
		output: {
			emitAssets: false,
			target: "node",
			minify: false,
			sourceMap: { js: false },
			distPath: {
				root: config.environments?.web.output?.distPath?.root,
			},
			externals: [
				"vue",
				/@vue\//,
				...(options.externals ?? []),
			],
		},
		tools: {
			rspack: {
				// Ensure that only one cjs bundle is generated.
				output: { asyncChunks: false },
			},
		},
	};
}

/** Avoid VS Code Linter warnings */
const patchScript = (c: string) => c.replace(/<script>(.+?)<\/script>/g, "<script>$1;</script>");
