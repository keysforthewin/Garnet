# Garnet MCP

Connect Claude Code and Codex to a running local [Garnet](https://github.com/keysforthewin/Garnet) notes library:

```sh
npx garnet-mcp setup
```

Requires Linux, Node 22.13+ and Garnet on the same machine under your OS account. This command connects an existing Garnet installation; it does not install the app or database.

Setup finds installed agents and asks separately before adding a user-level `garnet` MCP server. It displays executable/configuration paths, backs up changed configuration, and preserves unrelated settings. Start a new agent session after setup; the agent's normal tool approval rules apply.

Try “Create a to-do list in Garnet,” “Find my launch notes in Garnet,” or “Read my launch notes and add a testing checklist.” Edits appear in the web editor with a Garnet cursor. Small insertions reveal quickly; large edits and animation queues exceeding two seconds display immediately with a highlight. Saving never waits for animation.

```sh
npx garnet-mcp doctor
npx garnet-mcp remove
npx garnet-mcp setup --root=/path/to/garnet
```

`--root` supports packaged and source installations. `GARNET_HOME` overrides the default `~/.local/share/garnet` path. Agent configuration honors `CODEX_HOME` and `CLAUDE_CONFIG_DIR`.

For unattended setup, `--agents=claude,codex` explicitly consents to those agents; `--replace` also permits replacing a conflicting `garnet` entry. Without a terminal or explicit selection, setup skips configuration. `remove --agents=codex` disconnects only Codex. Removal preserves entries changed outside this installer.

Setup stores a local library credential in `data/runtime/mcp-token` (owner-only). This grants access to the shared notes library, independently of browser sessions. Credentials are not copied into agent configuration. Removing all tracked connections revokes that credential. No remote HTTP endpoint is exposed.

## Other MCP agents

After setup, configure a stdio server with the absolute path to your `garnet` executable and the argument `mcp`:

```json
{
  "mcpServers": {
    "garnet": {
      "command": "/home/YOUR_USER/.local/bin/garnet",
      "args": ["mcp"]
    }
  }
}
```

For manual configuration without Claude/Codex, run `garnet-mcp setup --agents=manual`, then copy the configuration it prints. Other clients use their own configuration format; the command and args remain the same.

The tools are `list_documents`, `search_documents`, `read_document`, `create_document`, and `edit_document`. Edits require the version returned by a read. On conflict, reread and retry. Markdown mirror files are exports and must not be edited directly.

## Publishing

The npm package has its own version in this directory. Bump that version when changing setup behavior. Garnet releases invoke that exact version, and the app release workflow checks that it exists before publishing the app.

Run `node scripts/smoke-mcp-package.mjs` from the repository root to verify the packed package in an isolated installation. Publish with `npm publish ./packages/garnet-mcp --access public` using an npm account allowed to publish `garnet-mcp`, or run the **Publish MCP setup package** workflow with the repository's `NPM_TOKEN` secret configured. Publish the package before tagging the Garnet release.
