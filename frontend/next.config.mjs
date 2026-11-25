/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',          // static files, served by Electron from app://autobrowser
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
};
export default nextConfig;
