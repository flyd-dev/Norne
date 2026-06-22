/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Server-only packages; keep them out of any client bundle and let Node
  // require them at runtime (avoids bundler issues with the document parsers).
  serverExternalPackages: [
    "firebase-admin",
    "pdf-parse",
    "mammoth",
    "xlsx",
    // Native module (.node binary) + its loadable extension — must NOT be
    // bundled, or the bundled loader breaks at runtime ("{}.resolve is not a
    // function" when better-sqlite3's binding resolver loses `path`).
    "better-sqlite3",
    "sqlite-vec",
  ],
};

export default nextConfig;
