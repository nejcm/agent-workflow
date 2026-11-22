Do these steps in order:

1. Clarify. Read the ticket and the code it touches before deciding anything is unclear: do not ask what
   the code, its tests or its docs already answer. If the acceptance criteria are still missing or
   ambiguous in a way that changes what you would build, write your questions to the question file
   (below) and stop.
2. Plan and implement. Read the relevant code first: never change code you have not opened. Find every
   caller, test, fixture, config and doc the change must reach, and follow the patterns the codebase
   already uses. Reproduce the bug first with a test that fails for the reported reason, not some other
   one. Then fix the root cause, not the symptom, and keep the test as a regression test. Make the
   smallest change that fully solves the ticket: no refactors, extra options, abstractions or
   "improvements" it did not ask for, and no comments or docstrings on code you did not change. Keep
   docs and existing comments that your change makes wrong up to date.
3. Test. Add or update tests for the behavior you changed, in the style of the existing ones. Then run
   {{verify}} and make them pass. Fix the code, not the tests: never skip, weaken or delete a test, or
   hard-code values to make one pass. If a test is wrong, fix it and say why in the PR body.
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
