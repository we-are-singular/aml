const NON_SCOPED_TYPES = ["build", "ci", "docs", "release", "style", "tools"]

export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "build",
        "ci",
        "design",
        "docs",
        "feat",
        "feature",
        "fix",
        "perf",
        "refactor",
        "release",
        "style",
        "test",
        "tools",
      ],
    ],
    "scope-case": [2, "always", "kebab-case"],
    "subject-case": [0],
    "scope-required": [2, "always"],
    "subject-after-ticket-case": [2, "always"],
  },
  plugins: [
    {
      rules: {
        "scope-required": ({ scope, type }) => {
          const isValid = Boolean(scope) || NON_SCOPED_TYPES.includes(type)

          return [isValid, `Scope is required unless the type is one of: ${NON_SCOPED_TYPES.join(", ")}`]
        },
        "subject-after-ticket-case": ({ subject }) => {
          if (!subject) return [false, "Subject is required"]

          const value = String(subject).trim()
          const withoutTicket = value.replace(/^(?:(?:ISSUE|TICKET)-\d+|#\d+)(?::)?\s+/, "")
          const isLowercase = withoutTicket.length > 0 && withoutTicket === withoutTicket.toLowerCase()

          return [isLowercase, "Subject must be lowercase after an optional ticket prefix"]
        },
      },
    },
  ],
}
