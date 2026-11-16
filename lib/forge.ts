/**
 * The forge's domain state: repositories (each with its own git object store
 * and ref table), issues, pull requests, labels and comments, all in memory.
 * REST, GraphQL, MCP and the git transport all read and write through here,
 * which is what makes the surfaces agree with each other.
 */
import {
  ZERO_OID, buildCommit, buildTreeFromFlat, commitTree, flattenTree,
  isAncestor, mergeBase, parseCommit, peelToCommit, storeObject,
} from './gitobj.ts';
import type { GitObject } from './gitobj.ts';
import { SCENARIO_EPOCH_SEC, VIEWER, userByLogin } from './scenario.ts';
import type { ScenarioUser } from './scenario.ts';

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  authorLogin: string;
  createdAtSec: number;
}

export interface IssueRec {
  recId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  authorLogin: string;
  createdAtSec: number;
  updatedAtSec: number;
  closedAtSec: number | null;
}

export interface PullRec {
  recId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAtSec: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  authorLogin: string;
  createdAtSec: number;
  updatedAtSec: number;
  closedAtSec: number | null;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAtSec: number;
  updatedAtSec: number;
  pushedAtSec: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
}

// --------------------------------------------------------------------- clock

function baseSec(): number {
  const env = process.env.MAKEFUN_TRIAL_NOW;
  if (env) {
    const ms = Date.parse(env);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return SCENARIO_EPOCH_SEC;
}

let clockSeq = 0;
/** Deterministic, strictly increasing timestamps: scenario epoch + a counter. */
export function tickSec(): number {
  clockSeq += 1;
  return baseSec() + clockSeq;
}

export function isoOf(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

// --------------------------------------------------------------------- repos

export const reposByKey = new Map<string, RepoRec>();
export const reposById = new Map<number, RepoRec>();
let nextRepoId = 100_000;
let nextRecId = 1;
let nextCommentId = 1;
let nextLabelId = 1;

export function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export function findRepo(owner: string, name: string): RepoRec | null {
  return reposByKey.get(repoKey(owner, name)) ?? null;
}

export function createRepo(
  owner: string,
  input: { name: string; description?: string; isPrivate?: boolean; defaultBranch?: string },
): RepoRec | 'exists' {
  const key = repoKey(owner, input.name);
  if (reposByKey.has(key)) return 'exists';
  const now = tickSec();
  const repo: RepoRec = {
    id: nextRepoId,
    owner,
    name: input.name,
    description: input.description ?? '',
    isPrivate: input.isPrivate ?? false,
    defaultBranch: input.defaultBranch && input.defaultBranch !== '' ? input.defaultBranch : 'main',
    createdAtSec: now,
    updatedAtSec: now,
    pushedAtSec: now,
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
  };
  nextRepoId += 1;
  reposByKey.set(key, repo);
  reposById.set(repo.id, repo);
  return repo;
}

export function deleteRepo(repo: RepoRec): void {
  reposByKey.delete(repoKey(repo.owner, repo.name));
  reposById.delete(repo.id);
}

export function viewerRepos(): RepoRec[] {
  return [...reposByKey.values()]
    .filter((repo) => repo.owner.toLowerCase() === VIEWER.login.toLowerCase())
    .sort((a, b) => a.id - b.id);
}

// ---------------------------------------------------------------------- refs

/** The oid a branch name points at, or null (unborn / unknown). */
export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Resolve a REST/GraphQL ref parameter (branch, tag, full ref, oid, HEAD) to a commit oid. */
export function resolveRefToCommit(repo: RepoRec, ref: string | undefined | null): string | null {
  const wanted = ref === undefined || ref === null || ref === '' || ref === 'HEAD' ? repo.defaultBranch : ref;
  let oid: string | null = null;
  if (/^[0-9a-f]{40}$/.test(wanted) && repo.objects.has(wanted)) oid = wanted;
  else if (wanted.startsWith('refs/')) oid = repo.refs.get(wanted) ?? null;
  else oid = repo.refs.get(`refs/heads/${wanted}`) ?? repo.refs.get(`refs/tags/${wanted}`) ?? null;
  if (!oid) return null;
  return peelToCommit(repo.objects, oid);
}

/** The default branch's tip commit, or null on an unborn repository. */
export function headCommit(repo: RepoRec): string | null {
  return branchTip(repo, repo.defaultBranch) ? peelToCommit(repo.objects, branchTip(repo, repo.defaultBranch) as string) : null;
}

// ------------------------------------------------------------------- commits

/** Create a commit authored by the viewer at the next deterministic tick. */
export function makeCommit(
  repo: RepoRec,
  input: { treeOid: string; parents: string[]; message: string },
): string {
  const ts = tickSec();
  const data = buildCommit({
    tree: input.treeOid,
    parents: input.parents,
    authorName: VIEWER.name,
    authorEmail: VIEWER.email,
    authorTs: ts,
    committerName: VIEWER.name,
    committerEmail: VIEWER.email,
    committerTs: ts,
    message: input.message,
  });
  const oid = storeObject(repo.objects, 'commit', data);
  repo.pushedAtSec = ts;
  repo.updatedAtSec = ts;
  return oid;
}

/** Commits reachable from a tip, newest first (DFS, first parent first). */
export function listCommits(repo: RepoRec, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
  }
  return out;
}

// ------------------------------------------------------------------ contents

export interface FileRead {
  blobOid: string;
  mode: string;
  data: Buffer;
}

export function readFileAt(repo: RepoRec, commitOid: string, path: string): FileRead | null {
  const tree = commitTree(repo.objects, commitOid);
  if (!tree) return null;
  const flat = flattenTree(repo.objects, tree);
  const entry = flat.get(path);
  if (!entry) return null;
  const blob = repo.objects.get(entry.oid);
  if (!blob || blob.type !== 'blob') return null;
  return { blobOid: entry.oid, mode: entry.mode, data: blob.data };
}

/**
 * Write a file on a branch (creating the branch's first commit when unborn).
 * Returns the new commit oid, or 'stale' when the caller's sha does not match.
 */
export function writeFile(
  repo: RepoRec,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
  sha: string | undefined,
): string | 'stale' {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref) ?? null;
  const tipCommit = tip ? peelToCommit(repo.objects, tip) : null;
  const flat = new Map<string, { oid: string; mode: string }>();
  if (tipCommit) {
    const tree = commitTree(repo.objects, tipCommit);
    if (tree) for (const [p, e] of flattenTree(repo.objects, tree)) flat.set(p, e);
  }
  const existing = flat.get(path);
  if (existing && sha !== undefined && sha !== existing.oid) return 'stale';
  if (existing && sha === undefined) return 'stale';
  const blobOid = storeObject(repo.objects, 'blob', content);
  flat.set(path, { oid: blobOid, mode: existing?.mode ?? '100644' });
  const treeOid = buildTreeFromFlat(repo.objects, flat);
  const commit = makeCommit(repo, { treeOid, parents: tipCommit ? [tipCommit] : [], message });
  repo.refs.set(ref, commit);
  return commit;
}

export function deleteFile(
  repo: RepoRec,
  branch: string,
  path: string,
  message: string,
  sha: string,
): string | 'stale' | 'missing' {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref) ?? null;
  const tipCommit = tip ? peelToCommit(repo.objects, tip) : null;
  if (!tipCommit) return 'missing';
  const tree = commitTree(repo.objects, tipCommit);
  if (!tree) return 'missing';
  const flat = flattenTree(repo.objects, tree);
  const existing = flat.get(path);
  if (!existing) return 'missing';
  if (sha !== existing.oid) return 'stale';
  flat.delete(path);
  const treeOid = buildTreeFromFlat(repo.objects, flat);
  const commit = makeCommit(repo, { treeOid, parents: [tipCommit], message });
  repo.refs.set(ref, commit);
  return commit;
}

// -------------------------------------------------------------------- issues

export function createIssue(
  repo: RepoRec,
  input: { title: string; body?: string; labels?: string[]; author?: ScenarioUser },
): IssueRec | { error: string } {
  const labelNames: string[] = [];
  for (const name of input.labels ?? []) {
    const label = repo.labels.get(name.toLowerCase());
    if (!label) return { error: `Label '${name}' does not exist in this repository` };
    labelNames.push(label.name);
  }
  const now = tickSec();
  const issue: IssueRec = {
    recId: nextRecId,
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: labelNames,
    comments: [],
    authorLogin: (input.author ?? VIEWER).login,
    createdAtSec: now,
    updatedAtSec: now,
    closedAtSec: null,
  };
  nextRecId += 1;
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function addComment(repo: RepoRec, issue: IssueRec, body: string, author?: ScenarioUser): CommentRec {
  const comment: CommentRec = {
    id: nextCommentId,
    body,
    authorLogin: (author ?? VIEWER).login,
    createdAtSec: tickSec(),
  };
  nextCommentId += 1;
  issue.comments.push(comment);
  return comment;
}

// --------------------------------------------------------------------- pulls

export function createPull(
  repo: RepoRec,
  input: { title: string; body?: string; head: string; base: string },
): PullRec | { error: string } {
  const headSha = branchTip(repo, input.head);
  const baseSha = branchTip(repo, input.base);
  if (!headSha) return { error: `Head branch '${input.head}' does not exist` };
  if (!baseSha) return { error: `Base branch '${input.base}' does not exist` };
  const now = tickSec();
  const pull: PullRec = {
    recId: nextRecId,
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    mergedAtSec: null,
    mergeCommitSha: null,
    headRef: input.head,
    baseRef: input.base,
    headSha,
    baseSha,
    authorLogin: VIEWER.login,
    createdAtSec: now,
    updatedAtSec: now,
    closedAtSec: null,
  };
  nextRecId += 1;
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** Live tips for a pull request (branch tips move; fall back to creation-time shas). */
export function pullTips(repo: RepoRec, pull: PullRec): { head: string; base: string } {
  const head = branchTip(repo, pull.headRef) ?? pull.headSha;
  const base = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    head: peelToCommit(repo.objects, head) ?? head,
    base: peelToCommit(repo.objects, base) ?? base,
  };
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length * b.length > 2_000_000) {
    return { additions: b.length, deletions: a.length };
  }
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const keep = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = keep;
    }
  }
  const lcs = dp[b.length];
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

export interface PullFileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** The file changes of a pull request, computed against its merge base. */
export function pullFiles(repo: RepoRec, pull: PullRec): PullFileChange[] {
  const { head, base } = pullTips(repo, pull);
  const basePoint = mergeBase(repo.objects, head, base) ?? base;
  const baseTree = commitTree(repo.objects, basePoint);
  const headTree = commitTree(repo.objects, head);
  const baseFlat = baseTree ? flattenTree(repo.objects, baseTree) : new Map();
  const headFlat = headTree ? flattenTree(repo.objects, headTree) : new Map();
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  const out: PullFileChange[] = [];
  for (const path of [...paths].sort()) {
    const inBase = baseFlat.get(path);
    const inHead = headFlat.get(path);
    if (inBase && inHead && inBase.oid === inHead.oid) continue;
    const oldText = inBase ? (repo.objects.get(inBase.oid)?.data.toString('utf8') ?? '') : '';
    const newText = inHead ? (repo.objects.get(inHead.oid)?.data.toString('utf8') ?? '') : '';
    const { additions, deletions } = lineDiff(oldText, newText);
    out.push({
      filename: path,
      status: !inBase ? 'added' : !inHead ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return out;
}

export interface MergeOutcome {
  conflict: boolean;
  mergedFlat: Map<string, { oid: string; mode: string }>;
  basePoint: string | null;
}

/** Three-way tree merge of head into base, against their merge base. */
export function threeWayMerge(repo: RepoRec, pull: PullRec): MergeOutcome {
  const { head, base } = pullTips(repo, pull);
  const basePoint = mergeBase(repo.objects, head, base);
  const flatOf = (commit: string | null): Map<string, { oid: string; mode: string }> => {
    if (!commit) return new Map();
    const tree = commitTree(repo.objects, commit);
    return tree ? flattenTree(repo.objects, tree) : new Map();
  };
  const baseFlat = flatOf(basePoint);
  const oursFlat = flatOf(base);
  const theirsFlat = flatOf(head);
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set<string>([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
  let conflict = false;
  for (const path of paths) {
    const b = baseFlat.get(path)?.oid ?? null;
    const o = oursFlat.get(path)?.oid ?? null;
    const t = theirsFlat.get(path)?.oid ?? null;
    if (o === t) {
      const keep = oursFlat.get(path) ?? theirsFlat.get(path);
      if (keep) merged.set(path, keep);
    } else if (b === o) {
      const keep = theirsFlat.get(path);
      if (keep) merged.set(path, keep);
    } else if (b === t) {
      const keep = oursFlat.get(path);
      if (keep) merged.set(path, keep);
    } else {
      conflict = true;
    }
  }
  return { conflict, mergedFlat: merged, basePoint };
}

/** Merge a pull request; returns the merge commit sha, or null on conflict. */
export function mergePull(repo: RepoRec, pull: PullRec, method: string): string | null {
  const outcome = threeWayMerge(repo, pull);
  if (outcome.conflict) return null;
  const { head, base } = pullTips(repo, pull);
  const treeOid = buildTreeFromFlat(repo.objects, outcome.mergedFlat);
  let sha: string;
  if (method === 'merge') {
    sha = makeCommit(repo, {
      treeOid,
      parents: [base, head],
      message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`,
    });
  } else {
    const body = pull.body ? `\n\n${pull.body}` : '';
    sha = makeCommit(repo, {
      treeOid,
      parents: [base],
      message: `${pull.title} (#${pull.number})${body}`,
    });
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  const now = tickSec();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAtSec = now;
  pull.mergeCommitSha = sha;
  pull.closedAtSec = now;
  pull.updatedAtSec = now;
  return sha;
}

// ---------------------------------------------------------------- global ids

/** Opaque, stable GraphQL node ids: base64 of `<Kind>:<key>`. Never a bare number. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const split = decoded.indexOf(':');
    if (split <= 0) return null;
    return { kind: decoded.slice(0, split), key: decoded.slice(split + 1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: RepoRec): string {
  return globalId('Repository', String(repo.id));
}

export function issueGlobalId(repo: RepoRec, issue: IssueRec): string {
  return globalId('Issue', `${repo.id}:${issue.number}`);
}

export function pullGlobalId(repo: RepoRec, pull: PullRec): string {
  return globalId('PullRequest', `${repo.id}:${pull.number}`);
}

// ------------------------------------------------------------------ REST JSON

export function userJson(user: ScenarioUser): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: globalId('User', user.login),
    type: 'User',
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

export function repoJson(repo: RepoRec, origin: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  const openIssues = [...repo.issues.values()].filter((i) => i.state === 'open').length
    + [...repo.pulls.values()].filter((p) => p.state === 'open').length;
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: fullName,
    owner: userJson(userByLogin(repo.owner) ?? VIEWER),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    url: `${origin}/api/v3/repos/${fullName}`,
    html_url: `${origin}/${fullName}`,
    created_at: isoOf(repo.createdAtSec),
    updated_at: isoOf(repo.updatedAtSec),
    pushed_at: isoOf(repo.pushedAtSec),
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: openIssues,
    language: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelJson(label: LabelRec): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Label', String(label.id)),
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function newLabel(repo: RepoRec, name: string, color: string, description?: string): LabelRec {
  const label: LabelRec = { id: nextLabelId, name, color, description: description ?? null };
  nextLabelId += 1;
  repo.labels.set(name.toLowerCase(), label);
  return label;
}

export function issueJson(repo: RepoRec, issue: IssueRec, origin: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: issue.recId,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels
      .map((name) => repo.labels.get(name.toLowerCase()))
      .filter((label): label is LabelRec => label !== undefined)
      .map((label) => labelJson(label)),
    user: userJson(userByLogin(issue.authorLogin) ?? VIEWER),
    comments: issue.comments.length,
    created_at: isoOf(issue.createdAtSec),
    updated_at: isoOf(issue.updatedAtSec),
    closed_at: issue.closedAtSec === null ? null : isoOf(issue.closedAtSec),
    url: `${origin}/api/v3/repos/${fullName}/issues/${issue.number}`,
    html_url: `${origin}/${fullName}/issues/${issue.number}`,
    repository_url: `${origin}/api/v3/repos/${fullName}`,
  };
}

export function commentJson(repo: RepoRec, issue: IssueRec, comment: CommentRec, origin: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`),
    body: comment.body,
    user: userJson(userByLogin(comment.authorLogin) ?? VIEWER),
    created_at: isoOf(comment.createdAtSec),
    updated_at: isoOf(comment.createdAtSec),
    url: `${origin}/api/v3/repos/${fullName}/issues/comments/${comment.id}`,
    html_url: `${origin}/${fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `${origin}/api/v3/repos/${fullName}/issues/${issue.number}`,
  };
}

export function pullJson(repo: RepoRec, pull: PullRec, origin: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  const { head, base } = pullTips(repo, pull);
  const side = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(VIEWER),
    repo: repoJson(repo, origin),
  });
  return {
    id: pull.recId,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(VIEWER),
    draft: false,
    head: side(pull.headRef, head),
    base: side(pull.baseRef, base),
    merged: pull.merged,
    merged_at: pull.mergedAtSec === null ? null : isoOf(pull.mergedAtSec),
    merge_commit_sha: pull.mergeCommitSha,
    closed_at: pull.closedAtSec === null ? null : isoOf(pull.closedAtSec),
    created_at: isoOf(pull.createdAtSec),
    updated_at: isoOf(pull.updatedAtSec),
    url: `${origin}/api/v3/repos/${fullName}/pulls/${pull.number}`,
    html_url: `${origin}/${fullName}/pull/${pull.number}`,
    merged_by: pull.merged ? userJson(VIEWER) : null,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

export { ZERO_OID, isAncestor };
