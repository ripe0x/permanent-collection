import {defineConfig} from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
    plugins: [react()],
    // Disable PostCSS processing — the Next app's postcss.config.mjs uses
    // Tailwind v4 plugin syntax which is incompatible with Vite 5's
    // older PostCSS loader. Our unit tests don't render anything that
    // needs styling.
    css: {postcss: {plugins: []}},
    test: {
        environment: 'jsdom',
        globals: true,
        include: ['lib/**/*.test.{ts,tsx}', 'components/**/*.test.{ts,tsx}'],
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname),
        },
    },
});
