// Self-test of scripts/mutation-select.mjs: each rule picks what it should and nothing else. Run: node scripts/mutation-select-self-test.mjs
import assert from 'node:assert/strict'
import { hunkNear, occurrenceProblems, parseDiff, parseMutants, patternLines, selectSince } from './mutation-select.mjs'

let n = 0
const check = (name, fn) => {
  fn()
  n++
  console.log(`ok  ${name}`)
}

check('parseMutants reads the array; quoting style does not change the value (an old mutant written in other quotes is not new)', () => {
  const single = "x\nconst MUTANTS = [\n  ['a.ts', 'f(1)', 'f(2)', 'label'],\n]\n\nrest"
  const double = 'x\nconst MUTANTS = [\n  ["a.ts", "f(1)", "f(2)", "label"],\n]\n\nrest'
  assert.deepEqual(parseMutants(single), [['a.ts', 'f(1)', 'f(2)', 'label']])
  const r = selectSince({ mutants: parseMutants(double), oldMutants: parseMutants(single), diff: new Map(), readFile: () => 'f(1)' })
  assert.deepEqual(r, [])
})

check('occurrenceProblems: 0 and 2 occurrences are problems, 1 is not; a missing file counts as 0', () => {
  const files = { 'a.ts': 'x\nx\n', 'b.ts': 'y\n' }
  const read = (f) => files[f] ?? null
  const p = occurrenceProblems(
    [
      ['a.ts', 'x', '', 'twice'],
      ['b.ts', 'y', '', 'once'],
      ['b.ts', 'z', '', 'none'],
      ['c.ts', 'x', '', 'gone'],
    ],
    read,
  )
  assert.deepEqual(
    p.map((x) => [x.label, x.count]),
    [
      ['twice', 2],
      ['none', 0],
      ['gone', 0],
    ],
  )
})

check('parseDiff: counts default to 1; a deleted file keeps its old path; a content line starting with ++ is not a header', () => {
  const d = parseDiff(
    [
      'diff --git a/s.ts b/s.ts',
      'index 1..2 100644',
      '--- a/s.ts',
      '+++ b/s.ts',
      '@@ -10 +10 @@',
      '-a',
      '+b',
      '@@ -20,2 +19,0 @@',
      '@@ -30 +29 @@',
      '-old',
      '+++ a content line that looks like a header',
      '@@ -40 +39 @@',
      'diff --git a/gone.ts b/gone.ts',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
    ].join('\n'),
  )
  assert.deepEqual(d.get('s.ts'), [
    { oldCount: 1, newStart: 10, newCount: 1 },
    { oldCount: 2, newStart: 19, newCount: 0 },
    { oldCount: 1, newStart: 29, newCount: 1 },
    { oldCount: 1, newStart: 39, newCount: 1 },
  ])
  assert.deepEqual(d.get('gone.ts'), [{ oldCount: 3, newStart: 0, newCount: 0 }])
})

check('patternLines: one-line, multi-line and trailing-newline patterns', () => {
  const t = 'l1\nl2\nl3\nl4\n'
  assert.deepEqual(patternLines(t, 'l2'), [2, 2])
  assert.deepEqual(patternLines(t, 'l2\nl3'), [2, 3])
  assert.deepEqual(patternLines(t, 'l3\n'), [3, 3])
  assert.equal(patternLines(t, 'nope'), null)
})

check('hunkNear: exactly 3 lines away is near, 4 is not, on both sides', () => {
  const at = [20, 21]
  assert.equal(hunkNear({ newStart: 24, newCount: 1 }, at), true)
  assert.equal(hunkNear({ newStart: 25, newCount: 1 }, at), false)
  assert.equal(hunkNear({ newStart: 17, newCount: 1 }, at), true)
  assert.equal(hunkNear({ newStart: 16, newCount: 1 }, at), false)
  assert.equal(hunkNear({ newStart: 10, newCount: 20 }, at), true)
})

check('hunkNear: a pure deletion counts at the gap it leaves', () => {
  // lines deleted after line 16: the gap is between 16 and 17, so line 20 is 3 lines from 17
  assert.equal(hunkNear({ newStart: 16, newCount: 0 }, [20, 20]), true)
  assert.equal(hunkNear({ newStart: 15, newCount: 0 }, [20, 20]), false)
  assert.equal(hunkNear({ newStart: 24, newCount: 0 }, [20, 20]), false)
  assert.equal(hunkNear({ newStart: 23, newCount: 0 }, [20, 20]), true)
})

check('selectSince: new, near and missing are chosen with their reasons; far and other files are not', () => {
  const file = Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join('\n') + '\n'
  const files = { 's.ts': file, 'o.ts': 'line10\n' }
  const old = [
    ['s.ts', 'line10', 'X', 'near'],
    ['s.ts', 'line30', 'X', 'far'],
    ['o.ts', 'line10', 'X', 'other file'],
    ['s.ts', 'line99', 'X', 'missing'],
  ]
  const now = [...old, ['s.ts', 'line31', 'X', 'new']]
  const diff = parseDiff('diff --git a/s.ts b/s.ts\n--- a/s.ts\n+++ b/s.ts\n@@ -12 +12 @@\n')
  const r = selectSince({ mutants: now, oldMutants: old, diff, readFile: (f) => files[f] ?? null })
  assert.deepEqual(
    r.map((x) => [x.mutant[3], x.reasons]),
    [
      ['near', ['changed within 3 lines']],
      ['missing', ['pattern not found']],
      ['new', ['new mutant']],
    ],
  )
})

check('selectSince: a changed replacement makes the mutant new', () => {
  const r = selectSince({ mutants: [['s.ts', 'a', 'B', 'l']], oldMutants: [['s.ts', 'a', 'C', 'l']], diff: new Map(), readFile: () => 'a' })
  assert.deepEqual(r[0].reasons, ['new mutant'])
})

console.log(`${n} checks passed`)
