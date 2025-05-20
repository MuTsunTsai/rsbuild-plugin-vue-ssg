# Rsbuild-Plugin-Vue-SSG

Generate Vue SSG contents and inject those into HTML for Rsbuild.

## Installation

```bash
pnpm add -D @mutsuntsai/rsbuild-plugin-vue-ssg
```

## Usage

```ts
import { defineConfig } from "@rsbuild/core";
import { pluginVue } from "@rsbuild/plugin-vue";
import { pluginVueSSG } from "@mutsuntsai/rsbuild-plugin-vue-ssg";

export default defineConfig({
	source: {
		entry: {
			index: "./src/index.ts",
		},
	},
	html: {
		// The HTML template should contain the string
		// "__VUE_SSG__" as the place for injection
		template: "./src/index.html",
	},
	plugins: [
		pluginVue(),
		pluginVueSSG({
			entry: {
				// The entry name should match the source
				index: "./src/app.vue",
			},
			// Lookup the typing here for the rest of the options
		});
	],
});
```