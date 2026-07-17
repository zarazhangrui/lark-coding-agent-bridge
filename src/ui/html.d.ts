// The management-console SPA is built by Vite into a single self-contained
// index.html (src/ui/generated/index.html) and imported as a string via tsup's
// text loader, so the bridge can serve it with no runtime file/CDN deps.
declare module "*.html" {
  const html: string;
  export default html;
}
