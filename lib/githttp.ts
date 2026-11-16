/**
 * Git over smart HTTP: ref advertisement (protocol v0 and v2), ls-refs,
 * fetch (v0 and v2, with shallow / deepen) and receive-pack with
 * report-status. Repositories exist only because REST created them; a push
 * to an unknown name is a 404 at the HTTP layer, handled by the router.
 */
import {
  PKT_FLUSH, ZERO_OID, buildPack, parseCommit, parsePackInto,
  parseTagTarget, peelToCommit, pktLine, readPktLines, reachableCommits,
} from './gitobj.ts';
import type { GitObject } from './gitobj.ts';
import { branchTip } from './forge.ts';
import type { RepoRec } from './forge.ts';

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'forge/1.0.0';
const UPLOAD_CAPS_V0 = [
  'multi_ack_detailed', 'side-band-64k', 'thin-pack', 'ofs-delta', 'shallow',
  'deepen-since', 'deepen-not', 'no-progress',
].join(' ');
const RECEIVE_CAPS_V0 = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', 'quiet'].join(' ');

function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function peeledOf(repo: RepoRec, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  const target = parseTagTarget(object.data);
  if (!target) return null;
  return peelToCommit(repo.objects, oid);
}

// ------------------------------------------------------------- advertisement

export function advertise(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack', protocolHeader: string | null): GitHttpResult {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  if (service === 'git-upload-pack' && protocolHeader !== null && /(^|,)version=2(,|$)/.test(protocolHeader.replace(/\s+/g, ''))) {
    // Protocol v2 capability advertisement (upload-pack only; receive-pack is always v0).
    parts.push(pktLine('version 2'));
    parts.push(pktLine(`agent=${AGENT}`));
    parts.push(pktLine('ls-refs=unborn'));
    parts.push(pktLine('fetch=shallow wait-for-done'));
    parts.push(pktLine('object-format=sha1'));
    parts.push(PKT_FLUSH);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: Buffer.concat(parts) };
  }
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef) ?? null;
  const caps = service === 'git-upload-pack'
    ? `${UPLOAD_CAPS_V0} symref=HEAD:${headRef} agent=${AGENT}`
    : `${RECEIVE_CAPS_V0} agent=${AGENT}`;
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(Buffer.concat([Buffer.from(`${ZERO_OID} capabilities^{}\0`, 'utf8'), Buffer.from(caps, 'utf8')])));
  } else {
    parts.push(pktLine(Buffer.concat([Buffer.from(`${headOid ?? ZERO_OID} HEAD\0`, 'utf8'), Buffer.from(caps, 'utf8')])));
    for (const [name, oid] of refs) {
      parts.push(pktLine(`${oid} ${name}`));
      const peeled = peeledOf(repo, oid);
      if (peeled && name.startsWith('refs/tags/')) parts.push(pktLine(`${peeled} ${name}^{}`));
    }
  }
  parts.push(PKT_FLUSH);
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: Buffer.concat(parts),
  };
}

// ------------------------------------------------------------------ ls-refs

export function handleLsRefs(repo: RepoRec, rawArgs: string[]): GitHttpResult {
  const args = rawArgs.map((arg) => arg.replace(/\n$/, ''));
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef) ?? null;
  if (prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix))) {
    if (headOid) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headRef}` : ''}`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD symref-target:${headRef}`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(line));
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// -------------------------------------------------------------------- fetch

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
}

export function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = Number(line.slice(7).trim());
      if (Number.isFinite(value)) args.deepen = value;
    }
  }
  return args;
}

interface FetchPlan {
  pack: Buffer;
  ackLines: string[];
  shallowLines: string[];
  hasShallowInfo: boolean;
}

const packCache = new Map<string, Buffer>();

function planFetch(repo: RepoRec, args: FetchArgs): FetchPlan {
  const store = repo.objects;
  const cacheKey = [
    repo.owner, repo.name, [...repo.refs.entries()].map(([k, v]) => `${k}=${v}`).join(','),
    args.wants.join(','), args.haves.join(','), args.shallow.join(','), String(args.deepen),
  ].join('|');
  const clientShallow = new Set(args.shallow.filter((oid) => store.has(oid)));

  // Commits the client already has: full closure of the haves, with the
  // client's shallow-boundary commits included but not descended past.
  const haveCommits = new Set<string>();
  {
    const stack: string[] = [];
    for (const have of args.haves) {
      const commit = peelToCommit(store, have);
      if (commit) stack.push(commit);
    }
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (haveCommits.has(oid)) continue;
      const object = store.get(oid);
      if (!object || object.type !== 'commit') continue;
      haveCommits.add(oid);
      if (clientShallow.has(oid)) continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
  }

  // Generations from the wants (shortest distance), for shallow planning.
  const wantCommits: string[] = [];
  for (const want of args.wants) {
    const commit = peelToCommit(store, want);
    if (commit && !wantCommits.includes(commit)) wantCommits.push(commit);
  }
  const generation = new Map<string, number>();
  {
    let frontier = [...wantCommits];
    let depth = 0;
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (generation.has(oid)) continue;
        const object = store.get(oid);
        if (!object || object.type !== 'commit') continue;
        generation.set(oid, depth);
        for (const parent of parseCommit(object.data).parents) next.push(parent);
      }
      frontier = next;
      depth += 1;
    }
  }

  // Inclusion: everything reachable, or — when the request deepens — only
  // the first `deepen` generations from the wants (deepen names the total
  // depth, so deepening a depth-1 clone by 2 adds exactly one generation).
  const include = new Set<string>();
  for (const [oid, gen] of generation) {
    if (args.deepen === null || gen < args.deepen) include.add(oid);
  }
  for (const oid of haveCommits) include.delete(oid);
  for (const oid of clientShallow) include.delete(oid);

  // New shallow boundary + unshallow notices.
  const shallowLines: string[] = [];
  if (args.deepen !== null) {
    for (const oid of include) {
      const object = store.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (store.has(parent) && !include.has(parent) && !haveCommits.has(parent)) {
          shallowLines.push(`shallow ${oid}`);
          break;
        }
      }
    }
  }
  for (const boundary of clientShallow) {
    const object = store.get(boundary);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => include.has(parent))) shallowLines.push(`unshallow ${boundary}`);
  }

  // Object set: included commits + their full tree closures + wanted tag
  // objects, minus everything the client provably has (haves and boundary).
  const excludeRoots = new Set<string>([...haveCommits, ...clientShallow]);
  const packSet = new Set<string>();
  const addTreeClosure = (treeOid: string, into: Set<string>): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (into.has(oid)) continue;
      const object = store.get(oid);
      if (!object) continue;
      into.add(oid);
      if (object.type === 'tree') {
        for (const entry of parseTreeEntries(object.data)) stack.push(entry);
      }
    }
  };
  const excludedTrees = new Set<string>();
  for (const root of excludeRoots) {
    const object = store.get(root);
    if (object && object.type === 'commit') addTreeClosure(parseCommit(object.data).tree, excludedTrees);
  }
  for (const oid of include) {
    packSet.add(oid);
    const object = store.get(oid);
    if (object && object.type === 'commit') {
      const closure = new Set<string>();
      addTreeClosure(parseCommit(object.data).tree, closure);
      for (const treeOid of closure) if (!excludedTrees.has(treeOid)) packSet.add(treeOid);
    }
  }
  for (const want of args.wants) {
    // Wanted tag objects (and tag chains) travel with the pack.
    let current = want;
    for (let depth = 0; depth < 8; depth += 1) {
      const object = store.get(current);
      if (!object || object.type !== 'tag') break;
      packSet.add(current);
      const target = parseTagTarget(object.data);
      if (!target) break;
      current = target.object;
    }
  }
  for (const oid of excludeRoots) packSet.delete(oid);

  const order = (oid: string): number => {
    const type = store.get(oid)?.type;
    return type === 'commit' ? 0 : type === 'tree' ? 1 : type === 'tag' ? 2 : 3;
  };
  const oids = [...packSet].sort((a, b) => order(a) - order(b) || (a < b ? -1 : 1));
  let pack = packCache.get(cacheKey);
  if (!pack) {
    pack = buildPack(store, oids);
    if (packCache.size > 64) packCache.clear();
    packCache.set(cacheKey, pack);
  }

  const ackLines: string[] = [];
  if (args.haves.length === 0) ackLines.push('NAK');
  else {
    for (const have of args.haves) if (store.has(have)) ackLines.push(`ACK ${have}`);
    if (ackLines.length === 0) ackLines.push('NAK');
  }
  return {
    pack,
    ackLines,
    shallowLines,
    hasShallowInfo: args.shallow.length > 0 || args.deepen !== null || shallowLines.length > 0,
  };
}

function parseTreeEntries(data: Buffer): string[] {
  const out: string[] = [];
  let pos = 0;
  while (pos < data.length) {
    const nul = data.indexOf(0x00, pos);
    out.push(data.toString('hex', nul + 1, nul + 21));
    pos = nul + 21;
  }
  return out;
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (parts.length === 0) parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return parts;
}

export function handleFetchV2(repo: RepoRec, args: FetchArgs): GitHttpResult {
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  for (const line of plan.ackLines) parts.push(pktLine(line));
  parts.push(PKT_FLUSH);
  if (plan.hasShallowInfo) {
    parts.push(pktLine('shallow-info\n'));
    for (const line of plan.shallowLines) parts.push(pktLine(line));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(plan.pack));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

export function handleFetchV0(repo: RepoRec, args: FetchArgs, caps: Set<string>): GitHttpResult {
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  for (const line of plan.shallowLines) parts.push(pktLine(line));
  for (const line of plan.ackLines) parts.push(pktLine(line));
  if (caps.has('side-band-64k') || caps.has('side-band')) {
    parts.push(...sidebandPackets(plan.pack));
  } else {
    parts.push(plan.pack);
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// -------------------------------------------------------------- receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: RepoRec, body: Buffer): GitHttpResult {
  const { frames, next } = readPktLines(body, 0);
  const commands: PushCommand[] = [];
  const caps = new Set<string>();
  frames.forEach((frame, index) => {
    if (frame === 'delim') return;
    let text = (frame as Buffer).toString('utf8').replace(/\n$/, '');
    if (index === 0) {
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        for (const cap of text.slice(nul + 1).split(' ')) if (cap) caps.add(cap);
        text = text.slice(0, nul);
      }
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
    if (match) commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  });
  const packBytes = body.subarray(next);
  let unpackOk = true;
  let unpackError = '';
  if (packBytes.length > 0) {
    try {
      if (packBytes.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack signature');
      parsePackInto(repo.objects, packBytes);
    } catch (error) {
      unpackOk = false;
      unpackError = error instanceof Error ? error.message : 'unpack failed';
    }
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (!unpackOk) {
      fail('unpack failed');
      continue;
    }
    if (command.oldOid !== current) {
      fail('stale info');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (command.ref === headRef) {
        fail('deletion of the current branch prohibited');
        continue;
      }
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const newObject = repo.objects.get(command.newOid);
    if (!newObject || (newObject.type !== 'commit' && newObject.type !== 'tag')) {
      fail('bad object');
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && command.oldOid !== ZERO_OID) {
      const newTip = peelToCommit(repo.objects, command.newOid);
      const oldTip = peelToCommit(repo.objects, command.oldOid);
      if (!newTip || !oldTip || !(newTip === oldTip || reachableCommits(repo.objects, [newTip]).has(oldTip))) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  const inner: Buffer[] = [];
  inner.push(pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackError || 'error'}\n`));
  for (const result of results) {
    inner.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  inner.push(PKT_FLUSH);
  const innerStream = Buffer.concat(inner);
  let responseBody: Buffer;
  if (caps.has('side-band-64k')) {
    const parts: Buffer[] = [];
    const CHUNK = 32768;
    for (let offset = 0; offset < innerStream.length; offset += CHUNK) {
      const chunk = innerStream.subarray(offset, Math.min(offset + CHUNK, innerStream.length));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(PKT_FLUSH);
    responseBody = Buffer.concat(parts);
  } else {
    responseBody = innerStream;
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
}

export { branchTip };
