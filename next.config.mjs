/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // firebase-admin is a server-only package; keep it out of any client bundle.
  serverExternalPackages: ["firebase-admin"],
};

export default nextConfig;
