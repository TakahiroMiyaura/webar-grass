// Where this build is published. Shared by tools/make-qr.mjs and tools/verify-qr.mjs so
// the generator and its check can never disagree about the URL -- they used to derive it
// separately, and the check simply refused to run without being handed one.
import fs from 'node:fs'
import path from 'node:path'

// GitHub Pages URL rules: a repo named "<owner>.github.io" publishes at the domain
// root, anything else publishes under /<repo>/. A CNAME file overrides both.
export function publishedUrl(override, outDir = 'dist') {
  if (override) return override

  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) {
    throw new Error('pass a URL as the first argument, or set GITHUB_REPOSITORY')
  }
  const [owner, name] = repo.split('/')
  const cname = path.join(outDir, 'CNAME')
  if (fs.existsSync(cname)) {
    return 'https://' + fs.readFileSync(cname, 'utf8').trim().replace(/\/+$/, '') + '/'
  }
  const host = owner.toLowerCase() + '.github.io'
  return name.toLowerCase() === host ? `https://${host}/` : `https://${host}/${name}/`
}
