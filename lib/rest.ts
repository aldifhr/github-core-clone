/**
 * The REST v3 surface: repositories, contents, branches, commits, labels,
 * issues, comments and pull requests, in GitHub's shapes and status codes.
 * Everything reads and writes the shared store in forge.ts, so a file pushed
 * over git is immediately readable here (and vice versa).
 */
import {
  addComment, commentJson, createIssue, createPull, createRepo, deleteFile,
  deleteRepo, findRepo, globalId, isoOf, issueJson, labelJson, listCommits,
  mergePull, newLabel, pullFiles, pullJson, readFileAt, repoJson, resolveRefToCommit,
  threeWayMerge, tickSec, userJson, viewerRepos, writeFile,
} from './forge.ts';
import { commitTree, parseCommit, peelToCommit, treeAtPath } from './gitobj.ts';
import type { RepoRec } from './forge.ts';
import { VIEWER } from './scenario.ts';

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, URL-decoded. */
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
  origin: string;
}

export interface RestResponse {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
}

const notFound = (): RestResponse => ({ status: 404, json: { message: 'Not Found' } });
const unprocessable = (message: string): RestResponse => ({ status: 422, json: { message, errors: [] } });

function bodyString(body: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = body?.[key];
  return typeof value === 'string' ? value : undefined;
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { page, perPage };
}

function paginate<T>(req: RestRequest, items: T[], path: string): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(req.query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const urlFor = (p: number): string => {
    const params = new URLSearchParams(req.query);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `${req.origin}${path}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page < lastPage) {
    links.push(`<${urlFor(page + 1)}>; rel="next"`);
    links.push(`<${urlFor(lastPage)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${urlFor(1)}>; rel="first"`);
    links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  }
  if (links.length > 0) headers.Link = links.join(', ');
  return { page: slice, headers };
}

export function routeRest(req: RestRequest): RestResponse | null {
  const seg = req.segments;
  const method = req.method;

  if (seg.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      json: {
        current_user_url: `${req.origin}/api/v3/user`,
        current_user_repositories_url: `${req.origin}/api/v3/user/repos`,
        repository_url: `${req.origin}/api/v3/repos/{owner}/{repo}`,
        issue_search_url: `${req.origin}/api/v3/search/issues?q={query}`,
        emojis_url: `${req.origin}/api/v3/emojis`,
        meta_url: `${req.origin}/api/v3/meta`,
      },
      headers: { 'X-Oauth-Scopes': 'repo, read:org', 'X-Accepted-Oauth-Scopes': 'repo, read:org' },
    };
  }

  if (seg[0] === 'meta' && seg.length === 1) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      json: {
        installed_version: '1.0.0-forge',
        verifiable_password_authentication: false,
        github_authentication_token_expiration: false,
        packages: [],
        actions: [],
        dependabot: [],
      },
    };
  }

  if (seg[0] === 'user' && seg.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, json: { ...userJson(VIEWER), plan: { name: 'free', space: 0, collaborators: 0, private_repos: 0 } } };
  }

  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') {
      const { page, headers } = paginate(req, viewerRepos(), '/api/v3/user/repos');
      return { status: 200, json: page.map((repo) => repoJson(repo, req.origin)), headers };
    }
    if (method === 'POST') {
      const name = bodyString(req.body, 'name');
      if (!name) return unprocessable('name is required');
      const created = createRepo(VIEWER.login, {
        name,
        description: bodyString(req.body, 'description') ?? '',
        isPrivate: req.body?.private === true,
        defaultBranch: bodyString(req.body, 'default_branch'),
      });
      if (created === 'exists') return { status: 422, json: { message: 'name already exists on this account' } };
      return { status: 201, json: repoJson(created, req.origin) };
    }
    return notFound();
  }

  if (seg[0] === 'repos' && seg.length >= 3) {
    const repo = findRepo(seg[1], seg[2]);
    if (!repo) return notFound();
    return routeRepo(req, repo, seg.slice(3));
  }

  return notFound();
}

function routeRepo(req: RestRequest, repo: RepoRec, rest: string[]): RestResponse {
  const method = req.method;
  const origin = req.origin;
  const fullName = `${repo.owner}/${repo.name}`;

  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, json: repoJson(repo, origin) };
    if (method === 'PATCH') {
      const description = bodyString(req.body, 'description');
      if (description !== undefined) repo.description = description;
      if (typeof req.body?.private === 'boolean') repo.isPrivate = req.body.private;
      const defaultBranch = bodyString(req.body, 'default_branch');
      if (defaultBranch) repo.defaultBranch = defaultBranch;
      repo.updatedAtSec = tickSec();
      return { status: 200, json: repoJson(repo, origin) };
    }
    if (method === 'DELETE') {
      deleteRepo(repo);
      return { status: 204 };
    }
    return notFound();
  }

  // ------------------------------------------------------------ git refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const ref = bodyString(req.body, 'ref');
      const sha = bodyString(req.body, 'sha');
      if (!ref || !sha || !ref.startsWith('refs/')) return unprocessable('ref and sha are required');
      if (!repo.objects.has(sha)) return unprocessable(`Object ${sha} does not exist`);
      if (repo.refs.has(ref)) return { status: 422, json: { message: 'Reference already exists' } };
      repo.refs.set(ref, sha);
      const object = repo.objects.get(sha) as { type: string };
      return {
        status: 201,
        json: {
          ref,
          node_id: globalId('Ref', `${repo.id}:${ref}`),
          url: `${origin}/api/v3/repos/${fullName}/git/refs/${ref.slice('refs/'.length)}`,
          object: { type: object.type, sha, url: `${origin}/api/v3/repos/${fullName}/git/commits/${sha}` },
        },
      };
    }
    if (rest.length === 2 && method === 'GET') {
      const out = [...repo.refs.entries()].map(([ref, sha]) => ({
        ref,
        node_id: globalId('Ref', `${repo.id}:${ref}`),
        url: `${origin}/api/v3/repos/${fullName}/git/refs/${ref.slice('refs/'.length)}`,
        object: { type: repo.objects.get(sha)?.type ?? 'commit', sha, url: `${origin}/api/v3/repos/${fullName}/git/commits/${sha}` },
      }));
      return { status: 200, json: out };
    }
    if (rest.length >= 3 && method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) return notFound();
      return {
        status: 200,
        json: {
          ref,
          node_id: globalId('Ref', `${repo.id}:${ref}`),
          url: `${origin}/api/v3/repos/${fullName}/git/refs/${ref.slice('refs/'.length)}`,
          object: { type: repo.objects.get(sha)?.type ?? 'commit', sha, url: `${origin}/api/v3/repos/${fullName}/git/commits/${sha}` },
        },
      };
    }
    return notFound();
  }

  // ------------------------------------------------------------ branches
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha, url: `${origin}/api/v3/repos/${fullName}/commits/${sha}` },
          protected: false,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return { status: 200, json: branches };
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return notFound();
      return {
        status: 200,
        json: {
          name: branch,
          commit: { sha, url: `${origin}/api/v3/repos/${fullName}/commits/${sha}` },
          protected: false,
        },
      };
    }
    return notFound();
  }

  // ------------------------------------------------------------- commits
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const tip = resolveRefToCommit(repo, req.query.get('sha') ?? undefined);
    if (!tip) return { status: 200, json: [] };
    const shas = listCommits(repo, tip);
    const { page, headers } = paginate(req, shas, `/api/v3/repos/${fullName}/commits`);
    const json = page.map((sha) => {
      const object = repo.objects.get(sha);
      const info = parseCommit((object as { data: Buffer }).data);
      const ident = (name: string, email: string, ts: number): Record<string, unknown> => ({ name, email, date: isoOf(ts) });
      return {
        sha,
        node_id: globalId('Commit', sha),
        commit: {
          author: ident(info.authorName, info.authorEmail, info.authorTs),
          committer: ident(info.committerName, info.committerEmail, info.committerTs),
          message: info.message,
          tree: { sha: info.tree, url: `${origin}/api/v3/repos/${fullName}/git/trees/${info.tree}` },
          comment_count: 0,
        },
        url: `${origin}/api/v3/repos/${fullName}/commits/${sha}`,
        html_url: `${origin}/${fullName}/commit/${sha}`,
        parents: info.parents.map((parent) => ({
          sha: parent,
          url: `${origin}/api/v3/repos/${fullName}/commits/${parent}`,
          html_url: `${origin}/${fullName}/commit/${parent}`,
        })),
        author: null,
        committer: null,
      };
    });
    return { status: 200, json, headers };
  }

  // ------------------------------------------------------------ contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      const commit = resolveRefToCommit(repo, req.query.get('ref') ?? undefined);
      if (!commit) return notFound();
      const tree = commitTree(repo.objects, commit);
      if (!tree) return notFound();
      const file = readFileAt(repo, commit, path);
      if (file && path !== '') {
        return {
          status: 200,
          json: {
            type: 'file',
            encoding: 'base64',
            size: file.data.length,
            name: path.split('/').pop(),
            path,
            content: file.data.toString('base64'),
            sha: file.blobOid,
            url: `${origin}/api/v3/repos/${fullName}/contents/${path}`,
            html_url: `${origin}/${fullName}/blob/${repo.defaultBranch}/${path}`,
            download_url: `${origin}/${fullName}/raw/${repo.defaultBranch}/${path}`,
          },
        };
      }
      const entries = treeAtPath(repo.objects, tree, path);
      if (!entries) return notFound();
      const json = entries.map((entry) => {
        const entryPath = path === '' ? entry.name : `${path}/${entry.name}`;
        const isDir = entry.mode === '40000';
        const blob = isDir ? null : repo.objects.get(entry.oid);
        return {
          type: isDir ? 'dir' : 'file',
          size: blob ? blob.data.length : 0,
          name: entry.name,
          path: entryPath,
          sha: entry.oid,
          url: `${origin}/api/v3/repos/${fullName}/contents/${entryPath}`,
          html_url: `${origin}/${fullName}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${entryPath}`,
          download_url: isDir ? null : `${origin}/${fullName}/raw/${repo.defaultBranch}/${entryPath}`,
        };
      });
      return { status: 200, json };
    }
    if (method === 'PUT') {
      const message = bodyString(req.body, 'message');
      const content = bodyString(req.body, 'content');
      if (message === undefined || content === undefined || path === '') return unprocessable('message and content are required');
      const branch = bodyString(req.body, 'branch') ?? repo.defaultBranch;
      const sha = bodyString(req.body, 'sha');
      const tipBefore = repo.refs.get(`refs/heads/${branch}`);
      const commitBefore = tipBefore ? peelToCommit(repo.objects, tipBefore) : null;
      const existed = commitBefore ? readFileAt(repo, commitBefore, path) !== null : false;
      const bytes = Buffer.from(content.replace(/\s+/g, ''), 'base64');
      const result = writeFile(repo, branch, path, bytes, message, sha);
      if (result === 'stale') return { status: 409, json: { message: `${path} does not match the given sha` } };
      const written = readFileAt(repo, result, path);
      return {
        status: existed ? 200 : 201,
        json: {
          content: {
            type: 'file',
            encoding: 'base64',
            size: written?.data.length ?? bytes.length,
            name: path.split('/').pop(),
            path,
            sha: written?.blobOid ?? '',
            url: `${origin}/api/v3/repos/${fullName}/contents/${path}`,
            html_url: `${origin}/${fullName}/blob/${branch}/${path}`,
            download_url: `${origin}/${fullName}/raw/${branch}/${path}`,
          },
          commit: {
            sha: result,
            url: `${origin}/api/v3/repos/${fullName}/commits/${result}`,
            html_url: `${origin}/${fullName}/commit/${result}`,
            message,
            author: { name: VIEWER.name, email: VIEWER.email },
            committer: { name: VIEWER.name, email: VIEWER.email },
          },
        },
      };
    }
    if (method === 'DELETE') {
      const message = bodyString(req.body, 'message');
      const sha = bodyString(req.body, 'sha');
      if (message === undefined || sha === undefined) return unprocessable('message and sha are required');
      const branch = bodyString(req.body, 'branch') ?? repo.defaultBranch;
      const result = deleteFile(repo, branch, path, message, sha);
      if (result === 'missing') return notFound();
      if (result === 'stale') return { status: 409, json: { message: `${path} does not match the given sha` } };
      return {
        status: 200,
        json: {
          content: null,
          commit: {
            sha: result,
            url: `${origin}/api/v3/repos/${fullName}/commits/${result}`,
            html_url: `${origin}/${fullName}/commit/${result}`,
            message,
            author: { name: VIEWER.name, email: VIEWER.email },
            committer: { name: VIEWER.name, email: VIEWER.email },
          },
        },
      };
    }
    return notFound();
  }

  // -------------------------------------------------------------- labels
  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'GET') {
      return { status: 200, json: [...repo.labels.values()].map((label) => labelJson(label)) };
    }
    if (rest.length === 1 && method === 'POST') {
      const name = bodyString(req.body, 'name');
      const color = bodyString(req.body, 'color') ?? 'ededed';
      if (!name) return unprocessable('name is required');
      if (repo.labels.has(name.toLowerCase())) return { status: 422, json: { message: 'Validation Failed: label already exists' } };
      const label = newLabel(repo, name, color.replace(/^#/, ''), bodyString(req.body, 'description'));
      return { status: 201, json: labelJson(label) };
    }
    if (rest.length === 2) {
      const label = repo.labels.get(rest[1].toLowerCase());
      if (!label) return notFound();
      if (method === 'GET') return { status: 200, json: labelJson(label) };
      if (method === 'DELETE') {
        repo.labels.delete(rest[1].toLowerCase());
        return { status: 204 };
      }
      if (method === 'PATCH') {
        const name = bodyString(req.body, 'new_name') ?? bodyString(req.body, 'name');
        const color = bodyString(req.body, 'color');
        if (color) label.color = color.replace(/^#/, '');
        if (name && name !== label.name) {
          repo.labels.delete(label.name.toLowerCase());
          label.name = name;
          repo.labels.set(name.toLowerCase(), label);
        }
        return { status: 200, json: labelJson(label) };
      }
    }
    return notFound();
  }

  // -------------------------------------------------------------- issues
  if (rest[0] === 'issues') {
    if (rest.length === 1 && method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const direction = req.query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (a.createdAtSec - b.createdAtSec) || (a.number - b.number));
      if (direction !== 'asc') issues.reverse();
      const { page, headers } = paginate(req, issues, `/api/v3/repos/${fullName}/issues`);
      return { status: 200, json: page.map((issue) => issueJson(repo, issue, origin)), headers };
    }
    if (rest.length === 1 && method === 'POST') {
      const title = bodyString(req.body, 'title');
      if (!title) return unprocessable('title is required');
      const labels = Array.isArray(req.body?.labels) ? (req.body?.labels as unknown[]).map(String) : undefined;
      const created = createIssue(repo, { title, body: bodyString(req.body, 'body') ?? '', labels });
      if ('error' in created) return unprocessable(created.error);
      return { status: 201, json: issueJson(repo, created, origin) };
    }
    if (rest.length >= 2) {
      const number = Number(rest[1]);
      const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
      if (!issue) return notFound();
      if (rest.length === 2 && method === 'GET') return { status: 200, json: issueJson(repo, issue, origin) };
      if (rest.length === 2 && method === 'PATCH') {
        const title = bodyString(req.body, 'title');
        if (title !== undefined) issue.title = title;
        const body = bodyString(req.body, 'body');
        if (body !== undefined) issue.body = body;
        const state = bodyString(req.body, 'state');
        if (state === 'closed' || state === 'open') {
          issue.state = state;
          issue.closedAtSec = state === 'closed' ? tickSec() : null;
        }
        if (Array.isArray(req.body?.labels)) {
          const names = (req.body?.labels as unknown[]).map(String);
          for (const name of names) if (!repo.labels.has(name.toLowerCase())) return unprocessable(`Label '${name}' does not exist`);
          issue.labels = names.map((name) => (repo.labels.get(name.toLowerCase()) as { name: string }).name);
        }
        issue.updatedAtSec = tickSec();
        return { status: 200, json: issueJson(repo, issue, origin) };
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          return { status: 200, json: issue.comments.map((comment) => commentJson(repo, issue, comment, origin)) };
        }
        if (method === 'POST') {
          const body = bodyString(req.body, 'body');
          if (body === undefined) return unprocessable('body is required');
          const comment = addComment(repo, issue, body);
          return { status: 201, json: commentJson(repo, issue, comment, origin) };
        }
      }
    }
    return notFound();
  }

  // --------------------------------------------------------------- pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1 && method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => (a.createdAtSec - b.createdAtSec) || (a.number - b.number));
      const direction = req.query.get('direction') ?? 'desc';
      if (direction !== 'asc') pulls.reverse();
      const { page, headers } = paginate(req, pulls, `/api/v3/repos/${fullName}/pulls`);
      return { status: 200, json: page.map((pull) => pullJson(repo, pull, origin)), headers };
    }
    if (rest.length === 1 && method === 'POST') {
      const title = bodyString(req.body, 'title');
      const head = bodyString(req.body, 'head');
      const base = bodyString(req.body, 'base');
      if (!title || !head || !base) return unprocessable('title, head and base are required');
      const created = createPull(repo, { title, body: bodyString(req.body, 'body') ?? '', head, base });
      if ('error' in created) return unprocessable(created.error);
      return { status: 201, json: pullJson(repo, created, origin) };
    }
    if (rest.length >= 2) {
      const number = Number(rest[1]);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (!pull) return notFound();
      if (rest.length === 2 && method === 'GET') {
        const json = pullJson(repo, pull, origin) as Record<string, unknown>;
        const files = pullFiles(repo, pull);
        json.commits = 0;
        json.changed_files = files.length;
        json.additions = files.reduce((sum, f) => sum + f.additions, 0);
        json.deletions = files.reduce((sum, f) => sum + f.deletions, 0);
        json.mergeable = pull.state === 'open' ? !threeWayMerge(repo, pull).conflict : null;
        json.mergeable_state = pull.merged ? 'clean' : json.mergeable ? 'clean' : 'dirty';
        return { status: 200, json };
      }
      if (rest.length === 2 && method === 'PATCH') {
        const title = bodyString(req.body, 'title');
        if (title !== undefined) pull.title = title;
        const body = bodyString(req.body, 'body');
        if (body !== undefined) pull.body = body;
        const state = bodyString(req.body, 'state');
        if ((state === 'closed' || state === 'open') && !pull.merged) {
          pull.state = state;
          pull.closedAtSec = state === 'closed' ? tickSec() : null;
        }
        pull.updatedAtSec = tickSec();
        return { status: 200, json: pullJson(repo, pull, origin) };
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const files = pullFiles(repo, pull);
        const { page, headers } = paginate(req, files, `/api/v3/repos/${fullName}/pulls/${pull.number}/files`);
        const json = page.map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          sha: '',
        }));
        return { status: 200, json, headers };
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pull.merged || pull.state !== 'open') {
          return { status: 405, json: { message: 'Pull Request is not mergeable' } };
        }
        const mergeMethod = (bodyString(req.body, 'merge_method') ?? 'squash').toLowerCase();
        const sha = mergePull(repo, pull, mergeMethod === 'merge' ? 'merge' : 'squash');
        if (!sha) return { status: 405, json: { message: 'Pull Request is not mergeable' } };
        return { status: 200, json: { sha, merged: true, message: 'Pull Request successfully merged' } };
      }
    }
    return notFound();
  }

  return notFound();
}
