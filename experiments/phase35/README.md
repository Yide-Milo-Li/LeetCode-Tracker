# Phase 35 synthetic host experiment

This entry is explicit and separate from desktop startup. It opens a new temporary SQLite database and backup directory with eight generated synthetic exercises. It never reads `.env`, a personal profile, provider keys, or a shipped catalog. Both hosts must connect to this same running lab.

From the repository root with Node 24.15.x:

```powershell
npm ci
npm run phase35:build
npm run phase35:lab
```

The lab prints its temporary data location and listens on `127.0.0.1:30135`. Its health endpoint is `/health`, MCP endpoint is `/mcp`, and resource is `ui://tracker/workspace.html`. Stop with Ctrl+C. Temporary evidence is retained for inspection; a new launch uses a new directory.

The allowlist exposes public preferences, strategies, existing Today plans, notes, records for a specified exercise, local Add one and note saving. It does not expose credentials, generation, restore, imports, settings writes or exports. Practice and planning conflict/replay rules still belong to the application.

## ChatGPT

Use a Secure MCP Tunnel whose runtime forwards to `http://127.0.0.1:30135/mcp`. Confirm the Tunnel ID, associated workspace and TunnelsRead/TunnelsUse permissions separately from ChatGPT developer mode. This experiment does not create a public deployment or bypass those permissions. The UI uses the official MCP Apps SDK for initialization, tool calls, results, links and teardown.

The explicit build also creates `dist/tracker-phase35/`, an Agent Plugins 1.0 local package with portable `mcp.json` and a bundled stdio proxy. Its proxy requires the running lab, so it shares the same database as DSH. It is not automatically installed or uploaded to an account. An account upload does not make the local process reachable from ChatGPT web.

## DSH

The actual Client Module artifact is `dist/dsh/`. React, React DOM and JSX runtime remain host-shared imports. The module registers `main` and `sidebar.footer.action` through declaration-lifetime Slots injection. Its component owns the workspace and closes the event subscription on unmount.

The tested local setup uses DSH `0.2.0-rc.2` in an isolated home:

```powershell
$env:DSH_HOME = [IO.Path]::GetFullPath('.local/hosts/dsh-home')
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 web --help
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add ./experiments/phase35/dist/dsh
```

The plugin is a client module, not a bundle layer. Add this entry to the isolated profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: tracker-phase35
      name: '@leetcode-tracker/dsh-phase35'
```

Then run in a second terminal, keeping the lab running:

```powershell
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 web --no-open --host 127.0.0.1 --port 30136
```

Open the locally printed authenticated URL and select Tracker. Keep its ephemeral token out of shared logs. An optional client configuration `endpoint` changes the loopback lab URL.

## Acceptance status

Actual SDK tests are offline evidence; building a Client Module is not real DSH acceptance. Real ChatGPT acceptance still requires the account/tunnel configuration. Local DSH was started, but the available acceptance browser blocked Windows loopback access. Neither host is currently accepted.

For each host record its version, screenshots, actions and returned data: Today → specified note → edit/save → tool Add one → current view refresh → reread. Also verify unsaved draft preservation, disconnect/reconnect and unload/reload. No Phase 35 completion claim is valid before both real-host flows and the desktop compatibility gates pass.
