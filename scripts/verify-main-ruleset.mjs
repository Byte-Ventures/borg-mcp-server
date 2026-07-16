import { fileURLToPath } from 'node:url';

const API = 'https://api.github.com';
const REPOSITORY = 'Byte-Ventures/borg-mcp-server';
const RULESET_ID = 18946516;

function sameValues(actual, expected) {
  return Array.isArray(actual) &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function fail(message) {
  throw new Error(message);
}

export function verifyMainRuleset(ruleset) {
  if (ruleset?.id !== RULESET_ID || ruleset.name !== 'protect-main' ||
      ruleset.target !== 'branch' || ruleset.source_type !== 'Repository' ||
      ruleset.source !== REPOSITORY || ruleset.enforcement !== 'active' ||
      typeof ruleset.updated_at !== 'string' || Number.isNaN(Date.parse(ruleset.updated_at))) {
    fail(`Ruleset ${RULESET_ID} is not the active protect-main repository ruleset.`);
  }
  if (!sameValues(ruleset.conditions?.ref_name?.include, ['refs/heads/main']) ||
      !sameValues(ruleset.conditions?.ref_name?.exclude, [])) {
    fail('protect-main must apply only to refs/heads/main.');
  }
  if (!sameValues(ruleset.bypass_actors, []) || ruleset.current_user_can_bypass !== 'never') {
    fail('protect-main must not allow bypass actors.');
  }

  const ruleTypes = ruleset.rules?.map((rule) => rule.type);
  if (!sameValues(ruleTypes, [
    'deletion',
    'non_fast_forward',
    'pull_request',
    'required_status_checks',
  ])) {
    fail('protect-main must enforce only pull request, status, deletion, and non-fast-forward rules.');
  }
  const rules = new Map(ruleset.rules.map((rule) => [rule.type, rule.parameters]));
  const review = rules.get('pull_request');
  if (review?.required_approving_review_count !== 0 ||
      review.dismiss_stale_reviews_on_push !== false ||
      !sameValues(review.required_reviewers, []) ||
      review.require_code_owner_review !== false ||
      review.dismissal_restriction?.enabled !== false ||
      !sameValues(review.dismissal_restriction?.allowed_actors, []) ||
      review.require_last_push_approval !== false ||
      review.required_review_thread_resolution !== true ||
      !sameValues(review.allowed_merge_methods, ['merge'])) {
    fail('protect-main pull-request policy differs from the approved sole-operator configuration.');
  }

  const checks = rules.get('required_status_checks');
  const requiredChecks = checks?.required_status_checks?.map(
    (check) => `${check.context}:${check.integration_id}`,
  );
  if (checks?.strict_required_status_checks_policy !== true ||
      checks.do_not_enforce_on_create !== false ||
      !sameValues(requiredChecks, ['test:15368'])) {
    fail('protect-main must require the strict current GitHub Actions test check.');
  }

  return {
    repository: REPOSITORY,
    rulesetId: RULESET_ID,
    rulesetUpdatedAt: ruleset.updated_at,
    checkedAt: new Date().toISOString(),
    main: 'pull-request-and-history-protected',
    approvals: 0,
    mergeMethods: ['merge'],
    requiredChecks: ['test:15368'],
    bypassActors: 0,
  };
}

export async function fetchMainRuleset(token, fetchImplementation = fetch) {
  if (!token) fail('GITHUB_TOKEN is required to verify the live main ruleset.');
  const response = await fetchImplementation(`${API}/repos/${REPOSITORY}/rulesets/${RULESET_ID}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
    cache: 'no-store',
  });
  if (!response.ok) {
    fail(`GitHub ruleset check returned HTTP ${response.status}.`);
  }
  return response.json();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ruleset = await fetchMainRuleset(process.env.GITHUB_TOKEN);
  console.log(JSON.stringify(verifyMainRuleset(ruleset), null, 2));
}
