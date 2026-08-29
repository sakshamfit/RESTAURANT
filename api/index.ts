// Checked-in Vercel Function entry point.
//
// Vercel validates `functions` against source files that exist in `api/` before
// it runs the project's build command. Keep this small source wrapper tracked
// in Git; `npm run build` separately emits api/index.cjs for the pre-bundled
// CommonJS artifact documented in DEPLOY.md.
// Explicit .js specifier: this project is "type": "module", so when Vercel
// transpiles this graph to native ESM .js files, a specifier without the
// extension fails with ERR_MODULE_NOT_FOUND at cold start (FUNCTION_INVOCATION_FAILED).
import handler from '../vercel-api/index.js';

export default handler;
