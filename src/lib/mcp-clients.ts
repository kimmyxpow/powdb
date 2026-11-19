/**
 * Setup guides for AI tools that talk to PowDB over MCP, plus the copy-paste prompt
 * that lets an AI tool install PowDB itself. Plain data: the AI access page renders it.
 */

type SetupKind = 'command' | 'file'
export type SetupMode = 'http' | 'docker'

interface HttpSetup {
  /** A command to run, or the file the snippet goes into. */
  where: string
  kind: SetupKind
  snippet: (url: string, token: string) => string
  note?: string | ((url: string) => string)
}

interface DockerSetup {
  where: string
  kind: SetupKind
  snippet: () => string
  note?: string
}

interface McpClient {
  id: string
  name: string
  http: HttpSetup
  docker: DockerSetup
}

/** Shown in the guides when no token was created on the page. */
export const PLACEHOLDER_TOKEN = '<YOUR_TOKEN>'
export const DEFAULT_CLIENT_ID = 'claude-code'

export function mcpUrl(): string {
  return `${window.location.origin}/mcp`
}

const DOCKER_NOTE = 'The PowDB container must be running on this machine.'

function dockerNote(extra?: string): string {
  return extra ? `${extra} ${DOCKER_NOTE}` : DOCKER_NOTE
}

/** The stdio server entry that runs the MCP command inside the PowDB container. */
const DOCKER_SERVER = { command: 'docker', args: ['exec', '-i', 'powdb', 'powdb', 'mcp'] }

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function mcpServers(server: unknown): string {
  return json({ mcpServers: { powdb: server } })
}

export const MCP_CLIENTS: McpClient[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    http: {
      where: 'Run in a terminal',
      kind: 'command',
      snippet: (url, token) =>
        `claude mcp add --scope user --transport http powdb ${url} --header "Authorization: Bearer ${token}"`,
      note: 'In Claude Code, run /mcp to check that powdb is connected.',
    },
    docker: {
      where: 'Run in a terminal',
      kind: 'command',
      snippet: () => 'claude mcp add --scope user powdb -- docker exec -i powdb powdb mcp',
      note: dockerNote(),
    },
  },
  {
    id: 'codex',
    name: 'Codex CLI (OpenAI)',
    http: {
      where: '~/.codex/config.toml',
      kind: 'file',
      snippet: (url, token) =>
        ['[mcp_servers.powdb]', `url = "${url}"`, `http_headers = { "Authorization" = "Bearer ${token}" }`].join('\n'),
      note: (url) =>
        `Codex also has \`codex mcp add powdb --url ${url} --bearer-token-env-var POWDB_TOKEN\`, which keeps the token in an environment variable instead of the file.`,
    },
    docker: {
      where: 'Run in a terminal',
      kind: 'command',
      snippet: () => 'codex mcp add powdb -- docker exec -i powdb powdb mcp',
      note: dockerNote(),
    },
  },
  {
    id: 'cursor',
    name: 'Cursor (editor and CLI)',
    http: {
      where: '~/.cursor/mcp.json, or .cursor/mcp.json in a project',
      kind: 'file',
      snippet: (url, token) => mcpServers({ url, headers: { Authorization: `Bearer ${token}` } }),
      note: 'The Cursor CLI (cursor-agent) reads the same file. Check with: cursor-agent mcp list',
    },
    docker: {
      where: '~/.cursor/mcp.json, or .cursor/mcp.json in a project',
      kind: 'file',
      snippet: () => mcpServers(DOCKER_SERVER),
      note: dockerNote(),
    },
  },
  {
    id: 'antigravity',
    name: 'Antigravity CLI (Google)',
    http: {
      where: '~/.gemini/config/mcp_config.json',
      kind: 'file',
      snippet: (url, token) => mcpServers({ serverUrl: url, headers: { Authorization: `Bearer ${token}` } }),
      note: 'Inside Antigravity, type /mcp to check the server. For one workspace only, use .agents/mcp_config.json.',
    },
    docker: {
      where: '~/.gemini/config/mcp_config.json',
      kind: 'file',
      snippet: () => mcpServers(DOCKER_SERVER),
      note: dockerNote(),
    },
  },
  {
    id: 'opencode',
    name: 'opencode',
    http: {
      where: 'Run in a terminal',
      kind: 'command',
      snippet: (url, token) => `opencode mcp add powdb --global --url ${url} --header 'Authorization=Bearer ${token}'`,
      note: 'Without --global it is added to the current project only.',
    },
    docker: {
      where: 'Run in a terminal',
      kind: 'command',
      snippet: () => 'opencode mcp add powdb --global -- docker exec -i powdb powdb mcp',
      note: dockerNote(),
    },
  },
  {
    id: 'vscode',
    name: 'VS Code (GitHub Copilot)',
    http: {
      where: '.vscode/mcp.json',
      kind: 'file',
      // The token is never written into the file: VS Code asks for it and stores it securely.
      // The literal ${input:powdb-token} is VS Code syntax, so it is single-quoted here.
      snippet: (url) =>
        json({
          servers: {
            powdb: {
              type: 'http',
              url,
              headers: { Authorization: 'Bearer ${input:powdb-token}' },
            },
          },
          inputs: [{ type: 'promptString', id: 'powdb-token', description: 'PowDB token', password: true }],
        }),
      note: "VS Code asks for the token the first time and stores it securely, so it is not saved in the file. For all workspaces, run 'MCP: Open User Configuration' and paste the same.",
    },
    docker: {
      where: '.vscode/mcp.json',
      kind: 'file',
      snippet: () => json({ servers: { powdb: { type: 'stdio', ...DOCKER_SERVER } } }),
      note: dockerNote(),
    },
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    http: {
      where: 'claude_desktop_config.json (Settings, Developer, Edit Config)',
      kind: 'file',
      snippet: (url, token) =>
        mcpServers({
          command: 'npx',
          args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${AUTH_HEADER}'],
          env: { AUTH_HEADER: `Bearer ${token}` },
        }),
      note: 'Needs Node.js for npx. Quit Claude Desktop completely and open it again afterwards.',
    },
    docker: {
      where: 'claude_desktop_config.json (Settings, Developer, Edit Config)',
      kind: 'file',
      snippet: () => mcpServers(DOCKER_SERVER),
      note: dockerNote('Quit Claude Desktop completely and open it again afterwards.'),
    },
  },
  {
    id: 'kiro',
    name: 'Kiro',
    http: {
      where: '~/.kiro/settings/mcp.json',
      kind: 'file',
      snippet: (url, token) => mcpServers({ url, headers: { Authorization: `Bearer ${token}` } }),
    },
    docker: {
      where: '~/.kiro/settings/mcp.json',
      kind: 'file',
      snippet: () => mcpServers(DOCKER_SERVER),
      note: dockerNote(),
    },
  },
  {
    id: 'cline',
    name: 'Cline',
    http: {
      where: 'Cline settings: Configure MCP Servers',
      kind: 'file',
      snippet: (url, token) =>
        mcpServers({ type: 'streamableHttp', url, headers: { Authorization: `Bearer ${token}` } }),
    },
    docker: {
      where: 'Cline settings: Configure MCP Servers',
      kind: 'file',
      snippet: () => mcpServers(DOCKER_SERVER),
      note: dockerNote(),
    },
  },
  {
    id: 'other',
    name: 'Other tools (generic)',
    http: {
      where: "your tool's MCP settings",
      kind: 'file',
      snippet: (url, token) =>
        `Server name: powdb\nTransport: Streamable HTTP\nURL: ${url}\nHeader: Authorization: Bearer ${token}`,
      note: 'Most tools accept these four values in their MCP settings.',
    },
    docker: {
      where: "your tool's MCP settings",
      kind: 'file',
      snippet: () => 'Command: docker exec -i powdb powdb mcp',
      note: dockerNote('Most tools accept a command like this in their MCP settings.'),
    },
  },
]

interface ResolvedSetup {
  where: string
  kind: SetupKind
  code: string
  note?: string
}

export function resolveSetup(client: McpClient, mode: SetupMode, url: string, token: string): ResolvedSetup {
  if (mode === 'docker') {
    const d = client.docker
    return { where: d.where, kind: d.kind, code: d.snippet(), note: d.note }
  }
  const h = client.http
  const note = typeof h.note === 'function' ? h.note(url) : h.note
  return { where: h.where, kind: h.kind, code: h.snippet(url, token), note }
}

/** The copy-paste prompt. The AI tool installs PowDB itself, so the details are spelled out. */
export function aiPrompt(url: string, token: string): string {
  return (
    `Add my PowDB MCP server to your user settings: ${url} (Streamable HTTP), header "Authorization: Bearer ${token}". ` +
    'Then tell me which databases you can see.'
  )
}

/** The same, for the Docker method: the AI tool runs PowDB's command, no token involved. */
export function aiDockerPrompt(): string {
  return (
    'Add my PowDB MCP server to your user settings as a local stdio server: docker exec -i powdb powdb mcp. ' +
    'Then tell me which databases you can see.'
  )
}
