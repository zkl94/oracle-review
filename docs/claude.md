# Claude Fable 5.1 browser mode

This fork adds Claude's signed-in website to the CLI. Upstream 0.21.1 already
supports `gpt-6-pro`; its model selection stays unchanged. Claude uses the web
subscription, with no API key or API fallback.

```bash
oracle --engine browser --model claude-fable-5-1 \
  --browser-attach-running --browser-thinking-time max \
  --browser-attachments never --browser-model-strategy select \
  -p "Review this patch" --file changes.patch --wait
```

Enable Chrome's remote debugging for `--browser-attach-running`, or replace it
with `--browser-manual-login` to use a dedicated persistent profile under
`~/.oracle/claude-browser-profile`. Sign in through the opened browser. Oracle
does not copy cookies or profiles. Run `--dry-run summary --files-report` and
`--dry-run full` first to inspect the exact text and selected files.

The driver opens its own standalone chat, selects the exact Fable 5.1 entry
and Max effort, and verifies the composer label before entering the prompt.
Per-chat tools, research and connectors are switched off. Existing account
personalization still applies; use an account with appropriate personalization
settings for the evidence you send. Browser labels prove the UI selection,
not independently the provider's backend execution.

Only text evidence inlined with `--browser-attachments never` is supported.
Binary uploads, images, Projects, incognito chats, cookie injection, remote
Oracle services, automatic archiving and queued follow-up prompts are rejected.
Unknown Claude browser model IDs are rejected rather than substituted.
`--models` remains an API panel; run separate CLI commands for independent web
reviews.

## Recovery and follow-ups

The session records the dedicated tab, durable conversation URL, verified
selection and committed user-turn fingerprint. A timeout preserves the tab.
Recover the existing answer without resubmitting:

```bash
oracle session <id> --render
oracle session <id> --harvest --write-output recovered.md
oracle session <id> --live
```

Claude's `--live` waits for a complete answer; it does not stream partial text.
Recovery can reopen a closed tab at its saved URL. It requires the same user
turn, model and effort and positive completion controls, then copies the
provider's Markdown. A changed conversation or unverifiable turn is refused.
If submission was interrupted before the URL and fingerprint were saved,
inspect the preserved tab manually; do not start a duplicate. Recovery keeps
the tab open, including after success.

Continue a completed session explicitly:

```bash
oracle --engine browser --followup <id> -p "Check this remaining concern" --wait
```

The follow-up inherits the saved Claude model, Max effort and conversation URL.
To run the account-free recovery check, build and execute
`node scripts/claude-recovery-proof.mjs`; signed-in checks are listed in
[manual tests](manual-tests.md).
