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

const DEFAULT_API_URL = "https://api.circles.ac"
const DEFAULT_AUTH_URL = "https://auth.circles.ac"
const CLIENT_ID = "circles-api"

// ── INI parser/serializer ────────────────────────────────────────────────

type IniData = Record<string, Record<string, string>>

function parseIni(text: string): IniData {
  const data: IniData = {}
  let section = ""
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#") || line.startsWith(";")) continue
    const secMatch = line.match(/^\[(.+)\]$/)
    if (secMatch) {
      section = secMatch[1]
      if (!data[section]) data[section] = {}
      continue
    }
    const eqIdx = line.indexOf("=")
    if (eqIdx > 0 && section) {
      data[section][line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim()
    }
  }
  return data
}

function serializeIni(data: IniData): string {
  const sections = Object.entries(data).filter(([_, v]) => Object.keys(v).length > 0)
  return sections.map(([section, entries]) => {
    const lines = Object.entries(entries).map(([k, v]) => `${k} = ${v}`)
    return `[${section}]\n${lines.join("\n")}`
  }).join("\n\n") + "\n"
}

function readIniFile(path: string): IniData {
  if (existsSync(path)) {
    try { return parseIni(readFileSync(path, "utf-8")) } catch { /* ignore */ }
  }
  return {}
}

function writeIniFile(path: string, data: IniData) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 })
  writeFileSync(path, serializeIni(data), { mode: 0o600 })
}

// ── Config types ─────────────────────────────────────────────────────────

export type Config = {
  profile: string
  api_url: string
  auth_url: string
  access_token: string | null
  refresh_token: string | null
  org: string | null
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

type Member = {
  user_id: number
  email: string | null
  name: string | null
  role: string
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

// ── File paths ───────────────────────────────────────────────────────────

function configFilePath() { return join(configDir(), "config") }
function credentialsFilePath() { return join(configDir(), "credentials") }
function legacyConfigFile() { return join(configDir(), "config.json") }

// ── Migration from config.json ───────────────────────────────────────────

function migrateFromJson() {
  const jsonPath = legacyConfigFile()
  if (!existsSync(jsonPath)) return

  try {
    const old = JSON.parse(readFileSync(jsonPath, "utf-8"))
    const configData: IniData = {}
    const credsData: IniData = {}

    const accounts = old.accounts || {}
    for (const [key, entry] of Object.entries(accounts) as [string, any][]) {
      // Extract profile name from key like "email [profile]" or just "email"
      const profileMatch = key.match(/\[(.+?)\]$/)
      const profile = profileMatch ? profileMatch[1] : "default"

      // Config
      const conf: Record<string, string> = {}
      if (entry.api_url) conf.api_url = entry.api_url
      if (entry.auth_url) conf.auth_url = entry.auth_url
      // Find default org slug
      if (entry.orgs) {
        const defaultOrg = Object.values(entry.orgs as Record<string, any>).find((o: any) => o.default)
        if (defaultOrg) conf.org = defaultOrg.slug
      }
      if (Object.keys(conf).length > 0) configData[profile] = conf

      // Credentials
      const creds: Record<string, string> = {}
      if (entry.access_token) creds.access_token = entry.access_token
      if (entry.refresh_token) creds.refresh_token = entry.refresh_token
      if (Object.keys(creds).length > 0) credsData[profile] = creds
    }

    if (Object.keys(configData).length > 0) writeIniFile(configFilePath(), configData)
    if (Object.keys(credsData).length > 0) writeIniFile(credentialsFilePath(), credsData)

    // Remove old file
    const { unlinkSync } = require("node:fs")
    unlinkSync(jsonPath)
  } catch { /* ignore migration errors */ }
}

// ── Load / Save ──────────────────────────────────────────────────────────

type LoadConfigOpts = {
  org?: string
  profile?: string
  apiUrl?: string
  authUrl?: string
}

function loadConfig(opts: LoadConfigOpts = {}): Config {
  migrateFromJson()

  const profile = opts.profile || process.env.CRCL_PROFILE || "default"
  const configData = readIniFile(configFilePath())
  const credsData = readIniFile(credentialsFilePath())

  const section = configData[profile] || {}
  const creds = credsData[profile] || {}

  // Check if profile exists when explicitly specified
  if ((opts.profile || process.env.CRCL_PROFILE) && !configData[profile] && !credsData[profile]) {
    console.error(`Profile '${profile}' not found.`)
    process.exit(1)
  }

  const org = opts.org || process.env.CRCL_ORG || section.org || null

  return {
    profile,
    api_url: opts.apiUrl || process.env.CRCL_API_URL || section.api_url || DEFAULT_API_URL,
    auth_url: opts.authUrl || process.env.CRCL_AUTH_URL || section.auth_url || DEFAULT_AUTH_URL,
    access_token: process.env.CRCL_AUTH_TOKEN || creds.access_token || null,
    refresh_token: creds.refresh_token || null,
    org,
    email: creds.access_token ? emailFromJwt(creds.access_token) : null,
  }
}

function saveCredentials(profile: string, update: Record<string, string>) {
  const data = readIniFile(credentialsFilePath())
  data[profile] = { ...data[profile], ...update }
  writeIniFile(credentialsFilePath(), data)
}

function saveProfileConfig(profile: string, update: Record<string, string>) {
  const data = readIniFile(configFilePath())
  data[profile] = { ...data[profile], ...update }
  writeIniFile(configFilePath(), data)
}

function deleteProfile(profile: string) {
  const configData = readIniFile(configFilePath())
  const credsData = readIniFile(credentialsFilePath())
  delete configData[profile]
  delete credsData[profile]
  writeIniFile(configFilePath(), configData)
  writeIniFile(credentialsFilePath(), credsData)
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
  saveCredentials(config.profile, { access_token: data.access_token, refresh_token: data.refresh_token })
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

async function resolveOrg(config: Config): Promise<{ org_slug: string }> {
  requireAuth(config)

  if (!config.org) {
    console.error("No org selected. Run: crcl orgs switch <slug>")
    process.exit(1)
  }

  return { org_slug: config.org }
}

// ── Login ───────────────────────────────────────────────────────────────────

async function cmdLogin(config: Config, profile: string = "default") {
  // --profile is required when using custom URLs
  if ((config.api_url !== DEFAULT_API_URL || config.auth_url !== DEFAULT_AUTH_URL) && profile === "default") {
    console.error("--profile is required when using --api-url or --auth-url.")
    console.error("Example: crcl login --api-url https://api-dev.circles.ac --profile dev")
    process.exit(1)
  }
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

  // Save credentials
  saveCredentials(profile, {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
  })

  // Save config (api_url, auth_url, org)
  const conf: Record<string, string> = {}
  if (config.api_url !== DEFAULT_API_URL) conf.api_url = config.api_url
  if (config.auth_url !== DEFAULT_AUTH_URL) conf.auth_url = config.auth_url

  // Set default org
  const requestedOrg = config.org
  if (requestedOrg) {
    const org = me.orgs.find((o) => o.slug === requestedOrg)
    if (org) {
      conf.org = org.slug
      console.log(`Using org: ${org.slug}`)
    } else {
      console.error(`Org '${requestedOrg}' not found.`)
      if (me.orgs.length > 0) {
        conf.org = me.orgs[0].slug
        console.log(`Using org: ${me.orgs[0].slug}`)
      }
    }
  } else if (me.orgs.length > 0) {
    console.log("\nYour organizations:")
    for (const o of me.orgs) {
      console.log(`  ${o.slug} (${o.name}) [${o.role}]`)
    }
    conf.org = me.orgs[0].slug
    console.log(`\nUsing org: ${me.orgs[0].slug}`)
  } else {
    console.log("\nNo organizations found. Create one with: crcl orgs create <slug> <name>")
  }

  if (Object.keys(conf).length > 0) saveProfileConfig(profile, conf)

  console.log(`Config saved to ${configDir()}`)
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

  console.log(`${"Slug".padEnd(24)} ${"Name".padEnd(30)} Role`)
  console.log("─".repeat(64))
  for (const o of me.orgs) {
    const marker = config.org === o.slug ? " *" : ""
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

  saveProfileConfig(config.profile, { org: org.slug })
  console.log(`Set as current org: ${org.slug}`)
}

async function cmdOrgsUpdate(config: Config, opts: { name?: string; slug?: string }) {
  const body: Record<string, string> = {}
  if (opts.name) body.name = opts.name
  if (opts.slug) body.new_slug = opts.slug

  if (Object.keys(body).length === 0) {
    console.error("Nothing to update. Use --name or --slug.")
    process.exit(1)
  }

  const { org_slug } = await resolveOrg(config)

  const { data: updated } = await api<{ id: number; slug: string; name: string }>(
    config,
    orgPath(org_slug),
    { method: "PUT", body }
  )

  console.log(`Organization updated: ${updated.slug} (${updated.name})`)

  if (opts.slug && opts.slug !== org_slug) {
    saveProfileConfig(config.profile, { org: updated.slug })
    console.log(`Local config updated: ${org_slug} → ${updated.slug}`)
  }
}

async function cmdOrgsSwitch(config: Config, args: string[]) {
  requireAuth(config)

  const slug = args[0]
  if (!slug) {
    console.error("Usage: crcl orgs switch <slug>")
    process.exit(1)
  }

  // Verify org exists on server
  const { data: me } = await api<UserMe>(config, "/users/me")
  const org = me.orgs.find((o) => o.slug === slug)

  if (!org) {
    console.error(`Org '${slug}' not found. Your orgs:`)
    for (const o of me.orgs) console.error(`  ${o.slug}`)
    process.exit(1)
  }

  saveProfileConfig(config.profile, { org: org.slug })
  console.log(`Switched to org: ${org.slug} (${org.name})`)
}

// ── API Keys ────────────────────────────────────────────────────────────────

function requireScope(opts: { user?: boolean; org?: string }): "user" | "org" {
  if (opts.user && opts.org) {
    console.error("Cannot use both --user and --org.")
    process.exit(1)
  }
  if (!opts.user && !opts.org) {
    console.error("Specify --user or --org <slug>.")
    process.exit(1)
  }
  return opts.user ? "user" : "org"
}

async function cmdApikeysList(config: Config, opts: { user?: boolean }) {
  if (opts.user) {
    requireAuth(config)
    const { data: keys } = await api<ApiKey[]>(config, "/users/me/api_keys")
    if (keys.length === 0) { console.log("No user API keys found."); return }
    console.log(`${"ID".padEnd(12)} ${"Name".padEnd(30)} ${"Key".padEnd(18)} Created`)
    console.log("─".repeat(80))
    for (const k of keys) {
      const date = new Date(k.created_at).toLocaleDateString()
      console.log(`${k.id.padEnd(12)} ${k.name.padEnd(30)} ${k.masked_key.padEnd(18)} ${date}`)
    }
    return
  }

  const { org_slug } = await resolveOrg(config)
  const { data: keys } = await api<ApiKey[]>(config, orgPath(org_slug, "api_keys"))

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

async function cmdApikeysCreate(config: Config, args: string[], opts: { user?: boolean }) {
  const force = args.includes("--force") || args.includes("-y")
  const cleanArgs = args.filter((a) => a !== "--force" && a !== "-y")
  const name = cleanArgs.join(" ") || `crcl-${new Date().toISOString().slice(0, 10)}`

  if (opts.user) {
    requireAuth(config)
    const { data: existing } = await api<ApiKey[]>(config, "/users/me/api_keys")

    if (existing.length > 0 && !force) {
      console.error(`User API key already exists:`)
      for (const k of existing) console.error(`  ${k.id}  ${k.name}  ${k.masked_key}`)
      console.error(`\nUse --force or -y to delete existing key(s) and create a new one.`)
      process.exit(1)
    }

    if (existing.length > 0 && force) {
      for (const k of existing) await api(config, `/users/me/api_keys/${encodeURIComponent(k.id)}`, { method: "DELETE" })
      console.log(`Deleted ${existing.length} existing key(s).`)
    }

    const { data: key } = await api<{ id: string; key: string; name: string; created_at: string }>(
      config, "/users/me/api_keys", { method: "POST", body: { name } }
    )

    console.log(`User API key created:`)
    console.log(`  ID:   ${key.id}`)
    console.log(`  Name: ${key.name}`)
    console.log(`  Key:  ${key.key}`)
    console.log(`\nSave this key — it won't be shown again.`)
    return
  }

  const { org_slug } = await resolveOrg(config)

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

  console.log(`API key created:`)
  console.log(`  ID:   ${key.id}`)
  console.log(`  Name: ${key.name}`)
  console.log(`  Key:  ${key.key}`)
  console.log(`\nSave this key — it won't be shown again.`)
}

async function cmdApikeysDelete(config: Config, args: string[], opts: { user?: boolean }) {
  const keyId = args[0]
  if (!keyId) {
    console.error("Usage: crcl apikeys delete <key_id>")
    process.exit(1)
  }

  if (opts.user) {
    requireAuth(config)
    await api(config, `/users/me/api_keys/${encodeURIComponent(keyId)}`, { method: "DELETE" })
    console.log(`User API key ${keyId} deleted.`)
    return
  }

  const { org_slug } = await resolveOrg(config)

  await api(config, orgPath(org_slug, "api_keys", keyId), { method: "DELETE" })

  console.log(`API key ${keyId} deleted.`)
}

// ── Members ─────────────────────────────────────────────────────────────────

async function cmdMembersList(config: Config) {
  const { org_slug } = await resolveOrg(config)
  const { data: members } = await api<Member[]>(config, orgPath(org_slug, "members"))

  if (members.length === 0) {
    console.log("No members found.")
    return
  }

  console.log(`${"ID".padEnd(8)} ${"Email".padEnd(30)} ${"Name".padEnd(20)} Role`)
  console.log("─".repeat(72))
  for (const m of members) {
    console.log(`${String(m.user_id).padEnd(8)} ${(m.email || "-").padEnd(30)} ${(m.name || "-").padEnd(20)} ${m.role}`)
  }
}

async function cmdMembersAdd(config: Config, email: string, role: string) {
  const { org_slug } = await resolveOrg(config)
  const { data: member } = await api<Member>(
    config,
    orgPath(org_slug, "members"),
    { method: "POST", body: { email, role } }
  )
  console.log(`Added ${member.email} as ${member.role}.`)
}

async function resolveMemberByEmail(config: Config, org_slug: string, email: string): Promise<Member> {
  const { data: members } = await api<Member[]>(config, orgPath(org_slug, "members"))
  const member = members.find((m) => m.email === email)
  if (!member) {
    console.error(`Member '${email}' not found in org.`)
    process.exit(1)
  }
  return member
}

async function cmdMembersRole(config: Config, email: string, role: string) {
  const { org_slug } = await resolveOrg(config)
  const existing = await resolveMemberByEmail(config, org_slug, email)
  const { data: member } = await api<Member>(
    config,
    orgPath(org_slug, "members", String(existing.user_id)),
    { method: "PUT", body: { role } }
  )
  console.log(`Updated ${member.email} to ${member.role}.`)
}

async function cmdMembersRemove(config: Config, email: string) {
  const { org_slug } = await resolveOrg(config)
  const existing = await resolveMemberByEmail(config, org_slug, email)
  await api(config, orgPath(org_slug, "members", String(existing.user_id)), { method: "DELETE" })
  console.log(`Removed ${email}.`)
}

// ── Auth Token ─────────────────────────────────────────────────────────────

async function cmdAuthToken(config: Config) {
  if (!config.access_token && !config.refresh_token) {
    console.error("Not authenticated. Run: crcl login")
    process.exit(1)
  }

  // Check if access token is expired by decoding JWT
  if (config.access_token) {
    try {
      const payload = JSON.parse(Buffer.from(config.access_token.split(".")[1], "base64url").toString())
      if (payload.exp && payload.exp * 1000 > Date.now()) {
        process.stdout.write(config.access_token)
        return
      }
    } catch { /* token invalid, try refresh */ }
  }

  // Token expired or invalid — refresh
  const newToken = await refreshAccessToken(config)
  if (!newToken) {
    console.error("Failed to refresh token. Run: crcl login")
    process.exit(1)
  }

  process.stdout.write(newToken)
}

// ── Whoami ──────────────────────────────────────────────────────────────────

async function cmdWhoami(config: Config) {
  requireAuth(config)

  const { data: me } = await api<UserMe>(config, "/users/me")

  console.log(`User:    ${me.name || me.email}`)
  console.log(`Email:   ${me.email}`)
  console.log(`Profile: ${config.profile}`)
  if (config.api_url !== DEFAULT_API_URL) console.log(`API:     ${config.api_url}`)
  if (config.org) console.log(`Org:     ${config.org}`)
  if (me.orgs.length > 0) {
    console.log(`Orgs:    ${me.orgs.map((o) => o.slug).join(", ")}`)
  }
}

// ── Logout ──────────────────────────────────────────────────────────────────

function cmdLogout(config: Config, opts: { all?: boolean }) {
  if (opts.all) {
    // Clear both files
    writeIniFile(configFilePath(), {})
    writeIniFile(credentialsFilePath(), {})
    console.log("Logged out of all profiles.")
    return
  }

  deleteProfile(config.profile)
  console.log(`Logged out of profile '${config.profile}'.`)
}

// ── Commands ─────────────────────────────────────────────────────────────────

const loginArgs = {
  org: { type: "string" as const, description: "Override current org" },
  "api-url": { type: "string" as const, description: "API URL (e.g. https://api-dev.circles.ac)" },
  "auth-url": { type: "string" as const, description: "Auth URL (e.g. https://auth-dev.circles.ac)" },
}

const globalArgs = {
  org: { type: "string" as const, description: "Override current org" },
  profile: { type: "string" as const, description: "Use a specific profile (number or name)" },
}

const orgsCommand = defineCommand({
  meta: { name: "orgs", description: "Manage organizations" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List your organizations" },
      args: { ...globalArgs },
      async run({ args }) { await cmdOrgsList(loadConfig({ org: args.org, profile: args.profile })) },
    }),
    create: defineCommand({
      meta: { name: "create", description: "Create a new organization" },
      args: {
        ...globalArgs,
        slug: { type: "positional" as const, description: "Organization slug", required: true },
        name: { type: "positional" as const, description: "Organization name", required: false },
      },
      async run({ args }) {
        await cmdOrgsCreate(loadConfig({ org: args.org, profile: args.profile }), [args.slug, args.name].filter(Boolean) as string[])
      },
    }),
    switch: defineCommand({
      meta: { name: "switch", description: "Switch current organization" },
      args: {
        ...globalArgs,
        slug: { type: "positional" as const, description: "Organization slug", required: true },
      },
      async run({ args }) { await cmdOrgsSwitch(loadConfig({ org: args.org, profile: args.profile }), [args.slug]) },
    }),
    update: defineCommand({
      meta: { name: "update", description: "Update organization name or slug" },
      args: {
        ...globalArgs,
        name: { type: "string" as const, description: "New organization name" },
        slug: { type: "string" as const, description: "New organization slug" },
      },
      async run({ args }) { await cmdOrgsUpdate(loadConfig({ org: args.org, profile: args.profile }), { name: args.name, slug: args.slug }) },
    }),
  },
})

const scopeArgs = {
  ...globalArgs,
  user: { type: "boolean" as const, description: "User-level API key" },
}

const membersCommand = defineCommand({
  meta: { name: "members", description: "Manage organization members" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List organization members" },
      args: { ...globalArgs },
      async run({ args }) { await cmdMembersList(loadConfig({ org: args.org, profile: args.profile })) },
    }),
    add: defineCommand({
      meta: { name: "add", description: "Add a member to the organization" },
      args: {
        ...globalArgs,
        email: { type: "positional" as const, description: "User email", required: true },
        role: { type: "string" as const, description: "Role: owner or member (default: member)" },
      },
      async run({ args }) {
        await cmdMembersAdd(loadConfig({ org: args.org, profile: args.profile }), args.email, args.role || "member")
      },
    }),
    role: defineCommand({
      meta: { name: "role", description: "Change a member's role" },
      args: {
        ...globalArgs,
        email: { type: "positional" as const, description: "Member email", required: true },
        role: { type: "string" as const, description: "New role: owner or member", required: true },
      },
      async run({ args }) {
        if (!args.role) {
          console.error("Usage: crcl members role <email> --role <owner|member>")
          process.exit(1)
        }
        await cmdMembersRole(loadConfig({ org: args.org, profile: args.profile }), args.email, args.role)
      },
    }),
    remove: defineCommand({
      meta: { name: "remove", description: "Remove a member from the organization" },
      args: {
        ...globalArgs,
        email: { type: "positional" as const, description: "Member email", required: true },
      },
      async run({ args }) {
        await cmdMembersRemove(loadConfig({ org: args.org, profile: args.profile }), args.email)
      },
    }),
  },
})

const apikeysCommand = defineCommand({
  meta: { name: "apikeys", description: "Manage API keys (use --user or --org <slug>)" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List API keys" },
      args: { ...scopeArgs },
      async run({ args }) {
        const scope = requireScope({ user: args.user, org: args.org })
        await cmdApikeysList(loadConfig({ org: args.org, profile: args.profile }), { user: scope === "user" })
      },
    }),
    create: defineCommand({
      meta: { name: "create", description: "Create a new API key" },
      args: {
        ...scopeArgs,
        name: { type: "positional" as const, description: "Key name", required: false },
        force: { type: "boolean" as const, alias: "y", description: "Delete existing keys and create new" },
      },
      async run({ args }) {
        const scope = requireScope({ user: args.user, org: args.org })
        const cmdArgs = [args.name, args.force ? "--force" : ""].filter(Boolean) as string[]
        await cmdApikeysCreate(loadConfig({ org: args.org, profile: args.profile }), cmdArgs, { user: scope === "user" })
      },
    }),
    delete: defineCommand({
      meta: { name: "delete", description: "Delete an API key" },
      args: {
        ...scopeArgs,
        key_id: { type: "positional" as const, description: "API key ID", required: true },
      },
      async run({ args }) {
        const scope = requireScope({ user: args.user, org: args.org })
        await cmdApikeysDelete(loadConfig({ org: args.org, profile: args.profile }), [args.key_id], { user: scope === "user" })
      },
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
      args: {
        ...loginArgs,
        profile: { type: "string" as const, description: "Profile name (required with --api-url)" },
      },
      async run({ args }) {
        await cmdLogin(loadConfig({ org: args.org, apiUrl: args["api-url"], authUrl: args["auth-url"] }), args.profile)
      },
    }),
    logout: defineCommand({
      meta: { name: "logout", description: "Clear stored credentials" },
      args: {
        profile: { type: "string" as const, description: "Profile to logout (default: current)" },
        all: { type: "boolean" as const, description: "Logout of all profiles" },
      },
      run({ args }) { cmdLogout(loadConfig({ profile: args.profile }), { all: args.all }) },
    }),
    whoami: defineCommand({
      meta: { name: "whoami", description: "Show current user and org" },
      args: { ...globalArgs },
      async run({ args }) { await cmdWhoami(loadConfig({ org: args.org, profile: args.profile })) },
    }),
    auth: defineCommand({
      meta: { name: "auth", description: "Authentication utilities" },
      subCommands: {
        token: defineCommand({
          meta: { name: "token", description: "Print a valid access token (refreshes if expired)" },
          args: { ...globalArgs },
          async run({ args }) { await cmdAuthToken(loadConfig({ org: args.org, profile: args.profile })) },
        }),
      },
    }),
    orgs: orgsCommand,
    members: membersCommand,
    apikeys: apikeysCommand,
  },
})

// Only run when executed directly (not imported for testing)
if (import.meta.main) {
  runMain(main)
}
