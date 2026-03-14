#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"
import { defineCommand, runMain } from "citty"
import pkg from "../package.json"

const VERSION = pkg.version || "0.0.0"

// ── Config ──────────────────────────────────────────────────────────────────

function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME
  return join(xdg || join(process.env.HOME || homedir(), ".config"), "crcl")
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

type AccountEntry = {
  access_token?: string
  refresh_token?: string
  orgs?: Record<string, OrgEntry>
  default?: boolean
}

type StoredConfig = {
  api_url?: string
  auth_url?: string
  accounts?: Record<string, AccountEntry> // keyed by email
  // Legacy flat fields (pre-migration)
  access_token?: string
  refresh_token?: string
  orgs?: Record<string, OrgEntry>
}

export type Config = {
  api_url: string
  auth_url: string
  access_token: string | null
  refresh_token: string | null
  orgs: Record<string, OrgEntry>
  email: string | null
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

export function emailFromJwt(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())
    return payload.email || null
  } catch {
    return null
  }
}

function migrateConfig(stored: StoredConfig): StoredConfig {
  if (stored.accounts || !stored.access_token) return stored
  const email = emailFromJwt(stored.access_token) || "_unknown"
  const { access_token, refresh_token, orgs, ...rest } = stored
  const migrated: StoredConfig = {
    ...rest,
    accounts: {
      [email]: { access_token, refresh_token, orgs, default: true },
    },
  }
  writeFileSync(configFile(), JSON.stringify(migrated, null, 2) + "\n", { mode: 0o600 })
  return migrated
}

function getDefaultAccount(stored: StoredConfig): { email: string; account: AccountEntry } | null {
  if (!stored.accounts) return null
  const match = Object.entries(stored.accounts).find(([_, a]) => a.default)
  return match ? { email: match[0], account: match[1] } : null
}

function loadConfig(orgFlag?: string): Config {
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

  stored = migrateConfig(stored)
  const active = getDefaultAccount(stored)

  const config: Config = {
    api_url: process.env.CRCL_API_URL || stored.api_url || DEFAULT_API_URL,
    auth_url: process.env.CRCL_AUTH_URL || stored.auth_url || DEFAULT_AUTH_URL,
    access_token: process.env.CRCL_AUTH_TOKEN || active?.account.access_token || null,
    refresh_token: active?.account.refresh_token || null,
    orgs: active?.account.orgs || {},
    email: active?.email || null,
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
  if (orgFlag) overrideOrg(orgFlag, "_flag")

  return config
}

function readStoredConfig(): StoredConfig {
  if (existsSync(configFile())) {
    try {
      return JSON.parse(readFileSync(configFile(), "utf-8"))
    } catch {
      return {}
    }
  }
  return {}
}

function writeStoredConfig(config: StoredConfig) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 })
  writeFileSync(configFile(), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
}

function saveConfig(update: Partial<StoredConfig>) {
  const existing = readStoredConfig()
  writeStoredConfig({ ...existing, ...update })
}

function saveAccountConfig(email: string, update: Partial<AccountEntry>) {
  const existing = readStoredConfig()
  const accounts = existing.accounts || {}
  accounts[email] = { ...accounts[email], ...update }
  writeStoredConfig({ ...existing, accounts })
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
  if (config.email) {
    saveAccountConfig(config.email, { orgs })
  } else {
    saveConfig({ orgs })
  }
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
  if (config.email) {
    saveAccountConfig(config.email, { access_token: data.access_token, refresh_token: data.refresh_token })
  } else {
    saveConfig({ access_token: data.access_token, refresh_token: data.refresh_token })
  }
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
    if (config.email) saveAccountConfig(config.email, { orgs })
    else saveConfig({ orgs })
    console.error(`Org slug updated: ${current.entry.slug} → ${org.slug}`)
    return { org_id: current.id, org_slug: org.slug }
  }

  // Find by slug (from --org flag)
  const bySlug = me.orgs.find((o) => o.slug === current.entry.slug)
  if (bySlug) {
    const orgs = { ...config.orgs }
    delete orgs[current.id]
    orgs[String(bySlug.id)] = { ...current.entry, slug: bySlug.slug }
    if (config.email) saveAccountConfig(config.email, { orgs })
    else saveConfig({ orgs })
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

  // Save account keyed by email
  const existing = readStoredConfig()
  const accounts = existing.accounts || {}
  // Clear default from all accounts
  for (const a of Object.values(accounts)) a.default = false
  accounts[me.email] = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    orgs,
    default: true,
  }
  writeStoredConfig({
    api_url: config.api_url,
    auth_url: config.auth_url,
    accounts,
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
  if (config.email) saveAccountConfig(config.email, { orgs })
  else saveConfig({ orgs })

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
    if (config.email) saveAccountConfig(config.email, { orgs })
    else saveConfig({ orgs })
  }

  console.log(`API key ${keyId} deleted.`)
}

// ── Whoami ──────────────────────────────────────────────────────────────────

async function cmdWhoami(config: Config) {
  requireAuth(config)

  const { data: me } = await api<UserMe>(config, "/users/me")
  const current = getDefaultOrg(config)

  console.log(`User:    ${me.name || me.email}`)
  console.log(`Email:   ${me.email}`)
  if (config.email) console.log(`Account: ${config.email}`)
  if (current) console.log(`Org:     ${current.entry.slug}`)
  if (me.orgs.length > 0) {
    console.log(`Orgs:    ${me.orgs.map((o) => o.slug).join(", ")}`)
  }
}

// ── Logout ──────────────────────────────────────────────────────────────────

function cmdLogout(config: Config, opts: { all?: boolean }) {
  if (!existsSync(configFile())) {
    console.log("Not logged in.")
    return
  }

  const stored = readStoredConfig()

  if (opts.all) {
    // Remove all accounts
    writeStoredConfig({ api_url: stored.api_url, auth_url: stored.auth_url })
    console.log("Logged out of all accounts.")
    return
  }

  if (!stored.accounts || Object.keys(stored.accounts).length === 0) {
    writeStoredConfig({ api_url: stored.api_url, auth_url: stored.auth_url })
    console.log("Logged out.")
    return
  }

  // Remove current (default) account
  const email = config.email
  if (!email) {
    console.log("No active account.")
    return
  }

  delete stored.accounts[email]

  // If remaining accounts exist, promote the first one as default
  const remaining = Object.keys(stored.accounts)
  if (remaining.length > 0) {
    stored.accounts[remaining[0]].default = true
    console.log(`Logged out of ${email}. Switched to ${remaining[0]}.`)
  } else {
    console.log(`Logged out of ${email}.`)
  }

  writeStoredConfig(stored)
}

// ── Accounts ─────────────────────────────────────────────────────────────────

function cmdAccountsList(config: Config) {
  const stored = readStoredConfig()
  const accounts = stored.accounts || {}
  const emails = Object.keys(accounts)

  if (emails.length === 0) {
    console.log("No accounts. Run: crcl login")
    return
  }

  for (const email of emails) {
    const marker = accounts[email].default ? " *" : ""
    console.log(`${email}${marker}`)
  }
}

function cmdAccountsSwitch(config: Config, email: string) {
  const stored = readStoredConfig()
  const accounts = stored.accounts || {}

  if (!accounts[email]) {
    console.error(`Account '${email}' not found. Your accounts:`)
    for (const e of Object.keys(accounts)) console.error(`  ${e}`)
    process.exit(1)
  }

  for (const a of Object.values(accounts)) a.default = false
  accounts[email].default = true
  writeStoredConfig({ ...stored, accounts })
  console.log(`Switched to ${email}.`)
}

// ── Commands ─────────────────────────────────────────────────────────────────

const orgArg = {
  org: { type: "string" as const, description: "Override current org" },
}

const orgsCommand = defineCommand({
  meta: { name: "orgs", description: "Manage organizations" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List your organizations" },
      args: { ...orgArg },
      async run({ args }) { await cmdOrgsList(loadConfig(args.org)) },
    }),
    create: defineCommand({
      meta: { name: "create", description: "Create a new organization" },
      args: {
        ...orgArg,
        slug: { type: "positional" as const, description: "Organization slug", required: true },
        name: { type: "positional" as const, description: "Organization name", required: false },
      },
      async run({ args }) {
        await cmdOrgsCreate(loadConfig(args.org), [args.slug, args.name].filter(Boolean) as string[])
      },
    }),
    switch: defineCommand({
      meta: { name: "switch", description: "Switch current organization" },
      args: {
        ...orgArg,
        slug: { type: "positional" as const, description: "Organization slug", required: true },
      },
      async run({ args }) { await cmdOrgsSwitch(loadConfig(args.org), [args.slug]) },
    }),
  },
})

const accountsCommand = defineCommand({
  meta: { name: "accounts", description: "Manage authenticated accounts" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List authenticated accounts" },
      run() { cmdAccountsList(loadConfig()) },
    }),
    switch: defineCommand({
      meta: { name: "switch", description: "Switch active account" },
      args: {
        email: { type: "positional" as const, description: "Account email", required: true },
      },
      run({ args }) { cmdAccountsSwitch(loadConfig(), args.email) },
    }),
  },
})

const apikeysCommand = defineCommand({
  meta: { name: "apikeys", description: "Manage API keys" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List API keys for current org" },
      args: { ...orgArg },
      async run({ args }) { await cmdApikeysList(loadConfig(args.org)) },
    }),
    create: defineCommand({
      meta: { name: "create", description: "Create a new API key" },
      args: {
        ...orgArg,
        name: { type: "positional" as const, description: "Key name", required: false },
        force: { type: "boolean" as const, alias: "y", description: "Delete existing keys and create new" },
      },
      async run({ args }) {
        const cmdArgs = [args.name, args.force ? "--force" : ""].filter(Boolean) as string[]
        await cmdApikeysCreate(loadConfig(args.org), cmdArgs)
      },
    }),
    delete: defineCommand({
      meta: { name: "delete", description: "Delete an API key" },
      args: {
        ...orgArg,
        key_id: { type: "positional" as const, description: "API key ID", required: true },
      },
      async run({ args }) { await cmdApikeysDelete(loadConfig(args.org), [args.key_id]) },
    }),
  },
})

export const main = defineCommand({
  meta: {
    name: "crcl",
    version: VERSION,
    description: "Circles CLI — manage orgs, API keys, and authenticate with circles.ac",
  },
  subCommands: {
    login: defineCommand({
      meta: { name: "login", description: "Authenticate via circles.ac" },
      args: { ...orgArg },
      async run({ args }) { await cmdLogin(loadConfig(args.org)) },
    }),
    logout: defineCommand({
      meta: { name: "logout", description: "Clear stored credentials" },
      args: {
        all: { type: "boolean" as const, description: "Logout of all accounts" },
      },
      run({ args }) { cmdLogout(loadConfig(), { all: args.all }) },
    }),
    whoami: defineCommand({
      meta: { name: "whoami", description: "Show current user and org" },
      args: { ...orgArg },
      async run({ args }) { await cmdWhoami(loadConfig(args.org)) },
    }),
    orgs: orgsCommand,
    accounts: accountsCommand,
    apikeys: apikeysCommand,
  },
})

// Only run when executed directly (not imported for testing)
if (import.meta.main) {
  runMain(main)
}
