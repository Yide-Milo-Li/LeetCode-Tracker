/**
 * MCP Server configuration discovery, persistence, and AI access state management.
 * Manages mcp-config.json across desktop runtime directories and standalone local environments.
 * Supports multiple named client connections with token rotation, revocation, and last-used tracking.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

export interface McpClientCredential {
  id: string;
  name: string;
  token: string;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
}

export interface McpConfig {
  /** Target loopback port for Streamable HTTP server (default 30138). */
  port: number;
  /** Secret Bearer token required for default / backward-compatible external client access. */
  clientToken: string;
  /** Named client connection credentials. */
  clients: McpClientCredential[];
  /** Whether external AI access is paused via system tray or Settings. */
  aiAccessPaused: boolean;
}

const DEFAULT_PORT = 30138;

function generateRandomToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function createDefaultClients(): McpClientCredential[] {
  const now = Date.now();
  return [
    {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      token: generateRandomToken(),
      createdAt: now,
      lastUsedAt: null,
      revoked: false,
    },
    {
      id: 'cursor',
      name: 'Cursor',
      token: generateRandomToken(),
      createdAt: now,
      lastUsedAt: null,
      revoked: false,
    },
    {
      id: 'cline',
      name: 'Cline',
      token: generateRandomToken(),
      createdAt: now,
      lastUsedAt: null,
      revoked: false,
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT Tunnel',
      token: generateRandomToken(),
      createdAt: now,
      lastUsedAt: null,
      revoked: false,
    },
  ];
}

/**
 * Returns prioritized list of candidate paths where mcp-config.json may reside.
 */
export function getMcpConfigCandidatePaths(preferredDir?: string): string[] {
  const candidates: string[] = [];

  if (preferredDir) {
    candidates.push(path.join(preferredDir, 'mcp-config.json'));
  }

  if (process.env.MCP_CONFIG_PATH) {
    candidates.push(path.resolve(process.env.MCP_CONFIG_PATH));
  }

  // Windows LocalAppData paths
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    candidates.push(path.join(localAppData, 'com.yidel.tracker', 'mcp-config.json'));
    candidates.push(path.join(localAppData, 'Leetcode-Tracker', 'mcp-config.json'));
  }

  // User home directory fallback
  candidates.push(path.join(os.homedir(), '.leetcode-tracker', 'mcp-config.json'));

  // Repo root .local directory fallback
  const cwdLocal = path.join(process.cwd(), '.local', 'mcp-config.json');
  candidates.push(cwdLocal);

  return candidates;
}

/**
 * Find the active mcp-config.json path or the default destination to create it.
 */
export function resolveMcpConfigPath(preferredDir?: string): { activePath: string; isExisting: boolean } {
  const candidates = getMcpConfigCandidatePaths(preferredDir);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return { activePath: candidate, isExisting: true };
      }
    } catch {
      // Continue to next candidate
    }
  }

  // Default to preferredDir if provided, else user home dir or localDir
  const defaultPath = preferredDir
    ? path.join(preferredDir, 'mcp-config.json')
    : candidates[0] || path.join(os.homedir(), '.leetcode-tracker', 'mcp-config.json');

  return { activePath: defaultPath, isExisting: false };
}

/**
 * Load or initialize mcp-config.json with stable tokens and port configurations.
 */
export function loadMcpConfig(preferredDir?: string): { config: McpConfig; configPath: string } {
  const { activePath, isExisting } = resolveMcpConfigPath(preferredDir);

  let raw: Partial<McpConfig> = {};
  if (isExisting) {
    try {
      const text = fs.readFileSync(activePath, 'utf8');
      raw = JSON.parse(text);
    } catch {
      raw = {};
    }
  }

  const port = typeof raw.port === 'number' && raw.port > 0 && raw.port <= 65535 ? raw.port : DEFAULT_PORT;
  const clientToken = typeof raw.clientToken === 'string' && raw.clientToken.length >= 16
    ? raw.clientToken
    : generateRandomToken();
  const aiAccessPaused = Boolean(raw.aiAccessPaused);

  let clients = Array.isArray(raw.clients) ? raw.clients : [];
  if (clients.length === 0) {
    clients = createDefaultClients();
  }

  const config: McpConfig = { port, clientToken, clients, aiAccessPaused };

  // Write if newly created or if missing required fields
  if (!isExisting || raw.port !== port || raw.clientToken !== clientToken || !raw.clients) {
    saveMcpConfig(config, activePath);
  }

  return { config, configPath: activePath };
}

/**
 * Save MCP configuration to the specified path.
 */
export function saveMcpConfig(config: McpConfig, targetPath: string): void {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const serialized = JSON.stringify(config, null, 2) + '\n';
  fs.writeFileSync(targetPath, serialized, 'utf8');
}

/**
 * Check whether AI access is currently paused.
 */
export function isAiAccessPaused(preferredDir?: string): boolean {
  try {
    const { activePath, isExisting } = resolveMcpConfigPath(preferredDir);
    if (!isExisting) return false;
    const text = fs.readFileSync(activePath, 'utf8');
    const parsed = JSON.parse(text);
    return Boolean(parsed.aiAccessPaused);
  } catch {
    return false;
  }
}

/**
 * Update the AI access paused flag in mcp-config.json.
 */
export function setAiAccessPaused(paused: boolean, preferredDir?: string): void {
  const { config, configPath } = loadMcpConfig(preferredDir);
  config.aiAccessPaused = paused;
  saveMcpConfig(config, configPath);
}

/**
 * Validates an incoming bearer token against configured clients and default token.
 * Updates lastUsedAt on successful match.
 */
export function validateClientToken(
  token: string,
  preferredDir?: string,
): { valid: boolean; clientName?: string; clientId?: string } {
  if (!token || typeof token !== 'string') {
    return { valid: false };
  }

  const { config, configPath } = loadMcpConfig(preferredDir);

  // Check named clients
  const matchedClient = config.clients.find((c) => c.token === token && !c.revoked);
  if (matchedClient) {
    matchedClient.lastUsedAt = Date.now();
    try {
      saveMcpConfig(config, configPath);
    } catch {
      // Ignore write errors during request
    }
    return { valid: true, clientName: matchedClient.name, clientId: matchedClient.id };
  }

  // Fallback check against default clientToken
  if (token === config.clientToken) {
    return { valid: true, clientName: 'Default Connection', clientId: 'default' };
  }

  return { valid: false };
}

/**
 * Create a new named client connection.
 */
export function createNamedClient(name: string, preferredDir?: string): McpClientCredential {
  const { config, configPath } = loadMcpConfig(preferredDir);
  const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + crypto.randomBytes(4).toString('hex');
  const newClient: McpClientCredential = {
    id,
    name: name.trim() || 'Custom Connection',
    token: generateRandomToken(),
    createdAt: Date.now(),
    lastUsedAt: null,
    revoked: false,
  };
  config.clients.push(newClient);
  saveMcpConfig(config, configPath);
  return newClient;
}

/**
 * Rotate token for an existing client connection.
 */
export function rotateClientToken(id: string, preferredDir?: string): McpClientCredential | null {
  const { config, configPath } = loadMcpConfig(preferredDir);
  const client = config.clients.find((c) => c.id === id);
  if (!client) return null;

  client.token = generateRandomToken();
  client.revoked = false;
  saveMcpConfig(config, configPath);
  return client;
}

/**
 * Revoke an existing client connection.
 */
export function revokeClientToken(id: string, preferredDir?: string): boolean {
  const { config, configPath } = loadMcpConfig(preferredDir);
  const client = config.clients.find((c) => c.id === id);
  if (!client) return false;

  client.revoked = true;
  saveMcpConfig(config, configPath);
  return true;
}
