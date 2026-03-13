import { describe, expect, it } from "vitest"
import { getDefaultOrg, getFlagValue, stripFlags } from "../src/index"
import type { Config } from "../src/index"

describe("getFlagValue", () => {
  it("returns value for existing flag", () => {
    expect(getFlagValue(["--org", "my-org", "list"], "--org")).toBe("my-org")
  })

  it("returns undefined for missing flag", () => {
    expect(getFlagValue(["list"], "--org")).toBeUndefined()
  })

  it("returns undefined when flag has no value", () => {
    expect(getFlagValue(["--org"], "--org")).toBeUndefined()
  })

  it("returns first occurrence", () => {
    expect(getFlagValue(["--org", "first", "--org", "second"], "--org")).toBe("first")
  })

  it("handles flag at end without value", () => {
    expect(getFlagValue(["list", "--org"], "--org")).toBeUndefined()
  })
})

describe("stripFlags", () => {
  it("removes flag and its value", () => {
    expect(stripFlags(["create", "--org", "my-org", "test"], ["--org"])).toEqual(["create", "test"])
  })

  it("keeps args when no flags present", () => {
    expect(stripFlags(["create", "test"], ["--org"])).toEqual(["create", "test"])
  })

  it("handles multiple flags", () => {
    expect(stripFlags(["--org", "my-org", "--env", "prod", "list"], ["--org", "--env"])).toEqual(["list"])
  })

  it("handles empty args", () => {
    expect(stripFlags([], ["--org"])).toEqual([])
  })

  it("keeps trailing flag without value", () => {
    expect(stripFlags(["list", "--org"], ["--org"])).toEqual(["list", "--org"])
  })
})

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
