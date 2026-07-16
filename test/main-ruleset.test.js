import { describe, expect, it } from "vitest";
import { fetchMainRuleset, verifyMainRuleset } from "../scripts/verify-main-ruleset.mjs";

describe("main ruleset release control", () => {
  it("accepts only the deliberate sole-operator configuration", () => {
    expect(verifyMainRuleset(validRuleset())).toMatchObject({
      repository: "Byte-Ventures/borg-mcp-server",
      rulesetId: 18946516,
      approvals: 0,
      mergeMethods: ["merge"],
      requiredChecks: ["test:15368"],
      bypassActors: 0,
    });
  });

  it("rejects hostile scope, enforcement, review, check, history, and bypass drift", () => {
    const mutations = [
      (fixture) => { fixture.id = 1; },
      (fixture) => { fixture.enforcement = "disabled"; },
      (fixture) => { fixture.target = "tag"; },
      (fixture) => { fixture.source = "attacker/repository"; },
      (fixture) => { fixture.updated_at = "invalid"; },
      (fixture) => { fixture.conditions.ref_name.include = ["refs/heads/*"]; },
      (fixture) => { fixture.bypass_actors = [{ actor_type: "OrganizationAdmin" }]; },
      (fixture) => { fixture.current_user_can_bypass = "always"; },
      (fixture) => { fixture.rules = fixture.rules.filter((rule) => rule.type !== "pull_request"); },
      (fixture) => { fixture.rules = fixture.rules.filter((rule) => rule.type !== "deletion"); },
      (fixture) => { fixture.rules = fixture.rules.filter((rule) => rule.type !== "non_fast_forward"); },
      (fixture) => { pullRequest(fixture).required_approving_review_count = 1; },
      (fixture) => { pullRequest(fixture).required_review_thread_resolution = false; },
      (fixture) => { pullRequest(fixture).allowed_merge_methods = ["squash"]; },
      (fixture) => { statusChecks(fixture).strict_required_status_checks_policy = false; },
      (fixture) => { statusChecks(fixture).do_not_enforce_on_create = true; },
      (fixture) => { statusChecks(fixture).required_status_checks[0].context = "attacker"; },
      (fixture) => { statusChecks(fixture).required_status_checks[0].integration_id = 1; },
    ];

    for (const mutate of mutations) {
      const fixture = validRuleset();
      mutate(fixture);
      expect(() => verifyMainRuleset(fixture)).toThrow();
    }
  });

  it("requires an authenticated successful GitHub response", async () => {
    await expect(fetchMainRuleset("", async () => new Response("{}"))).rejects.toThrow("GITHUB_TOKEN");
    await expect(fetchMainRuleset("token", async () => new Response("forbidden", { status: 403 })))
      .rejects.toThrow("HTTP 403");

    let request;
    await fetchMainRuleset("secret", async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify(validRuleset()));
    });
    expect(request).toMatchObject({
      url: "https://api.github.com/repos/Byte-Ventures/borg-mcp-server/rulesets/18946516",
      options: {
        cache: "no-store",
        headers: { authorization: "Bearer secret" },
      },
    });
  });
});

function pullRequest(fixture) {
  return fixture.rules.find((rule) => rule.type === "pull_request").parameters;
}

function statusChecks(fixture) {
  return fixture.rules.find((rule) => rule.type === "required_status_checks").parameters;
}

function validRuleset() {
  return {
    id: 18946516,
    name: "protect-main",
    target: "branch",
    source_type: "Repository",
    source: "Byte-Ventures/borg-mcp-server",
    enforcement: "active",
    conditions: {
      ref_name: { exclude: [], include: ["refs/heads/main"] },
    },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          required_reviewers: [],
          require_code_owner_review: false,
          dismissal_restriction: { enabled: false, allowed_actors: [] },
          require_last_push_approval: false,
          required_review_thread_resolution: true,
          allowed_merge_methods: ["merge"],
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: [{ context: "test", integration_id: 15368 }],
        },
      },
    ],
    bypass_actors: [],
    current_user_can_bypass: "never",
    updated_at: "2026-07-14T21:01:00.394+02:00",
  };
}
