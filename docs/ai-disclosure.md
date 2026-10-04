# AI tool disclosure: Hackathon

> **Team: please review and correct this before submission.** It must describe what actually happened.

## Tools used

| Tool | Used for |
|---|---|
| Claude Code (Anthropic, Claude Opus model) in the Claude desktop app | Reading the brief, the Designathon concept and the datasets; proposing the architecture; writing most of the application code, tests, Docker/Render configuration and these docs; running tests and checking the app in a browser. |
| *(add any others, e.g. ChatGPT, Copilot, Figma AI)* | |

## How we used it

1. **Specification first.** The Designathon concept (`Waypoint Relay`, 11 screens, the "Delivery recorded, connection lost" failure scenario) was the specification. We asked the assistant to implement those flows and to list any departures.
2. **Tests before features.** The planning engine was specified as unit tests first: the booklet's trip-time examples (101 min and the VEH036 64/40 min trips), the 55.7 kg overweight case, the S1-078 oversize order, and constraint rules. The engine was then written to make those tests pass. An API test walks all four roles end to end, including the shortfall, duplicate-upload and conflict paths.
3. **Independent check.** The engine's S1 allocation was exported and run through the organizers' `check_allocation.py`, which passed.
4. **Human decisions.** *(Team: describe yours, e.g. the product concept and screen scope from the Designathon, the priority policy, review of the generated code, the deployment and accounts, the demo video.)*

## Not AI-assisted

*(Team: list, e.g. the Designathon research and concept decisions, Figma design work, video narration.)*

## Verification

- `npm test` runs 25 tests (15 planner, 10 end-to-end API).
- The UI was exercised in a browser for every role before submission.
