/**
 * Line-based three-way merge, similar in spirit to `git merge-file`.
 * Given a common ancestor ("base") and two edited versions ("local", "remote"),
 * produces a merged result. Non-overlapping edits merge automatically.
 * Overlapping edits (both sides changed the same lines) are wrapped in
 * git-style conflict markers so the user resolves them manually instead of
 * silently losing one side's changes.
 */

export interface MergeResult {
  text: string;
  hasConflicts: boolean;
}

export function merge3(base: string, local: string, remote: string): MergeResult {
  const baseLines = splitLines(base);
  const localLines = splitLines(local);
  const remoteLines = splitLines(remote);

  const localDiff = diffLines(baseLines, localLines);
  const remoteDiff = diffLines(baseLines, remoteLines);

  return buildMerge(baseLines, localDiff, remoteDiff);
}

function splitLines(s: string): string[] {
  if (s.length === 0) return [];
  return s.split(/\r?\n/);
}

// --- LCS-based line diff -> list of ops touching base index ranges ---

type Op =
  | { kind: "equal"; baseStart: number; baseEnd: number; lines: string[] }
  | { kind: "change"; baseStart: number; baseEnd: number; lines: string[] };

function diffLines(base: string[], edited: string[]): Op[] {
  const lcs = longestCommonSubsequence(base, edited);
  const ops: Op[] = [];
  let bi = 0,
    ei = 0;

  for (const [bIdx, eIdx] of lcs) {
    if (bIdx > bi || eIdx > ei) {
      ops.push({
        kind: "change",
        baseStart: bi,
        baseEnd: bIdx,
        lines: edited.slice(ei, eIdx),
      });
    }
    ops.push({
      kind: "equal",
      baseStart: bIdx,
      baseEnd: bIdx + 1,
      lines: [base[bIdx]],
    });
    bi = bIdx + 1;
    ei = eIdx + 1;
  }
  if (bi < base.length || ei < edited.length) {
    ops.push({
      kind: "change",
      baseStart: bi,
      baseEnd: base.length,
      lines: edited.slice(ei),
    });
  }
  return ops;
}

/** Returns matched index pairs (baseIdx, editedIdx) for the LCS, in order. */
function longestCommonSubsequence(a: string[], b: string[]): [number, number][] {
  const n = a.length,
    m = b.length;
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const pairs: [number, number][] = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

// --- Merge the two op streams against shared base coordinates ---

function buildMerge(base: string[], localOps: Op[], remoteOps: Op[]): MergeResult {
  const localByBase = indexByBasePosition(localOps, base.length);
  const remoteByBase = indexByBasePosition(remoteOps, base.length);

  const out: string[] = [];
  let hasConflicts = false;
  let pos = 0;

  while (pos < base.length) {
    const l = localByBase[pos];
    const r = remoteByBase[pos];

    const localChanged = l?.kind === "change";
    const remoteChanged = r?.kind === "change";

    if (!localChanged && !remoteChanged) {
      out.push(base[pos]);
      pos++;
      continue;
    }
    if (localChanged && !remoteChanged) {
      out.push(...l!.lines);
      pos = l!.baseEnd;
      continue;
    }
    if (remoteChanged && !localChanged) {
      out.push(...r!.lines);
      pos = r!.baseEnd;
      continue;
    }

    // Both changed. If identical edits, take one. Otherwise, conflict.
    const lOp = l!,
      rOp = r!;
    if (
      lOp.baseStart === rOp.baseStart &&
      lOp.baseEnd === rOp.baseEnd &&
      arraysEqual(lOp.lines, rOp.lines)
    ) {
      out.push(...lOp.lines);
      pos = lOp.baseEnd;
      continue;
    }

    hasConflicts = true;
    out.push("<<<<<<< local");
    out.push(...lOp.lines);
    out.push("=======");
    out.push(...rOp.lines);
    out.push(">>>>>>> remote");
    pos = Math.max(lOp.baseEnd, rOp.baseEnd);
  }

  // trailing appended-only content past base.length
  const lTail = localByBase[base.length];
  const rTail = remoteByBase[base.length];
  if (lTail?.kind === "change") out.push(...lTail.lines);
  if (rTail?.kind === "change") out.push(...rTail.lines);

  return { text: out.join("\n"), hasConflicts };
}

/** Maps each base-line index to the op that starts there (change ops keyed by baseStart). */
function indexByBasePosition(ops: Op[], baseLen: number): (Op | undefined)[] {
  const map: (Op | undefined)[] = new Array(baseLen + 1);
  for (const op of ops) {
    if (op.kind === "change") {
      map[op.baseStart] = op;
    }
  }
  return map;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}
