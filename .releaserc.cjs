module.exports = {
  branches: [
    'main'
  ],
  
  plugins: [
    // Analyze commits to determine release type
    // While in 0.x, breaking changes bump minor (not major) per semver spec
    ['@semantic-release/commit-analyzer', {
      releaseRules: [
        { breaking: true, release: 'minor' },
        { type: 'feat', release: 'minor' },
        { type: 'fix', release: 'patch' },
        { type: 'perf', release: 'patch' },
        { type: 'refactor', release: 'patch' },
      ]
    }],
    
    // Generate release notes
    '@semantic-release/release-notes-generator',
    
    // Publishes the canonical version to npmjs via trusted publishing (OIDC).
    // The npm CLI exchanges the workflow's OIDC token (id-token: write) for
    // short-lived publish credentials, validated against the trusted
    // publisher configured on npmjs.com for this repo and workflow file
    // (ci.yml). No NPM_TOKEN exists anywhere; provenance attestation comes
    // with the OIDC publish. Trusted publishing cannot create a package's
    // first-ever version unless a pending trusted publisher was configured
    // first (npm/cli#8544) — that one-time npmjs-side setup is documented in
    // AGENTS.md.
    //
    // The companion GitHub Packages mirror is handled by
    // scripts/publish-github-packages.mjs in a separate step, authenticated
    // with GITHUB_TOKEN.
    //
    // package.json's committed version stays a placeholder (0.4.0) —
    // semantic-release sets the real version only in this ephemeral CI
    // checkout before `npm publish`, and never commits it back to the repo.
    // No PR, no committed version file, ever; the registries and git tags
    // are the only sources of truth for the release version.
    ['@semantic-release/npm', { provenance: true }],

    // Create GitHub release directly from HEAD's tree (no version-bump
    // commit precedes it)
    '@semantic-release/github'
  ]
};
