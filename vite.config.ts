import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const rootDir = dirname(fileURLToPath(import.meta.url));

function copyExtensionAssets() {
  return {
    name: 'copy-extension-assets',
    closeBundle() {
      const outDir = resolve(rootDir, 'dist');
      mkdirSync(resolve(outDir, 'icons'), { recursive: true });
      mkdirSync(resolve(outDir, 'popup'), { recursive: true });
      mkdirSync(resolve(outDir, 'options'), { recursive: true });

      copyFileSync(resolve(rootDir, 'manifest.json'), resolve(outDir, 'manifest.json'));

      const builtPopupHtml = resolve(outDir, 'src/popup/index.html');
      const builtOptionsHtml = resolve(outDir, 'src/options/index.html');
      if (existsSync(builtPopupHtml)) {
        copyFileSync(builtPopupHtml, resolve(outDir, 'popup/index.html'));
      }
      if (existsSync(builtOptionsHtml)) {
        copyFileSync(builtOptionsHtml, resolve(outDir, 'options/index.html'));
      }

      for (const icon of ['icon16.png', 'icon48.png', 'icon128.png']) {
        const src = resolve(rootDir, 'icons', icon);
        const dest = resolve(outDir, 'icons', icon);
        if (existsSync(src)) {
          copyFileSync(src, dest);
        }
      }
    },
  };
}

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    rollupOptions: {
      input: {
        'background/worker': resolve(rootDir, 'src/background/worker.ts'),
        'popup/index': resolve(rootDir, 'src/popup/index.html'),
        'options/index': resolve(rootDir, 'src/options/index.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  plugins: [copyExtensionAssets()],
});
