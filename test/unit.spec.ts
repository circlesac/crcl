import { describe, expect, it } from "vitest"
import { getDefaultOrg } from "../src/index"
import type { Config } from "../src/index"

describe("getDefaultOrg", () => {
  const baseConfig: Config = {
    api_url: "https://api.circles.ac",
    auth_url: "https://auth.circles.ac",
    access_token: null,
    refresh_token: null,
    orgs: {},
  }

  it("returns null when no orgs", () => {
    expect(getDefaultOrg(baseConfig)).toBeNull()
  })

  it("returns null when no default org", () => {
    const config: Config = {
      ...baseConfig,
      orgs: {
        "1": { slug: "org-a" },
        "2": { slug: "org-b" },
      },
    }
    expect(getDefaultOrg(config)).toBeNull()
  })

  it("returns default org", () => {
    const config: Config = {
      ...baseConfig,
      orgs: {
        "1": { slug: "org-a" },
        "2": { slug: "org-b", default: true },
      },
    }
    const result = getDefaultOrg(config)
    expect(result).not.toBeNull()
    expect(result!.id).toBe("2")
    expect(result!.entry.slug).toBe("org-b")
  })

  it("returns first default when multiple (edge case)", () => {
    const config: Config = {
      ...baseConfig,
      orgs: {
        "1": { slug: "org-a", default: true },
        "2": { slug: "org-b", default: true },
      },
    }
    const result = getDefaultOrg(config)
    expect(result!.id).toBe("1")
  })

  it("handles default: false", () => {
    const config: Config = {
      ...baseConfig,
      orgs: {
        "1": { slug: "org-a", default: false },
      },
    }
    expect(getDefaultOrg(config)).toBeNull()
  })
})
