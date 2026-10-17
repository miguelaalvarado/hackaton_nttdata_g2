/** @type {import('next').NextConfig} */
const nextConfig = {
  // Imagen Docker mínima; Vercel ignora esta opción.
  output: "standalone",
  // Módulos nativos de libSQL: no se empaquetan, se cargan desde node_modules.
  serverExternalPackages: ["@libsql/client", "libsql"],
};

export default nextConfig;
