import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runCommand } from "citty"

const testHome = join(tmpdir(), `crcl-test-${process.pid}`)

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`)
  }
}

let logs: string[] = []
let errs: string[] = []
let savedFetch: typeof fetch

beforeEach(() => {
  mkdirSync(join(testHome, ".config", "crcl"), { recursive: true })
  process.env.HOME = testHome
  delete process.env.XDG_CONFIG_HOME

  logs = []
  errs = []
  savedFetch = globalThis.fetch
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.join(" "))
  })
  vi.spyOn(console, "error").mockImplementation((...args) => {
    errs.push(args.join(" "))
  })
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new ExitError(typeof code === "number" ? code : 1)
  })
})

afterEach(() => {
  globalThis.fetch = savedFetch
  vi.restoreAllMocks()
  if (existsSync(testHome)) {
    rmSync(testHome, { recursive: true, force: true })
  }
})

// ── Test Helpers ──────────────────────────────────────────────────────────

async function crcl(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const savedArgv = process.argv
  const savedEnv = { ...process.env }

  process.argv = ["bun", "crcl", ...args]
  Object.assign(process.env, env)

  try {
    const mod = await import("../src/index")
    await runCommand(mod.main, { rawArgs: args })
    return { stdout: logs.join("\n"), stderr: errs.join("\n"), exitCode: 0 }
  } catch (e) {
    if (e instanceof ExitError) {
      return { stdout: logs.join("\n"), stderr: errs.join("\n"), exitCode: e.code }
    }
    if (e instanceof Error && e.constructor.name === "CLIError") {
      return { stdout: logs.join("\n"), stderr: errs.join("\n"), exitCode: 1 }
    }
    throw e
  } finally {
    process.argv = savedArgv
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key]
    }
    Object.assign(process.env, savedEnv)
  }
}

function configPath() { return join(testHome, ".config", "crcl", "config") }
function credentialsPath() { return join(testHome, ".config", "crcl", "credentials") }

function writeConfig(ini: string) {
  writeFileSync(configPath(), ini)
}

function writeCredentials(ini: string) {
  writeFileSync(credentialsPath(), ini)
}

function readConfig(): string {
  return existsSync(configPath()) ? readFileSync(configPath(), "utf-8") : ""
}

function readCredentials(): string {
  return existsSync(credentialsPath()) ? readFileSync(credentialsPath(), "utf-8") : ""
}

function setupProfile(profile: string, opts: { org?: string; api_url?: string; auth_url?: string; token?: string; refresh?: string } = {}) {
  const token = opts.token || fakeJwt(`test-${profile}@circles.ac`)

  // Config
  const confLines: string[] = []
  if (opts.org) confLines.push(`org = ${opts.org}`)
  if (opts.api_url) confLines.push(`api_url = ${opts.api_url}`)
  if (opts.auth_url) confLines.push(`auth_url = ${opts.auth_url}`)

  const existingConfig = readConfig()
  const configSection = confLines.length > 0 ? `[${profile}]\n${confLines.join("\n")}\n` : ""
  writeConfig(existingConfig + configSection)

  // Credentials
  const existingCreds = readCredentials()
  writeCredentials(existingCreds + `[${profile}]\naccess_token = ${token}\n${opts.refresh ? `refresh_token = ${opts.refresh}\n` : ""}\n`)
}

type RouteHandler = { status: number; body?: unknown }
type RouteEntry = RouteHandler | RouteHandler[]

function mockFetch(routes: Record<string, RouteEntry>) {
  const callCounts: Record<string, number> = {}

  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method || "GET"

    for (const [pattern, handler] of Object.entries(routes)) {
      const [routeMethod, routePath] = pattern.includes(" ") ? pattern.split(" ", 2) : ["GET", pattern]
      if (method === routeMethod && url.includes(routePath!)) {
        let response: RouteHandler
        if (Array.isArray(handler)) {
          const count = callCounts[pattern] || 0
          response = handler[Math.min(count, handler.length - 1)]
          callCounts[pattern] = count + 1
        } else {
          response = handler
        }
        return new Response(
          response.body !== undefined ? JSON.stringify(response.body) : null,
          { status: response.status, headers: { "Content-Type": "application/json" } }
        )
      }
    }

    return new Response("Not Found", { status: 404 })
  }) as unknown as typeof fetch
}

function fakeJwt(email: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify({ email })).toString("base64url")
  return `${header}.${payload}.sig`
}

const TEST_TOKEN = fakeJwt("test@circles.ac")

function authedConfig(opts: { org?: string; refresh_token?: string } = {}) {
  setupProfile("default", { org: opts.org || "acme", token: TEST_TOKEN, refresh: opts.refresh_token })
}

// ── Fixtures ──────────────────────────────────────────────────────────────

const ME_RESPONSE = {
  id: 1,
  email: "test@circles.ac",
  name: "Test User",
  orgs: [
    { id: 10, slug: "acme", name: "Acme Corp", role: "owner" },
    { id: 20, slug: "beta", name: "Beta Inc", role: "member" },
  ],
}

const API_KEYS_RESPONSE = [
  { id: "k1", name: "dev-key", masked_key: "sk_...abc", created_at: "2025-01-01T00:00:00Z" },
]

const MEMBERS_RESPONSE = [
  { user_id: 1, email: "alice@circles.ac", name: "Alice", role: "owner", created_at: "2025-01-01T00:00:00Z" },
  { user_id: 2, email: "bob@circles.ac", name: "Bob", role: "member", created_at: "2025-02-01T00:00:00Z" },
]

// ── Help & Version ────────────────────────────────────────────────────────

describe("help & version (meta)", () => {
  it("main command has correct metadata", async () => {
    const mod = await import("../src/index")
    expect(mod.main.meta?.name).toBe("crcl")
    expect(mod.main.meta?.version).toBe("0.0.0")
    expect(mod.main.subCommands).toHaveProperty("login")
    expect(mod.main.subCommands).toHaveProperty("orgs")
    expect(mod.main.subCommands).toHaveProperty("members")
    expect(mod.main.subCommands).toHaveProperty("apikeys")
  })
})

// ── Auth ──────────────────────────────────────────────────────────────────

describe("auth", () => {
  it("whoami fails without auth", async () => {
    const { stderr, exitCode } = await crcl(["whoami"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Not authenticated")
  })

  it("logout removes profile", async () => {
    authedConfig()
    const { stdout, exitCode } = await crcl(["logout"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Logged out of profile 'default'")
    expect(readCredentials()).not.toContain("[default]")
  })

  it("logout --profile dev removes only dev", async () => {
    authedConfig()
    setupProfile("dev", { org: "acme", api_url: "https://api-dev.circles.ac" })

    const { stdout, exitCode } = await crcl(["logout", "--profile", "dev"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Logged out of profile 'dev'")

    // default still exists
    expect(readCredentials()).toContain("[default]")
    expect(readCredentials()).not.toContain("[dev]")
  })

  it("logout --all removes all profiles", async () => {
    authedConfig()
    setupProfile("dev", { org: "acme" })

    const { stdout, exitCode } = await crcl(["logout", "--all"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Logged out of all profiles")
  })

  it("respects CRCL_AUTH_TOKEN env", async () => {
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout, exitCode } = await crcl(["whoami"], { CRCL_AUTH_TOKEN: "env-token" })
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Test User")
  })
})

// ── Config & Flags ────────────────────────────────────────────────────────

describe("config and flags", () => {
  it("--org flag overrides default org", async () => {
    authedConfig()
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout, exitCode } = await crcl(["whoami", "--org", "beta"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Org:     beta")
  })

  it("CRCL_ORG env overrides default org", async () => {
    authedConfig()
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout, exitCode } = await crcl(["whoami"], { CRCL_ORG: "beta" })
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Org:     beta")
  })

  it("--profile selects a different profile", async () => {
    authedConfig()
    setupProfile("dev", { org: "acme", api_url: "https://api-dev.circles.ac" })
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })

    const { stdout, exitCode } = await crcl(["whoami", "--profile", "dev"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("API:     https://api-dev.circles.ac")
    expect(stdout).toContain("Profile: dev")
  })

  it("--profile rejects unknown profile", async () => {
    authedConfig()
    const { stderr, exitCode } = await crcl(["whoami", "--profile", "nope"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("not found")
  })

  it("XDG_CONFIG_HOME overrides default config path", async () => {
    const xdgHome = join(testHome, "xdg-config")
    mkdirSync(join(xdgHome, "crcl"), { recursive: true })
    writeFileSync(join(xdgHome, "crcl", "credentials"), `[default]\naccess_token = ${TEST_TOKEN}\n`)
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout, exitCode } = await crcl(["whoami"], { XDG_CONFIG_HOME: xdgHome })
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Test User")
  })
})

// ── Whoami ────────────────────────────────────────────────────────────────

describe("whoami", () => {
  it("shows user info", async () => {
    authedConfig()
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout, exitCode } = await crcl(["whoami"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Test User")
    expect(stdout).toContain("test@circles.ac")
    expect(stdout).toContain("Profile: default")
    expect(stdout).toContain("Org:     acme")
  })
})

// ── Orgs (mocked) ────────────────────────────────────────────────────────

describe("orgs (mocked)", () => {
  it("orgs list shows orgs with current marker", async () => {
    authedConfig()
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout, exitCode } = await crcl(["orgs", "list"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("acme")
    expect(stdout).toContain("beta")
    expect(stdout).toContain("*")
  })

  it("orgs list shows empty message", async () => {
    authedConfig()
    mockFetch({ "GET /users/me": { status: 200, body: { ...ME_RESPONSE, orgs: [] } } })
    const { stdout, exitCode } = await crcl(["orgs", "list"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("No organizations found")
  })

  it("orgs create creates and sets default", async () => {
    authedConfig()
    mockFetch({ "POST /orgs/new": { status: 200, body: { id: 30, slug: "new-org", name: "New Org" } } })
    const { stdout, exitCode } = await crcl(["orgs", "create", "new-org", "New Org"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Organization created: new-org")
    expect(stdout).toContain("Set as current org: new-org")
    expect(readConfig()).toContain("org = new-org")
  })

  it("orgs switch verifies on server", async () => {
    authedConfig()
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout, exitCode } = await crcl(["orgs", "switch", "beta"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Switched to org: beta")
    expect(readConfig()).toContain("org = beta")
  })

  it("orgs switch rejects unknown slug", async () => {
    authedConfig()
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stderr, exitCode } = await crcl(["orgs", "switch", "nonexistent"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("not found")
  })

  it("orgs update changes name", async () => {
    authedConfig()
    mockFetch({
      "PUT /orgs/acme": { status: 200, body: { id: 1, slug: "acme", name: "New Name" } },
    })
    const { stdout, exitCode } = await crcl(["orgs", "update", "--name", "New Name"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Organization updated")
  })

  it("orgs update changes slug and updates config", async () => {
    authedConfig()
    mockFetch({
      "PUT /orgs/acme": { status: 200, body: { id: 1, slug: "new-slug", name: "Acme" } },
    })
    const { stdout, exitCode } = await crcl(["orgs", "update", "--slug", "new-slug"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Local config updated")
    expect(readConfig()).toContain("org = new-slug")
  })

  it("orgs update requires --name or --slug", async () => {
    authedConfig()
    const { stderr, exitCode } = await crcl(["orgs", "update"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Nothing to update")
  })
})

// ── API Keys (mocked) ────────────────────────────────────────────────────

describe("apikeys (mocked)", () => {
  it("apikeys requires --user or --org", async () => {
    authedConfig()
    const { stderr, exitCode } = await crcl(["apikeys", "list"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("--user or --org")
  })

  it("apikeys list --org shows keys", async () => {
    authedConfig()
    mockFetch({ "GET /orgs/acme/api_keys": { status: 200, body: API_KEYS_RESPONSE } })
    const { stdout, exitCode } = await crcl(["apikeys", "list", "--org", "acme"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("k1")
    expect(stdout).toContain("dev-key")
  })

  it("apikeys create --org creates key", async () => {
    authedConfig()
    mockFetch({
      "GET /orgs/acme/api_keys": { status: 200, body: [] },
      "POST /orgs/acme/api_keys": { status: 200, body: { id: "k2", key: "sk_full_key", name: "my-key", created_at: "2025-01-01T00:00:00Z" } },
    })
    const { stdout, exitCode } = await crcl(["apikeys", "create", "--org", "acme", "my-key"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("API key created")
    expect(stdout).toContain("sk_full_key")
  })

  it("apikeys create --org blocks when key exists", async () => {
    authedConfig()
    mockFetch({ "GET /orgs/acme/api_keys": { status: 200, body: API_KEYS_RESPONSE } })
    const { stderr, exitCode } = await crcl(["apikeys", "create", "--org", "acme"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("--force")
  })

  it("apikeys create --org --force replaces existing", async () => {
    authedConfig()
    mockFetch({
      "GET /orgs/acme/api_keys": { status: 200, body: API_KEYS_RESPONSE },
      "DELETE /orgs/acme/api_keys/k1": { status: 204 },
      "POST /orgs/acme/api_keys": { status: 200, body: { id: "k3", key: "sk_new", name: "forced", created_at: "2025-06-01T00:00:00Z" } },
    })
    const { stdout, exitCode } = await crcl(["apikeys", "create", "--org", "acme", "--force"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("sk_new")
  })

  it("apikeys delete --org removes key", async () => {
    authedConfig()
    mockFetch({
      "DELETE /orgs/acme/api_keys/k1": { status: 204 },
    })
    const { stdout, exitCode } = await crcl(["apikeys", "delete", "--org", "acme", "k1"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("API key k1 deleted")
  })

  it("apikeys list --user lists user-level keys", async () => {
    authedConfig()
    mockFetch({ "GET /users/me/api_keys": { status: 200, body: [{ id: "uk1", name: "my-user-key", masked_key: "sk_...usr", created_at: "2025-01-01T00:00:00Z" }] } })
    const { stdout, exitCode } = await crcl(["apikeys", "list", "--user"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("uk1")
  })

  it("apikeys create --user creates user-level key", async () => {
    authedConfig()
    mockFetch({
      "GET /users/me/api_keys": { status: 200, body: [] },
      "POST /users/me/api_keys": { status: 200, body: { id: "uk2", key: "sk_user_full", name: "user-key", created_at: "2025-01-01T00:00:00Z" } },
    })
    const { stdout, exitCode } = await crcl(["apikeys", "create", "--user", "user-key"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("User API key created")
    expect(stdout).toContain("sk_user_full")
  })

  it("apikeys delete --user deletes user-level key", async () => {
    authedConfig()
    mockFetch({ "DELETE /users/me/api_keys/uk1": { status: 204 } })
    const { stdout, exitCode } = await crcl(["apikeys", "delete", "--user", "uk1"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("User API key uk1 deleted")
  })
})

// ── Members (mocked) ──────────────────────────────────────────────────────

describe("members (mocked)", () => {
  it("members list shows members", async () => {
    authedConfig()
    mockFetch({ "GET /orgs/acme/members": { status: 200, body: MEMBERS_RESPONSE } })
    const { stdout, exitCode } = await crcl(["members", "list"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("alice@circles.ac")
    expect(stdout).toContain("bob@circles.ac")
  })

  it("members list shows empty message", async () => {
    authedConfig()
    mockFetch({ "GET /orgs/acme/members": { status: 200, body: [] } })
    const { stdout, exitCode } = await crcl(["members", "list"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("No members found")
  })

  it("members add adds a member", async () => {
    authedConfig()
    mockFetch({
      "POST /orgs/acme/members": { status: 200, body: { user_id: 3, email: "carol@circles.ac", name: "Carol", role: "member", created_at: "2025-03-01T00:00:00Z" } },
    })
    const { stdout, exitCode } = await crcl(["members", "add", "carol@circles.ac"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Added carol@circles.ac as member")
  })

  it("members role changes role", async () => {
    authedConfig()
    mockFetch({
      "GET /orgs/acme/members": { status: 200, body: MEMBERS_RESPONSE },
      "PUT /orgs/acme/members/2": { status: 200, body: { ...MEMBERS_RESPONSE[1], role: "owner" } },
    })
    const { stdout, exitCode } = await crcl(["members", "role", "bob@circles.ac", "--role", "owner"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Updated bob@circles.ac to owner")
  })

  it("members remove removes a member", async () => {
    authedConfig()
    mockFetch({
      "GET /orgs/acme/members": { status: 200, body: MEMBERS_RESPONSE },
      "DELETE /orgs/acme/members/2": { status: 204 },
    })
    const { stdout, exitCode } = await crcl(["members", "remove", "bob@circles.ac"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Removed bob@circles.ac")
  })

  it("members role rejects unknown email", async () => {
    authedConfig()
    mockFetch({ "GET /orgs/acme/members": { status: 200, body: MEMBERS_RESPONSE } })
    const { stderr, exitCode } = await crcl(["members", "role", "nope@circles.ac", "--role", "owner"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("not found")
  })
})

// ── Token Refresh ─────────────────────────────────────────────────────────

describe("token refresh", () => {
  it("auto-refreshes on 401", async () => {
    authedConfig({ refresh_token: "old-refresh" })
    mockFetch({
      "POST /token": { status: 200, body: { access_token: "new-token", refresh_token: "new-refresh" } },
      "GET /users/me": [
        { status: 401, body: { message: "Unauthorized" } },
        { status: 200, body: ME_RESPONSE },
      ],
    })

    const { stdout, exitCode } = await crcl(["whoami"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Test User")

    const creds = readCredentials()
    expect(creds).toContain("new-token")
    expect(creds).toContain("new-refresh")
  })
})

// ── Profiles ──────────────────────────────────────────────────────────────

describe("profiles", () => {
  it("multiple profiles with different URLs", async () => {
    authedConfig()
    setupProfile("dev", { org: "acme", api_url: "https://api-dev.circles.ac" })

    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout: devOut } = await crcl(["whoami", "--profile", "dev"])
    expect(devOut).toContain("API:     https://api-dev.circles.ac")
    expect(devOut).toContain("Profile: dev")
  })

  it("CRCL_PROFILE env selects profile", async () => {
    authedConfig()
    setupProfile("dev", { org: "acme", api_url: "https://api-dev.circles.ac" })

    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout } = await crcl(["whoami"], { CRCL_PROFILE: "dev" })
    expect(stdout).toContain("Profile: dev")
  })
})

// ── INI format ───────────────────────────────────────────────────────────

describe("INI format", () => {
  it("config and credentials are separate files", async () => {
    authedConfig()
    expect(existsSync(configPath())).toBe(true)
    expect(existsSync(credentialsPath())).toBe(true)

    const config = readConfig()
    const creds = readCredentials()

    // Config should have org, not tokens
    expect(config).toContain("org = acme")
    expect(config).not.toContain("access_token")

    // Credentials should have tokens, not org
    expect(creds).toContain("access_token")
    expect(creds).not.toContain("org")
  })
})

// ── Config Migration ──────────────────────────────────────────────────────

describe("config migration", () => {
  it("migrates legacy config.json to INI files", async () => {
    // Write old-style config.json
    const dir = join(testHome, ".config", "crcl")
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      accounts: {
        "test@circles.ac [default]": {
          access_token: TEST_TOKEN,
          refresh_token: "old-refresh",
          api_url: "https://api-dev.circles.ac",
          orgs: { "1": { slug: "acme", default: true } },
        },
      },
    }))

    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout, exitCode } = await crcl(["whoami"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Test User")

    // Old file should be removed
    expect(existsSync(join(dir, "config.json"))).toBe(false)

    // New files should exist
    const config = readConfig()
    const creds = readCredentials()
    expect(config).toContain("api_url = https://api-dev.circles.ac")
    expect(config).toContain("org = acme")
    expect(creds).toContain("access_token")
  })
})

// ── emailFromJwt ──────────────────────────────────────────────────────────

describe("emailFromJwt", () => {
  it("extracts email from JWT", async () => {
    const mod = await import("../src/index")
    expect(mod.emailFromJwt(TEST_TOKEN)).toBe("test@circles.ac")
  })

  it("returns null for invalid JWT", async () => {
    const mod = await import("../src/index")
    expect(mod.emailFromJwt("not-a-jwt")).toBeNull()
  })
})

// ── Error Handling ────────────────────────────────────────────────────────

describe("error handling", () => {
  it("api shows error message from server", async () => {
    authedConfig()
    mockFetch({ "GET /users/me": { status: 403, body: { message: "Forbidden" } } })
    const { stderr, exitCode } = await crcl(["whoami"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Error 403: Forbidden")
  })
})
