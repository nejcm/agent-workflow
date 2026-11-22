Do these steps in order:

1. Clarify. Read the ticket and the code it touches before deciding anything is unclear: do not ask what
   the code, its tests or its docs already answer. If the acceptance criteria are still missing or
   ambiguous in a way that changes what you would build, write your questions to the question file
   (below) and stop.
2. Plan and write the docs change. Change docs only. Read the docs and the code they describe, so every
   statement matches what the code actually does. Change no code: if the code is wrong, list it in the
   findings file. Match the existing docs' tone, structure and formatting. Keep it short: no sections,
   examples or caveats the ticket did not ask for.
3. Test. Add no new tests. Run {{verify}} and make them pass. Check that every command, snippet and link
   you changed is correct: run a command only if it is read-only and safe in this clone, never one that
   deploys, publishes, migrates or deletes data; check the rest against the code.
4. Verify the change on the real surface it affects (CLI, API, UI). If the repo has a verification
   skill (`.agents/skills/verify-*/` or `.claude/skills/*verif*/`), use it. Note what you ran
   and the result for the PR body: the command and its output, not just "it works". If you could not
   verify beyond the tests, say so there.
5. Review. Get an independent review of the diff from a model of a different family than yours. Give
   the reviewer the ticket and the diff, and ask it to check that every requirement is met and the risky
   cases are tested, and to skip style. Check each finding against the code and fix only the ones you
   confirm, at most 2 rounds. If no such model is available, skip it and set `reviewed` to `false` in
   the merge file.
6. Commit with a message that references {{id}}, in the style the repo's `git log` already uses. Commit
   only the files your change needs: no build output, temp files or `.tender/run/`.
