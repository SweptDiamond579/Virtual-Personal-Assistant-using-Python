import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

/**
 * Production builds are a static export served by the FastAPI backend (single
 * origin: cookies, CSRF and WebSockets all stay same-origin). During `next dev`
 * the REST API is proxied to the backend so the browser still sees one origin.
 */
export default function config(phase: string): NextConfig {
  const apiOrigin = process.env.JARVIS_API_ORIGIN ?? "http://127.0.0.1:8000";
  const isDev = phase === PHASE_DEVELOPMENT_SERVER;
  return {
    reactStrictMode: true,
    // Lets parallel dev servers (e.g. visual review harnesses) use separate build dirs.
    distDir: process.env.JARVIS_NEXT_DIST_DIR || ".next",
    transpilePackages: ["@jarvis/protocol"],
    poweredByHeader: false,
    ...(isDev
      ? {
          async rewrites() {
            return [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }];
          },
        }
      : { output: "export", images: { unoptimized: true }, trailingSlash: true }),
  };
}
