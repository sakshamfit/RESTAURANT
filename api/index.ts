// Checked-in Vercel Function entry point.
//
// Vercel validates `functions` against source files that exist in `api/` before
// it runs the project's build command. Keep this small source wrapper tracked
// in Git; `npm run build` separately emits api/index.cjs for the pre-bundled
// CommonJS artifact documented in DEPLOY.md.
import handler from '../vercel-api/index';

export default handler;
