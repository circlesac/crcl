#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"
import pkg from "../package.json"

const VERSION = pkg.version || "0.0.0"

// ── Config ──────────────────────────────────────────────────────────────────

function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME
  return join(xdg || join(homedir(), ".config"), "crcl")
}
function configFile() {
  return join(configDir(), "config.json")
}

const DEFAULT_API_URL = "https://api.circles.ac"
const DEFAULT_AUTH_URL = "https://auth.circles.ac"
const CLIENT_ID = "circles-api"

export type OrgEntry = {
  slug: string
  api_key?: string
  default?: boolean
}

type StoredConfig = {
  api_url?: string
  auth_url?: string
  access_token?: string
  refresh_token?: string
  orgs?: Record<string, OrgEntry> // keyed by org_id
}

export type Config = {
  api_url: string
  auth_url: string
  access_token: string | null
  refresh_token: string | null
  orgs: Record<string, OrgEntry>
}

type UserMe = {
  id: number
  email: string
  name: string
  orgs: Array<{ id: number; slug: string; name: string; role: string }>
}

type ApiKey = {
  id: string
  name: string
  masked_key: string
  created_at: string
}

function loadConfig(args: string[]): Config {
  let stored: StoredConfig = {}
  if (existsSync(configFile())) {
    try {
      stored = JSON.parse(readFileSync(configFile(), "utf-8"))
    } catch {
      console.error(`Config file corrupted: ${configFile()}`)
      console.error("Run 'crcl logout' to reset, or fix the file manually.")
      process.exit(1)
    }
  }

  const config: Config = {
    api_url: process.env.CRCL_API_URL || stored.api_url || DEFAULT_API_URL,
    auth_url: process.env.CRCL_AUTH_URL || stored.auth_url || DEFAULT_AUTH_URL,
    access_token: process.env.CRCL_AUTH_TOKEN || stored.access_token || null,
    refresh_token: stored.refresh_token || null,
    orgs: stored.orgs || {},
  }

  function overrideOrg(slug: string, key: string) {
    for (const entry of Object.values(config.orgs)) entry.default = false
    const match = Object.entries(config.orgs).find(([_, e]) => e.slug === slug)
    if (match) {
      match[1].default = true
    } else {
      config.orgs[key] = { slug, default: true }
    }
  }

  // CRCL_ORG env overrides default org
  if (process.env.CRCL_ORG) overrideOrg(process.env.CRCL_ORG, "_env")

  // --org flag takes highest priority
  const orgFlag = getFlagValue(args, "--org")
  if (orgFlag) overrideOrg(orgFlag, "_flag")

  return config
}

function saveConfig(update: Partial<StoredConfig>) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 })
  let existing: StoredConfig = {}
  if (existsSync(configFile())) {
    try {
      existing = JSON.parse(readFileSync(configFile(), "utf-8"))
    } catch {
      // Config corrupted — overwrite with update only
    }
  }
  writeFileSync(configFile(), JSON.stringify({ ...existing, ...update }, null, 2) + "\n", { mode: 0o600 })
}

export function getDefaultOrg(config: Config): { id: string; entry: OrgEntry } | null {
  const match = Object.entries(config.orgs).find(([_, e]) => e.default)
  return match ? { id: match[0], entry: match[1] } : null
}

function setDefaultOrg(config: Config, orgId: string) {
  const orgs = { ...config.orgs }
  for (const [id, entry] of Object.entries(orgs)) {
    orgs[id] = { ...entry, default: id === orgId }
  }
  saveConfig({ orgs })
}

// ── API Client ──────────────────────────────────────────────────────────────

async function refreshAccessToken(config: Config): Promise<string | null> {
  if (!config.refresh_token) return null

  const res = await fetch(`${config.auth_url}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: config.refresh_token,
    }),
  })

  if (!res.ok) return null

  const data = (await res.json()) as { access_token: string; refresh_token: string }
  saveConfig({ access_token: data.access_token, refresh_token: data.refresh_token })
  config.access_token = data.access_token
  config.refresh_token = data.refresh_token
  return data.access_token
}

async function api<T = unknown>(
  config: Config,
  path: string,
  opts: { method?: string; body?: unknown; noExit?: boolean } = {}
): Promise<{ data: T; status: number }> {
  const url = `${config.api_url}${path}`
  const headers: Record<string, string> = {}

  if (config.access_token) {
    headers["Authorization"] = `Bearer ${config.access_token}`
  }
  if (opts.body) {
    headers["Content-Type"] = "application/json"
  }

  const doFetch = () =>
    fetch(url, {
      method: opts.method || "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    })

  let res = await doFetch()

  // Auto-refresh on 401
  if (res.status === 401 && config.refresh_token) {
    const newToken = await refreshAccessToken(config)
    if (newToken) {
      headers["Authorization"] = `Bearer ${newToken}`
      res = await doFetch()
    }
  }

  if (!res.ok) {
    if (opts.noExit) return { data: undefined as T, status: res.status }
    const text = await res.text()
    let message: string
    try {
      message = JSON.parse(text).message || text
    } catch {
      message = text
    }
    console.error(`Error ${res.status}: ${message}`)
    process.exit(1)
  }

  if (res.status === 204) return { data: undefined as T, status: 204 }
  return { data: (await res.json()) as T, status: res.status }
}

function requireAuth(config: Config): asserts config is Config & { access_token: string } {
  if (!config.access_token) {
    console.error("Not authenticated. Run: crcl login")
    process.exit(1)
  }
}

function orgPath(slug: string, ...segments: string[]) {
  return `/orgs/${encodeURIComponent(slug)}${segments.length ? "/" + segments.map(encodeURIComponent).join("/") : ""}`
}

// ── Org Resolution ──────────────────────────────────────────────────────────

async function resolveOrg(config: Config): Promise<{ org_id: string; org_slug: string }> {
  requireAuth(config)

  const current = getDefaultOrg(config)
  if (!current) {
    console.error("No org selected. Run: crcl orgs switch <slug>")
    process.exit(1)
  }

  // Try with stored slug first
  const { status } = await api(config, orgPath(current.entry.slug, "api_keys"), { noExit: true })
  if (status === 401) {
    console.error("Session expired. Run: crcl login")
    process.exit(1)
  }
  if (status >= 200 && status < 400) {
    return { org_id: current.id, org_slug: current.entry.slug }
  }
  if (status !== 404) {
    console.error(`Unexpected error (${status}) resolving org.`)
    process.exit(1)
  }

  // Slug failed (404) — refresh from /users/me
  const { data: me } = await api<UserMe>(config, "/users/me")

  // Find by org_id
  const org = me.orgs.find((o) => String(o.id) === current.id)
  if (org) {
    const orgs = { ...config.orgs }
    orgs[current.id] = { ...current.entry, slug: org.slug }
    saveConfig({ orgs })
    console.error(`Org slug updated: ${current.entry.slug} → ${org.slug}`)
    return { org_id: current.id, org_slug: org.slug }
  }

  // Find by slug (from --org flag)
  const bySlug = me.orgs.find((o) => o.slug === current.entry.slug)
  if (bySlug) {
    const orgs = { ...config.orgs }
    delete orgs[current.id]
    orgs[String(bySlug.id)] = { ...current.entry, slug: bySlug.slug }
    saveConfig({ orgs })
    return { org_id: String(bySlug.id), org_slug: bySlug.slug }
  }

  console.error("Organization not found or you don't have access.")
  process.exit(1)
}

// ── Login ───────────────────────────────────────────────────────────────────

async function cmdLogin(config: Config) {
  const state = randomBytes(16).toString("hex")
  const { port, waitForCode } = await startCallbackServer(state)
  const redirectUri = `http://localhost:${port}/callback`

  const authUrl = new URL(`${config.auth_url}/authorize`)
  authUrl.searchParams.set("client_id", CLIENT_ID)
  authUrl.searchParams.set("redirect_uri", redirectUri)
  authUrl.searchParams.set("response_type", "code")
  authUrl.searchParams.set("provider", "google")
  authUrl.searchParams.set("state", state)

  console.log("Opening browser for authentication...")
  console.log(`If it doesn't open, visit: ${authUrl}`)
  openBrowser(authUrl.toString())

  const code = await waitForCode

  const tokenRes = await fetch(`${config.auth_url}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: redirectUri,
    }),
  })

  if (!tokenRes.ok) {
    console.error("Failed to exchange authorization code")
    process.exit(1)
  }

  const tokenData = (await tokenRes.json()) as { access_token: string; refresh_token: string }

  // Fetch user info
  const authedConfig: Config = { ...config, access_token: tokenData.access_token }
  const { data: me } = await api<UserMe>(authedConfig, "/users/me")

  console.log(`\nAuthenticated as ${me.name || me.email}`)

  // Build orgs map from user's orgs
  const orgs: Record<string, OrgEntry> = {}
  const current = getDefaultOrg(config)
  const requestedSlug = current?.entry.slug

  for (const o of me.orgs) {
    const existing = config.orgs[String(o.id)]
    orgs[String(o.id)] = {
      slug: o.slug,
      ...(existing?.api_key ? { api_key: existing.api_key } : {}),
    }
  }

  // Set default org
  if (requestedSlug) {
    const match = Object.entries(orgs).find(([_, e]) => e.slug === requestedSlug)
    if (match) {
      match[1].default = true
      console.log(`Using org: ${match[1].slug}`)
    } else {
      console.error(`Org '${requestedSlug}' not found.`)
      if (me.orgs.length > 0) {
        const firstOrgId = String(me.orgs[0].id)
        orgs[firstOrgId] = { ...orgs[firstOrgId], default: true }
        console.log(`Using org: ${me.orgs[0].slug}`)
      }
    }
  } else if (me.orgs.length > 0) {
    console.log("\nYour organizations:")
    for (const o of me.orgs) {
      console.log(`  ${o.slug} (${o.name}) [${o.role}]`)
    }
    const firstOrgId = String(me.orgs[0].id)
    orgs[firstOrgId] = { ...orgs[firstOrgId], default: true }
    console.log(`\nUsing org: ${me.orgs[0].slug}`)
  } else {
    console.log("\nNo organizations found. Create one with: crcl orgs create <slug> <name>")
  }

  saveConfig({
    api_url: config.api_url,
    auth_url: config.auth_url,
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    orgs,
  })

  console.log(`Config saved to ${configFile()}`)
}

function startCallbackServer(expectedState: string): Promise<{ port: number; waitForCode: Promise<string> }> {
  return new Promise((resolveServer) => {
    let resolveCode: (code: string) => void
    let rejectCode: (err: Error) => void

    const waitForCode = new Promise<string>((resolve, reject) => {
      resolveCode = resolve
      rejectCode = reject
    })

    const server = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost`)
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code")
        const state = url.searchParams.get("state")
        if (state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/plain" })
          res.end("Invalid state parameter")
          rejectCode(new Error("OAuth state mismatch — possible CSRF attack"))
          setTimeout(() => server.close(), 500)
        } else if (code) {
          res.writeHead(200, { "Content-Type": "text/html" })
          res.end("<html><body><h2>Authentication successful!</h2><p>You can close this window.</p></body></html>")
          resolveCode(code)
          setTimeout(() => server.close(), 500)
        } else {
          res.writeHead(400, { "Content-Type": "text/plain" })
          res.end("Missing authorization code")
        }
      }
    })

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      resolveServer({ port, waitForCode })
    })
  })
}

function openBrowser(url: string) {
  if (process.platform === "darwin") {
    Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" })
  } else if (process.platform === "win32") {
    Bun.spawn(["cmd", "/c", "start", "", url], { stdout: "ignore", stderr: "ignore" })
  } else {
    Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" })
  }
}

// ── Orgs ────────────────────────────────────────────────────────────────────

async function cmdOrgsList(config: Config) {
  requireAuth(config)

  const { data: me } = await api<UserMe>(config, "/users/me")

  if (me.orgs.length === 0) {
    console.log("No organizations found.")
    return
  }

  const current = getDefaultOrg(config)

  console.log(`${"Slug".padEnd(24)} ${"Name".padEnd(30)} Role`)
  console.log("─".repeat(64))
  for (const o of me.orgs) {
    const marker = current && String(o.id) === current.id ? " *" : ""
    console.log(`${o.slug.padEnd(24)} ${o.name.padEnd(30)} ${o.role}${marker}`)
  }
}

async function cmdOrgsCreate(config: Config, args: string[]) {
  requireAuth(config)

  const slug = args[0]
  const name = args.slice(1).join(" ") || slug
  if (!slug) {
    console.error("Usage: crcl orgs create <slug> [name]")
    process.exit(1)
  }

  const { data: org } = await api<{ id: number; slug: string; name: string }>(
    config,
    "/orgs/new",
    { method: "POST", body: { slug, name } }
  )

  console.log(`Organization created: ${org.slug} (${org.name})`)

  // Add to orgs and set as default
  config.orgs[String(org.id)] = { slug: org.slug }
  setDefaultOrg(config, String(org.id))
  console.log(`Set as current org: ${org.slug}`)
}

async function cmdOrgsSwitch(config: Config, args: string[]) {
  requireAuth(config)

  const slug = args[0]
  if (!slug) {
    console.error("Usage: crcl orgs switch <slug>")
    process.exit(1)
  }

  // Check locally first
  const local = Object.entries(config.orgs).find(([_, e]) => e.slug === slug)
  if (local) {
    setDefaultOrg(config, local[0])
    console.log(`Switched to org: ${slug}`)
    return
  }

  // Not found locally — check server
  const { data: me } = await api<UserMe>(config, "/users/me")
  const org = me.orgs.find((o) => o.slug === slug)

  if (!org) {
    console.error(`Org '${slug}' not found. Your orgs:`)
    for (const o of me.orgs) console.error(`  ${o.slug}`)
    process.exit(1)
  }

  config.orgs[String(org.id)] = { ...(config.orgs[String(org.id)] || {}), slug: org.slug }
  setDefaultOrg(config, String(org.id))
  console.log(`Switched to org: ${org.slug} (${org.name})`)
}

// ── API Keys ────────────────────────────────────────────────────────────────

async function cmdApikeysList(config: Config) {
  const { org_slug } = await resolveOrg(config)

  const { data: keys } = await api<ApiKey[]>(
    config,
    orgPath(org_slug, "api_keys")
  )

  if (keys.length === 0) {
    console.log("No API keys found.")
    return
  }

  console.log(`${"ID".padEnd(12)} ${"Name".padEnd(30)} ${"Key".padEnd(18)} Created`)
  console.log("─".repeat(80))
  for (const k of keys) {
    const date = new Date(k.created_at).toLocaleDateString()
    console.log(`${k.id.padEnd(12)} ${k.name.padEnd(30)} ${k.masked_key.padEnd(18)} ${date}`)
  }
}

async function cmdApikeysCreate(config: Config, args: string[]) {
  const { org_id, org_slug } = await resolveOrg(config)
  const force = args.includes("--force") || args.includes("-y")
  const cleanArgs = args.filter((a) => a !== "--force" && a !== "-y")
  const name = cleanArgs.join(" ") || `crcl-${new Date().toISOString().slice(0, 10)}`

  // Check for existing keys
  const { data: existing } = await api<ApiKey[]>(
    config,
    orgPath(org_slug, "api_keys")
  )

  if (existing.length > 0 && !force) {
    console.error(`API key already exists for org '${org_slug}':`)
    for (const k of existing) {
      console.error(`  ${k.id}  ${k.name}  ${k.masked_key}`)
    }
    console.error(`\nUse --force or -y to delete existing key(s) and create a new one.`)
    process.exit(1)
  }

  // Delete existing keys if --force
  if (existing.length > 0 && force) {
    for (const k of existing) {
      await api(config, orgPath(org_slug, "api_keys", k.id), { method: "DELETE" })
    }
    console.log(`Deleted ${existing.length} existing key(s).`)
  }

  const { data: key } = await api<{ id: string; key: string; name: string; created_at: string }>(
    config,
    orgPath(org_slug, "api_keys"),
    { method: "POST", body: { name } }
  )

  // Cache api_key in orgs map
  const orgs = { ...config.orgs }
  orgs[org_id] = { ...orgs[org_id], api_key: key.key }
  saveConfig({ orgs })

  console.log(`API key created:`)
  console.log(`  ID:   ${key.id}`)
  console.log(`  Name: ${key.name}`)
  console.log(`  Key:  ${key.key}`)
  console.log(`\nSave this key — it won't be shown again.`)
}

async function cmdApikeysDelete(config: Config, args: string[]) {
  const keyId = args[0]
  if (!keyId) {
    console.error("Usage: crcl apikeys delete <key_id>")
    process.exit(1)
  }

  const { org_id, org_slug } = await resolveOrg(config)

  await api(config, orgPath(org_slug, "api_keys", keyId), { method: "DELETE" })

  // Clear cached api_key for this org
  const orgEntry = config.orgs[org_id]
  if (orgEntry?.api_key) {
    const orgs = { ...config.orgs }
    const { api_key: _, ...rest } = orgEntry
    orgs[org_id] = rest
    saveConfig({ orgs })
  }

  console.log(`API key ${keyId} deleted.`)
}

// ── Whoami ──────────────────────────────────────────────────────────────────

async function cmdWhoami(config: Config) {
  requireAuth(config)

  const { data: me } = await api<UserMe>(config, "/users/me")
  const current = getDefaultOrg(config)

  console.log(`User:  ${me.name || me.email}`)
  console.log(`Email: ${me.email}`)
  if (current) console.log(`Org:   ${current.entry.slug}`)
  if (me.orgs.length > 0) {
    console.log(`Orgs:  ${me.orgs.map((o) => o.slug).join(", ")}`)
  }
}

// ── Logout ──────────────────────────────────────────────────────────────────

function cmdLogout() {
  if (existsSync(configFile())) {
    let existing: StoredConfig = {}
    try {
      existing = JSON.parse(readFileSync(configFile(), "utf-8"))
    } catch {
      // corrupted — just wipe
    }
    const { access_token, refresh_token, orgs, ...rest } = existing
    writeFileSync(configFile(), JSON.stringify(rest, null, 2) + "\n", { mode: 0o600 })
    console.log("Logged out. Config cleared.")
  } else {
    console.log("Not logged in.")
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1 || idx + 1 >= args.length) return undefined
  return args[idx + 1]
}

export function stripFlags(args: string[], flags: string[]): string[] {
  const result: string[] = []
  let i = 0
  while (i < args.length) {
    if (flags.includes(args[i]) && i + 1 < args.length) {
      i += 2 // skip flag and value
    } else {
      result.push(args[i])
      i++
    }
  }
  return result
}

// ── Main ────────────────────────────────────────────────────────────────────

const HELP = `crcl — Circles CLI (${VERSION})

Usage: crcl <command> [args] [--org <slug>]

Commands:
  login [--org <slug>]       Authenticate via circles.ac
  logout                     Clear stored credentials
  whoami                     Show current user and org

  orgs list                  List your organizations
  orgs create <slug> [name]  Create a new organization
  orgs switch <slug>         Switch current organization

  apikeys list               List API keys for current org
  apikeys create [name] [-y]  Create a new API key
  apikeys delete <key_id>    Delete an API key

  version                    Show version
  help                       Show this help

Global flags:
  --org <slug>         Override current org for this command

Environment variables:
  CRCL_API_URL        API base URL (default: ${DEFAULT_API_URL})
  CRCL_AUTH_URL       Auth server URL (default: ${DEFAULT_AUTH_URL})
  CRCL_AUTH_TOKEN     Auth token (overrides config)
  CRCL_ORG            Organization slug (overrides config)

Config: $XDG_CONFIG_HOME/crcl/config.json (default: ~/.config/crcl/config.json)
`

export async function main() {
  const rawArgs = process.argv.slice(2)
  const positional = stripFlags(rawArgs, ["--org"])
  const command = positional[0]
  const subcommand = positional[1]

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP)
    return
  }

  if (command === "version" || command === "--version" || command === "-v") {
    console.log(VERSION)
    return
  }

  const config = loadConfig(rawArgs)
  const commandArgs = positional.slice(2)

  switch (command) {
    case "login":
      return cmdLogin(config)
    case "logout":
      return cmdLogout()
    case "whoami":
      return cmdWhoami(config)

    case "orgs":
      switch (subcommand) {
        case "create":
          return cmdOrgsCreate(config, commandArgs)
        case "switch":
          return cmdOrgsSwitch(config, commandArgs)
        case "list":
        case undefined:
          return cmdOrgsList(config)
        default:
          console.error(`Unknown subcommand: orgs ${subcommand}`)
          process.exit(1)
      }
      break

    case "apikeys":
      switch (subcommand) {
        case "create":
          return cmdApikeysCreate(config, commandArgs)
        case "delete":
          return cmdApikeysDelete(config, commandArgs)
        case "list":
        case undefined:
          return cmdApikeysList(config)
        default:
          console.error(`Unknown subcommand: apikeys ${subcommand}`)
          process.exit(1)
      }
      break

    default:
      console.error(`Unknown command: ${command}`)
      console.log(HELP)
      process.exit(1)
  }
}

// Only run when executed directly (not imported for testing)
if (import.meta.main) {
  main().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
