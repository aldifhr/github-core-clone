/**
 * The MCP endpoint: JSON-RPC 2.0 over POST /mcp, in both protocol eras the
 * conformance client speaks — the modern `server/discover` handshake and the
 * legacy `initialize` one. Six tools over the same store as REST and
 * GraphQL, so an object made by one surface is the same object on the others.
 */
import {
  createIssue, createPull, createRepo, findRepo, issueJson, mergePull,
  pullJson, repoJson,
} from './forge.ts';
import type { RepoRec } from './forge.ts';
import { VIEWER } from './scenario.ts';

const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

export interface McpOutcome {
  status: number;
  /** Undefined means "no response body" (a notification acknowledgement). */
  payload?: unknown;
}

function resultResponse(id: unknown, result: unknown): McpOutcome {
  return { status: 200, payload: { jsonrpc: '2.0', id: id ?? null, result } };
}

function errorResponse(id: unknown, code: number, message: string): McpOutcome {
  return { status: 200, payload: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolSuccess(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

function repoArg(args: Record<string, unknown>): RepoRec | null {
  const owner = args.owner;
  const repo = args.repo;
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  return findRepo(owner, repo);
}

function callTool(params: Record<string, unknown>): Record<string, unknown> {
  const rawName = typeof params.name === 'string' ? params.name : '';
  const tool = TOOLS.find((candidate) => candidate.name === rawName)
    ?? TOOLS.find((candidate) => rawName.endsWith(`/${candidate.name}`) || rawName.endsWith(`_${candidate.name}`));
  if (!tool) {
    // Signalled as a JSON-RPC error by the caller wrapper; marked here.
    throw new ToolUnknownError(rawName);
  }
  const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolFailure(`Missing required argument: ${required}`);
    }
  }
  switch (tool.name) {
    case 'create_repo': {
      const created = createRepo(VIEWER.login, {
        name: String(args.name),
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      if (created === 'exists') return toolFailure('name already exists on this account');
      return toolSuccess(repoJson(created, ''));
    }
    case 'get_repo': {
      const repo = repoArg(args);
      if (!repo) return toolFailure('Repository not found');
      return toolSuccess(repoJson(repo, ''));
    }
    case 'create_issue': {
      const repo = repoArg(args);
      if (!repo) return toolFailure('Repository not found');
      const created = createIssue(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
      });
      if ('error' in created) return toolFailure(created.error);
      return toolSuccess(issueJson(repo, created, ''));
    }
    case 'list_issues': {
      const repo = repoArg(args);
      if (!repo) return toolFailure('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()].sort((a, b) => a.number - b.number);
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      return toolSuccess({ issues: issues.map((issue) => issueJson(repo, issue, '')), total_count: issues.length });
    }
    case 'create_pull_request': {
      const repo = repoArg(args);
      if (!repo) return toolFailure('Repository not found');
      const created = createPull(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        head: String(args.head),
        base: String(args.base),
      });
      if ('error' in created) return toolFailure(created.error);
      return toolSuccess(pullJson(repo, created, ''));
    }
    case 'merge_pull_request': {
      const repo = repoArg(args);
      if (!repo) return toolFailure('Repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (!pull) return toolFailure('Pull request not found');
      if (!pull.merged) {
        const sha = mergePull(repo, pull, 'squash');
        if (!sha) return toolFailure('Pull Request is not mergeable');
      }
      return toolSuccess(pullJson(repo, pull, ''));
    }
    default:
      return toolFailure(`Unimplemented tool: ${tool.name}`);
  }
}

class ToolUnknownError extends Error {
  constructor(name: string) {
    super(`Unknown tool: ${name}`);
  }
}

function handleOne(message: unknown): McpOutcome {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return errorResponse(null, -32600, 'Invalid Request');
  }
  const record = message as Record<string, unknown>;
  const method = record.method;
  const hasId = Object.prototype.hasOwnProperty.call(record, 'id');
  const id = record.id;
  if (typeof method !== 'string') {
    return hasId ? errorResponse(id, -32600, 'Invalid Request') : { status: 202 };
  }
  if (!hasId) {
    // A notification (notifications/initialized, notifications/cancelled, …):
    // accepted, never answered.
    return { status: 202 };
  }
  const params = (record.params && typeof record.params === 'object' ? record.params : {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return resultResponse(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-03-26';
      return resultResponse(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return resultResponse(id, {});
    case 'tools/list':
      return resultResponse(id, { tools: TOOLS });
    case 'tools/call': {
      try {
        return resultResponse(id, callTool(params));
      } catch (error) {
        if (error instanceof ToolUnknownError) return errorResponse(id, -32601, error.message);
        return resultResponse(id, toolFailure(error instanceof Error ? error.message : 'Tool failed'));
      }
    }
    case 'resources/list':
      return resultResponse(id, { resources: [] });
    case 'prompts/list':
      return resultResponse(id, { prompts: [] });
    default:
      return errorResponse(id, -32601, `Method not found: ${method}`);
  }
}

/** Handle a POST /mcp payload (single message or batch). Auth is the HTTP layer's job. */
export function handleMcpPayload(payload: unknown): McpOutcome {
  if (Array.isArray(payload)) {
    const responses: unknown[] = [];
    for (const message of payload) {
      const outcome = handleOne(message);
      if (outcome.payload !== undefined) responses.push(outcome.payload);
    }
    return { status: 200, payload: responses };
  }
  return handleOne(payload);
}

/** The -32700 body for a request that is not JSON at all (HTTP 400). */
export function mcpParseError(): Record<string, unknown> {
  return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
}
