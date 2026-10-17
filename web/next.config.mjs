/** @type {import('next').NextConfig} */
const nextConfig = {
  // Imagen Docker mínima; Vercel ignora esta opción.
  output: "standalone",
  // Evita que Next tome como raíz un package-lock.json ajeno en el directorio de usuario.
  outputFileTracingRoot: import.meta.dirname,
  // Módulos nativos de libSQL: no se empaquetan, se cargan desde node_modules.
  serverExternalPackages: ["@libsql/client", "libsql"],
};

export default nextConfig;
