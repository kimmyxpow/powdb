import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'

// The app version is baked into the build (src/lib/version.ts reads __POWVIEW_VERSION__).
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

/**
 * ssh2 tries two optional native addons (inside try/catch) and falls back to pure JavaScript.
 * The addons crash Bun, so they are removed on install; here every require of them becomes a
 * module that throws, which sends ssh2 down its JavaScript path.
 */
function noNativeAddons(): Plugin {
  const stub = '\0powview-no-native-addon'
  return {
    name: 'powview-no-native-addons',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'cpu-features' || id.endsWith('.node')) return stub
      return null
    },
    load(id) {
      if (id === stub) return "throw new Error('Native addons are not used in PowView.')"
      return null
    },
  }
}

export default defineConfig({
  server: { port: 3333 },
  resolve: { tsconfigPaths: true },
  // Bundle every dependency into the server build, so the Docker image needs no node_modules.
  ssr: { noExternal: true },
  define: { __POWVIEW_VERSION__: JSON.stringify(version) },
  // Vite leaves the server build unminified by default; minify it too, it ships in the image and the npm package.
  build: { minify: true },
  plugins: [
    noNativeAddons(),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
    // a component the compiler bails out of would ship unmemoized, so it fails the build instead
    babel({
      presets: [reactCompilerPreset({ panicThreshold: 'all_errors' })],
    }),
  ],
})
