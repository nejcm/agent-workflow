Plan and implement the ticket.
- Read the relevant code first: never change code you have not opened. Find every caller, test, fixture,
  config and doc the change must reach, and follow the patterns the codebase already uses.
- Reproduce the bug first with a test that fails for the reported reason, not some other one. Then find
  and fix the root cause, not the symptom, and keep the test as a regression test.
- Make the smallest change that fully solves the ticket. No refactors, extra options, abstractions or
  "improvements" it did not ask for, and no comments or docstrings on code you did not change.
- Keep docs and existing comments that your change makes wrong up to date.
