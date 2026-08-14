// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  // nitro CF preset이 서버를 여러 mjs로 분할하면 @tanstack/react-start 배럴의
  // createCsrfMiddleware가 순환 참조로 undefined가 되어 SSR 500이 발생한다.
  // 단일 번들로 강제해 모듈 로드 순서 문제를 제거한다.
  nitro: {
    rollupConfig: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
