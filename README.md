# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge in a single dependency-free Node process:
git over smart HTTP (protocol v0 and v2, shallow fetch and deepen,
receive-pack with report-status), the REST v3 API, a GraphQL API and an
MCP endpoint — all over one shared in-memory store, so an object created
through any surface is the same object on all the others.

## Run

```
node main.ts
```

The process is started by the harness: it listens on an ephemeral port,
registers the port with `$MAKEFUN_ENV_URL`, serves until the harness
reports done, and exits. For a standalone smoke test, serve `app.ts`'s
`createApp()` on any port and set `MAKEFUN_SHOP_TOKEN` to the Bearer token
every API call must carry.

## Layout

- `main.ts` — the harness lifecycle (register, serve, exit on done).
- `app.ts` — HTTP routing and token auth for the four surfaces.
- `lib/scenario.ts` — the scenario identities, recomputed from the fixed
  seed (the token's viewer is the first generated user).
- `lib/gitobj.ts` — the git object model: SHA-1 objects, trees, commits,
  packfile read/write with delta resolution, pkt-line codec.
- `lib/forge.ts` — the domain store: repositories, refs, issues, pull
  requests (three-way merge, conflict detection, file diffs), labels,
  comments, deterministic timestamps, GraphQL global ids.
- `lib/githttp.ts` — smart HTTP: advertisement, ls-refs, fetch (v0/v2,
  shallow/deepen planning), receive-pack.
- `lib/rest.ts` — the REST v3 surface.
- `lib/graphql.ts` + `lib/graphql-exec.ts` — a small GraphQL parser and
  an executor over a hand-rolled GitHub-shaped schema, with introspection.
- `lib/mcp.ts` — the MCP endpoint (server/discover + initialize eras,
  six tools).

No dependencies, no build step, no disk state: everything is in memory
and every timestamp derives from the scenario epoch, so runs are
reproducible byte for byte.
