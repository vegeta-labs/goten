// src/tokens.css is shared word for word with Deal Ops Inbox (src/web/tokens.css). The rules and the recorded hash live in that repo:
// docs/09_UI_DESIGN.md §11.2 (v0.3). Change the rules there first (§10), then both copies and this hash. The website (repo vegeta-labs/vegeta-site) does not use it.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const want = '3d53459029a0b910eff5962cb7dc89eb7ac84775f9fde534b67736e93424de6a'
const have = createHash('sha256').update(readFileSync('src/tokens.css')).digest('hex')
if (want !== have) {
  console.error(
    `src/tokens.css differs from the shared design variables (Deal Ops Inbox docs/09_UI_DESIGN.md §11.2)\n  recorded ${want}\n  file     ${have}\nChange the rules first (§10), then both copies.`,
  )
  process.exit(1)
}
console.log('tokens.css matches the shared design variables')
