// Which mutants a change can affect (DEV_PROCESS_RULES §5, owner 2026-11-24). Pure functions: the runner in
// mutation-check.mjs feeds them git output and file contents; scripts/mutation-select-self-test.mjs checks them.
//
// A mutant counts as affected since a commit when
//   (a) it is new: no mutant with the same file, pattern and replacement existed at that commit (values are compared,
//       not source text, so quoting style cannot make an old mutant look new);
//   (b) its pattern is within NEAR lines of a changed line in its file;
//   (c) its pattern is no longer in the file (the run reports it MISSING).
// A changed test does not by itself re-run mutants (owner 2026-11-24: Goten's mutants run the whole suite, so a test
// file reaches nearly every mutant; the weekly full run covers that case).

export const NEAR = 3

/** The MUTANTS array literal of a mutation-check.mjs text (current or from an older commit). */
export function parseMutants(scriptText) {
  const start = scriptText.indexOf('const MUTANTS = [')
  const end = scriptText.indexOf('\n]\n', start)
  if (start < 0 || end < 0) throw new Error('MUTANTS array not found')
  return new Function(`return ${scriptText.slice(start + 'const MUTANTS = '.length, end + 2)}`)()
}

export const mutantKey = ([file, find, repl]) => JSON.stringify([file, find, repl])

/** How often each mutant's pattern occurs in its file; the runner requires exactly once (`--check-only`). */
export function occurrenceProblems(mutants, readFile) {
  const out = []
  for (const [file, find, , label] of mutants) {
    const text = readFile(file)
    const n = text === null ? 0 : text.split(find).length - 1
    if (n !== 1) out.push({ file, label, count: n })
  }
  return out
}

/** Hunks of a `git diff -U0` output, by new path: { oldCount, newStart, newCount }. A deleted file is keyed by its old path. */
export function parseDiff(diffText) {
  const files = new Map()
  let current = null
  let oldPath = null
  let header = false // between a `diff --git` line and the first hunk: only there are ---/+++ lines file names
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      header = true
    } else if (header && line.startsWith('--- ')) oldPath = line === '--- /dev/null' ? null : line.slice(6)
    else if (header && line.startsWith('+++ ')) {
      current = line === '+++ /dev/null' ? oldPath : line.slice(6)
      if (!files.has(current)) files.set(current, [])
    } else if (line.startsWith('@@') && current) {
      header = false
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (m) files.get(current).push({ oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4] })
    }
  }
  return files
}

/** 1-based first and last line of the first occurrence of `find` in `text`, or null. */
export function patternLines(text, find) {
  const at = text.indexOf(find)
  if (at < 0) return null
  const first = text.slice(0, at).split('\n').length
  return [first, first + find.split('\n').length - 1 - (find.endsWith('\n') ? 1 : 0)]
}

/** Whether a hunk lies within NEAR lines of lines [first, last] of the new file. */
export function hunkNear(h, [first, last], near = NEAR) {
  // a pure deletion sits between lines newStart and newStart + 1
  const lo = h.newStart
  const hi = h.newCount === 0 ? h.newStart + 1 : h.newStart + h.newCount - 1
  return lo <= last + near && hi >= first - near
}

/**
 * Affected mutants with their reasons.
 * @param {object} o
 * @param {Array} o.mutants current mutants
 * @param {Array} o.oldMutants mutants at the base commit
 * @param {Map} o.diff parseDiff(git diff -U0 base)
 * @param {(f: string) => string|null} o.readFile current contents (null when the file is gone)
 */
export function selectSince({ mutants, oldMutants, diff, readFile }) {
  const oldKeys = new Set(oldMutants.map(mutantKey))
  const out = []
  for (const m of mutants) {
    const [file, find] = m
    const reasons = []
    if (!oldKeys.has(mutantKey(m))) reasons.push('new mutant')
    const text = readFile(file)
    const lines = text === null ? null : patternLines(text, find)
    if (!lines) reasons.push('pattern not found')
    else if ((diff.get(file) ?? []).some((h) => hunkNear(h, lines))) reasons.push(`changed within ${NEAR} lines`)
    if (reasons.length) out.push({ mutant: m, reasons })
  }
  return out
}
