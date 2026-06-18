/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Server-only packages; keep them out of any client bundle and let Node
  // require them at runtime (avoids bundler issues with the document parsers).
  serverExternalPackages: ["firebase-admin", "pdf-parse", "mammoth", "xlsx"],
};

export default nextConfig;
