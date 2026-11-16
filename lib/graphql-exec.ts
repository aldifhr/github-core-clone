/**
 * The GraphQL executor: a hand-rolled schema (Query, Mutation, Repository,
 * Issue, PullRequest, connections, introspection) over the forge's shared
 * store, driven by the parser in graphql.ts.
 */
import {
  addComment, createIssue, createPull, findRepo, globalId,
  issueGlobalId, isoOf, mergePull, parseGlobalId, pullFiles, pullGlobalId,
  repoGlobalId, reposById, threeWayMerge, tickSec,
} from './forge.ts';
import { parseCommit } from './gitobj.ts';
import { VIEWER, userByLogin } from './scenario.ts';
import { parseGraphQL, valueFromNode } from './graphql.ts';
import type { DocumentNode, FieldNode, FragmentNode, SelectionNode } from './graphql.ts';
import type { IssueRec, PullRec, RepoRec } from './forge.ts';

// ------------------------------------------------------------------ executor

type GqlObj = { __type: string } & Record<string, unknown>;

const gqlObj = (type: string, data: Record<string, unknown> = {}): GqlObj => ({ __type: type, ...data });
const UNKNOWN = Symbol('unknown-field');

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'user'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'url',
    'createdAt', 'updatedAt', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled',
    'issue', 'issues', 'pullRequest', 'pullRequests',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'closed', 'author', 'repository',
    'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'url',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeCommit',
    'headRefName', 'baseRefName', 'headRef', 'baseRef', 'mergeable', 'files', 'author',
    'repository', 'isDraft', 'createdAt', 'updatedAt', 'closedAt', 'url',
  ],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url'],
  Ref: ['name', 'prefix', 'target'],
  Commit: ['oid', 'message', 'committedDate', 'tree'],
  Tree: ['oid'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'url'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileEdge: ['node', 'cursor'],
  PullRequestFile: ['path', 'additions', 'deletions'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelEdge: ['node', 'cursor'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  AddCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
  __Directive: ['name', 'description', 'locations', 'args'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  Permission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  State: ['OPEN', 'CLOSED', 'MERGED'],
};

interface ExecCtx {
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: { message: string }[];
}

const userObj = (login: string): GqlObj => gqlObj('User', { login });
const repoObj = (rec: RepoRec): GqlObj => gqlObj('Repository', { rec });
const issueObj = (rec: RepoRec, issue: IssueRec): GqlObj => gqlObj('Issue', { rec, issue });
const pullObj = (rec: RepoRec, pull: PullRec): GqlObj => gqlObj('PullRequest', { rec, pull });
const typeObj = (name: string): GqlObj => gqlObj('__Type', { typeName: name });

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function makeConnection(type: string, edgeType: string, items: GqlObj[], first: unknown, after: unknown): GqlObj {
  let start = 0;
  if (typeof after === 'string') {
    const index = decodeCursor(after);
    if (index !== null) start = index + 1;
  }
  const limit = typeof first === 'number' && Number.isFinite(first) ? Math.max(0, Math.trunc(first)) : items.length;
  const slice = items.slice(start, start + limit);
  const edges = slice.map((node, i) => gqlObj(edgeType, { node, cursor: encodeCursor(start + i) }));
  const pageInfo = gqlObj('PageInfo', {
    hasNextPage: start + slice.length < items.length,
    hasPreviousPage: start > 0,
    startCursor: edges.length > 0 ? edges[0].cursor : null,
    endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
  });
  return gqlObj(type, { nodes: slice, edges, pageInfo, totalCount: items.length });
}

function sortIssues(issues: IssueRec[], orderBy: unknown): IssueRec[] {
  const sorted = [...issues].sort((a, b) => (a.createdAtSec - b.createdAtSec) || (a.number - b.number));
  if (orderBy && typeof orderBy === 'object') {
    const direction = (orderBy as Record<string, unknown>).direction;
    if (direction === 'DESC') sorted.reverse();
  }
  return sorted;
}

function repoFromGlobalId(id: unknown): RepoRec | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Repository') return null;
  return reposById.get(Number(parsed.key)) ?? null;
}

function issueFromGlobalId(id: unknown): { rec: RepoRec; issue: IssueRec } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Issue') return null;
  const [repoId, number] = parsed.key.split(':');
  const rec = reposById.get(Number(repoId));
  const issue = rec?.issues.get(Number(number));
  return rec && issue ? { rec, issue } : null;
}

function pullFromGlobalId(id: unknown): { rec: RepoRec; pull: PullRec } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'PullRequest') return null;
  const [repoId, number] = parsed.key.split(':');
  const rec = reposById.get(Number(repoId));
  const pull = rec?.pulls.get(Number(number));
  return rec && pull ? { rec, pull } : null;
}

function resolveNode(id: unknown): GqlObj | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  if (parsed.kind === 'Repository') {
    const rec = reposById.get(Number(parsed.key));
    return rec ? repoObj(rec) : null;
  }
  if (parsed.kind === 'Issue') {
    const found = issueFromGlobalId(id);
    return found ? issueObj(found.rec, found.issue) : null;
  }
  if (parsed.kind === 'PullRequest') {
    const found = pullFromGlobalId(id);
    return found ? pullObj(found.rec, found.pull) : null;
  }
  if (parsed.kind === 'User') {
    return userByLogin(parsed.key) ? userObj(parsed.key) : null;
  }
  return null;
}

function argOf(field: FieldNode, name: string, ctx: ExecCtx): unknown {
  return valueFromNode(field.args.get(name), ctx.variables);
}

function resolveField(typeName: string, source: GqlObj, field: FieldNode, ctx: ExecCtx): unknown {
  const name = field.name;
  const rec = source.rec as RepoRec | undefined;

  if (typeName === 'Query') {
    switch (name) {
      case 'viewer': return userObj(VIEWER.login);
      case 'user': {
        const login = argOf(field, 'login', ctx);
        return typeof login === 'string' && userByLogin(login) ? userObj(login) : null;
      }
      case 'repository': {
        const owner = argOf(field, 'owner', ctx);
        const repoName = argOf(field, 'name', ctx);
        if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
        const found = findRepo(owner, repoName);
        return found ? repoObj(found) : null;
      }
      case 'node': return resolveNode(argOf(field, 'id', ctx));
      case '__type': {
        const typeNameArg = argOf(field, 'name', ctx);
        if (typeof typeNameArg !== 'string') return null;
        return TYPE_FIELDS[typeNameArg] || ENUM_VALUES[typeNameArg] ? typeObj(typeNameArg) : null;
      }
      case '__schema': return gqlObj('__Schema', {});
      default: break;
    }
  }

  if (typeName === 'Mutation') {
    const input = (argOf(field, 'input', ctx) as Record<string, unknown> | undefined) ?? {};
    switch (name) {
      case 'createIssue': {
        const repo = repoFromGlobalId(input.repositoryId);
        if (!repo) throw new Error('Repository not found');
        const created = createIssue(repo, {
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
        });
        if ('error' in created) throw new Error(created.error);
        return gqlObj('CreateIssuePayload', { issue: issueObj(repo, created), clientMutationId: input.clientMutationId ?? null });
      }
      case 'closeIssue': {
        const found = issueFromGlobalId(input.issueId);
        if (!found) throw new Error('Issue not found');
        found.issue.state = 'closed';
        found.issue.closedAtSec = tickSec();
        found.issue.updatedAtSec = tickSec();
        return gqlObj('CloseIssuePayload', { issue: issueObj(found.rec, found.issue), clientMutationId: input.clientMutationId ?? null });
      }
      case 'createPullRequest': {
        const repo = repoFromGlobalId(input.repositoryId);
        if (!repo) throw new Error('Repository not found');
        const created = createPull(repo, {
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          head: typeof input.headRefName === 'string' ? input.headRefName : '',
          base: typeof input.baseRefName === 'string' ? input.baseRefName : '',
        });
        if ('error' in created) throw new Error(created.error);
        return gqlObj('CreatePullRequestPayload', { pullRequest: pullObj(repo, created), clientMutationId: input.clientMutationId ?? null });
      }
      case 'mergePullRequest': {
        const found = pullFromGlobalId(input.pullRequestId);
        if (!found) throw new Error('Pull request not found');
        if (!found.pull.merged) {
          const method = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
          const sha = mergePull(found.rec, found.pull, method === 'MERGE' ? 'merge' : 'squash');
          if (!sha) throw new Error('Pull Request is not mergeable');
        }
        return gqlObj('MergePullRequestPayload', { pullRequest: pullObj(found.rec, found.pull), clientMutationId: input.clientMutationId ?? null });
      }
      case 'addComment': {
        const found = issueFromGlobalId(input.subjectId);
        if (!found) throw new Error('Subject not found');
        const comment = addComment(found.rec, found.issue, typeof input.body === 'string' ? input.body : '');
        const node = gqlObj('IssueComment', {
          commentId: comment.id,
          rec: found.rec,
          issue: found.issue,
          body: comment.body,
          authorLogin: comment.authorLogin,
          createdAtSec: comment.createdAtSec,
        });
        return gqlObj('AddCommentPayload', {
          commentEdge: gqlObj('AddCommentEdge', { node, cursor: encodeCursor(0) }),
          subject: issueObj(found.rec, found.issue),
          clientMutationId: input.clientMutationId ?? null,
        });
      }
      default: break;
    }
  }

  if (typeName === 'Repository' && rec) {
    switch (name) {
      case 'id': return repoGlobalId(rec);
      case 'databaseId': return rec.id;
      case 'name': return rec.name;
      case 'nameWithOwner': return `${rec.owner}/${rec.name}`;
      case 'owner': return userObj(rec.owner);
      case 'description': return rec.description;
      case 'isPrivate': return rec.isPrivate;
      case 'url': return `https://forge.local/${rec.owner}/${rec.name}`;
      case 'createdAt': return isoOf(rec.createdAtSec);
      case 'updatedAt': return isoOf(rec.updatedAtSec);
      case 'defaultBranchRef': {
        const tip = rec.refs.get(`refs/heads/${rec.defaultBranch}`);
        return tip ? gqlObj('Ref', { rec, branch: rec.defaultBranch, oid: tip }) : null;
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'issue': {
        const number = argOf(field, 'number', ctx);
        const issue = typeof number === 'number' ? rec.issues.get(number) : undefined;
        return issue ? issueObj(rec, issue) : null;
      }
      case 'issues': {
        const states = argOf(field, 'states', ctx) as string[] | undefined;
        let list = [...rec.issues.values()];
        if (Array.isArray(states)) list = list.filter((issue) => states.includes(issue.state.toUpperCase()));
        list = sortIssues(list, argOf(field, 'orderBy', ctx));
        return makeConnection('IssueConnection', 'IssueEdge', list.map((issue) => issueObj(rec, issue)), argOf(field, 'first', ctx), argOf(field, 'after', ctx));
      }
      case 'pullRequest': {
        const number = argOf(field, 'number', ctx);
        const pull = typeof number === 'number' ? rec.pulls.get(number) : undefined;
        return pull ? pullObj(rec, pull) : null;
      }
      case 'pullRequests': {
        const states = argOf(field, 'states', ctx) as string[] | undefined;
        let list = [...rec.pulls.values()].sort((a, b) => (a.createdAtSec - b.createdAtSec) || (a.number - b.number));
        if (Array.isArray(states)) {
          list = list.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
        }
        return makeConnection('PullRequestConnection', 'PullRequestEdge', list.map((pull) => pullObj(rec, pull)), argOf(field, 'first', ctx), argOf(field, 'after', ctx));
      }
      default: break;
    }
  }

  if (typeName === 'Issue' && rec) {
    const issue = source.issue as IssueRec;
    switch (name) {
      case 'id': return issueGlobalId(rec, issue);
      case 'databaseId': return issue.recId;
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state': return issue.state.toUpperCase();
      case 'closed': return issue.state === 'closed';
      case 'author': return userObj(issue.authorLogin);
      case 'repository': return repoObj(rec);
      case 'labels': {
        const nodes = issue.labels
          .map((labelName) => rec.labels.get(labelName.toLowerCase()))
          .filter((label) => label !== undefined)
          .map((label) => gqlObj('Label', {
            id: globalId('Label', String((label as { id: number }).id)),
            name: (label as { name: string }).name,
            color: (label as { color: string }).color,
            description: (label as { description: string | null }).description,
          }));
        return makeConnection('LabelConnection', 'LabelEdge', nodes, argOf(field, 'first', ctx), argOf(field, 'after', ctx));
      }
      case 'comments': {
        const nodes = issue.comments.map((comment) => gqlObj('IssueComment', {
          commentId: comment.id,
          rec,
          issue,
          body: comment.body,
          authorLogin: comment.authorLogin,
          createdAtSec: comment.createdAtSec,
        }));
        return makeConnection('IssueCommentConnection', 'IssueCommentEdge', nodes, argOf(field, 'first', ctx), argOf(field, 'after', ctx));
      }
      case 'createdAt': return isoOf(issue.createdAtSec);
      case 'updatedAt': return isoOf(issue.updatedAtSec);
      case 'closedAt': return issue.closedAtSec === null ? null : isoOf(issue.closedAtSec);
      case 'url': return `https://forge.local/${rec.owner}/${rec.name}/issues/${issue.number}`;
      default: break;
    }
  }

  if (typeName === 'PullRequest' && rec) {
    const pull = source.pull as PullRec;
    switch (name) {
      case 'id': return pullGlobalId(rec, pull);
      case 'databaseId': return pull.recId;
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged': return pull.merged;
      case 'mergedAt': return pull.mergedAtSec === null ? null : isoOf(pull.mergedAtSec);
      case 'mergeCommit': return pull.mergeCommitSha ? gqlObj('Commit', { rec, oid: pull.mergeCommitSha }) : null;
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'headRef': {
        const tip = rec.refs.get(`refs/heads/${pull.headRef}`);
        return tip ? gqlObj('Ref', { rec, branch: pull.headRef, oid: tip }) : null;
      }
      case 'baseRef': {
        const tip = rec.refs.get(`refs/heads/${pull.baseRef}`);
        return tip ? gqlObj('Ref', { rec, branch: pull.baseRef, oid: tip }) : null;
      }
      case 'mergeable': {
        if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
        return threeWayMerge(rec, pull).conflict ? 'CONFLICTING' : 'MERGEABLE';
      }
      case 'files': {
        const nodes = pullFiles(rec, pull).map((file) => gqlObj('PullRequestFile', {
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
        }));
        return makeConnection('PullRequestFileConnection', 'PullRequestFileEdge', nodes, argOf(field, 'first', ctx), argOf(field, 'after', ctx));
      }
      case 'author': return userObj(pull.authorLogin);
      case 'repository': return repoObj(rec);
      case 'isDraft': return false;
      case 'createdAt': return isoOf(pull.createdAtSec);
      case 'updatedAt': return isoOf(pull.updatedAtSec);
      case 'closedAt': return pull.closedAtSec === null ? null : isoOf(pull.closedAtSec);
      case 'url': return `https://forge.local/${rec.owner}/${rec.name}/pull/${pull.number}`;
      default: break;
    }
  }

  if (typeName === 'User') {
    const login = source.login as string;
    const user = userByLogin(login);
    switch (name) {
      case 'id': return globalId('User', login);
      case 'databaseId': return user?.id ?? 0;
      case 'login': return login;
      case 'name': return user?.name ?? login;
      case 'email': return user?.email ?? `${login}@example.invalid`;
      case 'url': return `https://forge.local/${login}`;
      default: break;
    }
  }

  if (typeName === 'Ref' && rec) {
    switch (name) {
      case 'name': return source.branch as string;
      case 'prefix': return 'refs/heads/';
      case 'target': return gqlObj('Commit', { rec, oid: source.oid as string });
      default: break;
    }
  }

  if (typeName === 'Commit' && rec) {
    const oid = source.oid as string;
    const object = rec.objects.get(oid);
    switch (name) {
      case 'oid': return oid;
      case 'message': return object && object.type === 'commit' ? parseCommit(object.data).message : '';
      case 'committedDate': return object && object.type === 'commit' ? isoOf(parseCommit(object.data).committerTs) : null;
      case 'tree': {
        if (!object || object.type !== 'commit') return null;
        return gqlObj('Tree', { oid: parseCommit(object.data).tree });
      }
      default: break;
    }
  }

  if (typeName === 'IssueComment') {
    switch (name) {
      case 'id': {
        const issue = source.issue as IssueRec | undefined;
        return globalId('IssueComment', `${rec?.id ?? 0}:${issue?.number ?? 0}:${source.commentId as number}`);
      }
      case 'body': return source.body as string;
      case 'author': return userObj(source.authorLogin as string);
      case 'createdAt': return isoOf(source.createdAtSec as number);
      case 'url': return 'https://forge.local/';
      default: break;
    }
  }

  if (typeName === '__Type') {
    const typeNameArg = source.typeName as string;
    switch (name) {
      case 'name': return typeNameArg;
      case 'kind': return ENUM_VALUES[typeNameArg] ? 'ENUM' : 'OBJECT';
      case 'description': return null;
      case 'fields': {
        const fields = TYPE_FIELDS[typeNameArg];
        return fields ? fields.map((fieldName) => gqlObj('__Field', { fieldName })) : null;
      }
      case 'enumValues': {
        const values = ENUM_VALUES[typeNameArg];
        return values ? values.map((value) => gqlObj('__EnumValue', { enumName: value })) : null;
      }
      case 'inputFields': return null;
      case 'interfaces': return [];
      case 'possibleTypes': return null;
      case 'ofType': return null;
      case 'specifiedByURL': return null;
      default: break;
    }
  }

  if (typeName === '__Field') {
    switch (name) {
      case 'name': return source.fieldName as string;
      case 'description': return null;
      case 'args': return [];
      case 'type': return null;
      case 'isDeprecated': return false;
      case 'deprecationReason': return null;
      default: break;
    }
  }

  if (typeName === '__EnumValue') {
    switch (name) {
      case 'name': return source.enumName as string;
      case 'description': return null;
      case 'isDeprecated': return false;
      case 'deprecationReason': return null;
      default: break;
    }
  }

  if (typeName === '__Schema') {
    switch (name) {
      case 'types': return [...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_VALUES)].map((typeName) => typeObj(typeName));
      case 'queryType': return typeObj('Query');
      case 'mutationType': return typeObj('Mutation');
      case 'subscriptionType': return null;
      case 'directives': return [];
      default: break;
    }
  }

  // Data-carrying objects (connections, payloads, labels, files, page info)
  // resolve their remaining fields straight from the stored data.
  if (Object.prototype.hasOwnProperty.call(source, name)) return source[name];
  return UNKNOWN;
}

function completeValue(value: unknown, selectionSet: SelectionNode[] | undefined, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, selectionSet, ctx));
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    const typed = value as GqlObj;
    if (!selectionSet) return {};
    return executeSet(typed.__type, typed, selectionSet, ctx);
  }
  return value;
}

function executeSet(typeName: string, source: GqlObj, selections: SelectionNode[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[key] = typeName;
        continue;
      }
      let value: unknown;
      try {
        value = resolveField(typeName, source, selection, ctx);
      } catch (error) {
        ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
        out[key] = null;
        continue;
      }
      if (value === UNKNOWN) {
        ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
        out[key] = null;
        continue;
      }
      out[key] = completeValue(value, selection.selectionSet, ctx);
    } else if (selection.kind === 'inlineFragment') {
      if (!selection.typeCondition || selection.typeCondition === typeName || selection.typeCondition === 'Node') {
        Object.assign(out, executeSet(typeName, source, selection.selectionSet, ctx));
      }
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment && (fragment.typeCondition === typeName || fragment.typeCondition === 'Node')) {
        Object.assign(out, executeSet(typeName, source, fragment.selectionSet, ctx));
      }
    }
  }
  return out;
}

export interface GraphQLResult {
  status: number;
  payload: Record<string, unknown>;
}

/** Execute one GraphQL operation document (the HTTP layer handles auth and batching). */
export function executeGraphQL(body: { query?: unknown; variables?: unknown; operationName?: unknown }): GraphQLResult {
  if (typeof body.query !== 'string' || body.query.trim() === '') {
    return { status: 400, payload: { errors: [{ message: 'A query string is required' }] } };
  }
  let document: DocumentNode;
  try {
    document = parseGraphQL(body.query);
  } catch (error) {
    return { status: 200, payload: { errors: [{ message: error instanceof Error ? error.message : 'Parse error' }] } };
  }
  if (document.operations.length === 0) {
    return { status: 200, payload: { errors: [{ message: 'No operation found' }] } };
  }
  let operation = document.operations[0];
  if (typeof body.operationName === 'string') {
    operation = document.operations.find((candidate) => candidate.name === body.operationName) ?? operation;
  } else if (document.operations.length > 1) {
    operation = document.operations.find((candidate) => candidate.type === 'query') ?? operation;
  }
  const variables = (body.variables && typeof body.variables === 'object' ? body.variables : {}) as Record<string, unknown>;
  const ctx: ExecCtx = { variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSet(rootType, gqlObj(rootType, {}), operation.selectionSet, ctx);
  const payload: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) payload.errors = ctx.errors;
  return { status: 200, payload };
}
