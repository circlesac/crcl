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
    // citty throws CLIError for validation failures
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

function writeTestConfig(config: Record<string, unknown>) {
  const dir = join(testHome, ".config", "crcl")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2))
}

function readTestConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(testHome, ".config", "crcl", "config.json"), "utf-8"))
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

function authedConfig(overrides: Record<string, unknown> = {}) {
  writeTestConfig({
    access_token: "test-token",
    orgs: { "10": { slug: "acme", default: true } },
    ...overrides,
  })
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

// ── Help & Version ────────────────────────────────────────────────────────

describe("help & version (meta)", () => {
  it("main command has correct metadata", async () => {
    const mod = await import("../src/index")
    expect(mod.main.meta?.name).toBe("crcl")
    expect(mod.main.meta?.version).toBe("0.0.0")
    expect(mod.main.subCommands).toHaveProperty("login")
    expect(mod.main.subCommands).toHaveProperty("orgs")
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

  it("logout with no config", async () => {
    const { stdout, exitCode } = await crcl(["logout"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Not logged in")
  })

  it("logout clears tokens", async () => {
    writeTestConfig({
      api_url: "https://api.circles.ac",
      auth_url: "https://auth.circles.ac",
      access_token: "test-token",
      refresh_token: "test-refresh",
      orgs: { "1": { slug: "test", default: true } },
    })

    const { stdout, exitCode } = await crcl(["logout"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Logged out")

    const config = readTestConfig()
    expect(config.access_token).toBeUndefined()
    expect(config.refresh_token).toBeUndefined()
    expect(config.orgs).toBeUndefined()
    // api_url and auth_url should be preserved
    expect(config.api_url).toBe("https://api.circles.ac")
    expect(config.auth_url).toBe("https://auth.circles.ac")
  })

  it("respects CRCL_AUTH_TOKEN env", async () => {
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout, exitCode } = await crcl(["whoami"], { CRCL_AUTH_TOKEN: "env-token" })
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Test User")
  })
})

// ── Unknown commands ──────────────────────────────────────────────────────

describe("unknown commands", () => {
  it("rejects unknown command", async () => {
    const { exitCode } = await crcl(["foobar"])
    expect(exitCode).toBe(1)
  })

  it("rejects unknown orgs subcommand", async () => {
    writeTestConfig({ access_token: "test-token", orgs: {} })
    const { exitCode } = await crcl(["orgs", "foobar"])
    expect(exitCode).toBe(1)
  })

  it("rejects unknown apikeys subcommand", async () => {
    writeTestConfig({ access_token: "test-token", orgs: {} })
    const { exitCode } = await crcl(["apikeys", "foobar"])
    expect(exitCode).toBe(1)
  })
})

// ── Orgs (offline) ────────────────────────────────────────────────────────

describe("orgs (offline)", () => {
  it("orgs list requires auth", async () => {
    const { stderr, exitCode } = await crcl(["orgs", "list"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Not authenticated")
  })

  it("orgs create requires auth", async () => {
    const { stderr, exitCode } = await crcl(["orgs", "create", "test"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Not authenticated")
  })

  it("orgs create requires slug", async () => {
    writeTestConfig({ access_token: "test-token", orgs: {} })
    const { exitCode } = await crcl(["orgs", "create"])
    expect(exitCode).toBe(1)
  })

  it("orgs switch requires auth", async () => {
    const { stderr, exitCode } = await crcl(["orgs", "switch", "test"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Not authenticated")
  })

  it("orgs switch requires slug", async () => {
    writeTestConfig({ access_token: "test-token", orgs: {} })
    const { exitCode } = await crcl(["orgs", "switch"])
    expect(exitCode).toBe(1)
  })

  it("orgs switch finds local org", async () => {
    writeTestConfig({
      access_token: "test-token",
      orgs: {
        "1": { slug: "org-a", default: true },
        "2": { slug: "org-b" },
      },
    })
    const { stdout, exitCode } = await crcl(["orgs", "switch", "org-b"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Switched to org: org-b")

    const config = readTestConfig() as { orgs: Record<string, { default?: boolean }> }
    expect(config.orgs["1"].default).toBe(false)
    expect(config.orgs["2"].default).toBe(true)
  })
})

// ── API Keys (offline) ───────────────────────────────────────────────────

describe("apikeys (offline)", () => {
  it("apikeys list requires auth", async () => {
    const { stderr, exitCode } = await crcl(["apikeys", "list"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Not authenticated")
  })

  it("apikeys delete requires key_id", async () => {
    writeTestConfig({
      access_token: "test-token",
      orgs: { "1": { slug: "test", default: true } },
    })
    const { exitCode } = await crcl(["apikeys", "delete"])
    expect(exitCode).toBe(1)
  })

  it("apikeys requires org selected", async () => {
    writeTestConfig({
      access_token: "test-token",
      orgs: { "1": { slug: "test" } },
    })
    const { stderr, exitCode } = await crcl(["apikeys", "list"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("No org selected")
  })
})

// ── Config & Flags ────────────────────────────────────────────────────────

describe("config and flags", () => {
  it("--org flag overrides default org", async () => {
    writeTestConfig({
      access_token: "test-token",
      orgs: {
        "1": { slug: "org-a", default: true },
        "2": { slug: "org-b" },
      },
    })
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout, exitCode } = await crcl(["whoami", "--org", "org-b"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Test User")
  })

  it("CRCL_ORG env overrides default org", async () => {
    writeTestConfig({
      access_token: "test-token",
      orgs: { "1": { slug: "org-a", default: true } },
    })
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout, exitCode } = await crcl(["whoami"], { CRCL_ORG: "org-b" })
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Test User")
  })

  it("handles corrupted config file", async () => {
    const dir = join(testHome, ".config", "crcl")
    writeFileSync(join(dir, "config.json"), "NOT JSON{{{")
    const { stderr, exitCode } = await crcl(["whoami"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Config file corrupted")
  })

  it("XDG_CONFIG_HOME overrides default config path", async () => {
    const xdgHome = join(testHome, "xdg-config")
    mkdirSync(join(xdgHome, "crcl"), { recursive: true })
    writeFileSync(
      join(xdgHome, "crcl", "config.json"),
      JSON.stringify({ access_token: "xdg-token", orgs: {} })
    )
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout, exitCode } = await crcl(["whoami"], { XDG_CONFIG_HOME: xdgHome })
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Test User")
  })
})

// ── Whoami (mocked) ──────────────────────────────────────────────────────

describe("whoami", () => {
  it("shows user info", async () => {
    authedConfig()
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout, exitCode } = await crcl(["whoami"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Test User")
    expect(stdout).toContain("test@circles.ac")
    expect(stdout).toContain("acme")
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

    const config = readTestConfig() as { orgs: Record<string, { slug: string; default?: boolean }> }
    expect(config.orgs["30"].slug).toBe("new-org")
    expect(config.orgs["30"].default).toBe(true)
    expect(config.orgs["10"].default).toBe(false)
  })

  it("orgs switch fetches from server when not local", async () => {
    authedConfig()
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout, exitCode } = await crcl(["orgs", "switch", "beta"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Switched to org: beta")

    const config = readTestConfig() as { orgs: Record<string, { slug: string; default?: boolean }> }
    expect(config.orgs["20"].default).toBe(true)
    expect(config.orgs["10"].default).toBe(false)
  })

  it("orgs switch rejects unknown slug", async () => {
    authedConfig()
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stderr, exitCode } = await crcl(["orgs", "switch", "nonexistent"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("not found")
  })
})

// ── API Keys (mocked) ────────────────────────────────────────────────────

describe("apikeys (mocked)", () => {
  it("apikeys list shows keys", async () => {
    authedConfig()
    mockFetch({ "GET /orgs/acme/api_keys": { status: 200, body: API_KEYS_RESPONSE } })
    const { stdout, exitCode } = await crcl(["apikeys", "list"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("k1")
    expect(stdout).toContain("dev-key")
    expect(stdout).toContain("sk_...abc")
  })

  it("apikeys list shows empty message", async () => {
    authedConfig()
    mockFetch({ "GET /orgs/acme/api_keys": { status: 200, body: [] } })
    const { stdout, exitCode } = await crcl(["apikeys", "list"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("No API keys found")
  })

  it("apikeys create without existing keys", async () => {
    authedConfig()
    mockFetch({
      "GET /orgs/acme/api_keys": { status: 200, body: [] },
      "POST /orgs/acme/api_keys": { status: 200, body: { id: "k2", key: "sk_full_key", name: "my-key", created_at: "2025-01-01T00:00:00Z" } },
    })
    const { stdout, exitCode } = await crcl(["apikeys", "create", "my-key"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("API key created")
    expect(stdout).toContain("sk_full_key")
    expect(stdout).toContain("Save this key")

    const config = readTestConfig() as { orgs: Record<string, { api_key?: string }> }
    expect(config.orgs["10"].api_key).toBe("sk_full_key")
  })

  it("apikeys create blocks when key exists", async () => {
    authedConfig()
    mockFetch({ "GET /orgs/acme/api_keys": { status: 200, body: API_KEYS_RESPONSE } })
    const { stderr, exitCode } = await crcl(["apikeys", "create"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("API key already exists")
    expect(stderr).toContain("--force")
  })

  it("apikeys create --force deletes existing and creates new", async () => {
    authedConfig()
    mockFetch({
      "GET /orgs/acme/api_keys": { status: 200, body: API_KEYS_RESPONSE },
      "DELETE /orgs/acme/api_keys/k1": { status: 204 },
      "POST /orgs/acme/api_keys": { status: 200, body: { id: "k3", key: "sk_new", name: "forced", created_at: "2025-06-01T00:00:00Z" } },
    })
    const { stdout, exitCode } = await crcl(["apikeys", "create", "--force"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Deleted 1 existing key(s)")
    expect(stdout).toContain("sk_new")
  })

  it("apikeys create -y shorthand works", async () => {
    authedConfig()
    mockFetch({
      "GET /orgs/acme/api_keys": { status: 200, body: API_KEYS_RESPONSE },
      "DELETE /orgs/acme/api_keys/k1": { status: 204 },
      "POST /orgs/acme/api_keys": { status: 200, body: { id: "k4", key: "sk_y", name: "y-key", created_at: "2025-06-01T00:00:00Z" } },
    })
    const { stdout, exitCode } = await crcl(["apikeys", "create", "-y"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("sk_y")
  })

  it("apikeys delete removes key and clears cache", async () => {
    authedConfig({ orgs: { "10": { slug: "acme", default: true, api_key: "cached_key" } } })
    mockFetch({
      "GET /orgs/acme/api_keys": { status: 200, body: API_KEYS_RESPONSE },
      "DELETE /orgs/acme/api_keys/k1": { status: 204 },
    })
    const { stdout, exitCode } = await crcl(["apikeys", "delete", "k1"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("API key k1 deleted")

    const config = readTestConfig() as { orgs: Record<string, { api_key?: string }> }
    expect(config.orgs["10"].api_key).toBeUndefined()
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

    const config = readTestConfig() as { access_token: string; refresh_token: string }
    expect(config.access_token).toBe("new-token")
    expect(config.refresh_token).toBe("new-refresh")
  })

  it("exits on expired session (refresh fails)", async () => {
    authedConfig({ refresh_token: "bad-refresh" })
    mockFetch({
      "POST /token": { status: 401, body: { message: "Invalid refresh token" } },
      "GET /orgs/acme/api_keys": { status: 401, body: { message: "Unauthorized" } },
    })
    const { stderr, exitCode } = await crcl(["apikeys", "list"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Session expired")
  })
})

// ── Error Handling ────────────────────────────────────────────────────────

describe("error handling", () => {
  it("resolveOrg handles unexpected server error", async () => {
    authedConfig()
    mockFetch({ "GET /orgs/acme/api_keys": { status: 500, body: { message: "Internal Server Error" } } })
    const { stderr, exitCode } = await crcl(["apikeys", "list"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Unexpected error (500)")
  })

  it("api shows error message from server", async () => {
    authedConfig()
    mockFetch({ "GET /users/me": { status: 403, body: { message: "Forbidden" } } })
    const { stderr, exitCode } = await crcl(["whoami"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Error 403: Forbidden")
  })

  it("api handles non-JSON error response", async () => {
    authedConfig()
    globalThis.fetch = vi.fn(async () => {
      return new Response("Bad Gateway", { status: 502, headers: { "Content-Type": "text/plain" } })
    }) as unknown as typeof fetch
    const { stderr, exitCode } = await crcl(["whoami"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Error 502")
  })
})
